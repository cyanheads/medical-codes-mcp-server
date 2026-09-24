/**
 * @fileoverview Integration coverage against the shipped SQLite corpus. Uses a
 * small set of real anchors to verify ambiguity, NDC normalization, one-to-many
 * crosswalks, hierarchy semantics, billability, and release provenance.
 * @module tests/integration/bundled-index-correctness.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { listSystemsTool } from '@/mcp-server/tools/definitions/list-systems.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
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
      createMockContext({ errors: getCodeTool.errors }),
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

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/29
  it('decodes the header rows the index materializes without an explicit system', async () => {
    // Every one of these is a real row browse and search hand back: the HCPCS
    // letter bucket, and two of the 914 three-character ICD-10-PCS table rows.
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['J', '001', '00B'] }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    expect(out.notFound).toEqual([]);
    expect(out.found.map(({ code, system }) => ({ code, system }))).toEqual([
      { code: 'J', system: 'HCPCS' },
      { code: '001', system: 'ICD10PCS' },
      { code: '00B', system: 'ICD10PCS' },
    ]);
    expect(out.found[1]?.description).toBe('Central Nervous System and Cranial Nerves, Bypass');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/29
  it('decodes release codes whose leading characters no complete shape admits', async () => {
    // The ICD-10-CM shape excludes a leading `U` and requires a digit in position
    // 2, so the emergency-use COVID-19 chapters and the FY2026 `QA0…` genetic
    // codes match no complete shape at all — `QA00101` is even seven characters,
    // so it reads as ICD-10-PCS-shaped and resolves in ICD-10-CM only by membership.
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['U07.1', 'U09.9', 'QA00101'] }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    expect(out.notFound).toEqual([]);
    expect(
      out.found.map(({ code, system, description }) => ({ code, system, description })),
    ).toEqual([
      { code: 'U07.1', system: 'ICD10CM', description: 'COVID-19' },
      { code: 'U09.9', system: 'ICD10CM', description: 'Post COVID-19 condition, unspecified' },
      {
        // Display form re-inserts the ICD-10-CM dot after the 3-char category.
        code: 'QA0.0101',
        system: 'ICD10CM',
        description: 'SCN2A-related neurodevelopmental disorder',
      },
    ]);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/29
  it('keeps check_code and map_codes in step with get_code on a header row', async () => {
    // resolveSystems is shared, so the fix has to land on all three tools at once.
    const checked = await checkCodeTool.handler(
      checkCodeTool.input.parse({ code: 'J' }),
      createMockContext({ errors: checkCodeTool.errors }),
    );
    expect(checked).toMatchObject({ system: 'HCPCS', code: 'J', status: 'valid_header' });

    const mapped = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'J', direction: 'children', limit: 5 }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(mapped.resolvedSystem).toBe('HCPCS');
    expect(mapped.hits.length).toBeGreaterThan(0);
    expect(mapped.hits.every((hit) => hit.value.startsWith('J'))).toBe(true);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/32
  describe('code strings the shape pass narrows past a second real member', () => {
    // Derived from the shipped corpus, not hardcoded: every ICD-10-CM top-level
    // category (all three characters, so all roots) that is ALSO an ICD-10-PCS
    // table row. Only the ICD-10-CM pattern admits a 3-character letter+2-digit
    // value, so these resolve single while a second real row sits behind them.
    let shared: string[] = [];

    beforeAll(async () => {
      const svc = await ensureBundledIndex();
      const roots: string[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = svc.browse('ICD10CM', undefined, { offset, limit: 200 });
        if (page.kind !== 'codes') break;
        roots.push(...page.codes.map((entry) => entry.code));
        if (!page.hasMore) break;
      }
      shared = roots.filter((code) => svc.getByCode(code, 'ICD10PCS').kind === 'found');
    });

    it('finds the collision set the release actually carries', () => {
      expect(shared).toHaveLength(60);
      expect(shared.slice(0, 3)).toEqual(['B00', 'B01', 'B02']);
    });

    // The load-bearing constraint: the fix is a disclosure, so no lookup that
    // works today may change. Widening these to full membership instead would
    // convert all 60 into `ambiguous_system` and break every caller who meant the
    // diagnosis — which is why the resolution is pinned here, not just the notice.
    it('still resolves every one as ICD-10-CM, with none turned ambiguous', async () => {
      for (let start = 0; start < shared.length; start += 50) {
        const batch = shared.slice(start, start + 50);
        const out = await getCodeTool.handler(
          getCodeTool.input.parse({ codes: batch }),
          createMockContext({ errors: getCodeTool.errors }),
        );
        // An ambiguous code lands in notFound with candidateSystems — an empty
        // notFound is the direct assertion that none of them became one.
        expect(out.notFound).toEqual([]);
        expect(out.found.map((entry) => entry.code)).toEqual(batch);
        expect(out.found.map((entry) => entry.system)).toEqual(batch.map(() => 'ICD10CM'));
        expect(out.found.map((entry) => entry.alsoInSystems)).toEqual(
          batch.map(() => ['ICD10PCS']),
        );
      }
    });

    it('keeps check_code answering rather than throwing ambiguous_system', async () => {
      for (const code of shared) {
        const out = await checkCodeTool.handler(
          checkCodeTool.input.parse({ code }),
          createMockContext({ errors: checkCodeTool.errors }),
        );
        expect(out).toMatchObject({ system: 'ICD10CM', code, alsoInSystems: ['ICD10PCS'] });
      }
    });

    it('separates the two real meanings of B00 once the caller knows to ask', async () => {
      const diagnosis = await getCodeTool.handler(
        getCodeTool.input.parse({ codes: ['B00'] }),
        createMockContext({ errors: getCodeTool.errors }),
      );
      expect(diagnosis.found[0]).toMatchObject({
        system: 'ICD10CM',
        description: 'Herpesviral [herpes simplex] infections',
        alsoInSystems: ['ICD10PCS'],
      });

      const imaging = await getCodeTool.handler(
        getCodeTool.input.parse({ codes: ['B00'], system: 'ICD10PCS' }),
        createMockContext({ errors: getCodeTool.errors }),
      );
      expect(imaging.found[0]).toMatchObject({
        system: 'ICD10PCS',
        description: 'Imaging, Central Nervous System, Plain Radiography',
        alsoInSystems: ['ICD10CM'],
      });
    });
  });

  it('uses an explicit system to resolve both meanings of an ambiguous code', async () => {
    const diagnosis = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['A0100'], system: 'ICD10CM' }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    expect(diagnosis.found[0]).toMatchObject({
      code: 'A01.00',
      system: 'ICD10CM',
      description: 'Typhoid fever, unspecified',
    });

    const transport = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['A0100'], system: 'HCPCS' }),
      createMockContext({ errors: getCodeTool.errors }),
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
      createMockContext({ errors: getCodeTool.errors }),
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
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(forward.hits.map((hit) => hit.value)).toEqual(['2679323']);

    const reverse = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '2679323', direction: 'rxcui_to_ndc' }),
      createMockContext({ errors: mapCodesTool.errors }),
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
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(new Set(out.hits.map((hit) => hit.value))).toEqual(new Set(['161', '5640', '818102']));
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/28
  it('separates the substances of a combination product from the MIN concept grouping them', async () => {
    // 250085 is a two-substance product, but it carries three has_ingredient edges:
    // acetaminophen and ibuprofen, plus the `acetaminophen / ibuprofen` MIN concept
    // for the pair. Read flat, that is a three-ingredient product.
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '250085', direction: 'rxcui_to_ingredients' }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(
      out.hits
        .map(({ value, conceptType }) => ({ value, conceptType }))
        .sort((a, b) => a.value.localeCompare(b.value)),
    ).toEqual([
      { value: '161', conceptType: 'IN' },
      { value: '5640', conceptType: 'IN' },
      { value: '818102', conceptType: 'MIN' },
    ]);
    expect(out.hits.filter((hit) => hit.conceptType === 'IN')).toHaveLength(2);

    // The text client gets the same separation — it has no structuredContent to
    // fall back on, so a missing tag there is a silent over-count.
    const text = (mapCodesTool.format?.(out) ?? [])
      .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
      .join('\n');
    expect(text).toContain('[MIN]');
    expect(text.match(/\[IN\]/g)).toHaveLength(2);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/28
  it('distinguishes a precise ingredient from the base ingredient it refines', async () => {
    // 1000000 carries all three ingredient types at once: three IN substances, the
    // MIN naming the triple, and a PIN (`olmesartan medoxomil`) for the salt form of
    // an olmesartan the product ALSO lists as IN. Read flat that is five ingredients
    // for a three-substance product.
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '1000000', direction: 'rxcui_to_ingredients' }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    const byType = new Map(out.hits.map((hit) => [hit.value, hit.conceptType]));
    expect(byType.get('321064')).toBe('IN'); // olmesartan
    expect(byType.get('118463')).toBe('PIN'); // olmesartan medoxomil
    expect(byType.get('1008801')).toBe('MIN'); // the three-way combination
    expect(out.hits.filter((hit) => hit.conceptType === 'IN')).toHaveLength(3);
    expect(out.hits).toHaveLength(5);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/28
  it('does not let the IN hits stand as a substance count on their own', async () => {
    // 103462 is a two-substance ointment whose substances are both esters of one
    // base: two PIN hits share the single `fluocortolone` IN. Counting the IN hits
    // yields 1, so the field description must not sell that as the substance list
    // — 130 bundled products carry more PIN hits than IN hits this way.
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '103462', direction: 'rxcui_to_ingredients' }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    const byType = (t: string) => out.hits.filter((hit) => hit.conceptType === t);
    expect(byType('IN').map((hit) => hit.description)).toEqual(['fluocortolone']);
    expect(byType('PIN').map((hit) => hit.description)).toEqual([
      'fluocortolone caproate',
      'fluocortolone pivalate',
    ]);
    expect(byType('MIN')).toHaveLength(1);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/27
  it('names the product a package NDC decodes to', async () => {
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '0777-3105-02', direction: 'ndc_to_rxcui' }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(out.hits).toEqual([
      {
        source: 'NDC',
        system: 'RXNORM',
        value: '104849',
        description: 'fluoxetine 20 MG Oral Capsule [Prozac]',
      },
    ]);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/26
  it('answers an out-of-range cursor with an empty page rather than an unmapped source', async () => {
    // Reachable when a cursor outlives an index rebuild that shrank the set, or is
    // hand-built — the token is base64url of `{ offset, limit }`.
    const pastEnd = Buffer.from(JSON.stringify({ offset: 999_999, limit: 2 })).toString(
      'base64url',
    );

    for (const [from, direction] of [
      ['acetaminophen 500 MG Oral Tablet', 'name_to_rxcui'],
      ['104849', 'rxcui_to_ndc'],
    ] as const) {
      const firstCtx = createMockContext({ errors: mapCodesTool.errors });
      const first = await mapCodesTool.handler(
        mapCodesTool.input.parse({ from, direction, limit: 2 }),
        firstCtx,
      );
      expect(first.hits.length).toBeGreaterThan(0);

      const ctx = createMockContext({ errors: mapCodesTool.errors });
      const out = await mapCodesTool.handler(
        mapCodesTool.input.parse({ from, direction, limit: 2, cursor: pastEnd }),
        ctx,
      );
      expect(out.hits).toEqual([]);
      const meta = getEnrichment(ctx);
      expect(meta).toMatchObject({ truncated: false, shown: 0, cap: 2 });
      expect(meta?.nextCursor).toBeUndefined();
      expect(meta?.notice).toMatch(/page starts past the last/i);
    }
  });

  it('returns every brand edge for a product instead of selecting one', async () => {
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_brands' }),
      createMockContext({ errors: mapCodesTool.errors }),
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
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(out.hits.map((hit) => hit.value)).toContain('198440');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/20
  it('paginates the high-fanout RXCUI-to-NDC direction', async () => {
    const firstCtx = createMockContext({ errors: mapCodesTool.errors });
    const first = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_ndc', limit: 2 }),
      firstCtx,
    );
    const firstMeta = getEnrichment(firstCtx);
    expect(first.hits).toHaveLength(2);
    expect(firstMeta).toMatchObject({ truncated: true, shown: 2, cap: 2 });
    expect(firstMeta?.nextCursor).toEqual(expect.any(String));

    const secondCtx = createMockContext({ errors: mapCodesTool.errors });
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
    const wholeCtx = createMockContext({ errors: mapCodesTool.errors });
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
      const ctx = createMockContext({ errors: mapCodesTool.errors });
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
      createMockContext({ errors: browseHierarchyTool.errors }),
    );
    expect(cm.kind).toBe('codes');
    expect(cm.codes.map((code) => code.code)).toContain('E11.9');

    const hcpcs = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'HCPCS', node: 'J', limit: 200 }),
      createMockContext({ errors: browseHierarchyTool.errors }),
    );
    expect(hcpcs.kind).toBe('codes');
    expect(hcpcs.codes.map((code) => code.code)).toContain('J0120');
  });

  it('returns the PCS section axis and distinguishes a valid partial path', async () => {
    const top = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10PCS' }),
      createMockContext({ errors: browseHierarchyTool.errors }),
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

    const partialCtx = createMockContext({ errors: browseHierarchyTool.errors });
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
      createMockContext({ errors: checkCodeTool.errors }),
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

/**
 * ICD-10-CM, ICD-10-PCS, and HCPCS Level II carry a real billing signal, and the
 * RxNorm billability and short-description fixes (#37, #42) derive RxNorm's values
 * from the system rather than the stored row. These pins hold the three billing
 * systems byte-for-byte on both client surfaces, so a system-level derivation
 * that leaks past RxNorm fails here rather than shipping as a silent change.
 */
describe('billing-system output, pinned on both surfaces', () => {
  /** The rendered `format()` block — the first content block of a success. */
  function formatText(result: Awaited<ReturnType<typeof runToolContract>>): string {
    const [first] = result.content as { text?: string; type: string }[];
    return first?.type === 'text' ? (first.text ?? '') : '';
  }

  it.each([
    [
      'E11.9',
      undefined,
      { system: 'ICD10CM', code: 'E11.9', status: 'valid_billable', billable: true, whyNot: null },
      '## E11.9 — ICD-10-CM\n**Status:** ✅ Valid and billable\n**Billable:** Yes',
    ],
    [
      'E11',
      undefined,
      {
        system: 'ICD10CM',
        code: 'E11',
        status: 'valid_header',
        billable: false,
        whyNot:
          'Valid category/header, but not billable — submit a more specific child code instead.',
      },
      '## E11 — ICD-10-CM\n**Status:** ⚠️ Valid category/header — not billable\n**Billable:** No\n\nValid category/header, but not billable — submit a more specific child code instead.',
    ],
    [
      'B00',
      'ICD10PCS',
      {
        system: 'ICD10PCS',
        code: 'B00',
        status: 'valid_not_billable',
        billable: false,
        whyNot:
          'Valid code, but not flagged billable in this release — verify a more specific code is not required before submitting.',
        alsoInSystems: ['ICD10CM'],
      },
      '## B00 — ICD-10-PCS\n**Status:** ⚠️ Valid but not billable\n**Billable:** No\n\nValid code, but not flagged billable in this release — verify a more specific code is not required before submitting.\n\n**Also in:** ICD10CM — the same code string is a different code there, with its own billability; re-call with that `system` to validate it.',
    ],
    [
      'C5271',
      undefined,
      {
        system: 'HCPCS',
        code: 'C5271',
        status: 'terminated',
        billable: false,
        whyNot: 'Code terminated effective 2025-12-31; no longer valid for current claims.',
      },
      '## C5271 — HCPCS Level II\n**Status:** ⛔ Terminated\n**Billable:** No\n\nCode terminated effective 2025-12-31; no longer valid for current claims.',
    ],
  ] as const)('check_code %s (system %s) is unchanged', async (code, system, structured, text) => {
    const result = await runToolContract(checkCodeTool, { code, ...(system ? { system } : {}) });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(structured);
    expect(formatText(result)).toBe(text);
  });

  it('get_code decodes one code per billing system unchanged', async () => {
    const result = await runToolContract(getCodeTool, {
      codes: ['E11.9', '0DTJ4ZZ', 'E0110', 'C5271'],
    });
    expect(result.structuredContent).toEqual({
      found: [
        {
          system: 'ICD10CM',
          code: 'E11.9',
          description: 'Type 2 diabetes mellitus without complications',
          shortDescription: 'Type 2 diabetes mellitus without complications',
          billable: true,
          header: false,
          chapter: 'E',
        },
        {
          system: 'ICD10PCS',
          code: '0DTJ4ZZ',
          description: 'Resection of Appendix, Percutaneous Endoscopic Approach',
          shortDescription: 'Resection of Appendix, Percutaneous Endoscopic Approach',
          billable: true,
          header: false,
          chapter: '0',
        },
        {
          system: 'HCPCS',
          code: 'E0110',
          description:
            'Crutches, forearm, includes crutches of various materials, adjustable or fixed, pair, complete with tips and handgrips',
          shortDescription: 'Crutch forearm pair',
          billable: true,
          header: false,
          chapter: 'E',
        },
        {
          system: 'HCPCS',
          code: 'C5271',
          description:
            'Application of low cost skin substitute graft to trunk, arms, legs, total wound surface area up to 100 sq cm; first 25 sq cm or less wound surface area',
          shortDescription: 'Low cost skin substitute app',
          billable: false,
          header: false,
          chapter: 'C',
        },
      ],
      notFound: [],
    });
    expect(formatText(result)).toBe(
      [
        '## E11.9 — ICD-10-CM',
        '**billable: yes, header: no** · chapter E',
        'Type 2 diabetes mellitus without complications',
        '',
        '## 0DTJ4ZZ — ICD-10-PCS',
        '**billable: yes, header: no** · chapter 0',
        'Resection of Appendix, Percutaneous Endoscopic Approach',
        '',
        '## E0110 — HCPCS Level II',
        '**billable: yes, header: no** · chapter E',
        'Crutches, forearm, includes crutches of various materials, adjustable or fixed, pair, complete with tips and handgrips',
        '_Short:_ Crutch forearm pair',
        '',
        '## C5271 — HCPCS Level II',
        '**billable: no, header: no** · chapter C',
        'Application of low cost skin substitute graft to trunk, arms, legs, total wound surface area up to 100 sq cm; first 25 sq cm or less wound surface area',
        '_Short:_ Low cost skin substitute app',
      ].join('\n'),
    );
  });

  it('search_codes and browse_hierarchy render ICD-10-CM rows unchanged', async () => {
    const search = await runToolContract(searchCodesTool, {
      query: 'type 2 diabetes mellitus without complications',
      system: 'ICD10CM',
      limit: 2,
    });
    expect((search.structuredContent as { codes: unknown }).codes).toEqual([
      {
        system: 'ICD10CM',
        code: 'E11.9',
        description: 'Type 2 diabetes mellitus without complications',
        shortDescription: 'Type 2 diabetes mellitus without complications',
        billable: true,
        header: false,
        chapter: 'E',
      },
      {
        system: 'ICD10CM',
        code: 'E11.A',
        description: 'Type 2 diabetes mellitus without complications in remission',
        shortDescription: 'Type 2 diabetes mellitus without complications in remission',
        billable: true,
        header: false,
        chapter: 'E',
      },
    ]);
    expect(formatText(search)).toBe(
      [
        '## 2 matching code(s)',
        '',
        '- **E11.9** (ICD-10-CM; billable: yes, header: no · chapter E): Type 2 diabetes mellitus without complications',
        '- **E11.A** (ICD-10-CM; billable: yes, header: no · chapter E): Type 2 diabetes mellitus without complications in remission',
      ].join('\n'),
    );

    const browse = await runToolContract(browseHierarchyTool, {
      system: 'ICD10CM',
      node: 'E11',
      limit: 2,
    });
    expect((browse.structuredContent as { codes: unknown }).codes).toEqual([
      {
        system: 'ICD10CM',
        code: 'E11.0',
        description: 'Type 2 diabetes mellitus with hyperosmolarity',
        shortDescription: 'Type 2 diabetes mellitus with hyperosmolarity',
        billable: false,
        header: true,
        chapter: 'E',
      },
      {
        system: 'ICD10CM',
        code: 'E11.1',
        description: 'Type 2 diabetes mellitus with ketoacidosis',
        shortDescription: 'Type 2 diabetes mellitus with ketoacidosis',
        billable: false,
        header: true,
        chapter: 'E',
      },
    ]);
    expect(formatText(browse)).toBe(
      [
        '## Browse result (codes)',
        '',
        '### 2 child code(s)',
        '- **E11.0** (ICD-10-CM; billable: no, header: yes · chapter E): Type 2 diabetes mellitus with hyperosmolarity',
        '- **E11.1** (ICD-10-CM; billable: no, header: yes · chapter E): Type 2 diabetes mellitus with ketoacidosis',
      ].join('\n'),
    );
  });
});

/** Every text block a content-only client receives, the enrichment trailer included. */
function allText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content as { text?: string; type: string }[])
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n');
}

/** RXCUI 104849 — fluoxetine 20 MG Oral Capsule [Prozac], a branded product. */
const PROZAC_ROW = {
  system: 'RXNORM',
  code: '104849',
  description: 'fluoxetine 20 MG Oral Capsule [Prozac]',
  shortDescription: null,
  billable: null,
  header: false,
  chapter: 'SBD',
};

// https://github.com/cyanheads/medical-codes-mcp-server/issues/37
// https://github.com/cyanheads/medical-codes-mcp-server/issues/42
describe('RxNorm concepts in the shipped corpus', () => {
  it.each([
    ['104849', undefined],
    ['104849', 'RXNORM'],
    ['161', undefined],
    ['161', 'RXNORM'],
  ] as const)('check_code answers %s (system %s) as valid', async (code, system) => {
    const result = await runToolContract(checkCodeTool, { code, ...(system ? { system } : {}) });
    expect(result.structuredContent).toEqual({
      system: 'RXNORM',
      code,
      status: 'valid',
      billable: null,
      whyNot: null,
    });
    const text = allText(result);
    expect(text).toContain('**Billable:** n/a');
    expect(text).not.toMatch(/not billable|more specific|before submitting|claim/i);
  });

  it.each(['104849', '0777-3105-02'])(
    'get_code decodes %s with billable and shortDescription null',
    async (value) => {
      const result = await runToolContract(getCodeTool, { codes: [value] });
      const { found } = result.structuredContent as { found: Record<string, unknown>[] };
      expect(found).toEqual([value === '104849' ? PROZAC_ROW : { ...PROZAC_ROW, source: 'NDC' }]);
      const text = allText(result);
      expect(text).toContain('**billable: n/a, header: no** · chapter SBD');
      expect(text).not.toContain('Short:');
      expect(text).not.toContain('null');
    },
  );

  it('search_codes returns every Prozac hit with billable and shortDescription null', async () => {
    const result = await runToolContract(searchCodesTool, {
      query: 'Prozac',
      system: 'RXNORM',
      limit: 200,
    });
    const { codes } = result.structuredContent as {
      codes: { billable: unknown; chapter: string; shortDescription: unknown }[];
    };
    expect(codes.length).toBeGreaterThan(1);
    for (const row of codes) expect(row).toMatchObject({ billable: null, shortDescription: null });
    // The brand concept and the branded products both come back, each typed by chapter.
    expect(codes.map((row) => row.chapter)).toEqual(expect.arrayContaining(['BN', 'SBD']));
    const text = allText(result);
    expect(text).not.toContain('(short:');
    expect(text.match(/billable: n\/a/g)).toHaveLength(codes.length);
  });

  it('keeps the term-type chapter filter narrowing RxNorm results', async () => {
    const result = await runToolContract(searchCodesTool, {
      query: 'fluoxetine',
      system: 'RXNORM',
      chapter: 'SBD',
      limit: 200,
    });
    const { codes } = result.structuredContent as { codes: { code: string; chapter: string }[] };
    expect(codes.map((row) => row.code)).toContain('104849');
    expect(codes.every((row) => row.chapter === 'SBD')).toBe(true);
  });

  it('excludes every RxNorm row under billableOnly and names why', async () => {
    const result = await runToolContract(searchCodesTool, {
      query: 'fluoxetine',
      system: 'RXNORM',
      billableOnly: true,
    });
    const page = result.structuredContent as { codes: unknown[]; notice?: string };
    expect(page.codes).toEqual([]);
    expect(page.notice).toMatch(/RxNorm has no billing concept/);
    expect(page.notice).not.toMatch(/Broaden the terms/);
  });
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/43
describe('check_code on a real package NDC', () => {
  it.each(['0777-3105-02', '00777310502'])(
    'names %s as an NDC for RxNorm product 104849',
    async (ndc) => {
      const result = await runToolContract(checkCodeTool, { code: ndc });
      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { data?: { reason?: string; recovery?: { hint?: string } }; message: string };
      };
      expect(error.data?.reason).toBe('unknown_code');
      expect(error.message).toMatch(/National Drug Code \(NDC\)/);
      expect(error.message).toContain('104849');
      expect(error.message).not.toMatch(/matches no bundled code shape|CPT/);
      expect(error.data?.recovery?.hint).toContain('medcode_get_code');
      expect(error.data?.recovery?.hint).toContain('ndc_to_rxcui');
    },
  );

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/48
  it.each([
    ['E11.9', 'ICD-10-CM'],
    // J0120 is the HCPCS tetracycline injection AND ICD-10-CM J01.20 (acute
    // ethmoidal sinusitis) in the shipped release, so both are named.
    ['J0120', 'ICD-10-CM and HCPCS Level II'],
    ['0016070', 'ICD-10-PCS'],
  ])('names the system holding %s when asked for it in RxNorm', async (code, label) => {
    const result = await runToolContract(checkCodeTool, { code, system: 'RXNORM' });
    const { error } = result.structuredContent as {
      error: { data?: { reason?: string }; message: string };
    };
    expect(error.data?.reason).toBe('unknown_code');
    expect(error.message).toContain(`it is a code in ${label}`);
    expect(error.message).not.toMatch(/CPT/);
  });

  it('keeps the generic message for a malformed spelling get_code refuses', async () => {
    const result = await runToolContract(checkCodeTool, { code: '2-152-1' });
    const { error } = result.structuredContent as { error: { message: string } };
    expect(error.message).toMatch(/matches no bundled code shape/);
    expect(error.message).not.toContain('NDC');
  });
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/35
describe('ndc_to_rxcui against the shipped NDC map', () => {
  it.each([
    '00-7773-10502', // 2-4-5: its digits spell the real 0777-3105-02
    '00777-310502',
    '00777-3105-0-2',
    '00777--3105-02',
    '00777 3105 02',
    '00777.3105.02',
    '00777*3105*02',
    '00777/3105/02',
    'NDC 00777-3105-02',
  ])('refuses %j, as get_code does', async (spelling) => {
    const mapped = await caught(() =>
      mapCodesTool.handler(
        mapCodesTool.input.parse({ from: spelling, direction: 'ndc_to_rxcui' }),
        createMockContext({ errors: mapCodesTool.errors }),
      ),
    );
    expect(mapped.data?.reason).toBe('no_mapping');
    const decoded = await caught(() =>
      getCodeTool.handler(
        getCodeTool.input.parse({ codes: [spelling] }),
        createMockContext({ errors: getCodeTool.errors }),
      ),
    );
    expect(decoded.data?.reason).toBe('no_codes_found');
  });

  it.each(['0777-3105-02', '00777-3105-02', '0777310502', '00777310502'])(
    'still resolves %s, bare and padded, to 104849 through both tools',
    async (ndc) => {
      for (const spelling of [ndc, ` ${ndc} `]) {
        const mapped = await mapCodesTool.handler(
          mapCodesTool.input.parse({ from: spelling, direction: 'ndc_to_rxcui' }),
          createMockContext({ errors: mapCodesTool.errors }),
        );
        expect(mapped.hits.map((hit) => hit.value)).toEqual(['104849']);
        const decoded = await getCodeTool.handler(
          getCodeTool.input.parse({ codes: [spelling] }),
          createMockContext({ errors: getCodeTool.errors }),
        );
        expect(decoded.found.map((row) => row.code)).toEqual(['104849']);
      }
    },
  );
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/45
describe('RxNorm name matching against the shipped corpus', () => {
  it('returns no concept for the SBD term type, with a correct truncated flag', async () => {
    const result = await runToolContract(searchCodesTool, {
      query: 'sbd',
      system: 'RXNORM',
      limit: 3,
    });
    const page = result.structuredContent as { codes: unknown[]; truncated: boolean };
    expect(page.codes).toEqual([]);
    expect(page.truncated).toBe(false);

    const err = await caught(() =>
      mapCodesTool.handler(
        mapCodesTool.input.parse({ from: 'SBD', direction: 'name_to_rxcui', limit: 3 }),
        createMockContext({ errors: mapCodesTool.errors }),
      ),
    );
    expect(err.data?.reason).toBe('no_mapping');
  });

  it('keeps the Prozac search and the aspirin crosswalk as they were', async () => {
    const prozac = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'Prozac', system: 'RXNORM', limit: 200 }),
      createMockContext(),
    );
    expect(prozac.codes.map((row) => row.code)).toEqual(['58827', '104849', '205535', '261287']);

    const aspirin: string[] = [];
    let cursor: string | undefined;
    do {
      const ctx = createMockContext({ errors: mapCodesTool.errors });
      const page = await mapCodesTool.handler(
        mapCodesTool.input.parse({
          from: 'aspirin',
          direction: 'name_to_rxcui',
          limit: 200,
          ...(cursor ? { cursor } : {}),
        }),
        ctx,
      );
      aspirin.push(...page.hits.map((hit) => hit.value));
      cursor = getEnrichment(ctx)?.nextCursor as string | undefined;
    } while (cursor);
    expect(aspirin).toHaveLength(256);
    expect(aspirin.slice(0, 5)).toEqual(['611', '1191', '103863', '103954', '104474']);
    expect(aspirin.at(-1)).toBe('2734143');
  });

  it('still finds ICD-10-CM and HCPCS rows by their short description alone', async () => {
    // "NEC" is only in the short form of A05 ("… intoxications, NEC"); the long
    // form spells out "not elsewhere classified". "Whlchr" is the HCPCS short form.
    const icd = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'foodborne nec', system: 'ICD10CM' }),
      createMockContext(),
    );
    expect(icd.codes.map((row) => row.code)).toEqual(['A05']);

    const hcpcs = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'whlchr', system: 'HCPCS', limit: 5 }),
      createMockContext(),
    );
    expect(hcpcs.codes.map((row) => row.code)).toEqual([
      'K0004',
      'K0012',
      'K0013',
      'K0014',
      'K0002',
    ]);
  });
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/38
// https://github.com/cyanheads/medical-codes-mcp-server/issues/39
describe('map_codes misses against the shipped corpus', () => {
  it('names a CPT code as out of scope, and resolves a five-digit RXCUI', async () => {
    for (const cpt of ['43239', '99213', '36415', '80053']) {
      const err = await caught(() =>
        mapCodesTool.handler(
          mapCodesTool.input.parse({ from: cpt, direction: 'parents' }),
          createMockContext({ errors: mapCodesTool.errors }),
        ),
      );
      expect(err.data?.reason).toBe('no_mapping');
      expect(err.message).toContain('CPT or HCPCS Level I code, those are out of scope');
    }
    // 90176 is the RXCUI for iron: a bare integer that genuinely resolves.
    const iron = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '90176', direction: 'rxcui_to_ndc' }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(iron.resolvedSystem).toBe('RXNORM');
  });

  it('names a real package NDC as an NDC, never as a CPT code', async () => {
    // 00777310502 is the Prozac capsule package get_code decodes to 104849.
    for (const [from, direction] of [
      ['00777310502', 'rxcui_to_ingredients'],
      ['0777310502', 'parents'],
    ] as const) {
      const err = await caught(() =>
        mapCodesTool.handler(
          mapCodesTool.input.parse({ from, direction }),
          createMockContext({ errors: mapCodesTool.errors }),
        ),
      );
      expect(err.data?.reason).toBe('no_mapping');
      expect(err.message).toContain(`"${from}" is a National Drug Code (NDC)`);
      expect(err.message).not.toMatch(/CPT/);
    }
    const forced = await caught(() =>
      getCodeTool.handler(
        getCodeTool.input.parse({ codes: ['00777310502'], system: 'RXNORM' }),
        createMockContext({ errors: getCodeTool.errors }),
      ),
    );
    expect(forced.message).toContain('National Drug Codes (NDC)');
    expect(forced.message).not.toMatch(/CPT/);
  });

  it('names a code system passed as `from`', async () => {
    const err = await caught(() =>
      mapCodesTool.handler(
        mapCodesTool.input.parse({ from: 'ICD-10-CM', direction: 'children' }),
        createMockContext({ errors: mapCodesTool.errors }),
      ),
    );
    expect(err.data?.reason).toBe('no_mapping');
    expect(err.message).toBe('"ICD-10-CM" is a code system, not a code.');
  });
});
