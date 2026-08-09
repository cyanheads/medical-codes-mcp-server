/**
 * @fileoverview Deterministic adversarial fuzz coverage for code-shape/NDC
 * parsing, federal-source parsers, and read-only index queries across all four
 * systems. No network or mutable corpus is involved.
 * @module tests/fuzz/code-inputs.fuzz.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import type { CodeIndexService } from '@/services/code-index/code-index-service.js';
import { detectSystems, ndcCandidates } from '@/services/code-index/detect.js';
import type { SystemId } from '@/services/code-index/types.js';
import {
  parseHcpcsAnweb,
  parseIcd10cmOrder,
  parseIcd10pcsAxes,
  parseIcd10pcsOrder,
  parseRxNav,
} from '../../scripts/ingest/parsers.ts';
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
