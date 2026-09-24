/**
 * @fileoverview The shared index writer (`scripts/_db-writer.ts`) that both the
 * real build and the test fixture go through: what each insert method lands in
 * which table, the FTS mirror of every code row, the `build_meta` provenance row,
 * and what `finalize()` leaves on disk. Exercised against a real `bun:sqlite` file
 * in a temp directory and read back with a fresh read-only handle.
 * @module tests/scripts/db-writer.test
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { type CodeInput, createDbWriter } from '../../scripts/_db-writer.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'medcode-writer-'));
  dirs.push(dir);
  return join(dir, 'index.db');
}

function cmCode(code: string, desc: string): CodeInput {
  return {
    system: 'ICD10CM',
    code,
    shortDesc: desc,
    longDesc: `${desc} (long)`,
    billable: true,
    header: false,
    chapter: code.charAt(0),
    parent: code.length > 3 ? code.slice(0, -1) : null,
    effective: null,
    terminated: null,
  };
}

/** Write codes in several committed batches, the way `build-index.ts` streams each system. */
function writeBatches(path: string, batches: number, perBatch: number): void {
  const w = createDbWriter(path);
  for (let b = 0; b < batches; b++) {
    w.begin();
    for (let i = 0; i < perBatch; i++) {
      w.addCode(cmCode(`A${b}${String(i).padStart(3, '0')}`, `condition ${b} ${i} fever pain`));
    }
    w.commit();
  }
  w.writeMeta({
    system: 'ICD10CM',
    releaseId: 'test',
    effectiveStart: null,
    effectiveEnd: null,
    codeCount: w.countFor('ICD10CM'),
    sourceUrl: null,
  });
  w.finalize();
}

describe('DbWriter', () => {
  it('lands every row type in its table and mirrors codes into FTS', () => {
    const path = tempDbPath();
    const w = createDbWriter(path);
    w.begin();
    w.addCode(cmCode('E119', 'Type 2 diabetes mellitus without complications'));
    w.addCode({
      system: 'RXNORM',
      code: '198440',
      shortDesc: 'SCD',
      longDesc: 'Acetaminophen 500 MG Oral Tablet',
      billable: false,
      header: false,
      chapter: 'SCD',
      parent: null,
      effective: null,
      terminated: null,
    });
    w.addPcsAxis(1, '0', 'Medical and Surgical');
    w.addPcsAxis(1, '0', 'duplicate ignored');
    w.addRxNormRel('198440', 'has_ingredient', '161', 'IN');
    w.addNdc('11111222233', '198440');
    w.commit();
    expect(w.countFor('ICD10CM')).toBe(1);
    expect(w.countFor('RXNORM')).toBe(1);
    expect(w.countFor('HCPCS')).toBe(0);
    w.writeMeta({
      system: 'ICD10CM',
      releaseId: 'ICD-10-CM FY2026',
      effectiveStart: '2025-10-01',
      effectiveEnd: '2026-09-30',
      codeCount: 1,
      sourceUrl: 'https://example.gov/',
    });
    w.finalize();

    const db = new Database(path, { readonly: true });
    try {
      expect(db.query('SELECT * FROM codes WHERE code = ?').get('E119')).toEqual({
        system: 'ICD10CM',
        code: 'E119',
        short_desc: 'Type 2 diabetes mellitus without complications',
        long_desc: 'Type 2 diabetes mellitus without complications (long)',
        billable: 1,
        header: 0,
        chapter: 'E',
        parent: 'E11',
        effective: null,
        terminated: null,
      });
      expect(
        db.query("SELECT system, code FROM codes_fts WHERE codes_fts MATCH 'acetaminophen'").all(),
      ).toEqual([{ system: 'RXNORM', code: '198440' }]);
      expect(db.query('SELECT * FROM pcs_axes').all()).toEqual([
        { position: 1, value: '0', meaning: 'Medical and Surgical' },
      ]);
      expect(db.query('SELECT * FROM rxnorm_rel').all()).toEqual([
        { rxcui: '198440', rel: 'has_ingredient', target: '161', target_type: 'IN' },
      ]);
      expect(db.query('SELECT * FROM ndc_map').all()).toEqual([
        { ndc: '11111222233', rxcui: '198440' },
      ]);
      const meta = db.query('SELECT * FROM build_meta').all() as Record<string, unknown>[];
      expect(meta).toEqual([
        {
          system: 'ICD10CM',
          release_id: 'ICD-10-CM FY2026',
          effective_start: '2025-10-01',
          effective_end: '2026-09-30',
          code_count: 1,
          source_url: 'https://example.gov/',
          built_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('writes a single-file artifact with no journal sidecars', () => {
    const path = tempDbPath();
    writeBatches(path, 2, 10);
    expect(readdirSync(dirname(path))).toEqual(['index.db']);
  });

  it('leaves no free pages behind after finalize()', () => {
    const path = tempDbPath();
    writeBatches(path, 4, 250);
    const db = new Database(path, { readonly: true });
    try {
      expect(db.query('PRAGMA freelist_count').get()).toEqual({ freelist_count: 0 });
      expect(db.query('SELECT COUNT(*) AS n FROM codes').get()).toEqual({ n: 1000 });
      expect(
        db.query("SELECT COUNT(*) AS n FROM codes_fts WHERE codes_fts MATCH 'fever'").get(),
      ).toEqual({ n: 1000 });
    } finally {
      db.close();
    }
  });
});
