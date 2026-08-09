/**
 * @fileoverview Correctness-critical handler regressions for system provenance,
 * NDC normalization, billability verdicts, crosswalk round-trips, and known
 * output-parity defects against the deterministic fixture index.
 * @module tests/tools/correctness-critical.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import { ndcCandidates } from '@/services/code-index/detect.js';
import { ensureIndex } from '../helpers/index-fixture.ts';

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

/** Flatten a tool's `format()` blocks into the text a text-only client would see. */
function renderText(blocks: { text?: string; type: string }[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n');
}

beforeAll(async () => {
  await ensureIndex();
});

describe('system provenance', () => {
  it('echoes the independently resolved system for every code in a mixed batch', async () => {
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['E11.9', '0dtj4zz', ' j0120 ', '161'] }),
      createMockContext(),
    );

    expect(out.notFound).toEqual([]);
    expect(out.found.map(({ code, system }) => ({ code, system }))).toEqual([
      { code: 'E11.9', system: 'ICD10CM' },
      { code: '0DTJ4ZZ', system: 'ICD10PCS' },
      { code: 'J0120', system: 'HCPCS' },
      { code: '161', system: 'RXNORM' },
    ]);
  });
});

describe('NDC normalization', () => {
  it.each([
    ['1234-5678-90', ['01234567890']],
    ['12345-678-90', ['12345067890']],
    ['12345-6789-0', ['12345678900']],
    ['12345-6789-01', ['12345678901']],
    [' 1234-5678-90 ', ['01234567890']],
  ])('normalizes the supported hyphenated form %s', (raw, expected) => {
    expect(ndcCandidates(raw)).toEqual({ candidates: expected, unambiguous: true });
  });

  it('expands a bare 10-digit NDC across all three legal segmentations', () => {
    expect(ndcCandidates('1234567890')).toEqual({
      candidates: ['01234567890', '12345067890', '12345678900'],
      unambiguous: false,
    });
  });

  it.each([
    '',
    '123456789',
    '123456789012',
    '12345-6789',
    '12345-6789-001',
    '12345--678',
    '1234-56A8-90',
    '1234 5678 90',
  ])('rejects malformed NDC input %j', (raw) => {
    expect(ndcCandidates(raw)).toEqual({ candidates: [], unambiguous: false });
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/23
  it('rejects undersized hyphenated segments instead of padding them into another product', async () => {
    for (const raw of ['2-152-1', '123-4567-89', '1234-567-89', '12345-67-89']) {
      expect(ndcCandidates(raw)).toEqual({ candidates: [], unambiguous: false });
    }

    // `904-5161-60` is `0904-5161-60` (a real fixture NDC) with its labeler segment
    // one digit short. Padding it would land on 00904516160 and hand back RXCUI
    // 1049640 — a product the caller never asked for. It must not resolve at all.
    expect(ndcCandidates('904-5161-60')).toEqual({ candidates: [], unambiguous: false });
    const err = await caught(() =>
      getCodeTool.handler(
        getCodeTool.input.parse({ codes: ['904-5161-60'] }),
        createMockContext({ errors: getCodeTool.errors }),
      ),
    );
    expect(err.data?.reason).toBe('no_codes_found');
  });

  it('resolves 10- and 11-digit forms to the same product and round-trips through RXCUI', async () => {
    const forms = ['11111-2222-33', '11111222233'];
    for (const ndc of forms) {
      const decoded = await getCodeTool.handler(
        getCodeTool.input.parse({ codes: [ndc] }),
        createMockContext(),
      );
      expect(decoded.found[0]).toMatchObject({ code: '198440', system: 'RXNORM', source: 'NDC' });
    }

    const reverse = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_ndc' }),
      createMockContext(),
    );
    expect(reverse.hits.map((hit) => hit.value)).toContain('11111222233');
  });

  it('normalizes a 4-4-2 label NDC with and without hyphens', async () => {
    for (const ndc of ['0904-5161-60', '0904516160', '00904516160']) {
      const out = await mapCodesTool.handler(
        mapCodesTool.input.parse({ from: ndc, direction: 'ndc_to_rxcui' }),
        createMockContext(),
      );
      expect(out.hits.map((hit) => hit.value)).toContain('1049640');
    }
  });
});

describe('billability verdicts', () => {
  it('keeps billable, parent, non-billable, terminated, and absent outcomes distinct', async () => {
    const billable = await checkCodeTool.handler(
      checkCodeTool.input.parse({ code: 'E11.9' }),
      createMockContext(),
    );
    expect(billable).toMatchObject({
      status: 'valid_billable',
      billable: true,
      whyNot: null,
    });

    const parent = await checkCodeTool.handler(
      checkCodeTool.input.parse({ code: 'E11' }),
      createMockContext(),
    );
    expect(parent).toMatchObject({ status: 'valid_header', billable: false });
    expect(parent.whyNot).toMatch(/more specific child code/i);

    const nonBillable = await checkCodeTool.handler(
      checkCodeTool.input.parse({ code: '161' }),
      createMockContext(),
    );
    expect(nonBillable).toMatchObject({ status: 'valid_not_billable', billable: false });
    expect(nonBillable.whyNot).toBeTruthy();

    const terminated = await checkCodeTool.handler(
      checkCodeTool.input.parse({ code: 'K0552' }),
      createMockContext(),
    );
    expect(terminated).toMatchObject({ status: 'terminated', billable: false });
    expect(terminated.whyNot).toMatch(/2019-12-31/);

    const err = await caught(() =>
      checkCodeTool.handler(
        checkCodeTool.input.parse({ code: 'ZZ999' }),
        createMockContext({ errors: checkCodeTool.errors }),
      ),
    );
    expect(err.data?.reason).toBe('unknown_code');
  });
});

describe('crosswalk completeness and known output defects', () => {
  it('round-trips a child through its parent without losing the child', async () => {
    const parent = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'E11.9', direction: 'parents' }),
      createMockContext(),
    );
    expect(parent.hits.map((hit) => hit.value)).toEqual(['E11']);

    const children = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: parent.hits[0]!.value, direction: 'children' }),
      createMockContext(),
    );
    expect(children.hits.map((hit) => hit.value)).toContain('E11.9');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/19
  it('includes official target names on ingredient and brand crosswalk hits', async () => {
    const ingredients = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_ingredients' }),
      createMockContext(),
    );
    expect(ingredients.hits).toContainEqual(
      expect.objectContaining({ value: '161', description: 'acetaminophen' }),
    );

    const brands = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_brands' }),
      createMockContext(),
    );
    expect(brands.hits).toContainEqual(
      expect.objectContaining({ value: '202433', description: 'Tylenol' }),
    );

    // The name has to reach the text client path too, not just structuredContent —
    // and it must be the RxNorm name, never the 'IN'/'BN' concept type.
    const ingredientText = renderText(mapCodesTool.format!(ingredients));
    expect(ingredientText).toContain('acetaminophen');
    expect(ingredientText).not.toContain(': IN');
    expect(renderText(mapCodesTool.format!(brands))).toContain('Tylenol');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/21
  it('renders an explicitly empty and complete hierarchy on the text client path', async () => {
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['E11.9'], includeHierarchy: true }),
      createMockContext(),
    );
    expect(out.found[0]).toMatchObject({ children: [], childrenTruncated: false });

    const text = renderText(getCodeTool.format!(out));
    expect(text).toContain('**Children (0):**');
    expect(text).toMatch(/complete/i);

    // The defect is a collision, not a missing line: without hierarchy the same two
    // facts are genuinely absent, so a text-only client can only tell the two states
    // apart if the no-hierarchy render carries neither line.
    const plain = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['E11.9'] }),
      createMockContext(),
    );
    expect(plain.found[0]).not.toHaveProperty('children');
    const plainText = renderText(getCodeTool.format!(plain));
    expect(plainText).not.toMatch(/children/i);
    expect(plainText).not.toMatch(/complete/i);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/27
  it('names the decoded product on an ndc_to_rxcui hit, on both client paths', async () => {
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '11111-2222-33', direction: 'ndc_to_rxcui' }),
      createMockContext(),
    );
    expect(out.hits).toContainEqual(
      expect.objectContaining({
        value: '198440',
        source: 'NDC',
        description: 'Acetaminophen 500 MG Oral Tablet',
      }),
    );
    // Without this the text client sees a bare RXCUI and has to spend a second
    // medcode_get_code call to learn what the package actually is.
    expect(renderText(mapCodesTool.format!(out))).toContain('Acetaminophen 500 MG Oral Tablet');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/28
  it('tags ingredient and brand hits with their RxNorm concept type, on both client paths', async () => {
    const ingredients = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_ingredients' }),
      createMockContext(),
    );
    expect(ingredients.hits).toContainEqual(
      expect.objectContaining({ value: '161', conceptType: 'IN' }),
    );
    expect(renderText(mapCodesTool.format!(ingredients))).toContain(
      '- **161** (RXNORM) via has_ingredient [IN]: acetaminophen',
    );

    const brands = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_brands' }),
      createMockContext(),
    );
    expect(brands.hits).toContainEqual(
      expect.objectContaining({ value: '202433', conceptType: 'BN' }),
    );
    expect(renderText(mapCodesTool.format!(brands))).toContain('[BN]');

    // A hierarchy hit has no RxNorm concept type, so neither surface may show one.
    const parents = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'E11.9', direction: 'parents' }),
      createMockContext(),
    );
    // Length first: `hits[0]?.conceptType` and a not.toMatch over the render both
    // pass on an empty hit list, so neither says anything until there is a hit.
    expect(parents.hits).toHaveLength(1);
    expect(parents.hits[0]?.conceptType).toBeUndefined();
    expect(renderText(mapCodesTool.format!(parents))).not.toMatch(/\[[A-Z]{2,4}\]/);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/26
  it('reports a cursor past the last page as an empty page, not an unmapped source', async () => {
    // A hand-built or stale cursor whose offset outruns the set. `children` is the
    // reference: it confirms the row before paging, so it has always answered this
    // correctly — the drug directions must now agree with it.
    const pastEnd = Buffer.from(JSON.stringify({ offset: 999_999, limit: 2 })).toString(
      'base64url',
    );

    for (const [from, direction] of [
      ['a', 'name_to_rxcui'],
      ['1049640', 'rxcui_to_ndc'],
      ['A00', 'children'],
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
      expect(out.resolvedSystem).toBe(first.resolvedSystem);

      const meta = getEnrichment(ctx);
      expect(meta).toMatchObject({ truncated: false, shown: 0, cap: 2 });
      expect(meta?.nextCursor).toBeUndefined();
      // The notice has to name the page, not invent a missing edge — "leaf code
      // with no children" would be as wrong here as "no bundled code matches".
      expect(meta?.notice).toMatch(/page starts past the last/i);
      expect(meta?.notice).toContain('cursor');
    }
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/26
  it('still throws no_mapping for a source that resolves to nothing at any offset', async () => {
    const pastEnd = Buffer.from(JSON.stringify({ offset: 999_999, limit: 2 })).toString(
      'base64url',
    );
    for (const [from, direction] of [
      ['zzznotadrug', 'name_to_rxcui'],
      ['999999999', 'rxcui_to_ndc'],
    ] as const) {
      const err = await caught(() =>
        mapCodesTool.handler(
          mapCodesTool.input.parse({ from, direction, limit: 2, cursor: pastEnd }),
          createMockContext({ errors: mapCodesTool.errors }),
        ),
      );
      expect(err.data?.reason).toBe('no_mapping');
    }
  });

  it('returns an empty result for a resolvable concept with no edges, on every direction', async () => {
    // 161 decodes through medcode_get_code, so `no_mapping` — whose message is
    // "No bundled code matches" and whose own recovery hint says a resolvable
    // source with no edge is an empty result — would contradict both.
    for (const direction of ['rxcui_to_ndc', 'rxcui_to_ingredients', 'rxcui_to_brands'] as const) {
      const ctx = createMockContext({ errors: mapCodesTool.errors });
      const out = await mapCodesTool.handler(
        mapCodesTool.input.parse({ from: '161', direction }),
        ctx,
      );
      expect(out.hits).toEqual([]);
      expect(out.resolvedSystem).toBe('RXNORM');

      // The notice names the direction's own cause. "Leaf code with no children"
      // and "top-level code with no parent" are both false facts about an RXCUI.
      const notice = getEnrichment(ctx)?.notice ?? '';
      expect(notice).toContain(direction);
      expect(notice).not.toMatch(/leaf code|no parent|starts past the last/i);
    }
  });

  it('does not blame the cursor when a childless source is paged past zero', async () => {
    // The empty page and the non-zero offset are both present, but nothing was
    // skipped — steering the caller back to page one would return the same
    // nothing. Only a source that HAS results can be paged past their end.
    const cursor = Buffer.from(JSON.stringify({ offset: 5, limit: 2 })).toString('base64url');
    const ctx = createMockContext({ errors: mapCodesTool.errors });
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({
        from: 'E11.40',
        direction: 'children',
        system: 'ICD10CM',
        cursor,
      }),
      ctx,
    );
    expect(out.hits).toEqual([]);
    const notice = getEnrichment(ctx)?.notice ?? '';
    expect(notice).toMatch(/leaf code with no children/i);
    expect(notice).not.toMatch(/starts past the last/i);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/29
  it('decodes a materialized header row through every tool that auto-detects', async () => {
    // `J` is a HCPCS letter bucket browse and search both hand back. resolveSystems
    // is the single choke point all three tools share, so a header row that fails
    // detection fails all three — and passing `system` masks it in all three.
    const decoded = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['J'] }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    expect(decoded.notFound).toEqual([]);
    expect(decoded.found[0]).toMatchObject({ system: 'HCPCS', code: 'J', header: true });

    const checked = await checkCodeTool.handler(
      checkCodeTool.input.parse({ code: 'J' }),
      createMockContext({ errors: checkCodeTool.errors }),
    );
    expect(checked).toMatchObject({ system: 'HCPCS', code: 'J', status: 'valid_header' });

    const mapped = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'J', direction: 'children' }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(mapped.resolvedSystem).toBe('HCPCS');
    expect(mapped.hits.map((hit) => hit.value)).toContain('J0120');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/30
  it('matches a chapter filter case-insensitively while echoing the value that ran', async () => {
    const upperCtx = createMockContext();
    const upper = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'diabetes', system: 'ICD10CM', chapter: 'E' }),
      upperCtx,
    );
    expect(upper.codes.length).toBeGreaterThan(0);

    const lowerCtx = createMockContext();
    const lower = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'diabetes', system: 'ICD10CM', chapter: 'e' }),
      lowerCtx,
    );
    expect(lower.codes.map((code) => code.code)).toEqual(upper.codes.map((code) => code.code));

    // The 0.2.5 invariant: the echo names the filter that actually ran against the
    // index, so a caller reading `appliedFilters` can reproduce the query exactly.
    expect(getEnrichment(lowerCtx)?.appliedFilters).toMatchObject({ chapter: 'E' });
    expect(getEnrichment(upperCtx)?.appliedFilters).toMatchObject({ chapter: 'E' });

    // Normalizing case must not widen the filter into a no-op.
    const wrongCtx = createMockContext();
    const wrong = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'diabetes', system: 'ICD10CM', chapter: 'a' }),
      wrongCtx,
    );
    expect(wrong.codes).toEqual([]);
    expect(getEnrichment(wrongCtx)?.appliedFilters).toMatchObject({ chapter: 'A' });
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/22
  it('treats a blank chapter filter as omitted and applies a padded one trimmed', async () => {
    const baseCtx = createMockContext();
    const base = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'sterile' }),
      baseCtx,
    );
    // "sterile" spans two HCPCS chapters in the fixture, so "no chapter predicate
    // ran" is observable in the result set itself, not merely inferred from parity
    // with a baseline that a single-chapter query would satisfy either way.
    expect(new Set(base.codes.map((code) => code.chapter))).toEqual(new Set(['A', 'K']));
    expect(getEnrichment(baseCtx)?.appliedFilters).toMatchObject({ chapter: null });

    for (const chapter of ['', '   ']) {
      const ctx = createMockContext();
      const out = await searchCodesTool.handler(
        searchCodesTool.input.parse({ query: 'sterile', chapter }),
        ctx,
      );
      expect(out.codes.map((code) => code.code)).toEqual(base.codes.map((code) => code.code));
      expect(new Set(out.codes.map((code) => code.chapter))).toEqual(new Set(['A', 'K']));
      expect(getEnrichment(ctx)?.appliedFilters).toMatchObject({ chapter: null });
    }

    // A real value that arrives padded filters on the trimmed value rather than
    // zero-hitting on the literal, and echoes what it actually applied.
    const paddedCtx = createMockContext();
    const padded = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'sterile', chapter: ' A ' }),
      paddedCtx,
    );
    expect(padded.codes.map((code) => code.code)).toEqual(['A4206']);
    expect(getEnrichment(paddedCtx)?.appliedFilters).toMatchObject({ chapter: 'A' });
  });
});
