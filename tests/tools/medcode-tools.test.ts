/**
 * @fileoverview Handler tests for the six medcode_* tools against the bundled
 * fixture DB. Covers success paths, partial-success batching, the typed error
 * contracts (no_codes_found, unknown_code, no_mapping, direction_unavailable,
 * unknown_node), and enrichment (truncation, empty-result notice).
 * @module tests/tools/medcode-tools.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { listSystemsTool } from '@/mcp-server/tools/definitions/list-systems.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import { ensureIndex } from '../helpers/index-fixture.ts';

/**
 * Invoke a (sync- or async-throwing) handler and return the thrown error. The
 * tool handlers are synchronous and throw inline, so `expect(promise).rejects`
 * never sees a promise; this captures the error uniformly for assertions on its
 * `data.reason` (more meaningful than `instanceof`, and immune to the dual
 * class-identity issue under Vitest's SSR module resolution).
 */
async function caught(fn: () => unknown): Promise<{ data?: { reason?: string }; message: string }> {
  try {
    await fn();
  } catch (err) {
    return err as { data?: { reason?: string }; message: string };
  }
  throw new Error('expected handler to throw, but it resolved');
}

beforeAll(async () => {
  await ensureIndex();
});

describe('medcode_list_systems', () => {
  it('lists the bundled systems with provenance', async () => {
    const ctx = createMockContext();
    const out = await listSystemsTool.handler(listSystemsTool.input.parse({}), ctx);
    expect(out.systems.map((s) => s.system)).toEqual(['ICD10CM', 'ICD10PCS', 'HCPCS', 'RXNORM']);
    expect(out.systems[0]?.label).toBe('ICD-10-CM');
    expect(out.systems.find((s) => s.system === 'RXNORM')?.label).toBe('RxNorm');
    expect(out).toEqual(expect.schemaMatching(listSystemsTool.output));
  });
});

describe('medcode_get_code', () => {
  it('decodes a batch with partial success', async () => {
    const ctx = createMockContext();
    const input = getCodeTool.input.parse({ codes: ['E11.9', '0DTJ4ZZ', '99999'] });
    const out = await getCodeTool.handler(input, ctx);
    expect(out.found.map((f) => f.code)).toEqual(['E11.9', '0DTJ4ZZ']);
    expect(out.found.map((f) => f.system)).toEqual(['ICD10CM', 'ICD10PCS']);
    expect(out.notFound.map((n) => n.code)).toEqual(['99999']);
  });

  it('attaches hierarchy when requested', async () => {
    const ctx = createMockContext();
    const input = getCodeTool.input.parse({ codes: ['E11'], includeHierarchy: true });
    const out = await getCodeTool.handler(input, ctx);
    expect(out.found[0]?.children?.map((c) => c.code)).toContain('E11.9');
  });

  it('throws no_codes_found when nothing resolves', async () => {
    const ctx = createMockContext({ errors: getCodeTool.errors });
    const input = getCodeTool.input.parse({ codes: ['99999', 'ZZ999'] });
    const err = await caught(() => getCodeTool.handler(input, ctx));
    expect(err.data?.reason).toBe('no_codes_found');
  });

  it('decodes an NDC to its RxNorm product, tagged source NDC', async () => {
    const ctx = createMockContext();
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['11111-2222-33'] }),
      ctx,
    );
    expect(out.found[0]).toMatchObject({ system: 'RXNORM', code: '198440', source: 'NDC' });
  });

  it('decodes a bare RXCUI directly, with no NDC source tag', async () => {
    const ctx = createMockContext();
    const out = await getCodeTool.handler(getCodeTool.input.parse({ codes: ['161'] }), ctx);
    expect(out.found[0]).toMatchObject({ system: 'RXNORM', code: '161' });
    expect(out.found[0]?.source).toBeUndefined();
  });

  it('reports an unknown hyphenated NDC as a valid-format NDC miss', async () => {
    const ctx = createMockContext();
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['11111-2222-33', '99999-8888-77'] }),
      ctx,
    );
    expect(out.found.map((f) => f.code)).toEqual(['198440']);
    expect(out.notFound[0]?.code).toBe('99999-8888-77');
    expect(out.notFound[0]?.reason).toMatch(/NDC format/i);
  });
});

describe('medcode_search_codes', () => {
  it('finds codes by description and discloses no truncation under cap', async () => {
    const ctx = createMockContext();
    const input = searchCodesTool.input.parse({ query: 'diabetic neuropathy' });
    const out = await searchCodesTool.handler(input, ctx);
    expect(out.codes.map((c) => c.code)).toContain('E11.40');
    const enrich = getEnrichment(ctx);
    expect(enrich?.truncated).toBe(false);
    expect(enrich?.effectiveQuery).toBe('diabetic neuropathy');
  });

  it('emits an empty-result notice', async () => {
    const ctx = createMockContext();
    const input = searchCodesTool.input.parse({ query: 'zzzznotarealterm' });
    const out = await searchCodesTool.handler(input, ctx);
    expect(out.codes).toEqual([]);
    expect(getEnrichment(ctx)?.notice).toMatch(/no codes matched/i);
  });

  it('respects the limit and discloses truncation', async () => {
    const ctx = createMockContext();
    const input = searchCodesTool.input.parse({ query: 'diabetes', limit: 1 });
    const out = await searchCodesTool.handler(input, ctx);
    expect(out.codes).toHaveLength(1);
    expect(getEnrichment(ctx)?.truncated).toBe(true);
  });
});

describe('medcode_check_code', () => {
  it('returns valid_billable as a success', async () => {
    const ctx = createMockContext();
    const out = await checkCodeTool.handler(checkCodeTool.input.parse({ code: 'E11.9' }), ctx);
    expect(out.status).toBe('valid_billable');
    expect(out.billable).toBe(true);
    expect(out.whyNot).toBeNull();
  });

  it('returns valid_header with a why-not (not an error)', async () => {
    const ctx = createMockContext();
    const out = await checkCodeTool.handler(checkCodeTool.input.parse({ code: 'E11' }), ctx);
    expect(out.status).toBe('valid_header');
    expect(out.whyNot).toBeTruthy();
  });

  it('returns terminated with a why-not', async () => {
    const ctx = createMockContext();
    const out = await checkCodeTool.handler(checkCodeTool.input.parse({ code: 'K0552' }), ctx);
    expect(out.status).toBe('terminated');
  });

  it('throws unknown_code for an absent code', async () => {
    const ctx = createMockContext({ errors: checkCodeTool.errors });
    const err = await caught(() =>
      checkCodeTool.handler(checkCodeTool.input.parse({ code: '99999' }), ctx),
    );
    expect(err.data?.reason).toBe('unknown_code');
  });

  it('explains a numeric out-of-scope code (CPT) as not-in-RxNorm with an out-of-scope hint', async () => {
    const ctx = createMockContext({ errors: checkCodeTool.errors });
    const err = await caught(() =>
      checkCodeTool.handler(checkCodeTool.input.parse({ code: '99213' }), ctx),
    );
    expect(err.data?.reason).toBe('unknown_code');
    expect(err.message).toMatch(/out of scope/i);
    expect(err.message).toMatch(/CPT/);
  });
});

describe('medcode_map_codes', () => {
  it('maps a code to its parent', async () => {
    const ctx = createMockContext();
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'E11.9', direction: 'parents' }),
      ctx,
    );
    expect(out.hits[0]?.value).toBe('E11');
    expect(out.resolvedSystem).toBe('ICD10CM');
  });

  it('resolves the name_to_rxcui drug direction against bundled RxNorm', async () => {
    const ctx = createMockContext();
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'aspirin', direction: 'name_to_rxcui' }),
      ctx,
    );
    expect(out.resolvedSystem).toBe('RXNORM');
    expect(out.hits.map((h) => h.value)).toContain('1191');
  });

  it('resolves ndc_to_rxcui for a hyphenated NDC, tagged source NDC', async () => {
    const ctx = createMockContext();
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '11111-2222-33', direction: 'ndc_to_rxcui' }),
      ctx,
    );
    expect(out.hits[0]?.value).toBe('198440');
    expect(out.hits[0]?.source).toBe('NDC');
  });

  it('resolves rxcui_to_ingredients and rxcui_to_brands edges', async () => {
    const ing = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_ingredients' }),
      createMockContext(),
    );
    expect(ing.hits.map((h) => h.value)).toContain('161');
    const brands = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_brands' }),
      createMockContext(),
    );
    expect(brands.hits.map((h) => h.value)).toContain('202433');
  });

  it('returns ok-empty with a notice for a top-level code with no parent', async () => {
    const ctx = createMockContext();
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'E11', direction: 'parents' }),
      ctx,
    );
    expect(out.hits).toEqual([]);
    expect(out.resolvedSystem).toBe('ICD10CM');
    const notice = getEnrichment(ctx)?.notice;
    expect(notice).toMatch(/no parent/i);
    expect(notice).toContain('top-level');
  });

  it('returns ok-empty with a PCS-specific notice for an ICD-10-PCS code with no parent', async () => {
    const ctx = createMockContext();
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '0DTJ4ZZ', direction: 'parents' }),
      ctx,
    );
    expect(out.hits).toEqual([]);
    expect(out.resolvedSystem).toBe('ICD10PCS');
    expect(getEnrichment(ctx)?.notice).toMatch(/axis-based and have no prefix parent/i);
  });

  it('returns ok-empty with a notice for a leaf with no children (not the parents wording)', async () => {
    const ctx = createMockContext();
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'J0120', direction: 'children' }),
      ctx,
    );
    expect(out.hits).toEqual([]);
    expect(out.resolvedSystem).toBe('HCPCS');
    const notice = getEnrichment(ctx)?.notice;
    expect(notice).toMatch(/no children/i);
    expect(notice).not.toMatch(/no parent/i);
  });

  it('still throws no_mapping when the source does not resolve to any bundled code', async () => {
    const ctx = createMockContext({ errors: mapCodesTool.errors });
    const err = await caught(() =>
      mapCodesTool.handler(mapCodesTool.input.parse({ from: 'Z9999', direction: 'parents' }), ctx),
    );
    expect(err.data?.reason).toBe('no_mapping');
    expect(err.message).toContain('No bundled code matches');
  });

  it('maps a HCPCS code to its seeded letter-bucket parent', async () => {
    const ctx = createMockContext();
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'J0120', direction: 'parents' }),
      ctx,
    );
    expect(out.resolvedSystem).toBe('HCPCS');
    expect(out.hits[0]?.value).toBe('J');
  });
});

describe('medcode_browse_hierarchy', () => {
  it('returns child codes for ICD-10-CM', async () => {
    const ctx = createMockContext();
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10CM', node: 'E11' }),
      ctx,
    );
    expect(out.kind).toBe('codes');
    expect(out.codes.map((c) => c.code)).toContain('E11.9');
  });

  it('returns axis values for ICD-10-PCS', async () => {
    const ctx = createMockContext();
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10PCS' }),
      ctx,
    );
    expect(out.kind).toBe('axes');
    expect(out.axes.some((a) => a.position === 1)).toBe(true);
  });

  it('throws unknown_node for a non-existent node', async () => {
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
    const err = await caught(() =>
      browseHierarchyTool.handler(
        browseHierarchyTool.input.parse({ system: 'ICD10CM', node: 'ZZZ' }),
        ctx,
      ),
    );
    expect(err.data?.reason).toBe('unknown_node');
  });

  it('returns HCPCS letter buckets at the top level (no node)', async () => {
    const ctx = createMockContext();
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'HCPCS' }),
      ctx,
    );
    expect(out.kind).toBe('codes');
    expect(out.codes.map((c) => c.code)).toContain('J');
    expect(getEnrichment(ctx)?.shown).toBeGreaterThan(0);
  });

  it('returns the codes under a HCPCS bucket node', async () => {
    const ctx = createMockContext();
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'HCPCS', node: 'J' }),
      ctx,
    );
    expect(out.kind).toBe('codes');
    expect(out.codes.map((c) => c.code)).toContain('J0120');
  });

  it('returns empty axes plus a context-dependent notice for a partial ICD-10-PCS node', async () => {
    const ctx = createMockContext();
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10PCS', node: '0D' }),
      ctx,
    );
    expect(out.kind).toBe('axes');
    expect(out.axes).toEqual([]);
    expect(getEnrichment(ctx)?.notice).toMatch(/context-dependent|not enumerable/i);
  });

  it('steers to search/get_code/map_codes when browsing the flat RXNORM vocabulary', async () => {
    const ctx = createMockContext();
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'RXNORM' }),
      ctx,
    );
    expect(out.kind).toBe('codes');
    expect(out.codes).toEqual([]);
    expect(getEnrichment(ctx)?.notice).toMatch(/flat drug vocabulary|no prefix hierarchy/i);
  });
});

describe('medcode_search_codes — pagination (#17)', () => {
  it('paginates via nextCursor and reconstructs the ranked set by code identity', async () => {
    const full = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'diabetes', limit: 50 }),
      createMockContext(),
    );
    expect(full.codes).toHaveLength(4);

    const ctx1 = createMockContext();
    const p1 = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'diabetes', limit: 2 }),
      ctx1,
    );
    const e1 = getEnrichment(ctx1);
    expect(p1.codes).toHaveLength(2);
    expect(e1?.truncated).toBe(true);
    expect(typeof e1?.nextCursor).toBe('string');

    const ctx2 = createMockContext();
    const p2 = await searchCodesTool.handler(
      searchCodesTool.input.parse({
        query: 'diabetes',
        limit: 2,
        cursor: e1?.nextCursor as string,
      }),
      ctx2,
    );
    const e2 = getEnrichment(ctx2);
    expect(p2.codes).toHaveLength(2);
    expect(e2?.truncated).toBe(false);
    expect(e2?.nextCursor).toBeUndefined();

    expect([...p1.codes, ...p2.codes].map((c) => c.code)).toEqual(full.codes.map((c) => c.code));
  });
});

describe('medcode_browse_hierarchy — pagination (#16)', () => {
  // Fixture: ICD-10-CM A00 has exactly two children A00.0/A00.1.
  it('honors the node-path limit with correct metadata (limit:1 → shown:1, cap:1, not shown:50/cap:1)', async () => {
    const ctx = createMockContext();
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10CM', node: 'A00', limit: 1 }),
      ctx,
    );
    expect(out.codes).toHaveLength(1);
    expect(out.codes[0]?.code).toBe('A00.0');
    const e = getEnrichment(ctx);
    expect(e?.shown).toBe(1);
    expect(e?.cap).toBe(1);
    expect(e?.truncated).toBe(true);
    expect(typeof e?.nextCursor).toBe('string');
  });

  it('paginates children via nextCursor and reconstructs by code identity', async () => {
    const ctx1 = createMockContext();
    const p1 = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10CM', node: 'A00', limit: 1 }),
      ctx1,
    );
    const cursor = getEnrichment(ctx1)?.nextCursor as string;

    const ctx2 = createMockContext();
    const p2 = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10CM', node: 'A00', limit: 1, cursor }),
      ctx2,
    );
    const e2 = getEnrichment(ctx2);
    expect(p2.codes.map((c) => c.code)).toEqual(['A00.1']);
    expect(e2?.truncated).toBe(false);
    expect(e2?.nextCursor).toBeUndefined();

    expect([...p1.codes, ...p2.codes].map((c) => c.code)).toEqual(['A00.0', 'A00.1']);
  });

  it('reports complete (truncated:false) at the exact child count', async () => {
    const ctx = createMockContext();
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10CM', node: 'A00', limit: 2 }),
      ctx,
    );
    expect(out.codes).toHaveLength(2);
    const e = getEnrichment(ctx);
    expect(e?.shown).toBe(2);
    expect(e?.cap).toBe(2);
    expect(e?.truncated).toBe(false);
    expect(e?.nextCursor).toBeUndefined();
  });
});

describe('medcode_get_code — childrenTruncated (#16)', () => {
  it('discloses childrenTruncated:false when children fit the cap', async () => {
    const ctx = createMockContext();
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['E11'], includeHierarchy: true }),
      ctx,
    );
    expect(out.found[0]?.childrenTruncated).toBe(false);
  });

  it('omits childrenTruncated when hierarchy is not requested', async () => {
    const ctx = createMockContext();
    const out = await getCodeTool.handler(getCodeTool.input.parse({ codes: ['E11'] }), ctx);
    expect(out.found[0]?.childrenTruncated).toBeUndefined();
  });
});

describe('medcode_map_codes — pagination (#16 children, #18 name_to_rxcui)', () => {
  it('paginates the children direction via nextCursor and reconstructs by code identity', async () => {
    const ctx1 = createMockContext();
    const p1 = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'A00', direction: 'children', system: 'ICD10CM', limit: 1 }),
      ctx1,
    );
    const e1 = getEnrichment(ctx1);
    expect(p1.hits.map((h) => h.value)).toEqual(['A00.0']);
    expect(e1?.truncated).toBe(true);
    expect(e1?.shown).toBe(1);
    expect(typeof e1?.nextCursor).toBe('string');

    const ctx2 = createMockContext();
    const p2 = await mapCodesTool.handler(
      mapCodesTool.input.parse({
        from: 'A00',
        direction: 'children',
        system: 'ICD10CM',
        limit: 1,
        cursor: e1?.nextCursor as string,
      }),
      ctx2,
    );
    const e2 = getEnrichment(ctx2);
    expect(p2.hits.map((h) => h.value)).toEqual(['A00.1']);
    expect(e2?.truncated).toBe(false);
    expect(e2?.nextCursor).toBeUndefined();

    expect([...p1.hits, ...p2.hits].map((h) => h.value)).toEqual(['A00.0', 'A00.1']);
  });

  it('paginates name_to_rxcui via nextCursor and reconstructs by RXCUI identity', async () => {
    const full = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'a', direction: 'name_to_rxcui', limit: 50 }),
      createMockContext(),
    );
    const fullValues = full.hits.map((h) => h.value);
    expect(fullValues).toEqual(['161', '1191', '198440', '1049640']);

    const ctx1 = createMockContext();
    const p1 = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'a', direction: 'name_to_rxcui', limit: 2 }),
      ctx1,
    );
    const e1 = getEnrichment(ctx1);
    expect(p1.hits.map((h) => h.value)).toEqual(['161', '1191']);
    expect(e1?.truncated).toBe(true);
    expect(typeof e1?.nextCursor).toBe('string');

    const ctx2 = createMockContext();
    const p2 = await mapCodesTool.handler(
      mapCodesTool.input.parse({
        from: 'a',
        direction: 'name_to_rxcui',
        limit: 2,
        cursor: e1?.nextCursor as string,
      }),
      ctx2,
    );
    const e2 = getEnrichment(ctx2);
    expect(p2.hits.map((h) => h.value)).toEqual(['198440', '1049640']);
    expect(e2?.truncated).toBe(false);
    expect(e2?.nextCursor).toBeUndefined();

    expect([...p1.hits, ...p2.hits].map((h) => h.value)).toEqual(fullValues);
  });
});
