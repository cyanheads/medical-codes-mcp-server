/**
 * @fileoverview The RxClass class layer the test fixture carries, and the fixture
 * variant built without it. Read straight from the SQLite files so the shape the
 * tool suites build on — which edges sit on ingredients, which on products, which
 * classes have no direct member — is pinned independently of the service.
 * @module tests/scripts/fixture-class-layer.test
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RXCLASS_TABLES } from '@/services/code-index/schema.js';
import { ensureFixtureWithoutClassLayer, ensureIndex } from '../helpers/index-fixture.js';

let db: Database;

beforeAll(async () => {
  db = new Database((await ensureIndex()).dbPath, { readonly: true });
});

afterAll(() => db.close());

function tables(handle: Database): string[] {
  return (
    handle.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

describe('fixture class layer', () => {
  it('keys every edge on a bundled RXCUI and a known class node', () => {
    expect(
      db
        .query(
          `SELECT COUNT(*) AS n FROM rxclass_edge e
           LEFT JOIN codes c ON c.system = 'RXNORM' AND c.code = e.rxcui
           LEFT JOIN rxclass_class k ON k.class_type = e.class_type AND k.class_id = e.class_id
           WHERE c.code IS NULL OR k.class_id IS NULL`,
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it('lets a product reach its ingredient’s classes through has_ingredient', () => {
    const rows = db
      .query(
        `SELECT e.class_type, e.class_id, e.source, e.relation, r.target AS via
           FROM rxnorm_rel r JOIN rxclass_edge e ON e.rxcui = r.target
          WHERE r.rxcui = ? AND r.rel = 'has_ingredient'
          ORDER BY e.class_type, e.class_id, e.relation`,
      )
      .all('1049640');
    expect(rows).toEqual([
      {
        class_type: 'EPC',
        class_id: 'N0000175578',
        source: 'FDASPL',
        relation: 'has_epc',
        via: '1191',
      },
      {
        class_type: 'EPC',
        class_id: 'N0000175722',
        source: 'FDASPL',
        relation: 'has_epc',
        via: '1191',
      },
      {
        class_type: 'MOA',
        class_id: 'N0000000160',
        source: 'MEDRT',
        relation: 'has_moa',
        via: '1191',
      },
      {
        class_type: 'PE',
        class_id: 'N0000008836',
        source: 'MEDRT',
        relation: 'has_pe',
        via: '1191',
      },
    ]);
    expect(db.query('SELECT class_id FROM rxclass_edge WHERE rxcui = ?').all('198440')).toEqual([
      { class_id: 'CN103' },
    ]);
  });

  it('carries an RXCUI with no edges and classes with no direct member', () => {
    expect(
      db.query("SELECT code FROM codes WHERE system = 'RXNORM' AND code = '202433'").get(),
    ).toEqual({
      code: '202433',
    });
    expect(
      db.query('SELECT COUNT(*) AS n FROM rxclass_edge WHERE rxcui = ?').get('202433'),
    ).toEqual({ n: 0 });
    const memberless = db
      .query(
        `SELECT k.class_id FROM rxclass_class k
          WHERE NOT EXISTS (SELECT 1 FROM rxclass_edge e WHERE e.class_type = k.class_type AND e.class_id = k.class_id)
          ORDER BY k.class_id`,
      )
      .all();
    expect(memberless).toEqual([
      { class_id: 'CN100' },
      { class_id: 'N0000193873' },
      { class_id: 'SCHEDULE2' },
    ]);
  });

  it('records every bundled source with its version, null where RxClass publishes none', () => {
    expect(
      db
        .query(
          'SELECT source, version, class_count, edge_count FROM rxclass_source ORDER BY source',
        )
        .all(),
    ).toEqual([
      { source: 'CDC', version: null, class_count: 0, edge_count: 0 },
      { source: 'FDASPL', version: 'MEDRT 2026.07.06', class_count: 2, edge_count: 2 },
      { source: 'FMTSME', version: 'MEDRT 2026.07.06', class_count: 0, edge_count: 0 },
      { source: 'MEDRT', version: '2026.07.06', class_count: 6, edge_count: 8 },
      { source: 'RXNORM', version: '08-Sep-2026', class_count: 0, edge_count: 0 },
      { source: 'VA', version: '2026_07_31', class_count: 1, edge_count: 1 },
    ]);
  });
});

describe('fixture without the class layer', () => {
  it('has the same code rows and none of the class tables', () => {
    const bare = new Database(ensureFixtureWithoutClassLayer(), { readonly: true });
    try {
      const present = tables(bare);
      for (const table of RXCLASS_TABLES) expect(present).not.toContain(table);
      expect(tables(db)).toEqual(expect.arrayContaining([...RXCLASS_TABLES]));
      const count = (h: Database) => h.query('SELECT COUNT(*) AS n FROM codes').get();
      expect(count(bare)).toEqual(count(db));
      expect(bare.query('PRAGMA freelist_count').get()).toEqual({ freelist_count: 0 });
    } finally {
      bare.close();
    }
  });
});
