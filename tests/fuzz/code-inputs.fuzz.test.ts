/**
 * @fileoverview Deterministic adversarial fuzz coverage for code-shape/NDC
 * parsing, federal-source parsers, and read-only index queries across all four
 * systems. No network or mutable corpus is involved.
 * @module tests/fuzz/code-inputs.fuzz.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import type { CodeIndexService } from '@/services/code-index/code-index-service.js';
import {
  detectSystems,
  isIcd9cmForm,
  isIcd10cmDisplayForm,
  ndcCandidates,
} from '@/services/code-index/detect.js';
import { storageCode } from '@/services/code-index/schema.js';
import { RXCLASS_CLASS_TYPES, type SystemId } from '@/services/code-index/types.js';
import {
  parseHcpcsAnweb,
  parseIcd10cmOrder,
  parseIcd10pcsAxes,
  parseIcd10pcsOrder,
  parseRxNav,
} from '../../scripts/ingest/parsers.ts';
import { carriesPast64, echoSurfaces } from '../helpers/echo-bound.ts';
import { ensureIndex } from '../helpers/index-fixture.ts';

const NUL_QUERY = '\0';

const MALFORMED_IDENTIFIERS = [
  '',
  ' ',
  '\t\r\n',
  '.',
  '..',
  '!!',
  'E11..9',
  'E1',
  'E11999999',
  '0DTJ4Z',
  '0DTJ4ZZZ',
  '0DTI4ZZ',
  'J012',
  'J01200',
  '123456789',
  '123456789012',
  '12345-6789',
  '12345-6789-001',
  '12-34-56-78',
  '１２３４５６７８９０',
  '💊',
  NUL_QUERY,
  'A'.repeat(2_048),
] as const;

const SEARCH_CORPUS = [
  ...MALFORMED_IDENTIFIERS,
  '" OR 1=1 --',
  "' UNION SELECT * FROM codes --",
  '%',
  '_',
  '\\',
  '() * : ^ -',
  'diabetes\0neuropathy',
  'a  '.repeat(256),
] as const;

/** Sends a raw argument bag as a client would, including values the schema rejects. */
const callWithRawArgs = runToolContract as unknown as (
  tool: unknown,
  args: Record<string, unknown>,
) => ReturnType<typeof runToolContract>;

let svc: CodeIndexService;

beforeAll(async () => {
  svc = await ensureIndex();
});

describe('identifier parser fuzz', () => {
  it('keeps every derived NDC candidate unique, numeric, and exactly 11 digits', () => {
    for (const raw of [...MALFORMED_IDENTIFIERS, ...SEARCH_CORPUS]) {
      const parsed = ndcCandidates(raw);
      expect(new Set(parsed.candidates).size).toBe(parsed.candidates.length);
      for (const candidate of parsed.candidates) expect(candidate).toMatch(/^\d{11}$/);
    }
  });

  it('never throws while classifying malformed, truncated, or over-long identifiers', () => {
    for (const raw of MALFORMED_IDENTIFIERS) {
      expect(() => detectSystems(raw)).not.toThrow();
      expect(() => ndcCandidates(raw)).not.toThrow();
    }
  });

  it.each([
    ['ICD10CM', ' e11.9 ', 'E119'],
    ['ICD10PCS', ' 0dtj4zz ', '0DTJ4ZZ'],
    ['HCPCS', ' j0120 ', 'J0120'],
    ['RXNORM', ' 161 ', '161'],
  ] satisfies [SystemId, string, string][])(
    'normalizes wrong-case and padding for %s',
    (system, raw, storage) => {
      const result = svc.getByCode(raw, system);
      expect(result.kind).toBe('found');
      if (result.kind === 'found') {
        expect(result.row.system).toBe(system);
        expect(result.row.code).toBe(storage);
      }
    },
  );
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/61
describe('a dot in the input', () => {
  /** Fixture codes of every system, header rows included, plus shaped values none holds. */
  const CODES = [
    ...['A00', 'A000', 'A01', 'A010', 'A0100', 'B00', 'E11', 'E119', 'E1140', 'I10'],
    ...['0DTJ4ZZ', '0DTJ0ZZ', '02703DZ', '027', 'J0120', 'E0110', 'A4206', 'K0552', 'J', 'A'],
    ...['161', '198440', '1049640', 'R9999', 'A019999', '1049631', 'ZZZ9999', 'E1199'],
  ];
  /** Every single-dot spelling of each code, as typed and in lower case with padding. */
  const SPELLINGS = CODES.flatMap((code) =>
    Array.from({ length: code.length + 1 }, (_, i) => `${code.slice(0, i)}.${code.slice(i)}`),
  ).flatMap((dotted) => [dotted, ` ${dotted.toLowerCase()} `]);

  it('moves a resolution only to ICD-10-CM in display form, or to nothing in ICD-9-CM form', () => {
    let moved = 0;
    let rxcuiRuledOut = 0;
    let rxcuiAtAnEnd = 0;
    let icd9RuledOut = 0;
    for (const raw of SPELLINGS) {
      // The same characters undotted are what the dot-blind resolution answers.
      const base = svc.getByCode(storageCode(raw));
      const got = svc.getByCode(raw);
      const checked = svc.checkCode(raw);
      const checkedBase = svc.checkCode(storageCode(raw));
      // https://github.com/cyanheads/medical-codes-mcp-server/issues/69 — RxNorm is
      // dot-blind only at the ends: a dot between two digits is no RXCUI's spelling.
      if (base.kind === 'found' && base.row.system === 'RXNORM') {
        if (/[0-9]\.[0-9]/.test(raw)) {
          rxcuiRuledOut += 1;
          expect(got, raw).toEqual({ kind: 'not_found' });
          expect(checked.kind === 'resolved' && checked.result.status, raw).toBe('unknown');
          continue;
        }
        rxcuiAtAnEnd += 1;
      }
      // https://github.com/cyanheads/medical-codes-mcp-server/issues/71 and #74 — a value
      // in ICD-9-CM form is that system's spelling, which no bundled system holds.
      if (isIcd9cmForm(raw)) {
        if (base.kind !== 'not_found') icd9RuledOut += 1;
        expect(got, raw).toEqual({ kind: 'not_found' });
        expect(checked.kind === 'resolved' && checked.result.status, raw).toBe('unknown');
        continue;
      }
      if (
        isIcd10cmDisplayForm(raw) &&
        base.kind === 'ambiguous' &&
        base.systems.includes('ICD10CM')
      ) {
        moved += 1;
        const others = base.systems.filter((sys) => sys !== 'ICD10CM');
        expect(got.kind === 'found' && got.row.system, raw).toBe('ICD10CM');
        expect(got.kind === 'found' && got.alsoIn, raw).toEqual(others);
        expect(checked.kind === 'resolved' && checked.result.system, raw).toBe('ICD10CM');
        expect(checked.kind === 'resolved' && checked.result.alsoIn, raw).toEqual(others);
        continue;
      }
      expect(got, raw).toEqual(base);
      expect(checked.kind, raw).toBe(checkedBase.kind);
      if (checked.kind === 'resolved' && checkedBase.kind === 'resolved') {
        expect(checked.result.system, raw).toBe(checkedBase.result.system);
        expect(checked.result.status, raw).toBe(checkedBase.result.status);
      }
    }
    // A01.00 as typed and padded: the fixture's one ICD-10-CM / HCPCS collision.
    expect(moved).toBe(2);
    // 161, 198440, and 1049640, as typed and padded: 2 + 5 + 6 interior positions,
    // and a leading and a trailing dot each, which still resolve as the undotted RXCUI.
    expect(rxcuiRuledOut).toBe(26);
    expect(rxcuiAtAnEnd).toBe(12);
    // E011.0 over HCPCS E0110 and 02.7 over the ICD-10-PCS table row 027, as typed
    // and padded; E114.0 and E119.9 sit outside the external-cause stems and stay.
    expect(icd9RuledOut).toBe(4);
  });
});

describe('federal-source parser fuzz', () => {
  it('handles arbitrary line-oriented and XML-shaped garbage without crashing', () => {
    for (const raw of SEARCH_CORPUS) {
      expect(parseIcd10cmOrder(raw)).toBeInstanceOf(Array);
      expect(parseIcd10pcsOrder(raw)).toBeInstanceOf(Array);
      expect(parseHcpcsAnweb(raw, '20260802')).toBeInstanceOf(Array);
      expect(parseIcd10pcsAxes(raw)).toBeInstanceOf(Array);
    }
  });

  it('handles malformed RxNav concepts, edges, and NDC strings without crashing', () => {
    for (const raw of MALFORMED_IDENTIFIERS) {
      const result = parseRxNav(
        [{ rxcui: raw, name: raw, tty: raw }],
        [
          {
            rxcui: raw,
            ndcs: [raw],
            ingredients: [{ rxcui: raw, name: raw, tty: raw }],
            brands: [{ rxcui: raw, name: raw, tty: raw }],
          },
        ],
      );
      expect(result.codes).toBeInstanceOf(Array);
      expect(result.ndcs).toBeInstanceOf(Array);
      expect(result.rels).toBeInstanceOf(Array);
    }
  });
});

describe('index query fuzz', () => {
  it('returns discriminated outcomes for adversarial identifiers across every system', () => {
    const systems: SystemId[] = ['ICD10CM', 'ICD10PCS', 'HCPCS', 'RXNORM'];
    for (const raw of MALFORMED_IDENTIFIERS) {
      for (const system of systems) {
        expect(() => svc.getByCode(raw, system)).not.toThrow();
        expect(() => svc.checkCode(raw, system)).not.toThrow();
        expect(() => svc.mapCode(raw, 'parents', system, { offset: 0, limit: 7 })).not.toThrow();
        expect(() => svc.browse(system, raw, { offset: 0, limit: 7 })).not.toThrow();
      }
      expect(() => svc.getByNdc(raw)).not.toThrow();
    }
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/34
  it('drives the class directions over malformed identifiers and every class type', () => {
    for (const raw of [...MALFORMED_IDENTIFIERS, ...SEARCH_CORPUS]) {
      for (const direction of ['rxcui_to_classes', 'class_to_rxcuis'] as const) {
        for (const classType of [undefined, ...RXCLASS_CLASS_TYPES]) {
          let page: ReturnType<CodeIndexService['mapCode']>;
          try {
            page = svc.mapCode(raw, direction, undefined, { offset: 0, limit: 7 }, classType);
          } catch (error) {
            throw new Error(`${direction} threw for ${JSON.stringify(raw)} / ${classType}`, {
              cause: error,
            });
          }
          // None of these is a bundled RXCUI or class ID.
          expect(page.kind, `${direction} ${JSON.stringify(raw)}`).toBe('source_not_found');
        }
      }
    }
  });

  it('answers every malformed class-direction call with a declared outcome on both surfaces', async () => {
    const reasons = new Set<string>();
    for (const raw of [...MALFORMED_IDENTIFIERS, ...SEARCH_CORPUS]) {
      for (const direction of ['rxcui_to_classes', 'class_to_rxcuis']) {
        const result = await callWithRawArgs(mapCodesTool, { from: raw, direction });
        expect(result.isError, `${direction} ${JSON.stringify(raw)}`).toBe(true);
        const { error } = result.structuredContent as {
          error: { data?: { reason?: string }; message: string };
        };
        const reason = error.data?.reason ?? '<none>';
        reasons.add(reason);
        // A blank value never reaches the handler; everything else is an unmapped source.
        expect(['no_mapping', 'invalid_arguments']).toContain(reason);
        const text = (result.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
        expect(text).toContain(`(reason ${reason})`);
        expect(text).not.toMatch(/SQLite|SQLITE_|\bat .+\.ts:\d+/);
        if (direction === 'class_to_rxcuis') expect(text).not.toMatch(/CPT/);
      }
    }
    expect([...reasons].sort()).toEqual(['invalid_arguments', 'no_mapping']);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/35
  it('crosswalks an NDC exactly when get_code decodes it as one', () => {
    // The last nine spell the fixture key 11111222233 in a configuration the FDA
    // does not assign; a digit-stripping crosswalk would resolve every one of them.
    const spellings = [
      ...MALFORMED_IDENTIFIERS,
      '11111-2222-33',
      '11111222233',
      ' 0904-5161-60 ',
      '0904516160',
      '11-1112-22233',
      '11111-222233',
      '11111-2222-3-3',
      '11111 2222 33',
      '11111.2222.33',
      '11111*2222*33',
      'NDC 11111-2222-33',
      '11111--2222-33',
      '11111/2222/33',
    ];
    for (const raw of spellings) {
      let mapped: ReturnType<CodeIndexService['mapCode']>;
      try {
        mapped = svc.mapCode(raw, 'ndc_to_rxcui');
      } catch (error) {
        throw new Error(`ndc_to_rxcui threw for ${JSON.stringify(raw)}`, { cause: error });
      }
      const decoded = svc.getByNdc(raw);
      expect(mapped.kind, JSON.stringify(raw)).toBe(
        decoded.kind === 'found' ? 'ok' : 'source_not_found',
      );
      if (mapped.kind === 'ok' && decoded.kind === 'found') {
        expect(mapped.hits.map((hit) => hit.value)).toEqual(decoded.rows.map((row) => row.code));
      }
    }
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/26
  it('never converts an out-of-range page into a claim about the source', () => {
    // Offsets a caller can reach by holding a cursor across an index rebuild, or by
    // hand. Whatever the offset, the outcome must depend only on whether the source
    // maps to anything — never on whether this particular window happened to be empty.
    const sources = [
      ['a', 'name_to_rxcui'],
      ['acetaminophen', 'name_to_rxcui'],
      ['1049640', 'rxcui_to_ndc'],
      ['198440', 'rxcui_to_ndc'],
      ['A00', 'children'],
      ['E11', 'children'],
      ['198440', 'rxcui_to_classes'],
      ['N0000008836', 'class_to_rxcuis'],
    ] as const;

    for (const [from, direction] of sources) {
      const grounded = svc.mapCode(from, direction, undefined, { offset: 0, limit: 200 });
      expect(grounded.kind).toBe('ok');
      for (const offset of [1, 7, 999, 1_000_000, Number.MAX_SAFE_INTEGER]) {
        const page = svc.mapCode(from, direction, undefined, { offset, limit: 3 });
        expect(page.kind).toBe('ok');
        if (page.kind === 'ok') expect(page.hits.length).toBeLessThanOrEqual(3);
      }
    }
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/30
  it('matches every stored chapter regardless of the case the caller sent', async () => {
    const chapters = new Set(
      svc
        .searchFts('a', { limit: 200 })
        .codes.flatMap((code) => (code.chapter ? [code.chapter] : [])),
    );
    expect(chapters.size).toBeGreaterThan(0);

    for (const chapter of chapters) {
      const canonical = svc.searchFts('a', { limit: 200, chapter }).codes;
      for (const spelling of [chapter.toLowerCase(), ` ${chapter.toLowerCase()} `]) {
        const ctx = createMockContext();
        const out = await searchCodesTool.handler(
          searchCodesTool.input.parse({ query: 'a', limit: 200, chapter: spelling }),
          ctx,
        );
        expect(out.codes.map((code) => code.code)).toEqual(canonical.map((code) => code.code));
        // The echo names the filter that ran, so it is the canonical value, not
        // the spelling the caller happened to send.
        expect(getEnrichment(ctx)?.appliedFilters).toMatchObject({ chapter });
      }
    }
  });

  it('keeps adversarial full-text queries bounded and duplicate-free in every system', () => {
    const systems: SystemId[] = ['ICD10CM', 'ICD10PCS', 'HCPCS', 'RXNORM'];
    for (const query of SEARCH_CORPUS) {
      for (const system of systems) {
        let page: ReturnType<CodeIndexService['searchFts']>;
        try {
          page = svc.searchFts(query, { system, offset: 0, limit: 7 });
        } catch (error) {
          throw new Error(`searchFts threw for ${system} query ${JSON.stringify(query)}`, {
            cause: error,
          });
        }
        expect(page.codes.length).toBeLessThanOrEqual(7);
        expect(new Set(page.codes.map((code) => `${code.system}:${code.code}`)).size).toBe(
          page.codes.length,
        );
        expect(typeof page.hasMore).toBe('boolean');
      }
    }
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/25
  it('handles NUL-containing search queries without leaking a raw SQLite parser error', () => {
    for (const query of [NUL_QUERY, `diabetes${NUL_QUERY}neuropathy`]) {
      for (const system of ['ICD10CM', 'ICD10PCS', 'HCPCS', 'RXNORM'] satisfies SystemId[]) {
        expect(() => svc.searchFts(query, { system, offset: 0, limit: 7 })).not.toThrow();
      }
    }
  });

  it('keeps the terms of a NUL-separated query searchable instead of discarding them', async () => {
    // Normalizing (rather than rejecting) is only worth it if the surviving terms
    // still search: the embedded NUL must act as a token separator, so this query
    // resolves to "diabetic" AND "neuropathy" and returns the same rows as the
    // clean spelling — a rejection or a NUL-stripped single token would return none.
    const clean = svc.searchFts('diabetic neuropathy', { offset: 0, limit: 50 }).codes;
    const withNul = svc.searchFts(`diabetic${NUL_QUERY}neuropathy`, {
      offset: 0,
      limit: 50,
    }).codes;
    expect(clean.length).toBeGreaterThan(0);
    expect(withNul.map((code) => code.code)).toEqual(clean.map((code) => code.code));

    // At the tool boundary a NUL-only query is an ordinary empty result with the
    // standard broaden-your-terms notice, not a handler failure.
    const ctx = createMockContext();
    const out = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: NUL_QUERY }),
      ctx,
    );
    expect(out.codes).toEqual([]);
    expect(getEnrichment(ctx)?.notice).toMatch(/broaden/i);
  });
});

describe('RxNorm row invariants', () => {
  /** Queries that reach every fixture RxNorm concept, plus the adversarial corpus. */
  const QUERIES = [...SEARCH_CORPUS, 'a', 'acetaminophen', 'aspirin', 'tylenol', 'tablet'];

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/37
  // https://github.com/cyanheads/medical-codes-mcp-server/issues/42
  it('never gives an RxNorm row a billing verdict or a short description', () => {
    let rxnormRows = 0;
    for (const query of QUERIES) {
      for (const system of [undefined, 'RXNORM'] as const) {
        const { codes } = svc.searchFts(query, { ...(system && { system }), limit: 200 });
        for (const row of codes) {
          if (row.system === 'RXNORM') {
            rxnormRows += 1;
            expect(row.billable).toBeNull();
            expect(row.shortDescription).toBeNull();
            // The term type stays in chapter, where the chapter filter reads it.
            expect(row.chapter).toMatch(/^[A-Z]+$/);
          } else {
            expect(typeof row.billable).toBe('boolean');
          }
        }
      }
    }
    // Guard against a vacuous pass: the loop must actually have seen RxNorm rows.
    expect(rxnormRows).toBeGreaterThan(0);
  });

  it('checks every RxNorm concept as valid, with or without an explicit system', () => {
    const concepts = new Set<string>();
    for (const query of QUERIES) {
      for (const row of svc.searchFts(query, { system: 'RXNORM', limit: 200 }).codes) {
        concepts.add(row.code);
      }
    }
    expect(concepts.size).toBe(5);
    for (const code of concepts) {
      for (const system of [undefined, 'RXNORM'] as const) {
        const r = svc.checkCode(code, system);
        expect(r.kind === 'resolved' && r.result.status).toBe('valid');
        expect(r.kind === 'resolved' && r.result.whyNot).toBeUndefined();
      }
    }
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/43
  // https://github.com/cyanheads/medical-codes-mcp-server/issues/53
  it('names an unresolved value as an NDC exactly when get_code and map_codes read it as one', () => {
    const spellings = [
      ...MALFORMED_IDENTIFIERS,
      '11111-2222-33',
      '11111222233',
      '0904-5161-60',
      '0904516160',
      '00904516160',
      '99999-8888-77',
      '99999888877',
      '9999988887',
      '2-152-1',
      '0002-152-01',
      ' 11111-2222-33 ',
    ];
    let ndcs = 0;
    for (const raw of spellings) {
      const r = svc.checkCode(raw);
      const readsAsNdc = svc.ndcReading(raw) !== null;
      // An NDC is never a code check_code answers, so it must reach the miss branch.
      if (readsAsNdc) {
        ndcs += 1;
        expect(r.kind === 'resolved' && r.result.status, JSON.stringify(raw)).toBe('unknown');
      }
      if (r.kind !== 'resolved' || r.result.status !== 'unknown') continue;
      expect(r.result.ndc === true, `ndc flag for ${JSON.stringify(raw)}`).toBe(readsAsNdc);
      expect(/NDC/.test(r.result.whyNot ?? ''), `NDC wording for ${JSON.stringify(raw)}`).toBe(
        readsAsNdc,
      );
      // A well-formed NDC is never worded as a possible CPT code.
      if (readsAsNdc) expect(r.result.whyNot, JSON.stringify(raw)).not.toMatch(/CPT/);
    }
    // Nine of the spellings are NDCs: six decode to a product, and three are
    // well-formed (hyphenated, bare 11, bare 10 digits) with no match.
    expect(ndcs).toBe(9);
  });
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/75
describe('caller-value echo bound', () => {
  /** Alphabets no fixture code, drug name, or chapter is spelled with, so every value misses. */
  const ALPHABETS = ['qxzjvwk', '😀🧪💊', '漢字検索', 'qx😀z字'];
  /** Lengths in code points, across the bound and well past it. */
  const LENGTHS = [5, 17, 63, 64, 65, 66, 129, 1_000, 4_000];

  /** A seeded stream of picks, so every run fuzzes the same values. */
  let seed = 75;
  const pick = (count: number) => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return (seed >>> 16) % count;
  };
  const draw = (alphabet: string, length: number) => {
    const points = [...alphabet];
    return Array.from({ length }, () => points[pick(points.length)]).join('');
  };
  const pad = ' '.repeat(40);
  /** A value as sent, and padded past the bound. */
  const sentAndPadded = (value: string) => [value, `${pad}${value}${pad}`];
  /**
   * Code-shaped values no bundled system holds, which reach get_code's shaped misses
   * rather than its generic one: a bare integer, an NDC in a valid format nothing maps
   * to (hyphenated, and bare 10 digits), and ICD-9-CM and other dotted forms. Bare 11
   * digits reach the same miss as bare 10, and its reason names their normalized key,
   * which spells the value, so they are left out.
   */
  const SHAPED = [
    '99213',
    '99999-8888-77',
    '9999988887',
    '250.00',
    'E880.9',
    '00.1',
    'Z.Z.9',
    '9.9.9',
  ];
  const VALUES = [
    ...LENGTHS.flatMap((length) => ALPHABETS.map((alphabet) => draw(alphabet, length))),
    // Words with spaces between them, which search matches term by term.
    ...LENGTHS.map((length) => 'qxzjv '.repeat(length).slice(0, length).trim()),
    // Padding past the bound around values at it and just past it.
    ...[63, 64, 65].flatMap((length) => ALPHABETS.map((a) => `${pad}${draw(a, length)}${pad}`)),
    ...SHAPED.flatMap(sentAndPadded),
    // A bare integer and a dotted value at the bound and just past it.
    ...[63, 64, 65].flatMap((length) => [
      ...sentAndPadded('7'.repeat(length)),
      ...sentAndPadded(`Z${'.'.repeat(length - 3)}Z9`),
    ]),
  ];

  /**
   * Each call a caller value reaches, with how a reply spells a value it echoes:
   * as sent, or upper-cased for a chapter. A call that never echoes it has none.
   */
  const CALLS: [
    string,
    unknown,
    (value: string) => Record<string, unknown>,
    ((v: string) => string)?,
  ][] = [
    ['get_code', getCodeTool, (value) => ({ codes: ['A00', value] }), (v) => v],
    ['check_code', checkCodeTool, (value) => ({ code: value }), (v) => v],
    ...[
      'parents',
      'children',
      'name_to_rxcui',
      'ndc_to_rxcui',
      'rxcui_to_ndc',
      'rxcui_to_ingredients',
      'rxcui_to_brands',
      'rxcui_to_classes',
      'class_to_rxcuis',
    ].map((direction): (typeof CALLS)[number] => [
      `map_codes ${direction}`,
      mapCodesTool,
      (value) => ({ from: value, direction }),
      (v) => v,
    ]),
    ...['ICD10CM', 'ICD10PCS', 'HCPCS'].map((system): (typeof CALLS)[number] => [
      `browse_hierarchy ${system}`,
      browseHierarchyTool,
      (value) => ({ system, node: value }),
      (v) => v,
    ]),
    // RxNorm is flat: any node gets the same empty answer, which names no node.
    [
      'browse_hierarchy RXNORM',
      browseHierarchyTool,
      (value) => ({ system: 'RXNORM', node: value }),
    ],
    ['search_codes query', searchCodesTool, (value) => ({ query: value }), (v) => v],
    [
      'search_codes chapter',
      searchCodesTool,
      (value) => ({ query: 'diabetes', chapter: value }),
      (v) => v.toUpperCase(),
    ],
  ];

  /**
   * Codes a bundled system holds, each sent to the get_code call where it misses: a
   * code in two systems with no system named, plain and dotted; a code another system
   * holds, and an NDC a named system keeps from its decode, under ICD10CM; and an
   * ICD-10-PCS section value under ICD10PCS, beside a table row whose rendering spells
   * no section digit.
   */
  const COLLIDING: [string, (value: string) => Record<string, unknown>, string[]][] = [
    ['get_code', (value) => ({ codes: ['A00', value] }), ['A0100', 'A0.100']],
    [
      'get_code under ICD10CM',
      (value) => ({ codes: ['E11.9', value], system: 'ICD10CM' }),
      ['J0120', '11111-2222-33'],
    ],
    ['get_code under ICD10PCS', (value) => ({ codes: ['B00', value], system: 'ICD10PCS' }), ['0']],
  ];

  const PROBES = [
    ...VALUES.flatMap((value) =>
      CALLS.map(([name, tool, args, spell]) => ({ name, tool, args: args(value), spell, value })),
    ),
    ...COLLIDING.flatMap(([name, args, codes]) =>
      codes.flatMap(sentAndPadded).map((value) => ({
        name,
        tool: getCodeTool,
        args: args(value),
        spell: (v: string) => v,
        value,
      })),
    ),
  ];

  /** A letter or digit beside a copy of a value: the copy is part of another token, a code that contains it. */
  const WORD = /[\p{L}\p{N}]/u;

  /**
   * Whether `surface` echoes a value as exactly `echo`: it holds `echo`, and no copy of
   * it runs on into a space or a `…` — the padding an untrimmed echo keeps, or the cut
   * a value inside the bound must not get.
   */
  function echoesExactly(surface: string, echo: string): boolean {
    let echoed = false;
    for (let at = surface.indexOf(echo); at !== -1; at = surface.indexOf(echo, at + 1)) {
      const before = surface[at - 1] ?? '';
      const after = surface[at + echo.length] ?? '';
      if (WORD.test(before) || WORD.test(after)) continue;
      if (before === ' ' || after === ' ' || after === '…') return false;
      echoed = true;
    }
    return echoed;
  }

  it('carries no run of a caller value past 64 characters, and a value of 64 or fewer as the rule echoes it', async () => {
    const violations: string[] = [];
    for (const { name, tool, args, spell, value } of PROBES) {
      const trimmed = value.trim();
      const result = await callWithRawArgs(tool, args);
      const { text, json } = echoSurfaces(
        (result.structuredContent ?? {}) as Record<string, unknown>,
        (result.content as { text?: string }[]).map((block) => block.text ?? '').join(''),
      );
      const surfaces = [text, json];
      const label = `${name}, ${[...value].length} characters (${[...trimmed].slice(0, 8).join('')}…)`;
      if ([...trimmed].length > 64) {
        const spelled = spell?.(value) ?? value;
        if (surfaces.some((s) => carriesPast64(s, value) || carriesPast64(s, spelled))) {
          violations.push(`${label}: carries more than 64 characters of the value`);
        }
      } else if (spell) {
        // As sent at 64 characters or fewer, else trimmed.
        const echo = spell([...value].length <= 64 ? value : trimmed);
        if (!surfaces.every((s) => echoesExactly(s, echo))) {
          violations.push(`${label}: does not echo the value as ${JSON.stringify(echo)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
