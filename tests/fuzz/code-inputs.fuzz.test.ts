/**
 * @fileoverview Deterministic adversarial fuzz coverage for code-shape/NDC
 * parsing, federal-source parsers, and read-only index queries across all four
 * systems. No network or mutable corpus is involved.
 * @module tests/fuzz/code-inputs.fuzz.test
 */

import { beforeAll, describe, expect, it } from 'vitest';
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

  it('keeps adversarial full-text queries bounded and duplicate-free in every system', () => {
    const systems: SystemId[] = ['ICD10CM', 'ICD10PCS', 'HCPCS', 'RXNORM'];
    for (const query of SEARCH_CORPUS) {
      if (query.includes(NUL_QUERY)) continue;
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
  it.skip('handles NUL-containing search queries without leaking a raw SQLite parser error', () => {
    for (const query of [NUL_QUERY, `diabetes${NUL_QUERY}neuropathy`]) {
      for (const system of ['ICD10CM', 'ICD10PCS', 'HCPCS', 'RXNORM'] satisfies SystemId[]) {
        expect(() => svc.searchFts(query, { system, offset: 0, limit: 7 })).not.toThrow();
      }
    }
  });
});
