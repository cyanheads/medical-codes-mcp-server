/**
 * @fileoverview medcode_map_codes — crosswalk a code or drug across systems and
 * within a hierarchy. Hierarchy directions (code → parents/children) and the
 * RxNorm drug directions (drug name → RXCUI, NDC ↔ RXCUI, RXCUI →
 * ingredients/brands) are all live against the bundled corpus. The relational
 * bridge between the bundled systems and a composition point with the openfda
 * server (NDC/labels).
 * @module mcp-server/tools/definitions/map-codes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { CodeIndexService, getCodeIndexService } from '@/services/code-index/code-index-service.js';
import { type MapDirection, SYSTEM_IDS } from '@/services/code-index/types.js';
import { encodeNextCursor, resolvePage } from './_pagination.js';

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
    "Crosswalk a US medical code or drug across systems and within a hierarchy. Hierarchy directions: `parents` and `children` walk a code's prefix hierarchy one level per call — immediate parent/children only (depth-1); call iteratively for the full ancestor or descendant path (ICD-10-CM/HCPCS; ICD-10-PCS codes have no prefix parent). A resolvable code with no edge in the requested direction is a successful empty result with a notice, not an error. Drug directions (RxNorm): `name_to_rxcui` (drug name → RXCUI), `ndc_to_rxcui` and `rxcui_to_ndc` (NDC ↔ RXCUI; NDCs accepted hyphenated or 10/11-digit), `rxcui_to_ingredients` and `rxcui_to_brands` (RXCUI → ingredient/brand RXCUIs). Every result carries `source` provenance (which system or edge answered) so a chained call (e.g. into openfda with a resolved NDC) uses the right identifier. The `children` and `name_to_rxcui` directions can return large sets and paginate: a `nextCursor` in the response is passed back as `cursor` (with an optional `limit` page size) to walk the full set; the point directions ignore both.",
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
        'What to map to. parents/children return the immediate parent or children only (depth-1) — call iteratively to walk a full path; the rxcui/ndc/name directions are RxNorm drug crosswalks.',
      ),
    system: z
      .enum(SYSTEM_IDS)
      .optional()
      .describe(
        'For parents/children, force the source code into this system. Omit to auto-detect.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Max results per page for the paginated directions (children, name_to_rxcui). Defaults to MEDCODE_MAX_RESULTS (50), ceiling 200. Ignored by the point directions.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque continuation token from a previous response's `nextCursor`, for the paginated directions (children, name_to_rxcui). Omit for the first page.",
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

  enrichment: {
    truncated: z
      .boolean()
      .optional()
      .describe(
        'Paginated directions (children, name_to_rxcui) only: true when more results exist beyond this page.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Paginated directions only: number of hits returned on this page.'),
    cap: z
      .number()
      .optional()
      .describe('Paginated directions only: the page size that was applied.'),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Paginated directions only: opaque token to pass back as `cursor` for the next page. Present only when more results exist beyond this page.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when a resolvable code has no edge in the requested direction (e.g. a top-level code has no parent; a leaf has no children; ICD-10-PCS codes have no prefix parent).',
      ),
  },

  errors: [
    {
      reason: 'no_mapping',
      code: JsonRpcErrorCode.NotFound,
      when: 'The source value did not resolve to any bundled code.',
      recovery:
        'Check the code, or decode it with medcode_get_code first. A resolvable code with no edge in the requested direction returns an empty result with a notice, not this error.',
    },
    {
      reason: 'direction_unavailable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A drug-crosswalk direction was requested but this build carries no RxNorm tables.',
      recovery:
        'Use a hierarchy direction (parents/children), or rebuild the index with RxNorm bundled (the shipped default).',
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
        `The "${input.direction}" crosswalk needs RxNorm, which is not present in this build of the index.`,
        { ...ctx.recoveryFor('direction_unavailable') },
      );
    }

    const page = resolvePage(input.cursor, input.limit);
    const result = svc.mapCode(input.from, input.direction, input.system, page);

    if (result.kind === 'ambiguous') {
      throw ctx.fail(
        'ambiguous_system',
        `"${input.from.trim()}" exists in multiple systems: ${result.systems.join(', ')}.`,
        { candidateSystems: result.systems, ...ctx.recoveryFor('ambiguous_system') },
      );
    }
    if (result.kind === 'source_not_found') {
      throw ctx.fail('no_mapping', `No bundled code matches "${input.from.trim()}".`, {
        ...ctx.recoveryFor('no_mapping'),
      });
    }

    // children and name_to_rxcui paginate; disclose truncation + continuation for
    // them (even at zero hits — a leaf's empty children page is still "complete").
    // The point directions ignore the page and carry no continuation metadata.
    if (input.direction === 'children' || input.direction === 'name_to_rxcui') {
      ctx.enrich({ truncated: result.hasMore, shown: result.hits.length, cap: page.limit });
      if (result.hasMore) ctx.enrich({ nextCursor: encodeNextCursor(page) });
    }

    if (result.hits.length === 0) {
      // Resolved, but no edge in this direction — a successful empty result with a
      // notice, consistent with search_codes / browse_hierarchy. Only `parents` and
      // `children` reach this branch (drug directions return source_not_found).
      const reason =
        input.direction === 'children'
          ? 'it is a leaf code with no children'
          : result.resolvedSystem === 'ICD10PCS'
            ? 'ICD-10-PCS codes are axis-based and have no prefix parent'
            : 'it is a top-level code with no parent';
      ctx.enrich.notice(
        `"${input.from.trim()}" resolved in ${result.resolvedSystem} but has no ${input.direction} — ${reason}. Decode it with medcode_get_code, or map the opposite direction.`,
      );
      ctx.log.info('Mapped code (no edge)', {
        from: input.from,
        direction: input.direction,
        resolvedSystem: result.resolvedSystem,
      });
      return {
        from: input.from.trim(),
        direction: input.direction,
        resolvedSystem: result.resolvedSystem,
        hits: [],
      };
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
