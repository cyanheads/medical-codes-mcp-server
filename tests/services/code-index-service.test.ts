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
import { ICD10PCS_PARTIAL_RE, ndcCandidates } from '@/services/code-index/detect.js';
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

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/29
  it('resolves a materialized header row whose shape no complete pattern matches', () => {
    // `J` is a HCPCS letter bucket the index materializes: browse returns it and
    // map_codes walks its children, but detectSystems only describes complete
    // codes, so shape alone reports it as not a code at all.
    expect(svc.detectSystem('J')).toEqual([]);
    const r = svc.getByCode('J');
    expect(r.kind).toBe('found');
    if (r.kind === 'found') expect(r.row).toMatchObject({ system: 'HCPCS', code: 'J', header: 1 });

    // Lower case reaches the same row — storageCode normalizes before membership.
    expect(svc.getByCode('j').kind).toBe('found');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/29
  it('widens past a wrong shape verdict rather than asserting absence in that system', () => {
    // A0100 is shaped as both ICD-10-CM and HCPCS and is a member of both, so the
    // shape-narrowed pass answers and the widening must not fire — the widened set
    // would be identical here, but a code the shape pass CAN answer must never
    // reach it, or a fourth-system collision would start reporting as ambiguous.
    const shaped = svc.getByCode('A0100');
    expect(shaped.kind).toBe('ambiguous');
    if (shaped.kind === 'ambiguous') expect(shaped.systems).toEqual(['ICD10CM', 'HCPCS']);

    // An explicit system stays authoritative and is never widened past.
    expect(svc.getByCode('J', 'ICD10CM').kind).toBe('not_found');
    expect(svc.getByCode('J', 'HCPCS').kind).toBe('found');

    // A value absent from every system is still not_found — widening rescues real
    // rows, it does not manufacture hits.
    expect(svc.getByCode('ZZZ').kind).toBe('not_found');
    expect(svc.getByCode('!!').kind).toBe('not_found');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/32
  it('names the member the shape narrowing excluded instead of re-routing the answer', () => {
    // `B00` is an ICD-10-CM category AND an ICD-10-PCS table row. Only the CM shape
    // admits a 3-character letter+2-digit value, so the shape pass picks CM over a
    // second real member — the one case where narrowing decides rather than narrows.
    expect(svc.detectSystem('B00')).toEqual(['ICD10CM']);

    const auto = svc.getByCode('B00');
    expect(auto.kind).toBe('found');
    if (auto.kind !== 'found') return;
    // The resolution is untouched — widening it would cost a working single answer.
    expect(auto.row).toMatchObject({
      system: 'ICD10CM',
      code: 'B00',
      longDesc: 'Herpesviral [herpes simplex] infections',
    });
    // …and the excluded member rides along, so the caller can reach the other row.
    expect(auto.alsoIn).toEqual(['ICD10PCS']);

    // The disclosure is symmetric: an explicit system is still authoritative for
    // the choice, and names the system it was chosen over.
    const forced = svc.getByCode('B00', 'ICD10PCS');
    expect(forced.kind).toBe('found');
    if (forced.kind !== 'found') return;
    expect(forced.row).toMatchObject({
      system: 'ICD10PCS',
      longDesc: 'Imaging, Central Nervous System, Plain Radiography',
    });
    expect(forced.alsoIn).toEqual(['ICD10CM']);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/32
  it('leaves alsoIn empty for a single-system code and for an ambiguous one', () => {
    // A code present in exactly one system has nothing to disclose.
    const single = svc.getByCode('E11.9');
    expect(single.kind === 'found' && single.alsoIn).toEqual([]);

    // A0100 is a member of two systems the SHAPE pass admits both of, so it is
    // still `ambiguous` — every member is already named as a candidate there, and
    // demoting one to a footnote would hide half the answer.
    const both = svc.getByCode('A0100');
    expect(both.kind).toBe('ambiguous');
    expect(both).not.toHaveProperty('alsoIn');

    // A code absent from every system stays not_found — a disclosure qualifies an
    // answer, and an explicit system the value is absent from produces no answer.
    expect(svc.getByCode('B00', 'HCPCS').kind).toBe('not_found');
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
  it('requires every token (AND semantics) and recalls single-token compounds', () => {
    const codes = svc.searchFts('diabetic neuropathy', { limit: 10 }).codes.map((h) => h.code);
    // Prefix tier matches the standalone "neuropathy" token…
    expect(codes).toContain('E11.40');
    // …and the substring tier now recalls E11.42 ("…diabetic polyneuropathy"), the
    // single-token compound the prefix match misses. This inverts the prior
    // not.toContain assertion that codified the #6 undercoding bug as correct. Both
    // terms ("diabetic" AND "neuropathy") are still required.
    expect(codes).toContain('E11.42');
  });

  it('surfaces compound siblings for a bare single-term query via the substring tier', () => {
    // Fixture carries E1140 (standalone "neuropathy") and E1142 ("polyneuropathy");
    // both must surface for a plain "neuropathy" search (E1141/E1143 aren't seeded).
    const codes = svc.searchFts('neuropathy', { limit: 50 }).codes.map((h) => h.code);
    expect(codes).toEqual(expect.arrayContaining(['E11.40', 'E11.42']));
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

  it('restricts results to one chapter bucket', () => {
    // "fever" matches the A01 typhoid chain (chapter A) only; asking for chapter E
    // must drop them rather than ignore the filter.
    const inA = svc.searchFts('fever', { limit: 50, chapter: 'A' }).codes;
    expect(inA.map((h) => h.code)).toContain('A01.00');
    expect(inA.every((h) => h.chapter === 'A')).toBe(true);
    expect(svc.searchFts('fever', { limit: 50, chapter: 'E' }).codes).toEqual([]);
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
  it('reports ambiguous for a code present in two systems, and resolves each when forced', () => {
    const ambiguous = svc.checkCode('A0100');
    expect(ambiguous.kind).toBe('ambiguous');
    if (ambiguous.kind === 'ambiguous') expect(ambiguous.systems).toEqual(['ICD10CM', 'HCPCS']);

    // The same string is a billable diagnosis in one system and a billable
    // transport service in the other — the verdicts must not be interchangeable.
    const diagnosis = svc.checkCode('A0100', 'ICD10CM');
    expect(diagnosis.kind === 'resolved' && diagnosis.result.code).toBe('A01.00');
    const transport = svc.checkCode('A0100', 'HCPCS');
    expect(transport.kind === 'resolved' && transport.result.code).toBe('A0100');
  });
  // https://github.com/cyanheads/medical-codes-mcp-server/issues/32
  it('carries the excluded member onto the verdict, whichever verdict it is', () => {
    // The verdict is system-specific: B00 is a non-billable CM header and a
    // non-billable PCS table row, and neither reading is the other's answer.
    const cm = svc.checkCode('B00');
    expect(cm.kind === 'resolved' && cm.result).toMatchObject({
      system: 'ICD10CM',
      status: 'valid_header',
      alsoIn: ['ICD10PCS'],
    });

    const pcs = svc.checkCode('B00', 'ICD10PCS');
    expect(pcs.kind === 'resolved' && pcs.result).toMatchObject({
      system: 'ICD10PCS',
      status: 'valid_not_billable',
      alsoIn: ['ICD10CM'],
    });

    // A code in one system carries no disclosure at all, rather than an empty array.
    const single = svc.checkCode('E11.9');
    expect(single.kind === 'resolved' && single.result).not.toHaveProperty('alsoIn');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/32
  it('stops asserting a shape verdict on a value that is simply absent', () => {
    // Membership has been the arbiter since #29, so "matches no shape" cannot be
    // the reason a lookup failed — the value is absent from every system.
    const r = svc.checkCode('!!!');
    expect(r.kind === 'resolved' && r.result.status).toBe('unknown');
    expect(r.kind === 'resolved' && r.result.whyNot).toMatch(/not present in any bundled/i);
    expect(r.kind === 'resolved' && r.result.whyNot).not.toMatch(/does not match the shape/i);
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

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/32
  it('names the excluded member on a hierarchy page, since only one was walked', () => {
    // Both hierarchy directions resolve the source through resolveSystems, and both
    // walk the resolved system alone — the PCS row's neighbours are not in here.
    for (const direction of ['children', 'parents'] as const) {
      const r = svc.mapCode('B00', direction);
      expect(r.kind).toBe('ok');
      if (r.kind !== 'ok') continue;
      expect(r.resolvedSystem).toBe('ICD10CM');
      expect(r.alsoIn).toEqual(['ICD10PCS']);
    }

    // A source in one system has nothing to disclose, and the drug directions
    // resolve no system at all, so neither carries the field.
    expect(svc.mapCode('E11', 'children')).not.toHaveProperty('alsoIn');
    expect(svc.mapCode('161', 'rxcui_to_brands')).not.toHaveProperty('alsoIn');
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
  it('returns empty axes (not unknown_node) for a complete existing ICD-10-PCS code (#13)', () => {
    // 0DTJ4ZZ is a complete 7-char PCS code present in the fixture — it exists but
    // has no deeper axes to browse, so it is a successful empty-axes result.
    const r = svc.browse('ICD10PCS', '0DTJ4ZZ', { offset: 0, limit: 50 });
    expect(r.kind).toBe('axes');
    if (r.kind === 'axes') {
      expect(r.axes).toEqual([]);
      expect(r.hasMore).toBe(false);
    }
  });
  it('returns unknown_node for a shape-valid but absent ICD-10-PCS code (#13)', () => {
    // 0DTJ1ZZ is a well-formed 7-char PCS code absent from the fixture.
    expect(svc.browse('ICD10PCS', '0DTJ1ZZ', { offset: 0, limit: 50 }).kind).toBe('unknown_node');
  });
  it('returns unknown_node for a node outside the ICD-10-PCS axis alphabet (#24)', () => {
    for (const node of ['I', 'O', '!', '.', '0DI', 'ⅰ']) {
      const r = svc.browse('ICD10PCS', node, { offset: 0, limit: 50 });
      expect(r.kind).toBe('unknown_node');
      if (r.kind === 'unknown_node') expect(r.reason).toMatch(/ICD-10-PCS/);
    }
  });
  it('returns unknown_node for an in-alphabet node no bundled code begins with (#24)', () => {
    // Only 17 of the 34 axis values open a code and each later position is
    // constrained by the ones before it, so an in-alphabet string is not a path.
    // These are all drawn from the alphabet and clear the lexical guard.
    for (const node of ['Z', '1', '0A', '0DTJ2']) {
      const r = svc.browse('ICD10PCS', node, { offset: 0, limit: 50 });
      expect(r.kind).toBe('unknown_node');
      if (r.kind === 'unknown_node') expect(r.reason).toMatch(/begins with/);
    }
  });
  it('still walks a real partial prefix to the next-position axis query (#24)', () => {
    // What the guards must NOT reject: every prefix of a code the index carries
    // keeps reaching the axis query (empty here, since only position 1 is seeded).
    for (const node of ['0', '0D', '0DT', '0DTJ', '0DTJ4', '0DTJ4Z', '02', '02703DZ']) {
      expect(svc.browse('ICD10PCS', node, { offset: 0, limit: 50 }).kind).toBe('axes');
    }
  });
});

describe('ICD10PCS_PARTIAL_RE', () => {
  it('accepts exactly the axis alphabet the complete-code shape detector accepts', () => {
    // The partial-node guard and the 7-character shape test carry the same character
    // class in two literals; this pins them together so one can never drift.
    for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(ICD10PCS_PARTIAL_RE.test(ch)).toBe(
        svc.detectSystem(ch.repeat(7)).includes('ICD10PCS'),
      );
    }
    expect(ICD10PCS_PARTIAL_RE.test('I')).toBe(false);
    expect(ICD10PCS_PARTIAL_RE.test('O')).toBe(false);
    expect(ICD10PCS_PARTIAL_RE.test('')).toBe(false);
    expect(ICD10PCS_PARTIAL_RE.test('0DTJ4ZZ')).toBe(true);
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

  describe('mapCode rxcui_to_ndc', () => {
    // Fixture: 1049640 carries five package NDCs, ordered by the `ndc` column.
    const ALL_NDCS = ['00904516140', '00904516160', '00904516161', '00904516180', '00904516189'];

    it('paginates and reconstructs the package set by NDC identity', () => {
      const full = svc.mapCode('1049640', 'rxcui_to_ndc', undefined, { offset: 0, limit: 50 });
      if (full.kind !== 'ok') throw new Error('expected ok');
      expect(full.hits.map((h) => h.value)).toEqual(ALL_NDCS);
      expect(full.hasMore).toBe(false);

      const pages = [0, 2, 4].map((offset) =>
        svc.mapCode('1049640', 'rxcui_to_ndc', undefined, { offset, limit: 2 }),
      );
      const values = pages.map((p) => (p.kind === 'ok' ? p.hits.map((h) => h.value) : []));
      expect(values).toEqual([
        ['00904516140', '00904516160'],
        ['00904516161', '00904516180'],
        ['00904516189'],
      ]);
      expect(pages.map((p) => p.kind === 'ok' && p.hasMore)).toEqual([true, true, false]);
      expect(values.flat()).toEqual(ALL_NDCS);
    });

    it('does not false-positive hasMore when the limit equals the package count', () => {
      const exact = svc.mapCode('1049640', 'rxcui_to_ndc', undefined, { offset: 0, limit: 5 });
      expect(exact.kind === 'ok' && exact.hasMore).toBe(false);
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
  it('ndc_to_rxcui falls back to a digit strip for a non-standard separator', () => {
    // Not NDC-shaped (spaces, not hyphens), so no segmentation is inferred — the
    // digits alone still have to reach the 11-digit key.
    const r = svc.mapCode('11111 2222 33', 'ndc_to_rxcui');
    expect(r.kind === 'ok' && r.hits[0]?.value).toBe('198440');
  });
  it('source_not_found for an NDC absent from the map', () => {
    expect(svc.mapCode('99999-8888-77', 'ndc_to_rxcui').kind).toBe('source_not_found');
  });
  it('ok-empty for a resolvable concept with no packages and no edges', () => {
    // 161 is an ingredient concept: no NDC packages, no ingredient or brand edges
    // of its own. It is still a bundled concept, so each direction is an empty
    // result — calling it a missing source would deny a code get_code decodes.
    for (const direction of ['rxcui_to_ndc', 'rxcui_to_ingredients', 'rxcui_to_brands'] as const) {
      const r = svc.mapCode('161', direction);
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(r.hits).toEqual([]);
        expect(r.resolvedSystem).toBe('RXNORM');
        // Not a paged-past-the-end empty — the concept has no edges at any offset.
        expect(r.pastEnd).toBeFalsy();
      }
    }
  });

  it('source_not_found for an RXCUI absent from the index', () => {
    // What source_not_found still means on the RXCUI-source directions: the value
    // is not a bundled concept at all.
    for (const direction of ['rxcui_to_ndc', 'rxcui_to_ingredients', 'rxcui_to_brands'] as const) {
      expect(svc.mapCode('999999999', direction).kind).toBe('source_not_found');
    }
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/27
  it('names the product an NDC decoded to instead of returning a bare RXCUI', () => {
    const r = svc.mapCode('11111-2222-33', 'ndc_to_rxcui');
    expect(r.kind === 'ok' && r.hits[0]).toMatchObject({
      value: '198440',
      source: 'NDC',
      description: 'Acetaminophen 500 MG Oral Tablet',
    });
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/28
  it('carries the RxNorm concept type of each ingredient and brand target', () => {
    const ingredients = svc.mapCode('198440', 'rxcui_to_ingredients');
    expect(ingredients.kind === 'ok' && ingredients.hits[0]).toMatchObject({
      value: '161',
      conceptType: 'IN',
    });

    const brands = svc.mapCode('198440', 'rxcui_to_brands');
    expect(brands.kind === 'ok' && brands.hits[0]).toMatchObject({
      value: '202433',
      conceptType: 'BN',
    });

    // The concept type belongs to the drug graph alone — a hierarchy target is a
    // code, so tagging it with one would invent a fact the index does not carry.
    const parents = svc.mapCode('E11.9', 'parents');
    expect(parents.kind === 'ok' && parents.hits).toHaveLength(1);
    expect(parents.kind === 'ok' && parents.hits[0]?.conceptType).toBeUndefined();
  });
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/26
describe('mapCode — a page past the end is not an unmapped source', () => {
  const beyond = { offset: 999_999, limit: 2 };

  it.each([
    ['name_to_rxcui', 'a'],
    ['rxcui_to_ndc', '1049640'],
    ['children', 'A00'],
  ] as const)('returns ok-empty for %s past the last page', (direction, from) => {
    // The same source one call earlier returns hits, so reporting the out-of-range
    // window as source_not_found makes the tool contradict itself.
    const firstPage = svc.mapCode(from, direction, undefined, { offset: 0, limit: 2 });
    expect(firstPage.kind === 'ok' && firstPage.hits.length).toBeGreaterThan(0);

    const past = svc.mapCode(from, direction, undefined, beyond);
    expect(past.kind).toBe('ok');
    if (past.kind === 'ok') {
      expect(past.hits).toEqual([]);
      expect(past.hasMore).toBe(false);
      expect(past.resolvedSystem).toBe(firstPage.kind === 'ok' ? firstPage.resolvedSystem : null);
      // The flag, not the offset, is what lets the tool word the notice — an empty
      // page at a non-zero offset is past-the-end only when results exist to pass.
      expect(past.pastEnd).toBe(true);
    }
  });

  it.each([
    ['children', 'E1140'],
    ['rxcui_to_ndc', '161'],
  ] as const)('does not call %s past-the-end when the source has no edges at all', (d, from) => {
    // Same out-of-range offset, opposite cause: nothing was skipped, because there
    // was nothing to skip. Flagging these as past-the-end would send the caller
    // back for a first page that is equally empty.
    const past = svc.mapCode(from, d, d === 'children' ? 'ICD10CM' : undefined, beyond);
    expect(past.kind).toBe('ok');
    if (past.kind === 'ok') {
      expect(past.hits).toEqual([]);
      expect(past.pastEnd).toBeFalsy();
    }
  });

  it('still reports a genuinely unmapped source at any offset', () => {
    // The probe must confirm the source, not merely wave every empty page through:
    // a name and an RXCUI that resolve to nothing stay source_not_found off page one.
    expect(svc.mapCode('zzznotadrug', 'name_to_rxcui', undefined, beyond).kind).toBe(
      'source_not_found',
    );
    expect(svc.mapCode('999999999', 'rxcui_to_ndc', undefined, beyond).kind).toBe(
      'source_not_found',
    );
  });
});

describe('mapCode (hierarchy resolution)', () => {
  it('ambiguous for a hierarchy source present in two systems', () => {
    const r = svc.mapCode('A0100', 'parents');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.systems).toEqual(['ICD10CM', 'HCPCS']);
  });
  it('carries the target description on a hierarchy parent hit', () => {
    const r = svc.mapCode('A0100', 'parents', 'ICD10CM');
    expect(r.kind === 'ok' && r.hits[0]).toMatchObject({
      value: 'A01.0',
      description: 'Typhoid fever',
    });
  });
});
