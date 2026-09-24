/**
 * @fileoverview The RxClass class layer and file shape of the shipped index,
 * read straight from `data/medical-codes.db`: only the bundled sources, only
 * bundled RXCUIs, edges attached where RxClass attaches them, per-source
 * provenance, and a compacted file (no free pages).
 * @module tests/integration/bundled-class-layer.test
 */

import { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RXCLASS_CLASS_TYPES, RXCLASS_SOURCES } from '@/services/code-index/types.js';

const INDEX_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'medical-codes.db',
);

let db: Database;

beforeAll(() => {
  db = new Database(INDEX_PATH, { readonly: true });
});

afterAll(() => db.close());

function edges(rxcui: string) {
  return db
    .query('SELECT class_type, class_id, source, relation FROM rxclass_edge WHERE rxcui = ?')
    .all(rxcui) as { class_type: string; class_id: string; source: string; relation: string }[];
}

describe('shipped class layer', () => {
  it('holds only the bundled sources and class types', () => {
    const sources = db.query('SELECT DISTINCT source FROM rxclass_edge').all() as {
      source: string;
    }[];
    expect(sources.map((r) => r.source).sort()).toEqual([...RXCLASS_SOURCES].sort());
    const types = db.query('SELECT DISTINCT class_type FROM rxclass_class').all() as {
      class_type: string;
    }[];
    expect(types.map((r) => r.class_type).sort()).toEqual([...RXCLASS_CLASS_TYPES].sort());
  });

  it('keys every edge on a bundled RXCUI and a known class node', () => {
    expect(
      db
        .query(
          `SELECT COUNT(*) AS n FROM rxclass_edge e
            WHERE NOT EXISTS (SELECT 1 FROM codes c WHERE c.system = 'RXNORM' AND c.code = e.rxcui)
               OR NOT EXISTS (SELECT 1 FROM rxclass_class k
                               WHERE k.class_type = e.class_type AND k.class_id = e.class_id)`,
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it('stores relations in RxClass’s lowercase rela vocabulary', () => {
    expect(
      db.query('SELECT COUNT(*) AS n FROM rxclass_edge WHERE relation <> lower(relation)').get(),
    ).toEqual({ n: 0 });
  });

  it('attaches FDA classes to the ingredient and VA classes to the product', () => {
    expect(edges('6809')).toContainEqual({
      class_type: 'EPC',
      class_id: 'N0000175565',
      source: 'FDASPL',
      relation: 'has_epc',
    });
    expect(edges('6809').some((e) => e.class_type === 'VA' || e.class_type === 'SCHEDULE')).toBe(
      false,
    );
    expect(edges('861007')).toContainEqual({
      class_type: 'VA',
      class_id: 'HS502',
      source: 'VA',
      relation: 'has_vaclass',
    });
    expect(edges('861007').some((e) => e.class_type === 'EPC')).toBe(false);
    // The PIN carries MED-RT edges alongside its IN.
    const pinDisease = edges('235743').filter((e) => e.source === 'MEDRT');
    expect(pinDisease.length).toBeGreaterThan(0);
    for (const e of pinDisease) expect(edges('6809')).toContainEqual(e);
  });

  it('carries a brand name with no edges and a class with no direct member', () => {
    expect(edges('151827')).toEqual([]);
    expect(
      db
        .query("SELECT class_name FROM rxclass_class WHERE class_type = 'EPC' AND class_id = ?")
        .get('N0000193873'),
    ).toEqual({ class_name: 'Diuretic' });
    expect(
      db.query('SELECT COUNT(*) AS n FROM rxclass_edge WHERE class_id = ?').get('N0000193873'),
    ).toEqual({ n: 0 });
  });

  it('holds every direct member RxClass lists for CSA schedule II', () => {
    expect(
      db
        .query(
          "SELECT COUNT(*) AS n FROM rxclass_edge WHERE class_type = 'SCHEDULE' AND class_id = 'SCHEDULE2'",
        )
        .get(),
    ).toEqual({ n: 628 });
  });

  it('records a version and counts for every bundled source', () => {
    const rows = db
      .query('SELECT source, version, class_count, edge_count FROM rxclass_source')
      .all() as {
      source: string;
      version: string | null;
      class_count: number;
      edge_count: number;
    }[];
    expect(rows.map((r) => r.source).sort()).toEqual([...RXCLASS_SOURCES].sort());
    for (const row of rows) {
      expect(row.edge_count).toBeGreaterThan(0);
      expect(row.class_count).toBeGreaterThan(0);
      if (row.source !== 'CDC') expect(row.version).toEqual(expect.any(String));
    }
    expect(rows.find((r) => r.source === 'CDC')?.version).toBeNull();
    const total = db.query('SELECT COUNT(*) AS n FROM rxclass_edge').get() as { n: number };
    expect(rows.reduce((sum, r) => sum + r.edge_count, 0)).toBe(total.n);
  });
});

describe('shipped index file', () => {
  it('carries no free pages', () => {
    expect(db.query('PRAGMA freelist_count').get()).toEqual({ freelist_count: 0 });
  });
});
