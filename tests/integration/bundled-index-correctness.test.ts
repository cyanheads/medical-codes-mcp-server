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
