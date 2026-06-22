/**
 * @fileoverview Build-time acquisition of RxNorm Prescribable Content over the
 * KEYLESS RxNav REST API (https://rxnav.nlm.nih.gov/REST/) — no UMLS license and
 * no API key. NLM gates the RxNorm RRF bulk files (including the prescribable
 * subset) behind UMLS/UTS authentication, so the RRF path is not usable for an
 * offline, keyless, redistributable package. This script is the acquisition step
 * instead: it runs once at BUILD time (the same role as the manual ICD/HCPCS file
 * download), caches raw RxNav responses under `.sources/rxnav/`, and is NEVER
 * executed at server runtime. `parseRxNav()` (in `ingest/parsers.ts`) turns the
 * cache into normalized rows; `build-index.ts` bakes them into the bundled DB.
 *
 * Why RxNav and not the RRF: RxNav serves the public-domain RxNorm normalized
 * vocabulary (the redistributable core), not the UMLS-licensed source
 * vocabularies — so a keyless build from it carries the same redistribution
 * profile the RRF prescribable subset was chosen for.
 *
 * Strategy (all keyless):
 *  1. `allconcepts.json?tty=<CONCEPT_TTYS>` → the prescribable concept set in one
 *     call (ingredients, brand names, and clinical/branded drug + pack products).
 *     These become `codes(RXNORM)` rows — name→RXCUI search and get_code on an
 *     RXCUI both read this.
 *  2. Per drug PRODUCT (SCD/SBD/GPCK/BPCK): `ndcs.json` (→ the NDC↔RXCUI map) and
 *     `related.json?tty=IN+PIN+MIN+BN` (→ has_ingredient / has_tradename edges) —
 *     two calls each. (NOTE: the targeted `related.json` nests under `relatedGroup`;
 *     the broader `allrelated.json` nests under `allRelatedGroup` — different key.)
 *
 * The cache is resumable: products already present in `products.jsonl` are
 * skipped, so an interrupted fetch continues where it left off. NDCs come back
 * 11-digit from RxNav; the runtime normalizes user input to 11-digit before
 * lookup (see `normalizeNdc`).
 *
 * Usage:
 *   bun run scripts/ingest/fetch-rxnav.ts [--out .sources/rxnav] [--limit N] [--concurrency 10]
 * Then build with:  bun run scripts/build-index.ts --from-dir .sources --fy <FY>
 * @module scripts/ingest/fetch-rxnav
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'https://rxnav.nlm.nih.gov/REST';

/**
 * Concept TTYs stored as `codes(RXNORM)` rows. Ingredients (IN/PIN/MIN), brand
 * names (BN), and the prescribable drug products + packs (SCD/SBD/GPCK/BPCK) —
 * the set that answers name→RXCUI, get_code on an RXCUI, and the ingredient/brand
 * crosswalk targets. Drug components and dose forms are intentionally excluded:
 * they are not lookup targets for any bundled direction and would only add noise.
 */
const CONCEPT_TTYS = ['IN', 'PIN', 'MIN', 'BN', 'SCD', 'SBD', 'GPCK', 'BPCK'] as const;

/** TTYs that carry NDCs and ingredient/brand edges — the per-product fan-out set. */
const PRODUCT_TTYS = new Set(['SCD', 'SBD', 'GPCK', 'BPCK']);

/** TTYs that count as an ingredient target in `allrelated`. */
const INGREDIENT_TTYS = new Set(['IN', 'PIN', 'MIN']);

/** A single RxNorm concept as returned by `allconcepts`. */
interface RxNavConcept {
  name: string;
  rxcui: string;
  tty: string;
}

/** One product's fetched edges — one JSONL line in the cache. */
interface ProductRecord {
  brands: RxNavConcept[];
  ingredients: RxNavConcept[];
  ndcs: string[];
  rxcui: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Global request-start pacing. RxNav publishes a ~20 req/s per-IP ceiling; under
 * high concurrency the start times must be spread or the whole run risks getting
 * throttled (and a throttled response that comes back empty-but-200 would be
 * cached as missing data). `rateGate` serializes request STARTS to ~18/s
 * regardless of how many workers are in flight — concurrency still hides latency,
 * but the issue rate stays under the ceiling.
 */
const MIN_INTERVAL_MS = 55;
let nextSlot = 0;
async function rateGate(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}

/**
 * GET a JSON URL with a timeout and bounded retry. Retries on network failure,
 * HTTP 429, and 5xx (with exponential backoff + jitter to stay polite under
 * RxNav's ~20 req/s ceiling); returns `null` on a 4xx other than 429 (treated as
 * "no data for this concept"). Throws only after exhausting retries.
 */
async function fetchJson(url: string, retries = 5, timeoutMs = 45000): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rateGate();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'medical-codes-mcp-server build (github.com/cyanheads)' },
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) return null;
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (attempt >= retries) throw err;
      const backoff = 600 * 2 ** attempt + Math.floor(Math.random() * 400);
      await sleep(backoff);
    }
  }
}

/** Run `worker` over `items` with at most `n` in flight at once. */
async function pool<T>(items: T[], n: number, worker: (item: T, i: number) => Promise<void>) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      const item = items[i];
      if (item !== undefined) await worker(item, i);
    }
  });
  await Promise.all(runners);
}

/** Pull the `{rxcui,name,tty}` list out of an `allconcepts` response. */
function parseAllConcepts(json: unknown): RxNavConcept[] {
  const group = (json as { minConceptGroup?: { minConcept?: RxNavConcept[] } })?.minConceptGroup;
  return (group?.minConcept ?? []).filter((c) => c?.rxcui && c?.name && c?.tty);
}

/** Pull the 11-digit NDC list out of an `ndcs.json` response. */
function parseNdcs(json: unknown): string[] {
  const list = (json as { ndcGroup?: { ndcList?: { ndc?: string[] } } })?.ndcGroup?.ndcList?.ndc;
  return Array.isArray(list) ? list : [];
}

/** Split a `related.json?tty=IN+PIN+MIN+BN` response into ingredient and brand concepts. */
function parseRelated(json: unknown): { brands: RxNavConcept[]; ingredients: RxNavConcept[] } {
  const groups =
    (
      json as {
        relatedGroup?: { conceptGroup?: { tty?: string; conceptProperties?: RxNavConcept[] }[] };
      }
    )?.relatedGroup?.conceptGroup ?? [];
  const ingredients: RxNavConcept[] = [];
  const brands: RxNavConcept[] = [];
  for (const g of groups) {
    const props = g?.conceptProperties ?? [];
    if (INGREDIENT_TTYS.has(g?.tty ?? '')) ingredients.push(...props);
    else if (g?.tty === 'BN') brands.push(...props);
  }
  return { ingredients, brands };
}

/** rxcuis already cached in `products.jsonl`, for resume. */
function readDone(jsonlPath: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(jsonlPath)) return done;
  for (const line of readFileSync(jsonlPath, 'utf-8').split('\n')) {
    if (!line) continue;
    try {
      const { rxcui } = JSON.parse(line) as { rxcui?: string };
      if (rxcui) done.add(rxcui);
    } catch {
      // tolerate a truncated final line from an interrupted run
    }
  }
  return done;
}

async function main(): Promise<void> {
  const outDir = arg('--out') ?? join(ROOT, '.sources', 'rxnav');
  const concurrency = Number(arg('--concurrency') ?? '10');
  const limit = arg('--limit') ? Number(arg('--limit')) : undefined;
  mkdirSync(outDir, { recursive: true });

  const conceptsPath = join(outDir, 'concepts.json');
  const jsonlPath = join(outDir, 'products.jsonl');

  // 1. Concept set (one call). Cached so reruns don't refetch the enumeration.
  let concepts: RxNavConcept[];
  if (existsSync(conceptsPath)) {
    concepts = JSON.parse(readFileSync(conceptsPath, 'utf-8')).concepts as RxNavConcept[];
    console.log(`Reusing cached concepts.json (${concepts.length} concepts)`);
  } else {
    console.log(`Fetching concept set (tty=${CONCEPT_TTYS.join('+')}) …`);
    concepts = parseAllConcepts(
      await fetchJson(`${BASE}/allconcepts.json?tty=${CONCEPT_TTYS.join('+')}`),
    );
    if (concepts.length === 0) throw new Error('allconcepts returned no concepts — aborting');
    writeFileSync(conceptsPath, JSON.stringify({ concepts }));
    console.log(`  ${concepts.length} concepts → ${conceptsPath}`);
  }

  // 2. Per-product fan-out (ndcs + related), resumable. Process the single-drug
  // products (SCD/SBD) before the packs (GPCK/BPCK): they are the bulk of the
  // NDC + ingredient/brand data, so the high-value rows land first and an
  // interrupted run still yields a useful core.
  const ttyRank: Record<string, number> = { SCD: 0, SBD: 1, GPCK: 2, BPCK: 3 };
  const allProducts = concepts
    .filter((c) => PRODUCT_TTYS.has(c.tty))
    .sort((a, b) => (ttyRank[a.tty] ?? 9) - (ttyRank[b.tty] ?? 9));
  const done = readDone(jsonlPath);
  let todo = allProducts.filter((p) => !done.has(p.rxcui));
  if (limit !== undefined) todo = todo.slice(0, limit);

  console.log(
    `Products: ${allProducts.length} total, ${done.size} cached, ${todo.length} to fetch` +
      (limit !== undefined ? ` (--limit ${limit})` : '') +
      ` · concurrency ${concurrency}`,
  );

  let fetched = 0;
  let withNdcs = 0;
  await pool(todo, concurrency, async (p) => {
    const [ndcJson, relJson] = await Promise.all([
      fetchJson(`${BASE}/rxcui/${p.rxcui}/ndcs.json`),
      fetchJson(`${BASE}/rxcui/${p.rxcui}/related.json?tty=IN+PIN+MIN+BN`),
    ]);
    const ndcs = parseNdcs(ndcJson);
    const { ingredients, brands } = parseRelated(relJson);
    const record: ProductRecord = { rxcui: p.rxcui, ndcs, ingredients, brands };
    appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
    fetched++;
    if (ndcs.length > 0) withNdcs++;
    if (fetched % 500 === 0) {
      console.log(`  …${fetched}/${todo.length} products (${withNdcs} with NDCs)`);
    }
  });

  console.log(
    `Done. Fetched ${fetched} products (${withNdcs} with NDCs). Cache: ${jsonlPath}\n` +
      `Next: bun run scripts/build-index.ts --from-dir .sources --fy <FY>`,
  );
}

main();
