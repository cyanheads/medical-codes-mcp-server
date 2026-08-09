/**
 * @fileoverview Integration coverage against the shipped SQLite corpus. Uses a
 * small set of real anchors to verify ambiguity, NDC normalization, one-to-many
 * crosswalks, hierarchy semantics, billability, and release provenance.
 * @module tests/integration/bundled-index-correctness.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { listSystemsTool } from '@/mcp-server/tools/definitions/list-systems.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { ensureBundledIndex } from '../helpers/bundled-index.ts';

interface CaughtError {
  data?: { reason?: string };
  message: string;
}

async function caught(fn: () => unknown): Promise<CaughtError> {
  try {
    await fn();
  } catch (error) {
    return error as CaughtError;
  }
  throw new Error('expected handler to throw, but it resolved');
}

beforeAll(async () => {
  await ensureBundledIndex();
});

describe('system auto-detection against real overlaps', () => {
  it('reports a genuinely ambiguous code while preserving a mixed-system batch', async () => {
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['E11.9', 'A0100', '0dtj4zz', ' e0110 ', '161'] }),
      createMockContext(),
    );

    expect(out.found.map(({ code, system }) => ({ code, system }))).toEqual([
      { code: 'E11.9', system: 'ICD10CM' },
      { code: '0DTJ4ZZ', system: 'ICD10PCS' },
      { code: 'E0110', system: 'HCPCS' },
      { code: '161', system: 'RXNORM' },
    ]);
    expect(out.notFound).toEqual([
      expect.objectContaining({
        code: 'A0100',
        candidateSystems: ['ICD10CM', 'HCPCS'],
      }),
    ]);
  });

  it('uses an explicit system to resolve both meanings of an ambiguous code', async () => {
    const diagnosis = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['A0100'], system: 'ICD10CM' }),
      createMockContext(),
    );
    expect(diagnosis.found[0]).toMatchObject({
      code: 'A01.00',
      system: 'ICD10CM',
      description: 'Typhoid fever, unspecified',
    });

    const transport = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['A0100'], system: 'HCPCS' }),
      createMockContext(),
    );
    expect(transport.found[0]).toMatchObject({
      code: 'A0100',
      system: 'HCPCS',
      description: 'Non-emergency transportation; taxi',
    });
  });
});

describe('real NDC format permutations', () => {
  it.each([
    ['0002-0152-01', '2679323'],
    ['0002015201', '2679323'],
    ['00002-152-01', '2679323'],
    ['0000215201', '2679323'],
    ['00002015201', '2679323'],
    ['00003-0050-0', '2694850'],
    ['0000300500', '2694850'],
    ['00003005000', '2694850'],
  ])('maps %s to the expected RxNorm product', async (ndc, rxcui) => {
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: [ndc] }),
      createMockContext(),
    );
    expect(out.notFound).toEqual([]);
    expect(out.found[0]).toMatchObject({ code: rxcui, system: 'RXNORM', source: 'NDC' });
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/23
  it.each(['2-152-1', '0002-152-01', '00002-152-1'])(
    'refuses to pad the malformed %s onto a real product',
    async (malformed) => {
      const err = await caught(() =>
        getCodeTool.handler(
          getCodeTool.input.parse({ codes: [malformed] }),
          createMockContext({ errors: getCodeTool.errors }),
        ),
      );
      // Each of these left-pads to 00002015201 → RXCUI 2679323 (a tirzepatide
      // injection) under a bounds-only segment check. The FDA-valid spellings of
      // that key still resolve (above) — only the malformed widths are refused.
      expect(err.data?.reason).toBe('no_codes_found');
    },
  );

  it('round-trips a label NDC through RXCUI without losing the original package', async () => {
    const forward = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '0002-0152-01', direction: 'ndc_to_rxcui' }),
      createMockContext(),
    );
    expect(forward.hits.map((hit) => hit.value)).toEqual(['2679323']);

    const reverse = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '2679323', direction: 'rxcui_to_ndc' }),
      createMockContext(),
    );
    expect(new Set(reverse.hits.map((hit) => hit.value))).toEqual(
      new Set(['00002015201', '00002015204', '00002015261']),
    );
  });
});

describe('one-to-many crosswalk completeness', () => {
  it('returns every ingredient edge for a combination product', async () => {
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '250085', direction: 'rxcui_to_ingredients' }),
      createMockContext(),
    );
    expect(new Set(out.hits.map((hit) => hit.value))).toEqual(new Set(['161', '5640', '818102']));
  });

  it('returns every brand edge for a product instead of selecting one', async () => {
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_brands' }),
      createMockContext(),
    );
    expect(new Set(out.hits.map((hit) => hit.value))).toEqual(
      new Set(['1100002', '1293937', '1358830', '202432', '202433', '215257', '218205']),
    );
  });

  it('resolves a drug name to the expected RXCUI among all matching concepts', async () => {
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({
        from: 'acetaminophen 500 MG Oral Tablet',
        direction: 'name_to_rxcui',
        limit: 200,
      }),
      createMockContext(),
    );
    expect(out.hits.map((hit) => hit.value)).toContain('198440');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/20
  it('paginates the high-fanout RXCUI-to-NDC direction', async () => {
    const firstCtx = createMockContext();
    const first = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_ndc', limit: 2 }),
      firstCtx,
    );
    const firstMeta = getEnrichment(firstCtx);
    expect(first.hits).toHaveLength(2);
    expect(firstMeta).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    expect(firstMeta?.nextCursor).toEqual(expect.any(String));

    const secondCtx = createMockContext();
    const second = await mapCodesTool.handler(
      mapCodesTool.input.parse({
        from: '198440',
        direction: 'rxcui_to_ndc',
        limit: 2,
        cursor: firstMeta?.nextCursor,
      }),
      secondCtx,
    );
    expect(second.hits).toHaveLength(2);
    expect(new Set([...first.hits, ...second.hits].map((hit) => hit.value)).size).toBe(4);
  });

  // Pagination is only safe if the caller can still get the whole set back. RXCUI
  // 310384 (fluoxetine 10 MG Oral Capsule) has more package NDCs than the default
  // page but fewer than the 200 ceiling, so one maxed-out call is a provably
  // COMPLETE reference (truncated:false) to diff a cursor walk against.
  it('reconstructs the complete NDC set by walking only the emitted cursors', async () => {
    const wholeCtx = createMockContext();
    const whole = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '310384', direction: 'rxcui_to_ndc', limit: 200 }),
      wholeCtx,
    );
    const reference = whole.hits.map((hit) => hit.value);
    expect(getEnrichment(wholeCtx)?.truncated).toBe(false);
    expect(reference.length).toBeGreaterThan(50);
    expect(new Set(reference).size).toBe(reference.length);

    const walked: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const ctx = createMockContext();
      const out = await mapCodesTool.handler(
        mapCodesTool.input.parse({ from: '310384', direction: 'rxcui_to_ndc', limit: 7, cursor }),
        ctx,
      );
      const meta = getEnrichment(ctx);
      walked.push(...out.hits.map((hit) => hit.value));
      pageSizes.push(out.hits.length);
      expect(meta?.shown).toBe(out.hits.length);
      expect(meta?.cap).toBe(7);
      cursor = meta?.nextCursor as string | undefined;
      if (!cursor) {
        expect(meta?.truncated).toBe(false);
        break;
      }
      expect(meta?.truncated).toBe(true);
    }
    expect(cursor).toBeUndefined();

    // Same rows, same order, no gap and no repeat — every page but the last is full.
    expect(walked).toEqual(reference);
    expect(pageSizes.slice(0, -1).every((size) => size === 7)).toBe(true);
    expect(pageSizes.at(-1)).toBe(reference.length % 7 || 7);
  });
});

describe('hierarchy algorithms', () => {
  it('walks ICD-10-CM and HCPCS prefix children', async () => {
    const cm = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10CM', node: 'E11', limit: 200 }),
      createMockContext(),
    );
    expect(cm.kind).toBe('codes');
    expect(cm.codes.map((code) => code.code)).toContain('E11.9');

    const hcpcs = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'HCPCS', node: 'J', limit: 200 }),
      createMockContext(),
    );
    expect(hcpcs.kind).toBe('codes');
    expect(hcpcs.codes.map((code) => code.code)).toContain('J0120');
  });

  it('returns the PCS section axis and distinguishes a valid partial path', async () => {
    const top = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10PCS' }),
      createMockContext(),
    );
    expect(top.kind).toBe('axes');
    expect(top.axes.every((axis) => axis.position === 1)).toBe(true);
    expect(top.axes).toEqual(
      expect.arrayContaining([
        { position: 1, value: '0', meaning: 'Medical and Surgical' },
        { position: 1, value: 'B', meaning: 'Imaging' },
        { position: 1, value: 'X', meaning: 'New Technology' },
      ]),
    );

    const partialCtx = createMockContext();
    const partial = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10PCS', node: '0D' }),
      partialCtx,
    );
    expect(partial).toEqual({ kind: 'axes', codes: [], axes: [] });
    expect(getEnrichment(partialCtx)?.notice).toMatch(/context-dependent/i);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/24
  it('rejects invalid PCS axis values instead of returning a normal empty traversal', async () => {
    // `i` normalizes to `I`; `.` is stripped to nothing by storageCode and would
    // otherwise be served the top-level section list as if no node had been passed.
    for (const node of ['I', 'O', '!', '.', 'i', '0DO']) {
      const err = await caught(() =>
        browseHierarchyTool.handler(
          browseHierarchyTool.input.parse({ system: 'ICD10PCS', node }),
          createMockContext({ errors: browseHierarchyTool.errors }),
        ),
      );
      expect(err.data?.reason).toBe('unknown_node');
      expect(err.message).toMatch(/ICD-10-PCS/);
    }
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/24
  it('rejects an in-alphabet node that prefixes no code rather than implying a path', async () => {
    // Section values are 17 of the 34 axis characters and each later position is
    // constrained by the ones before it, so these clear the alphabet check while
    // naming nothing. Left unguarded they draw the same empty-axes success and
    // "positions 2–7 are context-dependent" notice a real partial path gets.
    for (const node of ['A', 'Z', 'E', '0Z', '0DZ', 'ZZZZZZ']) {
      const err = await caught(() =>
        browseHierarchyTool.handler(
          browseHierarchyTool.input.parse({ system: 'ICD10PCS', node }),
          createMockContext({ errors: browseHierarchyTool.errors }),
        ),
      );
      expect(err.data?.reason).toBe('unknown_node');
      expect(err.message).toMatch(/begins with/);
    }
  });

  it('keeps every real partial prefix and complete code browsable', async () => {
    // The guards are a narrowing, so what they must NOT reject is the load-bearing
    // half: prefixes at each length keep their context-dependent-axis notice, and a
    // complete existing code keeps the successful empty-axes result from #13.
    for (const node of ['0', '0D', '0DT', '0DTJ', '0DTJ4', '0DTJ4Z', 'X', 'XW']) {
      const ctx = createMockContext({ errors: browseHierarchyTool.errors });
      const out = await browseHierarchyTool.handler(
        browseHierarchyTool.input.parse({ system: 'ICD10PCS', node }),
        ctx,
      );
      expect(out).toEqual({ kind: 'axes', codes: [], axes: [] });
      expect(getEnrichment(ctx)?.notice).toMatch(/context-dependent/i);
    }

    const completeCtx = createMockContext({ errors: browseHierarchyTool.errors });
    const complete = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10PCS', node: '0DTJ4ZZ' }),
      completeCtx,
    );
    expect(complete).toEqual({ kind: 'axes', codes: [], axes: [] });
    expect(getEnrichment(completeCtx)?.notice).toMatch(/complete 7-character/i);
  });
});

describe('release provenance and current-code status', () => {
  it('reports the exact active releases baked into the shipped index', async () => {
    const out = await listSystemsTool.handler(listSystemsTool.input.parse({}), createMockContext());
    expect(
      out.systems.map(({ system, releaseId, effectiveStart, effectiveEnd }) => ({
        system,
        releaseId,
        effectiveStart,
        effectiveEnd,
      })),
    ).toEqual([
      {
        system: 'ICD10CM',
        releaseId: 'ICD-10-CM FY2026',
        effectiveStart: '2025-10-01',
        effectiveEnd: '2026-09-30',
      },
      {
        system: 'ICD10PCS',
        releaseId: 'ICD-10-PCS FY2026',
        effectiveStart: '2025-10-01',
        effectiveEnd: '2026-09-30',
      },
      {
        system: 'HCPCS',
        releaseId: 'HCPCS 2026',
        effectiveStart: '2026-01-01',
        effectiveEnd: '2026-12-31',
      },
      {
        system: 'RXNORM',
        releaseId: 'RxNorm (current normalized set)',
        effectiveStart: null,
        effectiveEnd: null,
      },
    ]);
  });

  it('returns a terminated code as a successful non-billable verdict, not unknown', async () => {
    const out = await checkCodeTool.handler(
      checkCodeTool.input.parse({ code: 'C5271', system: 'HCPCS' }),
      createMockContext(),
    );
    expect(out).toMatchObject({
      system: 'HCPCS',
      code: 'C5271',
      status: 'terminated',
      billable: false,
    });
    expect(out.whyNot).toMatch(/2025-12-31/);
  });
});
