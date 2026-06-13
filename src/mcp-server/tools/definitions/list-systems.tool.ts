/**
 * @fileoverview medcode_list_systems — list the bundled code systems with their
 * release identifiers, effective dates, and code counts. Cheap orientation /
 * provenance call so a caller can confirm which ICD-10 fiscal year, HCPCS
 * release, and RxNorm month are active before acting on results.
 * @module mcp-server/tools/definitions/list-systems.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { getCodeIndexService } from '@/services/code-index/code-index-service.js';
import { SYSTEM_LABELS } from '@/services/code-index/types.js';

const SOURCE_URL =
  'https://github.com/cyanheads/medical-codes-mcp-server/blob/main/src/mcp-server/tools/definitions/list-systems.tool.ts';

export const listSystemsTool = tool('medcode_list_systems', {
  title: 'medical-codes-mcp-server',
  description:
    'List the bundled US medical code systems with their release identifiers, effective dates, and code counts. Confirms which ICD-10-CM fiscal year, ICD-10-PCS fiscal year, HCPCS Level II release, and (when bundled) RxNorm month are active before acting on any decode, search, or crosswalk result. The corpus is offline and built at package-build time — this call reports exactly which release is baked into the running server. ICD-10-CM/PCS are the US clinical modifications, not the ICD-10/ICD-11 base.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sourceUrl: SOURCE_URL,

  input: z.object({}),

  output: z.object({
    systems: z
      .array(
        z
          .object({
            system: z
              .string()
              .describe('System identifier, e.g. "ICD10CM", "ICD10PCS", "HCPCS", "RXNORM".'),
            label: z.string().describe('Human-readable system name, e.g. "ICD-10-CM".'),
            releaseId: z
              .string()
              .describe(
                'Release/version identifier baked into this build, e.g. "ICD-10-CM FY2026".',
              ),
            effectiveStart: z
              .string()
              .nullable()
              .describe(
                'First date this release is effective (YYYY-MM-DD), or null if not recorded.',
              ),
            effectiveEnd: z
              .string()
              .nullable()
              .describe('Last date this release is effective (YYYY-MM-DD), or null if open-ended.'),
            codeCount: z.number().describe('Number of code rows bundled for this system.'),
            sourceUrl: z
              .string()
              .nullable()
              .describe('Canonical .gov source the release was built from, or null.'),
            builtAt: z.string().describe('ISO 8601 timestamp when this system was last baked.'),
          })
          .describe('Provenance for one bundled code system.'),
      )
      .describe('One entry per bundled code system, in canonical order.'),
  }),

  handler(_input, ctx) {
    const systems = getCodeIndexService()
      .listSystems()
      .map((s) => ({
        system: s.system,
        label: SYSTEM_LABELS[s.system] ?? s.system,
        releaseId: s.releaseId,
        effectiveStart: s.effectiveStart,
        effectiveEnd: s.effectiveEnd,
        codeCount: s.codeCount,
        sourceUrl: s.sourceUrl,
        builtAt: s.builtAt,
      }));
    ctx.log.info('Listed bundled code systems', { count: systems.length });
    return { systems };
  },

  format: (result) => {
    const lines = ['## Bundled code systems', ''];
    lines.push('| System | Release | Effective | Codes |');
    lines.push('|:---|:---|:---|---:|');
    for (const s of result.systems) {
      const effective =
        s.effectiveStart && s.effectiveEnd
          ? `${s.effectiveStart} → ${s.effectiveEnd}`
          : (s.effectiveStart ?? s.effectiveEnd ?? '—');
      lines.push(`| ${s.label} (${s.system}) | ${s.releaseId} | ${effective} | ${s.codeCount} |`);
    }
    lines.push('');
    for (const s of result.systems) {
      if (s.sourceUrl) lines.push(`- **${s.label}** source: ${s.sourceUrl} (built ${s.builtAt})`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
