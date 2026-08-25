/**
 * @fileoverview The `content[]` surface every tool renders through `format()`.
 * Text-only clients (Claude Desktop) never see `structuredContent`, so anything
 * the model needs to act on — codes, descriptions, flags, provenance, hierarchy,
 * failures — has to survive into the markdown. Asserted per tool against the
 * fixture index, plus the sparse/edge shapes the handler cannot produce on demand.
 * @module tests/tools/format-rendering.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import { ensureIndex } from '../helpers/index-fixture.ts';

/** Flatten format() blocks into the text a content-only client would receive. */
function textOf(blocks: { text?: string; type: string }[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n');
}

beforeAll(async () => {
  await ensureIndex();
});

describe('medcode_get_code format', () => {
  it('renders a root code with its hierarchy, flags, and both descriptions', async () => {
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['E11'], includeHierarchy: true }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    const text = textOf(getCodeTool.format!(out));

    expect(text).toContain('## E11 — ICD-10-CM');
    expect(text).toContain('billable: no, header: yes');
    expect(text).toContain('Type 2 diabetes mellitus');
    expect(text).toContain('**Parent:** (none — root)');
    expect(text).toContain('**Children (1):**');
    // A complete child list says so, so the text path never leaves the caller
    // guessing whether more children were withheld.
    expect(text).toContain('_Complete: no further children exist beyond those listed._');
    // Every child the structured path carries must be named in the text too.
    for (const child of out.found[0]?.children ?? []) expect(text).toContain(child.code);
  });

  it('names the immediate parent of a non-root code', async () => {
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['E11.9'], includeHierarchy: true }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    const text = textOf(getCodeTool.format!(out));
    expect(text).toContain('**Parent:** E11');
    // Short description differs from the long one here, so both must render.
    expect(text).toContain('Type 2 diabetes mellitus without complications');
    expect(text).toContain('_Short:_ Type 2 diab w/o complications');
  });

  it('discloses the NDC resolution path and the unresolved codes with their reasons', async () => {
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['11111-2222-33', 'A0100', '99999-8888-77'] }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    const text = textOf(getCodeTool.format!(out));

    expect(text).toContain('**Resolved via:** NDC');
    expect(text).toContain('### Not found (2)');
    // The ambiguous code must carry its candidate systems, or the caller cannot
    // re-issue the disambiguated call from the text path alone.
    expect(text).toContain('**A0100**');
    expect(text).toContain('[ICD10CM, HCPCS]');
    expect(text).toContain('**99999-8888-77**');
    expect(text).toMatch(/valid NDC format/i);
  });

  it('discloses a truncated child list rather than presenting it as complete', () => {
    const out = getCodeTool.output.parse({
      found: [
        {
          system: 'ICD10CM',
          code: 'A00',
          description: 'Cholera',
          shortDescription: 'Cholera',
          billable: false,
          header: true,
          chapter: 'A',
          parent: null,
          children: [
            {
              system: 'ICD10CM',
              code: 'A00.0',
              description: null,
              shortDescription: null,
              billable: true,
              header: false,
              chapter: null,
            },
          ],
          childrenTruncated: true,
        },
      ],
      notFound: [],
    });
    const text = textOf(getCodeTool.format!(out));

    expect(text).toContain('**Children (1):**');
    expect(text).toMatch(/More children exist/i);
    expect(text).toContain('medcode_browse_hierarchy');
    // The truncated and complete states are mutually exclusive renders — a caller
    // must never see both, or the disclosure is worthless.
    expect(text).not.toMatch(/^_Complete:/m);
    // A row with neither description must say so, not render an empty gap.
    expect(text).toContain('(no description)');
  });

  it('renders a description-less, chapter-less code without emitting empty fields', () => {
    const out = getCodeTool.output.parse({
      found: [
        {
          system: 'RXNORM',
          code: '161',
          description: null,
          shortDescription: null,
          billable: false,
          header: false,
          chapter: null,
        },
      ],
      notFound: [],
    });
    const text = textOf(getCodeTool.format!(out));

    expect(text).toContain('## 161 — RxNorm');
    expect(text).toContain('billable: no, header: no');
    expect(text).toContain('(no description)');
    expect(text).not.toContain('chapter');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});

describe('medcode_search_codes format', () => {
  it('renders every matched code with its system label, flags, and chapter', async () => {
    const out = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'diabetes', chapter: 'E', system: 'ICD10CM' }),
      createMockContext(),
    );
    const text = textOf(searchCodesTool.format!(out));

    expect(out.codes.length).toBeGreaterThan(0);
    expect(text).toContain(`## ${out.codes.length} matching code(s)`);
    for (const code of out.codes) expect(text).toContain(`**${code.code}**`);
    expect(text).toContain('· chapter E');
    expect(text).toContain('(ICD-10-CM;');
  });

  it('says nothing matched instead of rendering an empty list', async () => {
    const out = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'zzzznotarealterm' }),
      createMockContext(),
    );
    expect(textOf(searchCodesTool.format!(out))).toBe('No matching codes.');
  });

  it('renders the applied filters through the enrichment trailer', () => {
    const render = searchCodesTool.enrichmentTrailer?.appliedFilters?.render as (
      v: unknown,
    ) => string;
    expect(render({ system: 'HCPCS', billableOnly: true, chapter: 'J' })).toBe(
      '**Filters:** system=HCPCS, billableOnly=true, chapter=J',
    );
    // Unset filters read as "any" — never as an empty value the model could
    // misread as "filtered to nothing".
    expect(render({ system: null, billableOnly: false, chapter: null })).toBe(
      '**Filters:** system=any, billableOnly=false, chapter=any',
    );
  });
});

describe('medcode_check_code format', () => {
  it('renders the verdict, billability, and the why-not for a non-billable code', async () => {
    const out = await checkCodeTool.handler(
      checkCodeTool.input.parse({ code: 'E11' }),
      createMockContext({ errors: checkCodeTool.errors }),
    );
    const text = textOf(checkCodeTool.format!(out));
    expect(text).toContain('## E11 — ICD-10-CM');
    expect(text).toContain('Valid category/header');
    expect(text).toContain('**Billable:** No');
    expect(text).toContain(out.whyNot as string);
  });

  it('renders a billable verdict with no why-not paragraph', async () => {
    const out = await checkCodeTool.handler(
      checkCodeTool.input.parse({ code: 'E11.9' }),
      createMockContext({ errors: checkCodeTool.errors }),
    );
    const text = textOf(checkCodeTool.format!(out));
    expect(text).toContain('**Billable:** Yes');
    expect(text).toContain('Valid and billable');
    expect(text.trimEnd().endsWith('**Billable:** Yes')).toBe(true);
  });
});

describe('medcode_browse_hierarchy format', () => {
  it('renders child codes under a node', async () => {
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10CM', node: 'A00' }),
      createMockContext({ errors: browseHierarchyTool.errors }),
    );
    const text = textOf(browseHierarchyTool.format!(out));
    expect(text).toContain('## Browse result (codes)');
    expect(text).toContain('### 2 child code(s)');
    expect(text).toContain('**A00.0**');
    expect(text).toContain('**A00.1**');
  });

  it('renders PCS axis values as a position/value/meaning table', async () => {
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10PCS' }),
      createMockContext({ errors: browseHierarchyTool.errors }),
    );
    const text = textOf(browseHierarchyTool.format!(out));
    expect(text).toContain('### ICD-10-PCS axis values');
    expect(text).toContain('| 1 | 0 | Medical and Surgical |');
  });
});

describe('medcode_map_codes format', () => {
  it('renders each hit with its value, system, and edge', async () => {
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'E11.9', direction: 'parents' }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    const text = textOf(mapCodesTool.format!(out));
    expect(text).toContain('## parents: E11.9');
    expect(text).toContain('**Resolved system:** ICD10CM');
    expect(text).toContain('- **E11** (ICD10CM) via ICD10CM: Type 2 diabetes mellitus');
  });

  it('omits the resolved-system line for a system-less crosswalk', () => {
    const out = mapCodesTool.output.parse({
      from: '198440',
      direction: 'rxcui_to_ndc',
      resolvedSystem: null,
      hits: [{ source: 'NDC', system: null, value: '11111222233' }],
    });
    const text = textOf(mapCodesTool.format!(out));
    expect(text).not.toContain('Resolved system');
    expect(text).toContain('- **11111222233** via NDC');
  });
});
