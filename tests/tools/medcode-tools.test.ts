/**
 * @fileoverview Handler tests for the six medcode_* tools against the bundled
 * fixture DB. Covers success paths, partial-success batching, the typed error
 * contracts (no_codes_found, unknown_code, no_mapping, direction_unavailable,
 * unknown_node), and enrichment (truncation, empty-result notice).
 * @module tests/tools/medcode-tools.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { listSystemsTool } from '@/mcp-server/tools/definitions/list-systems.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import type { CodeIndexService } from '@/services/code-index/code-index-service.js';
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

let svc: CodeIndexService;
beforeAll(async () => {
  svc = await ensureIndex();
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
    const ctx = createMockContext({ errors: getCodeTool.errors });
    const input = getCodeTool.input.parse({ codes: ['E11.9', '0DTJ4ZZ', '99999'] });
    const out = await getCodeTool.handler(input, ctx);
    expect(out.found.map((f) => f.code)).toEqual(['E11.9', '0DTJ4ZZ']);
    expect(out.found.map((f) => f.system)).toEqual(['ICD10CM', 'ICD10PCS']);
    expect(out.notFound.map((n) => n.code)).toEqual(['99999']);
  });

  it('attaches hierarchy when requested', async () => {
    const ctx = createMockContext({ errors: getCodeTool.errors });
    const input = getCodeTool.input.parse({ codes: ['E11'], includeHierarchy: true });
    const out = await getCodeTool.handler(input, ctx);
    expect(out.found[0]?.children?.map((c) => c.code)).toContain('E11.9');
  });

  it('attaches the stored parent for a non-prefix system', async () => {
    // HCPCS parents come from the stored `parent` column (the letter bucket), not
    // from the ICD-10-CM prefix rule.
    const ctx = createMockContext({ errors: getCodeTool.errors });
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['J0120'], includeHierarchy: true }),
      ctx,
    );
    expect(out.found[0]).toMatchObject({ system: 'HCPCS', parent: 'J', children: [] });
  });

  it('throws no_codes_found when nothing resolves', async () => {
    const ctx = createMockContext({ errors: getCodeTool.errors });
    const input = getCodeTool.input.parse({ codes: ['99999', 'ZZ999'] });
    const err = await caught(() => getCodeTool.handler(input, ctx));
    expect(err.data?.reason).toBe('no_codes_found');
  });

  it('decodes an NDC to its RxNorm product, tagged source NDC', async () => {
    const ctx = createMockContext({ errors: getCodeTool.errors });
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['11111-2222-33'] }),
      ctx,
    );
    expect(out.found[0]).toMatchObject({ system: 'RXNORM', code: '198440', source: 'NDC' });
  });

  it('decodes a bare RXCUI directly, with no NDC source tag', async () => {
    const ctx = createMockContext({ errors: getCodeTool.errors });
    const out = await getCodeTool.handler(getCodeTool.input.parse({ codes: ['161'] }), ctx);
    expect(out.found[0]).toMatchObject({ system: 'RXNORM', code: '161' });
    expect(out.found[0]?.source).toBeUndefined();
  });

  it('reports an unknown hyphenated NDC as a valid-format NDC miss', async () => {
    const ctx = createMockContext({ errors: getCodeTool.errors });
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

  it('names the system filter in the empty-result notice so the caller can widen it', async () => {
    const ctx = createMockContext();
    const out = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'diabetes', system: 'HCPCS' }),
      ctx,
    );
    expect(out.codes).toEqual([]);
    expect(getEnrichment(ctx)?.notice).toContain('in HCPCS');
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
    const ctx = createMockContext({ errors: checkCodeTool.errors });
    const out = await checkCodeTool.handler(checkCodeTool.input.parse({ code: 'E11.9' }), ctx);
    expect(out.status).toBe('valid_billable');
    expect(out.billable).toBe(true);
    expect(out.whyNot).toBeNull();
  });

  it('returns valid_header with a why-not (not an error)', async () => {
    const ctx = createMockContext({ errors: checkCodeTool.errors });
    const out = await checkCodeTool.handler(checkCodeTool.input.parse({ code: 'E11' }), ctx);
    expect(out.status).toBe('valid_header');
    expect(out.whyNot).toBeTruthy();
  });

  it('returns terminated with a why-not', async () => {
    const ctx = createMockContext({ errors: checkCodeTool.errors });
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

  it('throws ambiguous_system with the candidate systems for a cross-system code', async () => {
    const ctx = createMockContext({ errors: checkCodeTool.errors });
    const err = await caught(() =>
      checkCodeTool.handler(checkCodeTool.input.parse({ code: 'A0100' }), ctx),
    );
    expect(err.data?.reason).toBe('ambiguous_system');
    expect(err.message).toContain('ICD10CM, HCPCS');
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
    const ctx = createMockContext({ errors: mapCodesTool.errors });
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'E11.9', direction: 'parents' }),
      ctx,
    );
    expect(out.hits[0]?.value).toBe('E11');
    expect(out.resolvedSystem).toBe('ICD10CM');
  });

  it('resolves the name_to_rxcui drug direction against bundled RxNorm', async () => {
    const ctx = createMockContext({ errors: mapCodesTool.errors });
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'aspirin', direction: 'name_to_rxcui' }),
      ctx,
    );
    expect(out.resolvedSystem).toBe('RXNORM');
    expect(out.hits.map((h) => h.value)).toContain('1191');
  });

  it('resolves ndc_to_rxcui for a hyphenated NDC, tagged source NDC', async () => {
    const ctx = createMockContext({ errors: mapCodesTool.errors });
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
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(ing.hits.map((h) => h.value)).toContain('161');
    const brands = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_brands' }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(brands.hits.map((h) => h.value)).toContain('202433');
  });

  it('returns ok-empty with a notice for a top-level code with no parent', async () => {
    const ctx = createMockContext({ errors: mapCodesTool.errors });
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
    const ctx = createMockContext({ errors: mapCodesTool.errors });
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '0DTJ4ZZ', direction: 'parents' }),
      ctx,
    );
    expect(out.hits).toEqual([]);
    expect(out.resolvedSystem).toBe('ICD10PCS');
    expect(getEnrichment(ctx)?.notice).toMatch(/axis-based and have no prefix parent/i);
  });

  it('returns ok-empty with a notice for a leaf with no children (not the parents wording)', async () => {
    const ctx = createMockContext({ errors: mapCodesTool.errors });
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
    const ctx = createMockContext({ errors: mapCodesTool.errors });
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'J0120', direction: 'parents' }),
      ctx,
    );
    expect(out.resolvedSystem).toBe('HCPCS');
    expect(out.hits[0]?.value).toBe('J');
  });

  it('throws ambiguous_system rather than guessing which system a cross-system code meant', async () => {
    const ctx = createMockContext({ errors: mapCodesTool.errors });
    const err = await caught(() =>
      mapCodesTool.handler(mapCodesTool.input.parse({ from: 'A0100', direction: 'parents' }), ctx),
    );
    expect(err.data?.reason).toBe('ambiguous_system');
    expect(err.message).toContain('ICD10CM, HCPCS');
  });

  it('throws no_mapping only when the RXCUI is not a bundled concept', async () => {
    const ctx = createMockContext({ errors: mapCodesTool.errors });
    const err = await caught(() =>
      mapCodesTool.handler(
        mapCodesTool.input.parse({ from: '999999999', direction: 'rxcui_to_ndc' }),
        ctx,
      ),
    );
    expect(err.data?.reason).toBe('no_mapping');

    // A concept that IS bundled but carries no packages is an empty result — the
    // error means the source did not resolve, never that it has no edges.
    const okCtx = createMockContext({ errors: mapCodesTool.errors });
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '161', direction: 'rxcui_to_ndc' }),
      okCtx,
    );
    expect(out.hits).toEqual([]);
    expect(out.resolvedSystem).toBe('RXNORM');
  });
});

describe('medcode_browse_hierarchy', () => {
  it('returns child codes for ICD-10-CM', async () => {
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10CM', node: 'E11' }),
      ctx,
    );
    expect(out.kind).toBe('codes');
    expect(out.codes.map((c) => c.code)).toContain('E11.9');
  });

  it('returns axis values for ICD-10-PCS', async () => {
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
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
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'HCPCS' }),
      ctx,
    );
    expect(out.kind).toBe('codes');
    expect(out.codes.map((c) => c.code)).toContain('J');
    expect(getEnrichment(ctx)?.shown).toBeGreaterThan(0);
  });

  it('returns the codes under a HCPCS bucket node', async () => {
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'HCPCS', node: 'J' }),
      ctx,
    );
    expect(out.kind).toBe('codes');
    expect(out.codes.map((c) => c.code)).toContain('J0120');
  });

  it('steers back to the top level when a leaf node has no children', async () => {
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'HCPCS', node: 'A0100' }),
      ctx,
    );
    expect(out.codes).toEqual([]);
    const notice = getEnrichment(ctx)?.notice;
    expect(notice).toContain('No children under "A0100" in HCPCS');
    expect(notice).toMatch(/leaf code/i);
  });

  it('returns empty axes plus a context-dependent notice for a partial ICD-10-PCS node', async () => {
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10PCS', node: '0D' }),
      ctx,
    );
    expect(out.kind).toBe('axes');
    expect(out.axes).toEqual([]);
    expect(getEnrichment(ctx)?.notice).toMatch(/context-dependent|not enumerable/i);
  });

  it('steers to search/get_code/map_codes when browsing the flat RXNORM vocabulary', async () => {
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'RXNORM' }),
      ctx,
    );
    expect(out.kind).toBe('codes');
    expect(out.codes).toEqual([]);
    expect(getEnrichment(ctx)?.notice).toMatch(/flat drug vocabulary|no prefix hierarchy/i);
  });

  it('returns empty axes with a complete-code notice for a complete ICD-10-PCS code (#13)', async () => {
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10PCS', node: '0DTJ4ZZ' }),
      ctx,
    );
    expect(out.kind).toBe('axes');
    expect(out.axes).toEqual([]);
    // Distinct from the partial-node notice — it names the complete code, not the
    // "positions 2–7 are context-dependent" partial wording.
    expect(getEnrichment(ctx)?.notice).toMatch(/complete 7-character/i);
  });

  it('still throws unknown_node for a shape-valid but absent ICD-10-PCS code (#13)', async () => {
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
    const err = await caught(() =>
      browseHierarchyTool.handler(
        browseHierarchyTool.input.parse({ system: 'ICD10PCS', node: '0DTJ1ZZ' }),
        ctx,
      ),
    );
    expect(err.data?.reason).toBe('unknown_node');
  });
});

describe('whitespace-only required strings are rejected (#14)', () => {
  // A whitespace value clears .min(1); the shared nonBlankString .refine then rejects
  // it at the Zod boundary, before any handler (and its service call — e.g.
  // map_codes' name_to_rxcui LIKE '%%') runs. On the wire the MCP SDK enforces this
  // same schema and returns InvalidParams (-32602) — verified in the live stdio
  // field-test; the unit level pins the durable contract: the schema rejects it.
  interface ParsedIssue {
    code: string;
    message: string;
    path: (string | number)[];
  }
  function issuesOf(fn: () => unknown): ParsedIssue[] {
    try {
      fn();
    } catch (e) {
      return (e as { issues?: ParsedIssue[] }).issues ?? [];
    }
    throw new Error('expected input.parse to throw, but it resolved');
  }

  it('rejects a whitespace-only map_codes.from (the name_to_rxcui LIKE %% case)', () => {
    const [issue] = issuesOf(() =>
      mapCodesTool.input.parse({ from: '   ', direction: 'name_to_rxcui' }),
    );
    expect(issue).toMatchObject({ path: ['from'], code: 'custom' });
    expect(issue?.message).toMatch(/blank or whitespace-only/);
  });
  it('rejects a whitespace-only search_codes.query', () => {
    expect(() => searchCodesTool.input.parse({ query: ' \t ' })).toThrow(
      /blank or whitespace-only/,
    );
  });
  it('rejects a whitespace-only check_code.code', () => {
    expect(() => checkCodeTool.input.parse({ code: '   ' })).toThrow(/blank or whitespace-only/);
  });
  it('rejects a whitespace-only element in get_code.codes[]', () => {
    const [issue] = issuesOf(() => getCodeTool.input.parse({ codes: ['E11.9', '   '] }));
    expect(issue?.path).toEqual(['codes', 1]);
    expect(issue?.message).toMatch(/blank or whitespace-only/);
  });
  it('rejects a whitespace-only browse_hierarchy.node but keeps empty/omitted as top level', () => {
    expect(() => browseHierarchyTool.input.parse({ system: 'ICD10PCS', node: '   ' })).toThrow();
    // Empty string and omitted both still mean "top level" — the guard must not break it.
    expect(() => browseHierarchyTool.input.parse({ system: 'ICD10PCS', node: '' })).not.toThrow();
    expect(() => browseHierarchyTool.input.parse({ system: 'ICD10PCS' })).not.toThrow();
  });
  it('still accepts valid non-blank input (guard is not over-broad)', () => {
    expect(() =>
      mapCodesTool.input.parse({ from: 'aspirin', direction: 'name_to_rxcui' }),
    ).not.toThrow();
    expect(() => searchCodesTool.input.parse({ query: 'diabetes' })).not.toThrow();
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
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
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
    const ctx1 = createMockContext({ errors: browseHierarchyTool.errors });
    const p1 = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10CM', node: 'A00', limit: 1 }),
      ctx1,
    );
    const cursor = getEnrichment(ctx1)?.nextCursor as string;

    const ctx2 = createMockContext({ errors: browseHierarchyTool.errors });
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
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
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
    const ctx = createMockContext({ errors: getCodeTool.errors });
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['E11'], includeHierarchy: true }),
      ctx,
    );
    expect(out.found[0]?.childrenTruncated).toBe(false);
  });

  it('omits childrenTruncated when hierarchy is not requested', async () => {
    const ctx = createMockContext({ errors: getCodeTool.errors });
    const out = await getCodeTool.handler(getCodeTool.input.parse({ codes: ['E11'] }), ctx);
    expect(out.found[0]?.childrenTruncated).toBeUndefined();
  });
});

describe('medcode_map_codes — pagination (#16 children, #18 name_to_rxcui, #20 rxcui_to_ndc)', () => {
  it('paginates rxcui_to_ndc via nextCursor and reconstructs by NDC identity', async () => {
    const full = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '1049640', direction: 'rxcui_to_ndc', limit: 50 }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    const fullValues = full.hits.map((h) => h.value);
    expect(fullValues).toHaveLength(5);

    const walked: string[] = [];
    let cursor: string | undefined;
    const truncatedFlags: (boolean | undefined)[] = [];
    do {
      const ctx = createMockContext({ errors: mapCodesTool.errors });
      const page = await mapCodesTool.handler(
        mapCodesTool.input.parse({ from: '1049640', direction: 'rxcui_to_ndc', limit: 2, cursor }),
        ctx,
      );
      const e = getEnrichment(ctx);
      expect(e?.cap).toBe(2);
      expect(e?.shown).toBe(page.hits.length);
      truncatedFlags.push(e?.truncated as boolean | undefined);
      walked.push(...page.hits.map((h) => h.value));
      cursor = e?.nextCursor as string | undefined;
    } while (cursor);

    expect(truncatedFlags).toEqual([true, true, false]);
    expect(walked).toEqual(fullValues);
  });

  it('carries the rxcui_to_ndc continuation disclosure on both client paths', async () => {
    // Through the full contract boundary: structuredContent (Claude Code) carries
    // the merged enrichment, content[] (text-only clients) carries the trailer.
    const result = await runToolContract(mapCodesTool, {
      from: '1049640',
      direction: 'rxcui_to_ndc',
      limit: 2,
    });
    expect(result.structuredContent).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    const cursor = (result.structuredContent as { nextCursor?: string }).nextCursor;
    expect(typeof cursor).toBe('string');

    const text = (result.content as { text?: string; type: string }[])
      .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
      .join('\n');
    expect(text).toContain('00904516140');
    expect(text).toContain(cursor as string);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/27
  // https://github.com/cyanheads/medical-codes-mcp-server/issues/28
  it('carries the target name and concept type across the full contract boundary', async () => {
    // Calling the handler directly skips output validation, so it cannot tell a
    // declared field from an undeclared one the wire would drop. Through the
    // contract, structuredContent only carries what the output schema declares.
    const ingredients = await runToolContract(mapCodesTool, {
      from: '198440',
      direction: 'rxcui_to_ingredients',
    });
    expect(ingredients.structuredContent).toMatchObject({
      hits: [
        { value: '161', source: 'has_ingredient', description: 'acetaminophen', conceptType: 'IN' },
      ],
    });

    const decoded = await runToolContract(mapCodesTool, {
      from: '11111-2222-33',
      direction: 'ndc_to_rxcui',
    });
    expect(decoded.structuredContent).toMatchObject({
      hits: [
        {
          value: '198440',
          source: 'NDC',
          description: 'Acetaminophen 500 MG Oral Tablet',
        },
      ],
    });
  });

  it('paginates the children direction via nextCursor and reconstructs by code identity', async () => {
    const ctx1 = createMockContext({ errors: mapCodesTool.errors });
    const p1 = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'A00', direction: 'children', system: 'ICD10CM', limit: 1 }),
      ctx1,
    );
    const e1 = getEnrichment(ctx1);
    expect(p1.hits.map((h) => h.value)).toEqual(['A00.0']);
    expect(e1?.truncated).toBe(true);
    expect(e1?.shown).toBe(1);
    expect(typeof e1?.nextCursor).toBe('string');

    const ctx2 = createMockContext({ errors: mapCodesTool.errors });
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
      createMockContext({ errors: mapCodesTool.errors }),
    );
    const fullValues = full.hits.map((h) => h.value);
    expect(fullValues).toEqual(['161', '1191', '198440', '1049640']);

    const ctx1 = createMockContext({ errors: mapCodesTool.errors });
    const p1 = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'a', direction: 'name_to_rxcui', limit: 2 }),
      ctx1,
    );
    const e1 = getEnrichment(ctx1);
    expect(p1.hits.map((h) => h.value)).toEqual(['161', '1191']);
    expect(e1?.truncated).toBe(true);
    expect(typeof e1?.nextCursor).toBe('string');

    const ctx2 = createMockContext({ errors: mapCodesTool.errors });
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

// ─── map_codes / get_code input and not-found contracts ──────────────────────

type MapArgs = Record<string, unknown> & { direction: string; from: string };

interface ThrownError {
  code?: number;
  data?: { direction?: string; fields?: string[]; reason?: string; recovery?: { hint?: string } };
  message: string;
}

/** Run the map_codes handler with fresh context, returning its output and enrichment. */
async function mapCall(args: MapArgs) {
  const ctx = createMockContext({ errors: mapCodesTool.errors });
  const out = await mapCodesTool.handler(mapCodesTool.input.parse(args), ctx);
  return { out, enrich: getEnrichment(ctx) };
}

/** Run the map_codes handler and return what it threw. */
function mapError(args: MapArgs): Promise<ThrownError> {
  return caught(() =>
    mapCodesTool.handler(
      mapCodesTool.input.parse(args),
      createMockContext({ errors: mapCodesTool.errors }),
    ),
  ) as Promise<ThrownError>;
}

/** Every text block a content-only client receives. */
function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content as { text?: string; type: string }[])
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n');
}

/** Error envelope from a runToolContract failure. */
function envelopeOf(result: Awaited<ReturnType<typeof runToolContract>>) {
  return (result.structuredContent as { error: ThrownError }).error;
}

/** Run `fn` against a build whose RxNorm tables are empty, restoring the real answer after. */
async function withoutRxNorm<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(svc, 'hasRxNorm').mockReturnValue(false);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

const declaredRecovery = (tool: typeof mapCodesTool | typeof getCodeTool, reason: string) =>
  tool.errors?.find((entry) => entry.reason === reason)?.recovery;

// https://github.com/cyanheads/medical-codes-mcp-server/issues/36
describe('medcode_map_codes — a field the direction does not use is rejected', () => {
  /** One fixture source per direction, each with at least two results where the direction pages. */
  const SOURCES = {
    parents: 'E11.9',
    children: 'A00',
    name_to_rxcui: 'a',
    ndc_to_rxcui: '11111-2222-33',
    rxcui_to_ndc: '1049640',
    rxcui_to_ingredients: '198440',
    rxcui_to_brands: '198440',
  } as const;
  const DIRECTIONS = Object.keys(SOURCES) as (keyof typeof SOURCES)[];
  const HIERARCHY = new Set(['parents', 'children']);
  const PAGINATED = new Set(['children', 'name_to_rxcui', 'rxcui_to_ndc']);
  const cursorAt = (offset: number, limit: number) =>
    Buffer.from(JSON.stringify({ offset, limit })).toString('base64url');

  async function expectRejected(args: MapArgs, fields: string[]) {
    const err = await mapError(args);
    expect(err.data?.reason, JSON.stringify(args)).toBe('field_not_applicable');
    expect(err.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(err.data?.fields).toEqual(fields);
    expect(err.data?.direction).toBe(args.direction);
    expect(err.message).toContain(`"${args.direction}"`);
    for (const field of fields) expect(err.message).toContain(`\`${field}\``);
    expect(err.data?.recovery?.hint).toBe(declaredRecovery(mapCodesTool, 'field_not_applicable'));
  }

  describe.each(DIRECTIONS)('%s', (direction) => {
    const from = SOURCES[direction];
    const hierarchy = HIERARCHY.has(direction);
    const paginated = PAGINATED.has(direction);

    it(`system — ${hierarchy ? 'applies' : 'accepts only RXNORM, as a no-op'}`, async () => {
      const baseline = await mapCall({ from, direction });
      expect(baseline.out.hits.length).toBeGreaterThan(0);
      if (hierarchy) {
        // The source's own system resolves it exactly as auto-detection does…
        expect((await mapCall({ from, direction, system: 'ICD10CM' })).out).toEqual(baseline.out);
        // …and another system is a lookup there, not a rejected field.
        expect((await mapError({ from, direction, system: 'HCPCS' })).data?.reason).toBe(
          'no_mapping',
        );
      } else {
        expect((await mapCall({ from, direction, system: 'RXNORM' })).out).toEqual(baseline.out);
        for (const system of ['ICD10CM', 'ICD10PCS', 'HCPCS']) {
          await expectRejected({ from, direction, system }, ['system']);
        }
      }
    });

    it(`limit — ${paginated ? 'caps the page' : 'rejected'}`, async () => {
      if (!paginated) {
        await expectRejected({ from, direction, limit: 1 }, ['limit']);
        return;
      }
      const capped = await mapCall({ from, direction, limit: 1 });
      expect(capped.out.hits).toHaveLength(1);
      expect(capped.enrich).toMatchObject({ truncated: true, shown: 1, cap: 1 });
    });

    it(`cursor — ${paginated ? 'walks past the first page' : 'rejected'}`, async () => {
      if (!paginated) {
        await expectRejected({ from, direction, cursor: cursorAt(1, 1) }, ['cursor']);
        // A cursor the decoder would refuse is still refused for the direction first.
        await expectRejected({ from, direction, cursor: 'not-a-cursor' }, ['cursor']);
        return;
      }
      const full = await mapCall({ from, direction, limit: 200 });
      const second = await mapCall({ from, direction, cursor: cursorAt(1, 1) });
      expect(second.out.hits.map((h) => h.value)).toEqual([full.out.hits[1]?.value]);
      // Past the end is an empty page, not an error.
      const beyond = await mapCall({ from, direction, cursor: cursorAt(999_999, 1) });
      expect(beyond.out.hits).toEqual([]);
      expect(beyond.enrich?.notice).toMatch(/page starts past the last/i);
      // A malformed cursor still fails as it always has — on the cursor, not the field.
      const malformed = await mapError({ from, direction, cursor: 'not-a-cursor' });
      expect(malformed.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(malformed.data?.reason).not.toBe('field_not_applicable');
    });

    it('treats an empty cursor as omitted', async () => {
      expect((await mapCall({ from, direction, cursor: '' })).out).toEqual(
        (await mapCall({ from, direction })).out,
      );
    });
  });

  it('names every rejected field in one error', async () => {
    await expectRejected(
      { from: '198440', direction: 'rxcui_to_ingredients', system: 'HCPCS', limit: 1 },
      ['system', 'limit'],
    );
    await expectRejected(
      { from: 'E11.9', direction: 'parents', limit: 2, cursor: cursorAt(1, 1) },
      ['limit', 'cursor'],
    );
    await expectRejected(
      {
        from: '11111-2222-33',
        direction: 'ndc_to_rxcui',
        system: 'ICD10CM',
        limit: 1,
        cursor: cursorAt(0, 1),
      },
      ['system', 'limit', 'cursor'],
    );
  });

  it('keeps the page boundaries of the directions that do page', async () => {
    // At the exact package count the page is complete, not truncated.
    const exact = await mapCall({ from: '1049640', direction: 'rxcui_to_ndc', limit: 5 });
    expect(exact.out.hits).toHaveLength(5);
    expect(exact.enrich).toMatchObject({ truncated: false, shown: 5, cap: 5 });
    expect(exact.enrich?.nextCursor).toBeUndefined();
    // A leaf paged with an explicit limit is still an empty result, not a rejection.
    const leaf = await mapCall({ from: 'E11.9', direction: 'children', limit: 1 });
    expect(leaf.out.hits).toEqual([]);
    expect(leaf.enrich).toMatchObject({ truncated: false, shown: 0, cap: 1 });
  });

  it('reports a drug direction a build without RxNorm cannot run ahead of its fields', async () => {
    // Dropping the field would only reach this error, so the field is not the news.
    const err = await withoutRxNorm(() =>
      mapError({ from: '198440', direction: 'rxcui_to_brands', limit: 1, system: 'HCPCS' }),
    );
    expect(err.data?.reason).toBe('direction_unavailable');
    // A hierarchy direction still runs there, so its inapplicable field is still rejected.
    const hierarchy = await withoutRxNorm(() =>
      mapError({ from: 'E11.9', direction: 'parents', limit: 1 }),
    );
    expect(hierarchy.data?.reason).toBe('field_not_applicable');
  });
});

const CPT_SENTENCE =
  'If this is a CPT or HCPCS Level I code, those are out of scope — this server bundles ICD-10-CM, ICD-10-PCS, HCPCS Level II, and RxNorm.';
const CPT_SENTENCE_NO_RXNORM =
  'RxNorm is not present in this build, and CPT / HCPCS Level I are out of scope — this build carries ICD-10-CM, ICD-10-PCS, and HCPCS Level II.';
/** The ndc_to_rxcui miss for a spelling ndcCandidates() refuses, after the quoted value (#50). */
const NDC_MALFORMED_TAIL =
  'is not an NDC spelling this server reads: an NDC is hyphenated in an FDA segment configuration (4-4-2, 5-3-2, 5-4-1, or 5-4-2) or written as bare 10 or 11 digits.';

// https://github.com/cyanheads/medical-codes-mcp-server/issues/38
describe('medcode_map_codes — a bare integer that resolves nowhere', () => {
  it.each(['parents', 'children', 'rxcui_to_ndc', 'rxcui_to_ingredients', 'rxcui_to_brands'])(
    'names CPT / HCPCS Level I as out of scope on %s, on both surfaces',
    async (direction) => {
      const result = await runToolContract(mapCodesTool, { from: '43239', direction } as never);
      expect(result.isError).toBe(true);
      const error = envelopeOf(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('no_mapping');
      expect(error.message).toBe(`No bundled code matches "43239". ${CPT_SENTENCE}`);
      const hint = error.data?.recovery?.hint ?? '';
      expect(hint).not.toBe(declaredRecovery(mapCodesTool, 'no_mapping'));
      expect(hint).toContain('medcode_search_codes');
      expect(hint).toContain('ICD-10-PCS');

      const text = contentText(result);
      expect(text).toContain(CPT_SENTENCE);
      expect(text).toContain(hint);
      expect(text).toContain('(reason no_mapping)');
    },
  );

  it('keeps the generic miss on name_to_rxcui, which reads the value as a name', async () => {
    const err = await mapError({ from: '43239', direction: 'name_to_rxcui' });
    expect(err.data?.reason).toBe('no_mapping');
    expect(err.message).toBe('No bundled code matches "43239".');
    expect(err.data?.recovery?.hint).toBe(declaredRecovery(mapCodesTool, 'no_mapping'));
  });

  it('reads the value as an NDC spelling on ndc_to_rxcui, with no CPT sentence', async () => {
    // Five digits is no NDC configuration, so #50's malformed-spelling miss answers.
    const err = await mapError({ from: '43239', direction: 'ndc_to_rxcui' });
    expect(err.data?.reason).toBe('no_mapping');
    expect(err.message).toBe(`"43239" ${NDC_MALFORMED_TAIL}`);
    expect(err.message).not.toMatch(/CPT/);
  });

  it('keeps the generic miss for a value that is not a bare integer', async () => {
    for (const from of ['ZZZZZZ9', '432.39', '43239A']) {
      const err = await mapError({ from, direction: 'parents' });
      expect(err.message).toBe(`No bundled code matches "${from}".`);
      expect(err.data?.recovery?.hint).toBe(declaredRecovery(mapCodesTool, 'no_mapping'));
    }
  });

  it('resolves a bare integer that is a bundled RXCUI instead of calling it out of scope', async () => {
    const { out } = await mapCall({ from: '161', direction: 'rxcui_to_ndc' });
    expect(out.resolvedSystem).toBe('RXNORM');
  });

  it('names a bundled RXCUI looked up in another system as an RxNorm concept, not CPT', async () => {
    // 161 misses in ICD-10-CM, but it is a bundled concept, not an unbundled code.
    const err = await mapError({ from: '161', direction: 'children', system: 'ICD10CM' });
    expect(err.message).toContain('it is a code in RxNorm');
    expect(err.message).not.toMatch(/CPT/);
  });

  it('uses the no-RxNorm variant in a build without RxNorm', async () => {
    const err = await withoutRxNorm(() => mapError({ from: '43239', direction: 'parents' }));
    expect(err.message).toBe(`No bundled code matches "43239". ${CPT_SENTENCE_NO_RXNORM}`);
  });
});

// A bare 10/11-digit NDC is also a bare integer, and medcode_get_code decodes it: the
// directions that read `from` as a code or an RXCUI name it as an NDC, never as CPT.
describe('medcode_map_codes — an NDC where a code or an RXCUI belongs', () => {
  it.each([
    ['11111222233', 'parents', 'a code'],
    ['11111222233', 'children', 'a code'],
    ['0904516160', 'rxcui_to_ndc', 'an RXCUI'],
    ['11111222233', 'rxcui_to_ingredients', 'an RXCUI'],
    ['11111-2222-33', 'rxcui_to_brands', 'an RXCUI'],
    ['99999-8888-77', 'children', 'a code'],
  ])('names %s as an NDC on %s, on both surfaces', async (from, direction, notA) => {
    const result = await runToolContract(mapCodesTool, { from, direction } as never);
    const error = envelopeOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('no_mapping');
    expect(error.message).toBe(`"${from}" is a National Drug Code (NDC), not ${notA}.`);
    const hint = error.data?.recovery?.hint ?? '';
    expect(hint).toContain('ndc_to_rxcui');
    expect(hint).toContain('medcode_get_code');
    expect(hint).not.toMatch(/CPT/);

    const text = contentText(result);
    expect(text).not.toMatch(/CPT/);
    expect(text).toContain(hint);
    expect(text).toContain('(reason no_mapping)');
  });

  it('keeps the CPT sentence for a bare integer the NDC map does not hold', async () => {
    // Eleven digits but no package: not an NDC get_code decodes, so still a bare-integer miss.
    const err = await mapError({ from: '99999888877', direction: 'rxcui_to_ndc' });
    expect(err.message).toBe(`No bundled code matches "99999888877". ${CPT_SENTENCE}`);
  });
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/38
describe('medcode_get_code — a bare integer that resolves nowhere', () => {
  it('carries the out-of-scope sentence on its notFound entry, on both surfaces', async () => {
    const result = await runToolContract(getCodeTool, { codes: ['43239', 'E11.9'] } as never);
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as {
      found: { code: string }[];
      notFound: { code: string; reason: string }[];
    };
    expect(out.found.map((f) => f.code)).toEqual(['E11.9']);
    expect(out.notFound).toEqual([
      {
        code: '43239',
        reason: `"43239" is not present in the bundled release (matched shape: RXNORM). ${CPT_SENTENCE}`,
      },
    ]);
    expect(contentText(result)).toContain(CPT_SENTENCE);
  });

  it('names every bare-integer input when nothing resolves, keeping the declared recovery', async () => {
    const result = await runToolContract(getCodeTool, { codes: ['43239', '99213'] } as never);
    expect(result.isError).toBe(true);
    const error = envelopeOf(result);
    expect(error.data?.reason).toBe('no_codes_found');
    expect(error.message).toContain('"43239"');
    expect(error.message).toContain('"99213"');
    expect(error.message).toContain(CPT_SENTENCE);
    expect(error.data?.recovery?.hint).toBe(declaredRecovery(getCodeTool, 'no_codes_found'));
    expect(contentText(result)).toContain(CPT_SENTENCE);
  });

  it('names only the bare integers of a mixed batch, and nothing for a batch without one', async () => {
    const mixed = await caught(() =>
      getCodeTool.handler(
        getCodeTool.input.parse({ codes: ['ZZZZZZ9', '43239'] }),
        createMockContext({ errors: getCodeTool.errors }),
      ),
    );
    expect(mixed.message).toContain('"43239"');
    expect(mixed.message).not.toContain('ZZZZZZ9');

    const none = await caught(() =>
      getCodeTool.handler(
        getCodeTool.input.parse({ codes: ['ZZZZZZ9'] }),
        createMockContext({ errors: getCodeTool.errors }),
      ),
    );
    expect(none.message).toBe('None of the 1 requested code(s) resolved in any bundled system.');
  });

  it('decodes a bare integer that is a bundled RXCUI, with no out-of-scope sentence', async () => {
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['161'] }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    expect(out.found[0]).toMatchObject({ system: 'RXNORM', code: '161' });

    // Forced into a system it is not in, it misses — but as a bundled concept,
    // so the reason and the batch error stay without the out-of-scope sentence.
    const forced = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['161', 'E11.9'], system: 'ICD10CM' }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    expect(forced.notFound[0]?.reason).not.toContain('CPT');
    const batch = await caught(() =>
      getCodeTool.handler(
        getCodeTool.input.parse({ codes: ['161'], system: 'ICD10CM' }),
        createMockContext({ errors: getCodeTool.errors }),
      ),
    );
    expect(batch.message).not.toContain('CPT');
  });

  it('names an NDC looked up under an explicit system as an NDC, not a CPT code', async () => {
    // A forced `system` skips the NDC decode, so the value misses — as an NDC.
    const mixed = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['11111222233', 'E11.9'], system: 'ICD10CM' }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    const reason = mixed.notFound[0]?.reason ?? '';
    expect(reason).toContain('National Drug Code (NDC)');
    expect(reason).toContain('omit `system`');
    expect(reason).not.toMatch(/CPT/);

    const only = await caught(() =>
      getCodeTool.handler(
        getCodeTool.input.parse({ codes: ['11111222233', '43239'], system: 'RXNORM' }),
        createMockContext({ errors: getCodeTool.errors }),
      ),
    );
    expect(only.data?.reason).toBe('no_codes_found');
    // The NDC is named as one; the CPT-shaped value alone keeps the out-of-scope note.
    expect(only.message).toContain(
      'National Drug Codes (NDC) looked up under an explicit `system`: "11111222233"',
    );
    expect(only.message).toContain('Bare integers with no match: "43239".');
    expect(only.message).not.toContain('Bare integers with no match: "11111222233"');
  });

  it('uses the no-RxNorm variant on get_code and check_code in a build without RxNorm', async () => {
    const get = await withoutRxNorm(() =>
      caught(() =>
        getCodeTool.handler(
          getCodeTool.input.parse({ codes: ['43239'] }),
          createMockContext({ errors: getCodeTool.errors }),
        ),
      ),
    );
    expect(get.message).toContain(CPT_SENTENCE_NO_RXNORM);

    const check = await withoutRxNorm(() =>
      caught(() =>
        checkCodeTool.handler(
          checkCodeTool.input.parse({ code: '99213' }),
          createMockContext({ errors: checkCodeTool.errors }),
        ),
      ),
    );
    expect(check.message).toBe(
      `"99213" looks like an RxNorm RXCUI or a CPT / HCPCS Level I code. ${CPT_SENTENCE_NO_RXNORM}`,
    );
  });

  it('leaves check_code on a CPT code worded as it was', async () => {
    const err = await caught(() =>
      checkCodeTool.handler(
        checkCodeTool.input.parse({ code: '99213' }),
        createMockContext({ errors: checkCodeTool.errors }),
      ),
    );
    expect(err.message).toBe(`No RxNorm concept matches "99213". ${CPT_SENTENCE}`);
  });
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/39
describe('medcode_map_codes — a code system name in `from`', () => {
  const ALL_DIRECTIONS = [
    'parents',
    'children',
    'name_to_rxcui',
    'ndc_to_rxcui',
    'rxcui_to_ndc',
    'rxcui_to_ingredients',
    'rxcui_to_brands',
  ];
  const TOKENS = [
    ['ICD10CM', 'ICD10CM'],
    ['ICD-10-CM', 'ICD10CM'],
    ['icd10cm', 'ICD10CM'],
    ['ICD 10 CM', 'ICD10CM'],
    ['ICD10PCS', 'ICD10PCS'],
    ['icd-10-pcs', 'ICD10PCS'],
    ['HCPCS', 'HCPCS'],
    ['HCPCS Level II', 'HCPCS'],
    ['RXNORM', 'RXNORM'],
    ['RxNorm', 'RXNORM'],
  ] as const;

  it.each(TOKENS)('names "%s" as a code system on every direction', async (token, system) => {
    for (const direction of ALL_DIRECTIONS) {
      const err = await mapError({ from: token, direction });
      expect(err.data?.reason, direction).toBe('no_mapping');
      expect(err.message).toBe(`"${token}" is a code system, not a code.`);
      const hint = err.data?.recovery?.hint ?? '';
      expect(hint).not.toBe(declaredRecovery(mapCodesTool, 'no_mapping'));
      if (direction === 'parents' || direction === 'children') {
        expect(hint).toContain(`\`system\` ("${system}")`);
        expect(hint).toContain('medcode_browse_hierarchy');
      } else {
        expect(hint).toMatch(/drug name, an NDC, or an RXCUI/);
        expect(hint).not.toContain('medcode_browse_hierarchy');
      }
    }
  });

  it('carries the message and the hierarchy recovery on both surfaces', async () => {
    const result = await runToolContract(mapCodesTool, {
      from: 'ICD10CM',
      direction: 'children',
    } as never);
    const error = envelopeOf(result);
    expect(error.data?.reason).toBe('no_mapping');
    expect(error.message).toBe('"ICD10CM" is a code system, not a code.');
    const text = contentText(result);
    expect(text).toContain('"ICD10CM" is a code system, not a code.');
    expect(text).toContain(error.data?.recovery?.hint ?? '<missing hint>');
    expect(text).toContain('medcode_browse_hierarchy');
  });

  it('gives the drug-direction recovery for RXNORM on rxcui_to_ingredients', async () => {
    const result = await runToolContract(mapCodesTool, {
      from: 'RXNORM',
      direction: 'rxcui_to_ingredients',
    } as never);
    const hint = envelopeOf(result).data?.recovery?.hint ?? '';
    expect(hint).toMatch(/drug name, an NDC, or an RXCUI/);
    expect(contentText(result)).toContain(hint);
  });

  it.each(['ICD10', 'CPT', 'NDC', 'ICD10CMX'])(
    'keeps the generic miss for %s, which names no bundled system',
    async (from) => {
      for (const direction of ['parents', 'rxcui_to_ingredients']) {
        const err = await mapError({ from, direction });
        expect(err.message).toBe(`No bundled code matches "${from}".`);
        expect(err.data?.recovery?.hint).toBe(declaredRecovery(mapCodesTool, 'no_mapping'));
      }
    },
  );
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/44
describe('medcode_map_codes — hierarchy directions on an RxNorm concept', () => {
  it.each(['parents', 'children'])(
    'says RxNorm has no code hierarchy on %s and names the drug directions',
    async (direction) => {
      for (const args of [{}, { system: 'RXNORM' }]) {
        const { out, enrich } = await mapCall({ from: '161', direction, ...args });
        expect(out.hits).toEqual([]);
        expect(out.resolvedSystem).toBe('RXNORM');
        const notice = String(enrich?.notice);
        expect(notice).toContain('RxNorm concepts have no code hierarchy');
        for (const drug of ['rxcui_to_ingredients', 'rxcui_to_brands', 'rxcui_to_ndc']) {
          expect(notice).toContain(drug);
        }
        expect(notice).not.toMatch(/top-level code|leaf code/);
      }
    },
  );

  it('leaves the ICD-10-CM top-level and leaf notices as they were', async () => {
    const top = await mapCall({ from: 'E11', direction: 'parents' });
    expect(top.enrich?.notice).toBe(
      '"E11" resolved in ICD10CM but has no parents — it is a top-level code with no parent. Decode it with medcode_get_code, or map the opposite direction.',
    );
    const leaf = await mapCall({ from: 'E11.9', direction: 'children' });
    expect(leaf.enrich?.notice).toBe(
      '"E11.9" resolved in ICD10CM but has no children — it is a leaf code with no children. Decode it with medcode_get_code, or map the opposite direction.',
    );
  });
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/35
describe('medcode_map_codes — ndc_to_rxcui accepts only what get_code decodes', () => {
  it.each([
    '11-1112-22233',
    '11111-222233',
    '11111-2222-3-3',
    '11111 2222 33',
    '11111.2222.33',
    '11111*2222*33',
    'NDC 11111-2222-33',
    '11111--2222-33',
    '11111/2222/33',
  ])('throws no_mapping for %j, which get_code also refuses', async (spelling) => {
    const err = await mapError({ from: spelling, direction: 'ndc_to_rxcui' });
    expect(err.data?.reason).toBe('no_mapping');
    const decoded = await caught(() =>
      getCodeTool.handler(
        getCodeTool.input.parse({ codes: [spelling] }),
        createMockContext({ errors: getCodeTool.errors }),
      ),
    );
    expect(decoded.data?.reason).toBe('no_codes_found');
  });

  it.each(['11111-2222-33', '11111222233', ' 11111-2222-33 ', ' 11111222233 '])(
    'still decodes %j to 198440',
    async (spelling) => {
      const { out } = await mapCall({ from: spelling, direction: 'ndc_to_rxcui' });
      expect(out.hits.map((h) => h.value)).toEqual(['198440']);
    },
  );
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/49
describe('medcode_get_code — no_codes_found under an explicit system', () => {
  it.each([
    [
      { codes: ['161'], system: 'ICD10CM' },
      'None of the 1 requested code(s) resolved in ICD-10-CM, the `system` this call named. Codes another bundled system holds: "161" (RxNorm). Re-call with that `system` to decode each one.',
    ],
    [
      { codes: ['E11.9'], system: 'HCPCS' },
      'None of the 1 requested code(s) resolved in HCPCS Level II, the `system` this call named. Codes another bundled system holds: "E11.9" (ICD-10-CM). Re-call with that `system` to decode each one.',
    ],
    [
      { codes: ['A0100', 'ZZZZZZ9'], system: 'RXNORM' },
      'None of the 2 requested code(s) resolved in RxNorm, the `system` this call named. Codes another bundled system holds: "A0100" (ICD-10-CM and HCPCS Level II). Re-call with that `system` to decode each one.',
    ],
  ])('names the named system and the holder for %j on both surfaces', async (args, message) => {
    const result = await runToolContract(getCodeTool, args as never);
    expect(result.isError).toBe(true);
    const error = envelopeOf(result);
    expect(error.data?.reason).toBe('no_codes_found');
    expect(error.message).toBe(message);
    expect(error.data?.recovery?.hint).toBe(declaredRecovery(getCodeTool, 'no_codes_found'));
    expect(contentText(result)).toContain(message);
  });

  it('names the holder on the per-code reason of a partial success', async () => {
    const result = await runToolContract(getCodeTool, {
      codes: ['161', 'E11.9'],
      system: 'ICD10CM',
    } as never);
    const out = result.structuredContent as { notFound: { code: string; reason: string }[] };
    const reason =
      'No ICD-10-CM code matches "161" — it is a code in RxNorm. Re-call with `system` "RXNORM" to decode it there.';
    expect(out.notFound).toEqual([{ code: '161', reason }]);
    expect(contentText(result)).toContain(reason);
  });

  it('keeps the message of a call without system as it was', async () => {
    const err = await caught(() =>
      getCodeTool.handler(
        getCodeTool.input.parse({ codes: ['ZZZZZZ9', 'Q99999'] }),
        createMockContext({ errors: getCodeTool.errors }),
      ),
    );
    expect(err.message).toBe('None of the 2 requested code(s) resolved in any bundled system.');
  });
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/52
describe('medcode_map_codes — a hierarchy miss under an explicit system', () => {
  it.each([
    [
      { from: 'E11.9', direction: 'parents', system: 'HCPCS' },
      'No HCPCS Level II code matches "E11.9" — it is a code in ICD-10-CM. Re-call with `system` "ICD10CM" to walk it there.',
    ],
    [
      { from: '161', direction: 'children', system: 'ICD10CM' },
      'No ICD-10-CM code matches "161" — it is a code in RxNorm. Re-call with `system` "RXNORM" to walk it there.',
    ],
    [
      { from: 'A0100', direction: 'children', system: 'RXNORM' },
      'No RxNorm concept matches "A0100" — it is a code in ICD-10-CM and HCPCS Level II. Re-call with `system` "ICD10CM" or "HCPCS" to walk it there.',
    ],
  ])('names the system that holds %j on both surfaces', async (args, message) => {
    const result = await runToolContract(mapCodesTool, args as never);
    expect(result.isError).toBe(true);
    const error = envelopeOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('no_mapping');
    expect(error.message).toBe(message);
    const hint = error.data?.recovery?.hint ?? '';
    expect(hint).not.toBe(declaredRecovery(mapCodesTool, 'no_mapping'));
    expect(hint).toContain('`system`');
    expect(hint).not.toContain('medcode_get_code');

    const text = contentText(result);
    expect(text).toContain(message);
    expect(text).toContain(hint);
    expect(text).toContain('(reason no_mapping)');
  });

  it('keeps the generic miss for a value no bundled system holds', async () => {
    const err = await mapError({ from: 'ZZZZZZ9', direction: 'parents', system: 'HCPCS' });
    expect(err.message).toBe('No bundled code matches "ZZZZZZ9".');
    expect(err.data?.recovery?.hint).toBe(declaredRecovery(mapCodesTool, 'no_mapping'));
  });

  it('keeps the out-of-scope miss for a bare integer no bundled system holds', async () => {
    const err = await mapError({ from: '43239', direction: 'parents', system: 'ICD10CM' });
    expect(err.message).toBe(`No bundled code matches "43239". ${CPT_SENTENCE}`);
  });
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/50
describe('medcode_map_codes — an ndc_to_rxcui miss says which case it is', () => {
  it.each([
    ['11-1112-22233', `"11-1112-22233" ${NDC_MALFORMED_TAIL}`, /FDA segment configurations/],
    [
      'NDC 11111-2222-33',
      `"NDC 11111-2222-33" ${NDC_MALFORMED_TAIL}`,
      /FDA segment configurations/,
    ],
    [
      '99999-8888-77',
      '"99999-8888-77" is a valid NDC format but no bundled drug maps to it (normalized 99999888877).',
      /no product for this package/,
    ],
    [
      '99999888877',
      '"99999888877" is a valid NDC format but no bundled drug maps to it (normalized 99999888877).',
      /no product for this package/,
    ],
    [
      '9999988887',
      '"9999988887" is a valid NDC format but no bundled drug maps to it.',
      /no product for this package/,
    ],
  ])('words the miss for %j on both surfaces', async (from, message, hintShape) => {
    const result = await runToolContract(mapCodesTool, {
      from,
      direction: 'ndc_to_rxcui',
    } as never);
    const error = envelopeOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('no_mapping');
    expect(error.message).toBe(message);
    const hint = error.data?.recovery?.hint ?? '';
    expect(hint).toMatch(hintShape);
    expect(hint).toContain('name_to_rxcui');
    expect(hint).not.toContain('medcode_get_code');

    const text = contentText(result);
    expect(text).toContain(message);
    expect(text).toContain(hint);
    expect(text).not.toContain('medcode_get_code');
    expect(text).toContain('(reason no_mapping)');
  });

  it('keeps the code-system hint ahead of the NDC wording', async () => {
    const err = await mapError({ from: 'RXNORM', direction: 'ndc_to_rxcui' });
    expect(err.message).toBe('"RXNORM" is a code system, not a code.');
  });
});
