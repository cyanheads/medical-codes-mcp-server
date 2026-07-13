/**
 * @fileoverview Behavior tests for the code-index service against the bundled
 * fixture DB: code-shape detection, decode with membership-based
 * disambiguation, FTS search, the validity-vs-existence split, hierarchy
 * crosswalk, browse, and provenance.
 * @module tests/services/code-index-service.test
 */

import { beforeAll, describe, expect, it } from 'vitest';

import type { CodeIndexService } from '@/services/code-index/code-index-service.js';
import { escapeLike, toFtsMatch } from '@/services/code-index/code-index-service.js';
import { ndcCandidates } from '@/services/code-index/detect.js';
import { ensureIndex } from '../helpers/index-fixture.ts';

let svc: CodeIndexService;
beforeAll(async () => {
  svc = await ensureIndex();
});

describe('detectSystem', () => {
  it('detects ICD-10-CM shape (dotted and dot-free)', () => {
    expect(svc.detectSystem('E11.9')).toEqual(['ICD10CM']);
    expect(svc.detectSystem('E119')).toEqual(['ICD10CM']);
  });
  it('detects ICD-10-PCS by 7-char shape', () => {
    expect(svc.detectSystem('0DTJ4ZZ')).toContain('ICD10PCS');
  });
  it('returns multiple candidates for a letter+4-digit shape (CM and HCPCS)', () => {
    expect(svc.detectSystem('J0120')).toEqual(['ICD10CM', 'HCPCS']);
  });
  it('returns empty for an unrecognizable shape', () => {
    expect(svc.detectSystem('!!')).toEqual([]);
  });
});

describe('getByCode', () => {
  it('decodes a dotted ICD-10-CM code to storage form', () => {
    const r = svc.getByCode('E11.9');
    expect(r.kind).toBe('found');
    if (r.kind === 'found')
      expect(r.row).toMatchObject({ system: 'ICD10CM', code: 'E119', billable: 1 });
  });

  it('disambiguates a shape-overlapping code by DB membership', () => {
    // J0120 is shaped like CM and HCPCS but present only in HCPCS → unambiguous.
    const r = svc.getByCode('J0120');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') expect(r.row.system).toBe('HCPCS');
  });

  it('returns not_found for a well-shaped but absent code', () => {
    expect(svc.getByCode('Z9999').kind).toBe('not_found');
  });

  it('attaches parent and children with includeHierarchy', () => {
    const r = svc.getByCode('E11');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') {
      const h = svc.getByCodeWithHierarchy(r.row);
      expect(h.children.map((c) => c.code)).toContain('E11.9');
    }
  });
});

describe('searchFts', () => {
  it('requires every token (AND semantics)', () => {
    const hits = svc.searchFts('diabetic neuropathy', { limit: 10 }).codes;
    expect(hits.map((h) => h.code)).toContain('E11.40');
    // "polyneuropathy" must not match the "neuropathy" prefix token.
    expect(hits.map((h) => h.code)).not.toContain('E11.42');
  });

  it('honors the billableOnly filter', () => {
    const all = svc.searchFts('diabetes', { limit: 50 }).codes;
    const billable = svc.searchFts('diabetes', { limit: 50, billableOnly: true }).codes;
    expect(all.some((h) => h.code === 'E11')).toBe(true); // header present unfiltered
    expect(billable.some((h) => h.code === 'E11')).toBe(false); // header excluded
  });

  it('returns an empty result for no match', () => {
    expect(svc.searchFts('zzzznotarealterm', { limit: 10 }).codes).toEqual([]);
  });
});

describe('checkCode', () => {
  it('reports valid_billable for a leaf code', () => {
    const r = svc.checkCode('E11.9');
    expect(r.kind === 'resolved' && r.result.status).toBe('valid_billable');
  });
  it('reports valid_header with a why-not for a category', () => {
    const r = svc.checkCode('E11');
    if (r.kind === 'resolved') {
      expect(r.result.status).toBe('valid_header');
      expect(r.result.whyNot).toBeTruthy();
    }
  });
  it('reports terminated for a retired HCPCS code', () => {
    const r = svc.checkCode('K0552');
    expect(r.kind === 'resolved' && r.result.status).toBe('terminated');
  });
  it('reports unknown for an absent code', () => {
    const r = svc.checkCode('99999');
    expect(r.kind === 'resolved' && r.result.status).toBe('unknown');
  });
  it('explains a numeric out-of-scope code (e.g. CPT) as not-in-RxNorm with an out-of-scope hint', () => {
    const r = svc.checkCode('99213'); // a CPT code — out of scope, RxNorm-shaped (bare integer)
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') {
      expect(r.result.status).toBe('unknown');
      expect(r.result.whyNot).toMatch(/out of scope/i);
      expect(r.result.whyNot).toMatch(/CPT/);
    }
  });
});

describe('mapCode', () => {
  it('maps a code to its parent', () => {
    const r = svc.mapCode('E11.9', 'parents');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.hits[0]?.value).toBe('E11');
  });
  it('maps a category to its children', () => {
    const r = svc.mapCode('E11', 'children');
    expect(r.kind === 'ok' && r.hits.some((h) => h.value === 'E11.9')).toBe(true);
  });
  it('returns ok-empty for a root with no parent', () => {
    const r = svc.mapCode('E11', 'parents');
    expect(r.kind === 'ok' && r.hits).toEqual([]);
  });
  it('maps a HCPCS code to its seeded letter-bucket parent', () => {
    const r = svc.mapCode('J0120', 'parents');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.resolvedSystem).toBe('HCPCS');
      expect(r.hits[0]?.value).toBe('J');
    }
  });
  it('returns ok-empty for a HCPCS leaf with no children', () => {
    const r = svc.mapCode('J0120', 'children');
    expect(r.kind === 'ok' && r.hits).toEqual([]);
  });
});

describe('browse', () => {
  it('lists ICD-10-CM top-level categories (no node)', () => {
    const r = svc.browse('ICD10CM', undefined, { offset: 0, limit: 50 });
    expect(r.kind).toBe('codes');
    if (r.kind === 'codes') expect(r.codes.some((c) => c.code === 'E11')).toBe(true);
  });
  it('returns PCS axis values for the first position', () => {
    const r = svc.browse('ICD10PCS', undefined, { offset: 0, limit: 50 });
    expect(r.kind).toBe('axes');
    if (r.kind === 'axes') expect(r.axes.some((a) => a.position === 1)).toBe(true);
  });
  it('lists HCPCS top-level letter buckets (no node)', () => {
    const r = svc.browse('HCPCS', undefined, { offset: 0, limit: 50 });
    expect(r.kind).toBe('codes');
    if (r.kind === 'codes') {
      const bucket = r.codes.find((c) => c.code === 'J');
      expect(bucket?.header).toBe(true);
      expect(bucket?.description).toBe('Drugs administered other than oral method');
    }
  });
  it('lists the codes under a HCPCS letter bucket (node)', () => {
    const r = svc.browse('HCPCS', 'J', { offset: 0, limit: 50 });
    expect(r.kind).toBe('codes');
    if (r.kind === 'codes') expect(r.codes.map((c) => c.code)).toContain('J0120');
  });
});

describe('pagination (fetchPage-backed paths)', () => {
  describe('childrenOf', () => {
    // Fixture: ICD-10-CM A00 has exactly two children A000/A001 (display A00.0/A00.1),
    // ordered by the unique primary key `code`.
    it('returns the first page with an exact hasMore', () => {
      const p1 = svc.childrenOf('ICD10CM', 'A00', { offset: 0, limit: 1 });
      expect(p1.children.map((c) => c.code)).toEqual(['A00.0']);
      expect(p1.hasMore).toBe(true);
    });
    it('returns the last page with hasMore false', () => {
      const p2 = svc.childrenOf('ICD10CM', 'A00', { offset: 1, limit: 1 });
      expect(p2.children.map((c) => c.code)).toEqual(['A00.1']);
      expect(p2.hasMore).toBe(false);
    });
    it('does not false-positive hasMore when limit equals the child count', () => {
      const exact = svc.childrenOf('ICD10CM', 'A00', { offset: 0, limit: 2 });
      expect(exact.children.map((c) => c.code)).toEqual(['A00.0', 'A00.1']);
      expect(exact.hasMore).toBe(false);
    });
    it('reconstructs the full child set from consecutive pages by code identity', () => {
      const full = svc
        .childrenOf('ICD10CM', 'A00', { offset: 0, limit: 50 })
        .children.map((c) => c.code);
      const p1 = svc.childrenOf('ICD10CM', 'A00', { offset: 0, limit: 1 }).children;
      const p2 = svc.childrenOf('ICD10CM', 'A00', { offset: 1, limit: 1 }).children;
      expect([...p1, ...p2].map((c) => c.code)).toEqual(full.slice(0, 2));
    });
  });

  describe('searchFts', () => {
    // Fixture: "diabetes" matches four ICD-10-CM rows (E11, E11.9, E11.40, E11.42).
    it('paginates and reconstructs the ranked set by code identity', () => {
      const full = svc.searchFts('diabetes', { offset: 0, limit: 50 }).codes;
      expect(full).toHaveLength(4);
      const p1 = svc.searchFts('diabetes', { offset: 0, limit: 2 });
      const p2 = svc.searchFts('diabetes', { offset: 2, limit: 2 });
      expect(p1.codes).toHaveLength(2);
      expect(p1.hasMore).toBe(true);
      expect(p2.codes).toHaveLength(2);
      expect(p2.hasMore).toBe(false);
      expect([...p1.codes, ...p2.codes].map((c) => c.code)).toEqual(full.map((c) => c.code));
    });
    it('orders deterministically across identical queries (tie-break locked)', () => {
      const a = svc.searchFts('diabetes', { offset: 0, limit: 50 }).codes.map((c) => c.code);
      const b = svc.searchFts('diabetes', { offset: 0, limit: 50 }).codes.map((c) => c.code);
      expect(a).toEqual(b);
    });
    it('reports hasMore false at the exact match count (no >=cap false positive)', () => {
      const exact = svc.searchFts('diabetes', { offset: 0, limit: 4 });
      expect(exact.codes).toHaveLength(4);
      expect(exact.hasMore).toBe(false);
    });
    it('returns an empty final page past the end', () => {
      const past = svc.searchFts('diabetes', { offset: 4, limit: 2 });
      expect(past.codes).toEqual([]);
      expect(past.hasMore).toBe(false);
    });
  });

  describe('mapCode name_to_rxcui', () => {
    // Fixture: substring "a" matches four of five RxNorm concepts, ordered by
    // (length(code), code): 161, 1191, 198440, 1049640.
    it('paginates and reconstructs the drug-name set by RXCUI identity', () => {
      const full = svc.mapCode('a', 'name_to_rxcui', undefined, { offset: 0, limit: 50 });
      expect(full.kind).toBe('ok');
      if (full.kind !== 'ok') return;
      const fullValues = full.hits.map((h) => h.value);
      expect(fullValues).toEqual(['161', '1191', '198440', '1049640']);

      const p1 = svc.mapCode('a', 'name_to_rxcui', undefined, { offset: 0, limit: 2 });
      const p2 = svc.mapCode('a', 'name_to_rxcui', undefined, { offset: 2, limit: 2 });
      if (p1.kind !== 'ok' || p2.kind !== 'ok') throw new Error('expected ok');
      expect(p1.hits.map((h) => h.value)).toEqual(['161', '1191']);
      expect(p1.hasMore).toBe(true);
      expect(p2.hits.map((h) => h.value)).toEqual(['198440', '1049640']);
      expect(p2.hasMore).toBe(false);
      expect([...p1.hits, ...p2.hits].map((h) => h.value)).toEqual(fullValues);
    });
  });

  describe('getByCodeWithHierarchy childrenTruncated', () => {
    it('flags truncation when a code has more children than the cap', () => {
      const r = svc.getByCode('A00');
      expect(r.kind).toBe('found');
      if (r.kind !== 'found') return;
      const capped = svc.getByCodeWithHierarchy(r.row, 1);
      expect(capped.children.map((c) => c.code)).toEqual(['A00.0']);
      expect(capped.childrenTruncated).toBe(true);
    });
    it('reports no truncation when the children fit the cap', () => {
      const r = svc.getByCode('A00');
      if (r.kind !== 'found') throw new Error('expected found');
      const full = svc.getByCodeWithHierarchy(r.row, 50);
      expect(full.children.map((c) => c.code)).toEqual(['A00.0', 'A00.1']);
      expect(full.childrenTruncated).toBe(false);
    });
  });
});

describe('listSystems / hasRxNorm', () => {
  it('lists bundled systems in canonical order with counts', () => {
    const systems = svc.listSystems();
    expect(systems.map((s) => s.system)).toEqual(['ICD10CM', 'ICD10PCS', 'HCPCS', 'RXNORM']);
    expect(systems[0]?.codeCount).toBeGreaterThan(0);
  });
  it('reports RxNorm as bundled', () => {
    expect(svc.hasRxNorm()).toBe(true);
  });
  it('records the RxNorm provenance row', () => {
    const rx = svc.listSystems().find((s) => s.system === 'RXNORM');
    expect(rx?.releaseId).toMatch(/RxNorm/);
    expect(rx?.codeCount).toBeGreaterThan(0);
  });
});

describe('toFtsMatch', () => {
  it('builds an AND of prefix-matched quoted tokens', () => {
    expect(toFtsMatch('type 2 diabetes')).toBe('"type"* AND "2"* AND "diabetes"*');
  });
  it('returns null when nothing usable remains', () => {
    expect(toFtsMatch('  ()*  ')).toBeNull();
  });
});

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape char so they match literally', () => {
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('c\\d')).toBe('c\\\\d');
  });
  it('leaves ordinary drug-name text untouched', () => {
    expect(escapeLike('metformin')).toBe('metformin');
  });
});

describe('ndcCandidates', () => {
  it('normalizes a hyphenated 5-4-2 NDC to one unambiguous 11-digit key', () => {
    expect(ndcCandidates('11111-2222-33')).toEqual({
      candidates: ['11111222233'],
      unambiguous: true,
    });
  });
  it('left-pads a hyphenated 4-4-2 NDC to 5-4-2', () => {
    expect(ndcCandidates('0904-5161-60')).toEqual({
      candidates: ['00904516160'],
      unambiguous: true,
    });
  });
  it('pads the middle segment of a hyphenated 5-3-2 NDC', () => {
    expect(ndcCandidates('12345-678-90')).toEqual({
      candidates: ['12345067890'],
      unambiguous: true,
    });
  });
  it('treats a bare 11-digit value as a single ambiguous candidate (also RXCUI-shaped)', () => {
    expect(ndcCandidates('11111222233')).toEqual({
      candidates: ['11111222233'],
      unambiguous: false,
    });
  });
  it('expands a bare 10-digit value into the three standard segmentations', () => {
    expect(ndcCandidates('0904516160')).toEqual({
      candidates: ['00904516160', '09045016160', '09045161600'],
      unambiguous: false,
    });
  });
  it('returns no candidates for an RXCUI-length integer or a non-NDC shape', () => {
    expect(ndcCandidates('161').candidates).toEqual([]);
    expect(ndcCandidates('E11.9').candidates).toEqual([]);
  });
});

describe('getByCode (RxNorm)', () => {
  it('decodes a bare RXCUI to its concept', () => {
    const r = svc.getByCode('161');
    expect(r.kind).toBe('found');
    if (r.kind === 'found')
      expect(r.row).toMatchObject({ system: 'RXNORM', code: '161', longDesc: 'acetaminophen' });
  });
});

describe('getByNdc', () => {
  it('decodes a bare 11-digit NDC to its RxNorm product', () => {
    const r = svc.getByNdc('11111222233');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') expect(r.rows[0]?.code).toBe('198440');
  });
  it('decodes a hyphenated 5-4-2 NDC', () => {
    const r = svc.getByNdc('11111-2222-33');
    expect(r.kind === 'found' && r.rows[0]?.code).toBe('198440');
  });
  it('decodes a hyphenated 4-4-2 NDC via 11-digit normalization', () => {
    const r = svc.getByNdc('0904-5161-60');
    expect(r.kind === 'found' && r.rows[0]?.code).toBe('1049640');
  });
  it('reports no_match for an unambiguous hyphenated NDC absent from the map', () => {
    expect(svc.getByNdc('99999-8888-77').kind).toBe('no_match');
  });
  it('returns not_ndc for a non-NDC shape (falls through to RXCUI/other)', () => {
    expect(svc.getByNdc('161').kind).toBe('not_ndc');
    expect(svc.getByNdc('E11.9').kind).toBe('not_ndc');
  });
  it('returns not_ndc for a bare-digit NDC candidate with no map hit (may be an RXCUI)', () => {
    expect(svc.getByNdc('99999888877').kind).toBe('not_ndc');
  });
});

describe('mapCode (RxNorm drug directions)', () => {
  it('name_to_rxcui finds concepts by name substring', () => {
    const r = svc.mapCode('acetaminophen', 'name_to_rxcui');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.hits.map((h) => h.value)).toContain('161');
  });
  it('ndc_to_rxcui resolves a hyphenated NDC to its RXCUI', () => {
    const r = svc.mapCode('11111-2222-33', 'ndc_to_rxcui');
    expect(r.kind === 'ok' && r.hits[0]?.value).toBe('198440');
  });
  it('rxcui_to_ndc lists the NDCs for a product', () => {
    const r = svc.mapCode('198440', 'rxcui_to_ndc');
    expect(r.kind === 'ok' && r.hits.map((h) => h.value)).toContain('11111222233');
  });
  it('rxcui_to_ingredients returns the ingredient RXCUIs', () => {
    const r = svc.mapCode('198440', 'rxcui_to_ingredients');
    expect(r.kind === 'ok' && r.hits.map((h) => h.value)).toContain('161');
  });
  it('rxcui_to_brands returns the brand RXCUIs', () => {
    const r = svc.mapCode('198440', 'rxcui_to_brands');
    expect(r.kind === 'ok' && r.hits.map((h) => h.value)).toContain('202433');
  });
  it('source_not_found for an unknown drug name', () => {
    expect(svc.mapCode('zzznotadrug', 'name_to_rxcui').kind).toBe('source_not_found');
  });
});
