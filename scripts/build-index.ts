/**
 * @fileoverview Build the bundled SQLite + FTS5 medical-codes index from the
 * canonical federal source files. This is the MirrorService's ingester role done
 * AT BUILD TIME: run on the federal update cadence, output baked into the package
 * and Docker image — never executed at server startup.
 *
 * It does NOT download anything. Point `--from-dir` at a directory holding the
 * already-extracted source files (URLs documented below); the script parses them
 * with the pure parsers in `ingest/parsers.ts`, normalizes into the schema, and
 * writes `data/medical-codes.db`. For tests and local smoke runs use
 * `scripts/build-fixture-db.ts`, which writes a small synthetic DB instead.
 *
 * Canonical sources (static bulk downloads, no key, no runtime API):
 *  - ICD-10-CM order file: CDC NCHS FTP
 *      ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM/<FY>/
 *      → icd10cm-order-<FY>.txt (+ icd10cm-order-addenda-<FY>.txt overlay)
 *  - ICD-10-PCS order file: CMS ICD-10 page
 *      → icd10pcs_order_<FY>.txt  (+ icd10pcs_tabular_<FY>.xml for pcs_axes)
 *  - HCPCS Level II annual file: CMS HCPCS page
 *      → HCPC<yr>_CONTR_ANWEB.txt
 *  - RxNorm Prescribable Content subset (PHASE 2 — not bundled in v1): NLM
 *      → RxNorm_full_prescribe_<MMDDYYYY>.zip → RXNCONSO/RXNSAT/RXNREL.RRF
 *      MUST use the Prescribable subset, NEVER the full monthly release (the full
 *      release drags in UMLS-licensed source vocabularies and breaks redistribution).
 *
 * Usage:
 *   bun run scripts/build-index.ts --from-dir ./.sources --fy 2026 [--out data/medical-codes.db]
 *   Expected files in --from-dir (match the names above; the script probes common variants).
 * @module scripts/build-index
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDbWriter, type DbWriter } from './_db-writer.ts';
import {
  hcpcsSectionRows,
  parseHcpcsAnweb,
  parseIcd10cmOrder,
  parseIcd10pcsAxes,
  parseIcd10pcsOrder,
  parseRxNorm,
} from './ingest/parsers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** First file in `dir` whose name matches any of the substrings (case-insensitive). */
function findFile(dir: string, ...needles: string[]): string | undefined {
  if (!existsSync(dir)) return;
  const lower = needles.map((n) => n.toLowerCase());
  for (const name of readdirSync(dir)) {
    const n = name.toLowerCase();
    if (lower.some((needle) => n.includes(needle))) return join(dir, name);
  }
  return;
}

function ingestIcd10cm(w: DbWriter, dir: string, fy: string): boolean {
  const file = findFile(dir, 'icd10cm-order', 'icd10cm_order');
  if (!file) return false;
  const rows = parseIcd10cmOrder(readFileSync(file, 'utf-8'));
  w.begin();
  for (const r of rows) w.addCode(r);
  // No addenda overlay: the published FY order file already incorporates the
  // mid-year (Apr 1) addenda — verified for FY2026, where all 630 addenda "Add"
  // codes are present in the base file and none are net-new. The separate
  // `icd10cm-order-addenda-*.txt` is an informational change list with its own
  // layout (Add/Delete/Revise actions, code at a different column) and trailing
  // summary lines; re-parsing it with the order-file parser produced garbage
  // codes that collided on the primary key. The base file is authoritative.
  w.commit();
  w.writeMeta({
    system: 'ICD10CM',
    releaseId: `ICD-10-CM FY${fy}`,
    effectiveStart: `${Number(fy) - 1}-10-01`,
    effectiveEnd: `${fy}-09-30`,
    codeCount: w.countFor('ICD10CM'),
    sourceUrl: 'https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM/',
  });
  console.log(`  ICD-10-CM: ${w.countFor('ICD10CM')} codes`);
  return true;
}

function ingestIcd10pcs(w: DbWriter, dir: string, fy: string): boolean {
  const file = findFile(dir, 'icd10pcs_order', 'icd10pcs-order');
  if (!file) return false;
  const rows = parseIcd10pcsOrder(readFileSync(file, 'utf-8'));
  w.begin();
  for (const r of rows) w.addCode(r);
  // pcs_axes: the position-1 Section axis from the tabular XML (when present).
  // Only position 1 is baked — positions 2-7 are context-dependent (see
  // parseIcd10pcsAxes); browse surfaces Sections at the top level and a notice
  // for deeper positions rather than storing wrong per-position meanings.
  const tablesXml = findFile(dir, 'icd10pcs_tables', 'icd10pcs-tables');
  let axisCount = 0;
  if (tablesXml) {
    for (const ax of parseIcd10pcsAxes(readFileSync(tablesXml, 'utf-8'))) {
      w.addPcsAxis(ax.position, ax.value, ax.meaning);
      axisCount++;
    }
  }
  w.commit();
  w.writeMeta({
    system: 'ICD10PCS',
    releaseId: `ICD-10-PCS FY${fy}`,
    effectiveStart: `${Number(fy) - 1}-10-01`,
    effectiveEnd: `${fy}-09-30`,
    codeCount: w.countFor('ICD10PCS'),
    sourceUrl: 'https://www.cms.gov/medicare/coding-billing/icd-10-codes',
  });
  console.log(
    `  ICD-10-PCS: ${w.countFor('ICD10PCS')} codes, ${axisCount} section-axis values` +
      (tablesXml ? '' : ' (no tabular XML found — pcs_axes empty)'),
  );
  return true;
}

function ingestHcpcs(w: DbWriter, dir: string, year: string): boolean {
  const file = findFile(dir, 'anweb');
  if (!file) return false;
  const rows = parseHcpcsAnweb(readFileSync(file, 'utf-8'));
  w.begin();
  for (const r of rows) w.addCode(r);
  // Materialize the single-letter range buckets (e.g. J0120 → bucket "J") as
  // browsable category headers. The ANWEB file carries no row for the buckets,
  // so without these the HCPCS hierarchy top level is unreachable — see
  // `hcpcsSectionRows`. Seeded from the first letters actually present.
  for (const b of hcpcsSectionRows(rows.map((r) => r.code.charAt(0)))) w.addCode(b);
  w.commit();
  w.writeMeta({
    system: 'HCPCS',
    releaseId: `HCPCS ${year}`,
    effectiveStart: `${year}-01-01`,
    effectiveEnd: `${year}-12-31`,
    codeCount: w.countFor('HCPCS'),
    sourceUrl: 'https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system',
  });
  console.log(`  HCPCS: ${w.countFor('HCPCS')} codes`);
  return true;
}

function ingestRxNorm(w: DbWriter, dir: string): boolean {
  const conso = findFile(dir, 'rxnconso');
  const sat = findFile(dir, 'rxnsat');
  const rel = findFile(dir, 'rxnrel');
  if (!conso || !sat || !rel) return false;
  const parsed = parseRxNorm({
    rxnconso: readFileSync(conso, 'utf-8'),
    rxnsat: readFileSync(sat, 'utf-8'),
    rxnrel: readFileSync(rel, 'utf-8'),
  });
  w.begin();
  for (const r of parsed.codes) w.addCode(r);
  for (const e of parsed.rels) w.addRxNormRel(e.rxcui, e.rel, e.target, e.targetType);
  for (const n of parsed.ndcs) w.addNdc(n.ndc, n.rxcui);
  w.commit();
  w.writeMeta({
    system: 'RXNORM',
    releaseId: 'RxNorm Prescribable Content',
    effectiveStart: null,
    effectiveEnd: null,
    codeCount: w.countFor('RXNORM'),
    sourceUrl: 'https://www.nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html',
  });
  console.log(
    `  RxNorm: ${w.countFor('RXNORM')} concepts, ${parsed.rels.length} edges, ${parsed.ndcs.length} NDC maps`,
  );
  return true;
}

function main(): void {
  const fromDir = arg('--from-dir');
  const fy = arg('--fy') ?? '2026';
  const year = arg('--year') ?? fy;
  const outPath = arg('--out') ?? join(ROOT, 'data', 'medical-codes.db');

  if (!fromDir) {
    console.error(
      'Usage: bun run scripts/build-index.ts --from-dir <dir-with-source-files> [--fy 2026] [--out data/medical-codes.db]\n' +
        'This script never downloads — extract the federal source files into <dir> first (URLs in the file header).\n' +
        'For tests / local smoke, run scripts/build-fixture-db.ts instead.',
    );
    process.exit(2);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  if (existsSync(outPath)) unlinkSync(outPath);

  console.log(`Building index from ${fromDir} → ${outPath}`);
  const w = createDbWriter(outPath);

  const built = {
    icd10cm: ingestIcd10cm(w, fromDir, fy),
    icd10pcs: ingestIcd10pcs(w, fromDir, fy),
    hcpcs: ingestHcpcs(w, fromDir, year),
    rxnorm: ingestRxNorm(w, fromDir), // phase 2 — only if RRF files are present
  };

  w.finalize();

  const any = Object.values(built).some(Boolean);
  if (!any) {
    console.error(
      `No recognized source files found in ${fromDir}. Expected at least one of: ` +
        'icd10cm-order-*.txt, icd10pcs_order_*.txt, *ANWEB.txt, RXNCONSO.RRF.',
    );
    process.exit(1);
  }
  console.log('Index build complete.', built);
}

main();
