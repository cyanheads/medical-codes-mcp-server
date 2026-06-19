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
    expect(out.systems.map((s) => s.system)).toEqual(['ICD10CM', 'ICD10PCS', 'HCPCS']);
    expect(out.systems[0]?.label).toBe('ICD-10-CM');
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

  it('names RxNorm as unbundled (not "No RXNORM code matches") for a numeric out-of-scope code', async () => {
    const ctx = createMockContext({ errors: checkCodeTool.errors });
    const err = await caught(() =>
      checkCodeTool.handler(checkCodeTool.input.parse({ code: '99213' }), ctx),
    );
    expect(err.data?.reason).toBe('unknown_code');
    expect(err.message).toMatch(/not bundled/i);
    expect(err.message).not.toMatch(/No RXNORM code matches/i);
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

  it('throws direction_unavailable for a drug direction before RxNorm is bundled', async () => {
    const ctx = createMockContext({ errors: mapCodesTool.errors });
    const err = await caught(() =>
      mapCodesTool.handler(
        mapCodesTool.input.parse({ from: 'aspirin', direction: 'name_to_rxcui' }),
        ctx,
      ),
    );
    expect(err.data?.reason).toBe('direction_unavailable');
    expect(err.message).toMatch(/RxNorm/i);
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

  it('names RxNorm as not bundled when browsing the RXNORM system', async () => {
    const ctx = createMockContext();
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'RXNORM' }),
      ctx,
    );
    expect(out.kind).toBe('codes');
    expect(out.codes).toEqual([]);
    expect(getEnrichment(ctx)?.notice).toMatch(/not bundled/i);
  });
});
