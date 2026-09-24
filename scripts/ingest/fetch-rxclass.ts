/**
 * @fileoverview Build-time acquisition of RxClass drug-class edges over the
 * KEYLESS RxClass REST API (https://rxnav.nlm.nih.gov/REST/rxclass/). Same role as
 * `fetch-rxnav.ts`: runs once at BUILD time, caches raw responses under
 * `.sources/rxclass/`, and is NEVER executed at server runtime. `parseRxClass()`
 * (in `ingest/parsers.ts`) turns the cache into class, edge, and source rows;
 * `build-index.ts` bakes them into the bundled DB.
 *
 * What it fetches (all keyless):
 *  1. `version/<SRC>.json` for each bundled relationship source → the release each
 *     source's edges come from. (The documented `version/relaSource.json?relaSource=`
 *     form returns 404; the per-source path is the one that works.)
 *  2. `allClasses.json?classTypes=<T>` for each bundled class type → every class
 *     node, including the hierarchy nodes that have no direct member.
 *  3. `class/byRxcui.json?rxcui=<id>` for every bundled ingredient (`IN`, `MIN`)
 *     from the RxNav cache. RxClass answers an ingredient query with the edges of
 *     that ingredient, its precise ingredients (`PIN`), the multi-ingredients that
 *     contain it, and the products (`SCD`/`SBD`/`GPCK`/`BPCK`) built from it — each
 *     keyed by its own `minConcept`. So the ingredient set reaches the product-level
 *     VA/schedule/CVX edges without a request per product. Responses are cached
 *     whole (every source); the parser keeps only the bundled sources.
 *
 * Pacing: request starts are serialized to ≤10/s (RxNav's published ceiling is
 * 20/s per IP), and the run aborts once `--max-requests` requests (retries
 * included) have been issued. Resumable: RXCUIs already in `byrxcui.jsonl` are
 * skipped, and the version/class snapshots are reused when present. A request
 * that still fails after its retries is not cached; the run reports it and exits
 * non-zero so a rerun picks it up.
 *
 * Once every ingredient is cached, `meta.json` records `fetchedAt` (with the run's
 * request count and duration) — the fetch time the index build stamps on every
 * class-layer source, beside the versions `versions.json` recorded. A rerun over a
 * complete cache fetches nothing and keeps that record.
 *
 * Usage:
 *   bun run scripts/ingest/fetch-rxclass.ts [--rxnav .sources/rxnav] [--out .sources/rxclass]
 *     [--limit N] [--concurrency 8] [--max-requests 20000]
 * Then build with:  bun run scripts/build-index.ts --from-dir .sources --fy <FY>
 * @module scripts/ingest/fetch-rxclass
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RXCLASS_CLASS_TYPES, RXCLASS_SOURCES } from '@/services/code-index/types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'https://rxnav.nlm.nih.gov/REST/rxclass';

/** Ingredient TTYs queried with `class/byRxcui` — the rest are reached through them. */
const QUERY_TTYS = new Set(['IN', 'MIN']);

/** 10 request starts per second. */
const MIN_INTERVAL_MS = 100;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let requests = 0;
let maxRequests = 20_000;
let nextSlot = 0;

/** Thrown once the run has issued `--max-requests` requests; aborts the whole run. */
class RequestCapError extends Error {}

/**
 * Count the request against the cap and wait for its start slot. Slots are
 * handed out synchronously, so concurrent workers never start more than one
 * request per interval.
 */
async function gate(): Promise<void> {
  if (requests >= maxRequests) {
    throw new RequestCapError(
      `Request cap reached (${maxRequests}); rerun to resume or raise --max-requests`,
    );
  }
  requests++;
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}

/** Thrown for an HTTP status that retrying will not fix. */
class TerminalHttpError extends Error {}

/**
 * GET a JSON URL through the pacing gate. Retries network failures, HTTP 429,
 * and 5xx with exponential backoff; any other non-2xx status fails immediately.
 */
async function fetchJson(path: string, retries = 5, timeoutMs = 60_000): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    await gate();
    try {
      const res = await fetch(`${BASE}/${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'medical-codes-mcp-server build (github.com/cyanheads)' },
      });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) {
        throw new TerminalHttpError(`HTTP ${res.status} for ${path}`);
      }
      throw new Error(`HTTP ${res.status} for ${path}`);
    } catch (err) {
      if (err instanceof TerminalHttpError || attempt >= retries) throw err;
      await sleep(600 * 2 ** attempt + Math.floor(Math.random() * 400));
    }
  }
}

/** Run `worker` over `items` with at most `n` in flight at once. */
async function pool<T>(items: T[], n: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) {
      const item = items[idx++];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

/** RXCUIs already cached in `byrxcui.jsonl`, for resume. */
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

/** Fetch one snapshot file (versions or classes) unless it is already cached. */
async function snapshot(
  path: string,
  label: string,
  keys: readonly string[],
  urlFor: (key: string) => string,
): Promise<void> {
  if (existsSync(path)) {
    console.log(`Reusing cached ${label} (${path})`);
    return;
  }
  const responses: Record<string, unknown> = {};
  for (const key of keys) responses[key] = await fetchJson(urlFor(key));
  writeFileSync(path, JSON.stringify({ fetchedAt: new Date().toISOString(), responses }));
  console.log(`  ${label}: ${keys.length} responses → ${path}`);
}

async function main(): Promise<void> {
  const rxnavDir = arg('--rxnav') ?? join(ROOT, '.sources', 'rxnav');
  const outDir = arg('--out') ?? join(ROOT, '.sources', 'rxclass');
  const concurrency = Number(arg('--concurrency') ?? '8');
  const limit = arg('--limit') ? Number(arg('--limit')) : undefined;
  maxRequests = Number(arg('--max-requests') ?? maxRequests);
  mkdirSync(outDir, { recursive: true });

  const conceptsPath = join(rxnavDir, 'concepts.json');
  if (!existsSync(conceptsPath)) {
    throw new Error(`${conceptsPath} not found — run scripts/ingest/fetch-rxnav.ts first`);
  }
  const concepts = JSON.parse(readFileSync(conceptsPath, 'utf-8')).concepts as {
    rxcui: string;
    tty: string;
  }[];

  const started = Date.now();

  await snapshot(
    join(outDir, 'versions.json'),
    'source versions',
    RXCLASS_SOURCES,
    (src) => `version/${src}.json`,
  );
  await snapshot(
    join(outDir, 'classes.json'),
    'class nodes',
    RXCLASS_CLASS_TYPES,
    (type) => `allClasses.json?classTypes=${type}`,
  );

  const jsonlPath = join(outDir, 'byrxcui.jsonl');
  const queries = concepts.filter((c) => QUERY_TTYS.has(c.tty)).map((c) => c.rxcui);
  const done = readDone(jsonlPath);
  let todo = queries.filter((rxcui) => !done.has(rxcui));
  if (limit !== undefined) todo = todo.slice(0, limit);
  console.log(
    `Ingredients (IN+MIN): ${queries.length} total, ${done.size} cached, ${todo.length} to fetch` +
      ` · concurrency ${concurrency} · ≤10 req/s · cap ${maxRequests} requests`,
  );

  let fetched = 0;
  const failed: { rxcui: string; error: string }[] = [];
  await pool(todo, concurrency, async (rxcui) => {
    try {
      const body = await fetchJson(`class/byRxcui.json?rxcui=${rxcui}`);
      appendFileSync(jsonlPath, `${JSON.stringify({ rxcui, status: 200, body })}\n`);
      fetched++;
    } catch (err) {
      if (err instanceof RequestCapError) throw err;
      failed.push({ rxcui, error: String(err) });
    }
    if ((fetched + failed.length) % 1000 === 0) {
      console.log(`  …${fetched + failed.length}/${todo.length} · ${requests} requests`);
    }
  });

  const seconds = Math.round((Date.now() - started) / 1000);
  const cached = done.size + fetched;
  console.log(
    `Done in ${seconds}s. ${requests} requests, ${fetched} responses cached, ${failed.length} failed. ` +
      `Cache: ${jsonlPath} (${cached}/${queries.length} ingredients)`,
  );
  if (failed.length > 0) {
    console.error(`Failed RXCUIs (rerun to retry): ${failed.map((f) => f.rxcui).join(', ')}`);
    process.exit(1);
  }
  if (cached < queries.length) {
    console.log('Cache incomplete — rerun to finish; no fetch date recorded yet.');
    return;
  }

  // Record when the cache was completed; a rerun that fetched nothing keeps it.
  const metaPath = join(outDir, 'meta.json');
  if (fetched > 0 || !existsSync(metaPath)) {
    const meta = { fetchedAt: new Date().toISOString(), requests, seconds, fetched };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  console.log(
    `Snapshot recorded in ${metaPath}: ${readFileSync(metaPath, 'utf-8')}\n` +
      'Next: bun run scripts/build-index.ts --from-dir .sources --fy <FY>',
  );
}

await main();
