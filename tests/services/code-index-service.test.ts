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
    const hits = svc.searchFts('diabetic neuropathy', { limit: 10 });
    expect(hits.map((h) => h.code)).toContain('E11.40');
    // "polyneuropathy" must not match the "neuropathy" prefix token.
    expect(hits.map((h) => h.code)).not.toContain('E11.42');
  });

  it('honors the billableOnly filter', () => {
    const all = svc.searchFts('diabetes', { limit: 50 });
    const billable = svc.searchFts('diabetes', { limit: 50, billableOnly: true });
    expect(all.some((h) => h.code === 'E11')).toBe(true); // header present unfiltered
    expect(billable.some((h) => h.code === 'E11')).toBe(false); // header excluded
  });

  it('returns an empty array for no match', () => {
    expect(svc.searchFts('zzzznotarealterm', { limit: 10 })).toEqual([]);
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
  it('names RxNorm as unbundled for a numeric out-of-scope code, not a per-system not-found', () => {
    const r = svc.checkCode('99213');
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') {
      expect(r.result.status).toBe('unknown');
      expect(r.result.whyNot).toMatch(/not bundled/i);
      expect(r.result.whyNot).not.toMatch(/No RXNORM code matches/i);
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
    const r = svc.browse('ICD10CM', undefined, 50);
    expect(r.kind).toBe('codes');
    if (r.kind === 'codes') expect(r.codes.some((c) => c.code === 'E11')).toBe(true);
  });
  it('returns PCS axis values for the first position', () => {
    const r = svc.browse('ICD10PCS', undefined, 50);
    expect(r.kind).toBe('axes');
    if (r.kind === 'axes') expect(r.axes.some((a) => a.position === 1)).toBe(true);
  });
  it('lists HCPCS top-level letter buckets (no node)', () => {
    const r = svc.browse('HCPCS', undefined, 50);
    expect(r.kind).toBe('codes');
    if (r.kind === 'codes') {
      const bucket = r.codes.find((c) => c.code === 'J');
      expect(bucket?.header).toBe(true);
      expect(bucket?.description).toBe('Drugs administered other than oral method');
    }
  });
  it('lists the codes under a HCPCS letter bucket (node)', () => {
    const r = svc.browse('HCPCS', 'J', 50);
    expect(r.kind).toBe('codes');
    if (r.kind === 'codes') expect(r.codes.map((c) => c.code)).toContain('J0120');
  });
});

describe('listSystems / hasRxNorm', () => {
  it('lists bundled systems in canonical order with counts', () => {
    const systems = svc.listSystems();
    expect(systems.map((s) => s.system)).toEqual(['ICD10CM', 'ICD10PCS', 'HCPCS']);
    expect(systems[0]?.codeCount).toBeGreaterThan(0);
  });
  it('reports RxNorm as not bundled in v1', () => {
    expect(svc.hasRxNorm()).toBe(false);
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
