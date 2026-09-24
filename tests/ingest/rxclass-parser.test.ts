/**
 * @fileoverview `parseRxClass` over real RxClass responses captured on
 * 2026-09-24 and trimmed to a handful of items each (`tests/fixtures/rxclass/`):
 *
 *  - `byrxcui-6809.json` — metformin (`IN`): its own edges from bundled and
 *    excluded sources, its `PIN` 235743's MEDRT edges, and the product 861007's
 *    VA and ATCPROD edges (an ingredient query reaches its products).
 *  - `byrxcui-861007.json` — the metformin 500 MG tablet (`SCD`): the same
 *    ingredient edges again, plus its own VA and ATCPROD edges.
 *  - `byrxcui-161.json` — acetaminophen: a CSA schedule edge and a VA extended
 *    edge on two products.
 *  - `byrxcui-89717.json` — thymol iodide: its only edge sits on an `SCDF`, a term
 *    type the index does not bundle.
 *  - `byrxcui-1801150.json` — an ingredient RxClass answers with `{}`.
 *  - `classes.json` / `versions.json` — `allClasses` and `version/<SRC>` snapshots
 *    in the fetcher's cache shape.
 * @module tests/ingest/rxclass-parser.test
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  parseRxClass,
  type RxClassParseInput,
  type RxClassResponseRecord,
  type RxClassSnapshot,
} from '../../scripts/ingest/parsers.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'rxclass');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf-8')) as T;
}

function record(rxcui: string): RxClassResponseRecord {
  return { rxcui, status: 200, body: fixture(`byrxcui-${rxcui}.json`) };
}

/** The bundled concepts the metformin captures touch (IN, PIN, SCD). */
const METFORMIN = new Set(['6809', '235743', '861007']);

function input(overrides: Partial<RxClassParseInput> = {}): RxClassParseInput {
  return {
    bundled: METFORMIN,
    queried: ['6809'],
    byRxcui: [record('6809'), record('861007')],
    classes: fixture<RxClassSnapshot>('classes.json'),
    versions: fixture<RxClassSnapshot>('versions.json'),
    fetchedAt: '2026-09-24T18:49:34.413Z',
    ...overrides,
  };
}

describe('parseRxClass — edges', () => {
  it('keys each edge on its own member, keeping only the bundled sources', () => {
    const { edges } = parseRxClass(input());
    expect(edges).toEqual(
      expect.arrayContaining([
        {
          rxcui: '6809',
          classType: 'EPC',
          classId: 'N0000175565',
          source: 'FDASPL',
          relation: 'has_epc',
        },
        {
          rxcui: '235743',
          classType: 'DISEASE',
          classId: 'D003924',
          source: 'MEDRT',
          relation: 'may_treat',
        },
        {
          rxcui: '861007',
          classType: 'VA',
          classId: 'HS502',
          source: 'VA',
          relation: 'has_vaclass',
        },
      ]),
    );
    expect(new Set(edges.map((e) => e.source))).toEqual(new Set(['FDASPL', 'MEDRT', 'VA']));
  });

  it('drops ATC, ATCPROD, SNOMEDCT, and DAILYMED edges', () => {
    const { edges, dropped } = parseRxClass(input());
    // 6809's response: SNOMEDCT, ATC, 2× DAILYMED, ATCPROD; 861007's: ATCPROD.
    expect(dropped.excludedSource).toBe(6);
    for (const excluded of ['ATC', 'ATCPROD', 'SNOMEDCT', 'DAILYMED']) {
      expect(edges.some((e) => (e.source as string) === excluded)).toBe(false);
    }
    expect(edges.some((e) => (e.classType as string) === 'ATC1-4')).toBe(false);
  });

  it('dedupes a class × source × relation edge repeated across responses', () => {
    const { edges, dropped } = parseRxClass(input());
    // 861007's response repeats 6809's has_epc and may_treat edges and its own VA edge.
    expect(dropped.duplicate).toBe(3);
    expect(edges).toHaveLength(9);
    const keys = edges.map(
      (e) => `${e.rxcui}|${e.classType}|${e.classId}|${e.source}|${e.relation}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the same class under different relations as separate edges', () => {
    const { edges } = parseRxClass(input());
    const acidosisOrDiabetes = edges.filter((e) => e.rxcui === '6809' && e.source === 'MEDRT');
    expect(acidosisOrDiabetes.map((e) => `${e.classId}:${e.relation}`).sort()).toEqual([
      'D000138:ci_with',
      'D003924:may_treat',
      'D004342:ci_with',
    ]);
  });

  it('drops an edge whose member is not a bundled RXCUI', () => {
    const { edges, dropped } = parseRxClass(
      input({ bundled: new Set(['89717']), queried: ['89717'], byRxcui: [record('89717')] }),
    );
    expect(edges).toEqual([]);
    expect(dropped.unbundledRxcui).toBe(1);
  });

  it('lowercases the relation to RxClass’s own rela vocabulary', () => {
    const { edges } = parseRxClass(
      input({
        bundled: new Set(['1014599', '1038779']),
        queried: ['161'],
        byRxcui: [record('161')],
      }),
    );
    expect(edges).toEqual([
      {
        rxcui: '1014599',
        classType: 'SCHEDULE',
        classId: 'SCHEDULE2',
        source: 'RXNORM',
        relation: 'has_schedule',
      },
      {
        rxcui: '1038779',
        classType: 'VA',
        classId: 'CN103',
        source: 'VA',
        relation: 'has_vaclass_extended',
      },
    ]);
  });

  it('treats an ingredient RxClass answers with {} as one with no classes', () => {
    const result = parseRxClass(
      input({ bundled: new Set(['1801150']), queried: ['1801150'], byRxcui: [record('1801150')] }),
    );
    expect(result.edges).toEqual([]);
    expect(result.dropped).toEqual({ excludedSource: 0, unbundledRxcui: 0, duplicate: 0 });
  });
});

describe('parseRxClass — cache integrity', () => {
  it('refuses a cache holding a failed response', () => {
    expect(() =>
      parseRxClass(
        input({ byRxcui: [record('6809'), { rxcui: '861007', status: 503, body: {} }] }),
      ),
    ).toThrow(/failed response.*861007.*503/);
  });

  it('refuses a cache missing an ingredient it should cover', () => {
    expect(() => parseRxClass(input({ queried: ['6809', '1801150'] }))).toThrow(
      /incomplete: 1 of 2 ingredients.*1801150/,
    );
  });

  it('refuses a snapshot missing a bundled source or class type', () => {
    const versions = fixture<RxClassSnapshot>('versions.json');
    delete versions.responses.CDC;
    expect(() => parseRxClass(input({ versions }))).toThrow(
      /version snapshot has no response for CDC/,
    );

    const classes = fixture<RxClassSnapshot>('classes.json');
    delete classes.responses.CVX;
    expect(() => parseRxClass(input({ classes }))).toThrow(
      /class-node snapshot has no response for CVX/,
    );
  });

  it('refuses a bundled source asserting a class type the layer does not carry', () => {
    // A captured 6809 item with its class type swapped for SNOMED CT's STRUCT: no
    // bundled source asserts one today, and the build must stop if one starts to.
    const body = fixture<{
      rxclassDrugInfoList: { rxclassDrugInfo: { rxclassMinConceptItem: { classType: string } }[] };
    }>('byrxcui-6809.json');
    const fdaspl = body.rxclassDrugInfoList.rxclassDrugInfo.find(
      (i) => (i as { relaSource?: string }).relaSource === 'FDASPL',
    );
    if (!fdaspl) throw new Error('fixture lost its FDASPL item');
    fdaspl.rxclassMinConceptItem.classType = 'STRUCT';
    expect(() => parseRxClass(input({ byRxcui: [{ rxcui: '6809', status: 200, body }] }))).toThrow(
      /FDASPL asserts class type STRUCT/,
    );
  });
});

describe('parseRxClass — classes and sources', () => {
  it('carries every class node of the bundled types, memberless hierarchy nodes included', () => {
    const { classes, edges } = parseRxClass(input());
    expect(classes).toContainEqual({
      classType: 'EPC',
      classId: 'N0000193873',
      className: 'Diuretic',
    });
    expect(edges.some((e) => e.classId === 'N0000193873')).toBe(false);
    expect(classes).toHaveLength(16);
  });

  it('adds a class seen only on an edge', () => {
    const classes = fixture<RxClassSnapshot>('classes.json');
    classes.responses.VA = { rxclassMinConceptList: { rxclassMinConcept: [] } };
    const parsed = parseRxClass(input({ classes }));
    expect(parsed.classes).toContainEqual({
      classType: 'VA',
      classId: 'HS502',
      className: 'ORAL HYPOGLYCEMIC AGENTS,ORAL',
    });
  });

  it('records each bundled source’s version and counts, null when RxClass publishes none', () => {
    const { sources } = parseRxClass(input());
    expect(sources.map((s) => s.source)).toEqual([
      'MEDRT',
      'FDASPL',
      'FMTSME',
      'VA',
      'RXNORM',
      'CDC',
    ]);
    expect(sources.find((s) => s.source === 'MEDRT')).toEqual({
      source: 'MEDRT',
      version: '2026.07.06',
      classCount: 3,
      edgeCount: 6,
      // The cache's recorded fetch time, not the version snapshot's own timestamp.
      fetchedAt: '2026-09-24T18:49:34.413Z',
    });
    expect(sources.find((s) => s.source === 'FDASPL')).toMatchObject({
      version: 'MEDRT 2026.07.06',
      classCount: 2,
      edgeCount: 2,
    });
    expect(sources.find((s) => s.source === 'CDC')).toMatchObject({
      version: null,
      classCount: 0,
      edgeCount: 0,
    });
  });
});
