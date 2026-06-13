/**
 * @fileoverview medcode_map_codes — crosswalk a code or drug across systems and
 * within a hierarchy. v1 ships the hierarchy directions (code → parents/children);
 * the drug directions (drug name → RXCUI, NDC ↔ RXCUI, RXCUI → ingredients/brands)
 * land with RxNorm in phase 2 and raise `direction_unavailable` until then. The
 * relational bridge between the bundled systems and a composition point with the
 * openfda server (NDC/labels).
 * @module mcp-server/tools/definitions/map-codes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { CodeIndexService, getCodeIndexService } from '@/services/code-index/code-index-service.js';
import { type MapDirection, SYSTEM_IDS } from '@/services/code-index/types.js';

const SOURCE_URL =
  'https://github.com/cyanheads/medical-codes-mcp-server/blob/main/src/mcp-server/tools/definitions/map-codes.tool.ts';

const DIRECTIONS = [
  'parents',
  'children',
  'name_to_rxcui',
  'ndc_to_rxcui',
  'rxcui_to_ndc',
  'rxcui_to_ingredients',
  'rxcui_to_brands',
] as const satisfies readonly MapDirection[];

export const mapCodesTool = tool('medcode_map_codes', {
  title: 'medical-codes-mcp-server',
  description:
    "Crosswalk a US medical code or drug across systems and within a hierarchy. Hierarchy directions (available now): `parents` and `children` walk a code's prefix hierarchy (ICD-10-CM/HCPCS; ICD-10-PCS codes have no prefix parent). Drug directions (RxNorm): `name_to_rxcui`, `ndc_to_rxcui`, `rxcui_to_ndc`, `rxcui_to_ingredients`, `rxcui_to_brands` — these return an error until RxNorm is bundled in a later release. Every result carries `source` provenance (which system or edge answered) so a chained call (e.g. into openfda with a resolved NDC) uses the right identifier.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sourceUrl: SOURCE_URL,

  input: z.object({
    from: z
      .string()
      .min(1)
      .describe(
        'The source value: a code (for parents/children), a drug name, an NDC, or an RXCUI.',
      ),
    direction: z
      .enum(DIRECTIONS)
      .describe(
        'What to map to. parents/children walk the code hierarchy; the rxcui/ndc/name directions are RxNorm drug crosswalks (phase 2).',
      ),
    system: z
      .enum(SYSTEM_IDS)
      .optional()
      .describe(
        'For parents/children, force the source code into this system. Omit to auto-detect.',
      ),
  }),

  output: z.object({
    from: z.string().describe('The source value, echoed back.'),
    direction: z.string().describe('The mapping direction that was applied.'),
    resolvedSystem: z
      .string()
      .nullable()
      .describe('The system the source resolved in, or null when not system-scoped.'),
    hits: z
      .array(
        z
          .object({
            source: z
              .string()
              .describe(
                'Which system or relationship edge produced this hit (e.g. "ICD10CM", "has_ingredient", "NDC").',
              ),
            system: z
              .string()
              .nullable()
              .describe(
                'The code system of the target value, or null when the target is not a system code (e.g. an NDC).',
              ),
            value: z.string().describe('The mapped target value (a code, RXCUI, or NDC).'),
            description: z
              .string()
              .optional()
              .describe('Description of the target when available.'),
          })
          .describe('One crosswalk result tagged with the edge that produced it.'),
      )
      .describe('Crosswalk results, each tagged with the edge that produced it.'),
  }),

  errors: [
    {
      reason: 'no_mapping',
      code: JsonRpcErrorCode.NotFound,
      when: 'The source resolved but has no edge in the requested direction.',
      recovery:
        'Confirm the direction is supported for this system, or decode the code with medcode_get_code first.',
    },
    {
      reason: 'direction_unavailable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A drug-crosswalk direction was requested before RxNorm (phase 2) is bundled.',
      recovery: 'Use a hierarchy direction (parents/children); drug crosswalks land with RxNorm.',
    },
    {
      reason: 'ambiguous_system',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The source code is present in more than one system and no `system` was given.',
      recovery: 'Re-call with an explicit `system` to disambiguate.',
    },
  ],

  handler(input, ctx) {
    const svc = getCodeIndexService();

    if (CodeIndexService.isDrugDirection(input.direction) && !svc.hasRxNorm()) {
      throw ctx.fail(
        'direction_unavailable',
        `The "${input.direction}" crosswalk needs RxNorm, which is not bundled in this release.`,
        { ...ctx.recoveryFor('direction_unavailable') },
      );
    }

    const result = svc.mapCode(input.from, input.direction, input.system);

    if (result.kind === 'ambiguous') {
      throw ctx.fail(
        'ambiguous_system',
        `"${input.from.trim()}" exists in multiple systems: ${result.systems.join(', ')}.`,
        { candidateSystems: result.systems, ...ctx.recoveryFor('ambiguous_system') },
      );
    }
    if (result.kind === 'source_not_found') {
      throw ctx.fail(
        'no_mapping',
        `No "${input.direction}" mapping found for "${input.from.trim()}".`,
        { ...ctx.recoveryFor('no_mapping') },
      );
    }
    if (result.hits.length === 0) {
      throw ctx.fail(
        'no_mapping',
        `"${input.from.trim()}" resolved but has no ${input.direction} (e.g. a top-level code has no parent).`,
        { ...ctx.recoveryFor('no_mapping') },
      );
    }

    ctx.log.info('Mapped code', {
      from: input.from,
      direction: input.direction,
      hits: result.hits.length,
    });
    return {
      from: input.from.trim(),
      direction: input.direction,
      resolvedSystem: result.resolvedSystem,
      hits: result.hits.map((h) => ({
        source: h.source,
        system: h.system,
        value: h.value,
        ...(h.description ? { description: h.description } : {}),
      })),
    };
  },

  format: (result) => {
    const lines = [
      `## ${result.direction}: ${result.from}`,
      result.resolvedSystem ? `**Resolved system:** ${result.resolvedSystem}` : '',
      '',
    ].filter(Boolean);
    for (const h of result.hits) {
      lines.push(
        `- **${h.value}**${h.system ? ` (${h.system})` : ''} via ${h.source}${h.description ? `: ${h.description}` : ''}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
