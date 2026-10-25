/**
 * @fileoverview `scripts/build-index.ts` end to end over a tiny source directory:
 * an RxNav cache for the metformin family, an RxClass cache built from the
 * captured responses in `tests/fixtures/rxclass/`, and a one-code October-layout
 * HCPCS file. Pins that the snapshot dates the index reports come from the caches
 * (each fetcher's `meta.json`), not from the moment the index is built — so
 * rebuilding from an unchanged cache reports the same dates — and that the HCPCS
 * release comes from the quarterly file name, never from `--fy`.
 * @module tests/scripts/build-index.test
 */

import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RXCLASS_FIXTURES = join(ROOT, 'tests', 'fixtures', 'rxclass');

const RXNAV_FETCHED_AT = '2026-06-22T00:44:15.018Z';
const RXCLASS_FETCHED_AT = '2026-09-24T18:49:34.413Z';

let dir: string;

/** Write the source directory the two builds read. */
function writeSources(): string {
  const sources = join(dir, 'sources');
  const rxnav = join(sources, 'rxnav');
  const rxclass = join(sources, 'rxclass');
  mkdirSync(rxnav, { recursive: true });
  mkdirSync(rxclass, { recursive: true });

  writeFileSync(
    join(rxnav, 'concepts.json'),
    JSON.stringify({
      concepts: [
        { rxcui: '6809', name: 'metformin', tty: 'IN' },
        { rxcui: '235743', name: 'metformin hydrochloride', tty: 'PIN' },
        { rxcui: '861007', name: 'metformin hydrochloride 500 MG Oral Tablet', tty: 'SCD' },
      ],
    }),
  );
  writeFileSync(
    join(rxnav, 'products.jsonl'),
    `${JSON.stringify({
      rxcui: '861007',
      ndcs: [],
      ingredients: [
        { rxcui: '6809', name: 'metformin', tty: 'IN' },
        { rxcui: '235743', name: 'metformin hydrochloride', tty: 'PIN' },
      ],
      brands: [],
    })}\n`,
  );
  writeFileSync(join(rxnav, 'meta.json'), JSON.stringify({ fetchedAt: RXNAV_FETCHED_AT }));

  const byRxcui = JSON.parse(readFileSync(join(RXCLASS_FIXTURES, 'byrxcui-6809.json'), 'utf-8'));
  writeFileSync(
    join(rxclass, 'byrxcui.jsonl'),
    `${JSON.stringify({ rxcui: '6809', status: 200, body: byRxcui })}\n`,
  );
  copyFileSync(join(RXCLASS_FIXTURES, 'classes.json'), join(rxclass, 'classes.json'));
  copyFileSync(join(RXCLASS_FIXTURES, 'versions.json'), join(rxclass, 'versions.json'));
  writeFileSync(join(rxclass, 'meta.json'), JSON.stringify({ fetchedAt: RXCLASS_FETCHED_AT }));

  // An October-layout HCPCS file: right-trimmed rows, CRLF line endings, and the
  // release named only by the file name.
  const primary =
    'E0110001003Crutches, forearm, includes crutches of various materials, adjustable or fixed, Crutch forearm pair';
  writeFileSync(
    join(sources, 'HCPC2026_OCT_ANWEB_09232026.txt'),
    [
      `${primary.padEnd(268)}1986010119960101`,
      'E0110002004pair, complete with tips and handgrips',
      '',
    ].join('\r\n'),
  );
  return sources;
}

/** Build with `--fy 2027` alone — the ICD fiscal year must not relabel HCPCS. */
function build(sources: string, out: string): void {
  execFileSync(
    'bun',
    ['run', 'scripts/build-index.ts', '--from-dir', sources, '--fy', '2027', '--out', out],
    { cwd: ROOT, stdio: 'pipe' },
  );
}

function read<T>(path: string, sql: string): T[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

let first: string;
let second: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'medcode-build-'));
  const sources = writeSources();
  first = join(dir, 'first.db');
  second = join(dir, 'second.db');
  build(sources, first);
  // Two builds whose own clocks differ by at least the timestamp resolution.
  await new Promise((resolve) => setTimeout(resolve, 25));
  build(sources, second);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('build-index snapshot dates', () => {
  it('reports the RxNav fetch time as the RxNorm date, the same on every rebuild', () => {
    const sql = "SELECT built_at FROM build_meta WHERE system = 'RXNORM'";
    expect(read(second, sql)).toEqual(read(first, sql));
    expect(read(first, sql)).toEqual([{ built_at: RXNAV_FETCHED_AT }]);
  });

  it('stamps every class-layer source with the RxClass fetch time and its fetched version', () => {
    const sql = 'SELECT source, version, fetched_at FROM rxclass_source ORDER BY source';
    const rows = read<{ source: string; version: string | null; fetched_at: string }>(first, sql);
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.fetched_at).toBe(RXCLASS_FETCHED_AT);
    expect(rows.find((r) => r.source === 'MEDRT')?.version).toBe('2026.07.06');
    expect(read(second, sql)).toEqual(rows);
  });
});

describe('build-index HCPCS release', () => {
  it('labels the release and its effective dates from the quarterly file name', () => {
    const sql =
      "SELECT release_id, effective_start, effective_end, code_count FROM build_meta WHERE system = 'HCPCS'";
    expect(read(first, sql)).toEqual([
      {
        release_id: 'HCPCS 2026 October',
        effective_start: '2026-10-01',
        effective_end: '2026-12-31',
        code_count: 2, // E0110 plus its letter bucket E
      },
    ]);
  });

  it('keeps the long description a right-trimmed continuation row carries', () => {
    const sql =
      "SELECT short_desc, long_desc, effective FROM codes WHERE system = 'HCPCS' AND code = 'E0110'";
    expect(read(first, sql)).toEqual([
      {
        short_desc: 'Crutch forearm pair',
        long_desc:
          'Crutches, forearm, includes crutches of various materials, adjustable or fixed, pair, complete with tips and handgrips',
        effective: '19860101',
      },
    ]);
  });
});
