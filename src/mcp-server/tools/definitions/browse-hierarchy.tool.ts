/**
 * @fileoverview medcode_browse_hierarchy — walk a code system's hierarchy
 * without a search term. Returns the children of a node, or the top-level
 * entries when no node is given. ICD-10-CM/HCPCS browse the prefix hierarchy
 * (chapter → category → code); ICD-10-PCS browses its axis structure (each of
 * the 7 characters is an independent axis), returning valid next-position axis
 * values rather than prefix children.
 * @module mcp-server/tools/definitions/browse-hierarchy.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getServerConfig } from '@/config/server-config.js';
import { getCodeIndexService } from '@/services/code-index/code-index-service.js';
import { SYSTEM_IDS } from '@/services/code-index/types.js';
import { renderCodeLine } from './_render.js';

const SOURCE_URL =
  'https://github.com/cyanheads/medical-codes-mcp-server/blob/main/src/mcp-server/tools/definitions/browse-hierarchy.tool.ts';

const CodeNodeSchema = z
  .object({
    system: z.string().describe('The system the node belongs to.'),
    code: z.string().describe('The child code in display form.'),
    description: z.string().nullable().describe('Official long description, or null.'),
    shortDescription: z.string().nullable().describe('Official short description, or null.'),
    billable: z.boolean().describe('True when the code is a billable leaf.'),
    header: z.boolean().describe('True when the code is a non-billable category/header.'),
    chapter: z.string().nullable().describe('Chapter/range bucket, or null.'),
  })
  .describe('A child code in a prefix hierarchy (ICD-10-CM/HCPCS).');

const AxisNodeSchema = z
  .object({
    position: z.number().describe('The 1-based character position in the ICD-10-PCS code.'),
    value: z.string().describe('The single-character axis value valid at this position.'),
    meaning: z.string().describe('What this axis value means at this position.'),
  })
  .describe('A valid ICD-10-PCS axis value at a given character position.');

export const browseHierarchyTool = tool('medcode_browse_hierarchy', {
  title: 'medical-codes-mcp-server',
  description:
    "Walk a US medical code system's hierarchy for discovery without a search term. With no `node`, returns the top-level entries (ICD-10-CM categories, HCPCS range buckets, or ICD-10-PCS first-axis values). With a `node`, returns its immediate children. ICD-10-CM and HCPCS use a prefix hierarchy (a shorter code is the parent of a longer one); ICD-10-PCS is axis-based — each of its 7 characters is an independent axis (section, body system, root operation, body part, approach, device, qualifier), so browsing returns the valid values for the next character position, not prefix children. Lets an agent orient in an unfamiliar system or enumerate a category's specific codes.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sourceUrl: SOURCE_URL,

  input: z.object({
    system: z.enum(SYSTEM_IDS).describe('The code system to browse.'),
    node: z
      .string()
      .optional()
      .describe(
        'A node to expand. For ICD-10-CM/HCPCS, a code whose children to list. For ICD-10-PCS, a partial code whose next-position axis values to list. Omit for the top level.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Max entries to return. Defaults to MEDCODE_MAX_RESULTS (50), ceiling 200.'),
  }),

  output: z.object({
    kind: z
      .enum(['codes', 'axes'])
      .describe(
        '"codes" for prefix-hierarchy children (ICD-10-CM/HCPCS); "axes" for ICD-10-PCS axis values.',
      ),
    codes: z
      .array(CodeNodeSchema)
      .describe('Child codes under the requested node or top level. Empty when kind is "axes".'),
    axes: z
      .array(AxisNodeSchema)
      .describe(
        'Valid next-position axis values for a partial PCS code. Empty when kind is "codes".',
      ),
  }),

  enrichment: {
    truncated: z.boolean().describe('True when the returned list was capped at the limit.'),
    shown: z.number().describe('Number of entries returned (codes or axes).'),
    cap: z.number().describe('The limit that was applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when a node has no children/axes — suggests the top level or a valid node.',
      ),
  },

  errors: [
    {
      reason: 'unknown_node',
      code: JsonRpcErrorCode.NotFound,
      when: 'The node does not exist in the system.',
      recovery: 'Omit `node` to list top-level entries, or verify the node code.',
    },
  ],

  handler(input, ctx) {
    const limit = input.limit ?? getServerConfig().maxResults;
    const result = getCodeIndexService().browse(input.system, input.node, limit);

    if (result.kind === 'unknown_node') {
      throw ctx.fail('unknown_node', `Node "${input.node}" does not exist in ${input.system}.`, {
        ...ctx.recoveryFor('unknown_node'),
      });
    }

    if (result.kind === 'axes') {
      ctx.enrich({ truncated: result.axes.length >= limit, shown: result.axes.length, cap: limit });
      if (result.axes.length === 0) {
        ctx.enrich.notice(
          input.node
            ? `ICD-10-PCS axis values for positions 2–7 are context-dependent (their meaning ` +
                `varies by the section, body system, and operation that precede them), so they ` +
                `are not enumerable from a flat partial code. Omit \`node\` to list the 17 ` +
                `sections, or decode a complete 7-character code with medcode_get_code for its ` +
                `full axis breakdown.`
            : `No ICD-10-PCS sections are bundled in this release.`,
        );
      }
      ctx.log.info('Browsed PCS axes', { node: input.node ?? null, count: result.axes.length });
      return { kind: 'axes' as const, codes: [], axes: result.axes };
    }

    ctx.enrich({ truncated: result.codes.length >= limit, shown: result.codes.length, cap: limit });
    if (result.codes.length === 0) {
      ctx.enrich.notice(
        `No children under "${input.node ?? '(top level)'}" in ${input.system}. ` +
          'Omit `node` for the top level, or browse a parent category.',
      );
    }
    ctx.log.info('Browsed hierarchy', { node: input.node ?? null, count: result.codes.length });
    return { kind: 'codes' as const, codes: result.codes, axes: [] };
  },

  // Render both arrays unconditionally — one is always empty at runtime, but the
  // format-parity linter synthesizes a single sample with both populated, so each
  // branch's fields must be reachable in one pass (kind discrimination would hide
  // half of them from the linter).
  format: (result) => {
    const lines = [`## Browse result (${result.kind})`, ''];
    if (result.codes.length > 0 || result.kind === 'codes') {
      lines.push(`### ${result.codes.length} child code(s)`);
      for (const c of result.codes) lines.push(renderCodeLine(c));
    }
    if (result.axes.length > 0 || result.kind === 'axes') {
      lines.push(
        '### ICD-10-PCS axis values',
        '',
        '| Position | Value | Meaning |',
        '|---:|:---|:---|',
      );
      for (const a of result.axes) lines.push(`| ${a.position} | ${a.value} | ${a.meaning} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
