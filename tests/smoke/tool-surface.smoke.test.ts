/**
 * @fileoverview One real-index smoke path through every public tool, including
 * output-schema validation and the text surface consumed by content-only clients.
 * @module tests/smoke/tool-surface.smoke.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, expect, it } from 'vitest';

import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { listSystemsTool } from '@/mcp-server/tools/definitions/list-systems.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import { ensureBundledIndex } from '../helpers/bundled-index.ts';

function textOf(blocks: ReturnType<NonNullable<typeof getCodeTool.format>>): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

beforeAll(async () => {
  await ensureBundledIndex();
});

it('executes and renders all six tools against the shipped index', async () => {
  const systems = await listSystemsTool.handler(
    listSystemsTool.input.parse({}),
    createMockContext(),
  );
  expect(systems).toEqual(expect.schemaMatching(listSystemsTool.output));
  expect(textOf(listSystemsTool.format!(systems))).toContain('ICD-10-CM FY2026');

  const decoded = await getCodeTool.handler(
    getCodeTool.input.parse({ codes: ['E11.9'] }),
    createMockContext({ errors: getCodeTool.errors }),
  );
  expect(decoded).toEqual(expect.schemaMatching(getCodeTool.output));
  expect(textOf(getCodeTool.format!(decoded))).toContain('E11.9');

  const searched = await searchCodesTool.handler(
    searchCodesTool.input.parse({
      query: 'type 2 diabetes without complications',
      system: 'ICD10CM',
      billableOnly: true,
      limit: 10,
    }),
    createMockContext(),
  );
  expect(searched).toEqual(expect.schemaMatching(searchCodesTool.output));
  expect(searched.codes.map((code) => code.code)).toContain('E11.9');
  expect(textOf(searchCodesTool.format!(searched))).toContain('E11.9');

  const checked = await checkCodeTool.handler(
    checkCodeTool.input.parse({ code: 'E11.9' }),
    createMockContext({ errors: checkCodeTool.errors }),
  );
  expect(checked).toEqual(expect.schemaMatching(checkCodeTool.output));
  expect(textOf(checkCodeTool.format!(checked))).toContain('Valid and billable');

  const mapped = await mapCodesTool.handler(
    mapCodesTool.input.parse({ from: '0002-0152-01', direction: 'ndc_to_rxcui' }),
    createMockContext({ errors: mapCodesTool.errors }),
  );
  expect(mapped).toEqual(expect.schemaMatching(mapCodesTool.output));
  expect(mapped.hits.map((hit) => hit.value)).toEqual(['2679323']);
  expect(textOf(mapCodesTool.format!(mapped))).toContain('2679323');

  const browsed = await browseHierarchyTool.handler(
    browseHierarchyTool.input.parse({ system: 'ICD10PCS' }),
    createMockContext({ errors: browseHierarchyTool.errors }),
  );
  expect(browsed).toEqual(expect.schemaMatching(browseHierarchyTool.output));
  expect(browsed.axes).toContainEqual({
    position: 1,
    value: '0',
    meaning: 'Medical and Surgical',
  });
  expect(textOf(browseHierarchyTool.format!(browsed))).toContain('Medical and Surgical');
});
