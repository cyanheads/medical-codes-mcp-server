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
import { nonBlankString } from './_schema.js';

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

/**
 * The directions whose result sets are unbounded in the corpus and therefore
 * paginate: hierarchy children, the drug-name substring crosswalk, and a
 * product's package NDCs (one RXCUI can carry thousands). The remaining point
 * directions ignore `limit`/`cursor` and carry no continuation metadata.
 */
const PAGINATED_DIRECTIONS: ReadonlySet<MapDirection> = new Set([
  'children',
  'name_to_rxcui',
  'rxcui_to_ndc',
]);

/**
 * The notice for a resolvable source that has no edges in `direction`. Every
 * direction states its own cause and next move, because the causes are not
 * interchangeable facts: an ingredient concept has no ingredients of its own, an
 * ICD-10-PCS code has no prefix parent, and wording either as "a leaf code with
 * no children" would tell the caller something untrue about its input.
 */
function noEdgeNotice(from: string, direction: MapDirection, system: string | null): string {
  const head = `"${from}" resolved in ${system} but has no ${direction}`;
  switch (direction) {
    case 'children':
      return `${head} — it is a leaf code with no children. Decode it with medcode_get_code, or map the opposite direction.`;
    case 'rxcui_to_ndc':
      return `${head} — no package in the bundled prescribable set lists it. Ingredient and brand-name concepts carry no packages; map a drug product's RXCUI instead.`;
    case 'rxcui_to_ingredients':
      return `${head} — ingredient, precise-ingredient, multiple-ingredient, and brand-name concepts carry no ingredient edges. Map a drug product's RXCUI instead, or decode this one with medcode_get_code.`;
    case 'rxcui_to_brands':
      return `${head} — no branded form of it is in the bundled prescribable set. Decode it with medcode_get_code.`;
    default:
      return system === 'ICD10PCS'
        ? `${head} — ICD-10-PCS codes are axis-based and have no prefix parent. Decode it with medcode_get_code.`
        : `${head} — it is a top-level code with no parent. Decode it with medcode_get_code, or map the opposite direction.`;
  }
}

export const mapCodesTool = tool('medcode_map_codes', {
  title: 'medical-codes-mcp-server',
  description:
    "Crosswalk a US medical code or drug across systems and within a hierarchy. Hierarchy directions: `parents` and `children` walk a code's prefix hierarchy one level per call — immediate parent/children only (depth-1); call iteratively for the full ancestor or descendant path (ICD-10-CM/HCPCS; ICD-10-PCS codes have no prefix parent). A resolvable source with no edge in the requested direction is a successful empty result with a notice, not an error. A source code string that also exists in another bundled system carries `alsoInSystems` naming it, since only the resolved system's hierarchy was walked. Drug directions (RxNorm): `name_to_rxcui` (drug name → RXCUI), `ndc_to_rxcui` and `rxcui_to_ndc` (NDC ↔ RXCUI; NDCs accepted hyphenated in an FDA segment configuration — 4-4-2, 5-3-2, 5-4-1, or the 11-digit 5-4-2 — or as bare 10/11 digits; `ndc_to_rxcui` names the product it decoded to), `rxcui_to_ingredients` and `rxcui_to_brands` (RXCUI → ingredient/brand RXCUIs, each with the target's RxNorm name and its `conceptType` — read that before counting a combination product's ingredients). Every result carries `source` provenance (which system or edge answered) so a chained call (e.g. into openfda with a resolved NDC) uses the right identifier. The `children`, `name_to_rxcui`, and `rxcui_to_ndc` directions can return large sets and paginate: a `nextCursor` in the response is passed back as `cursor` (with an optional `limit` page size) to walk the full set; the point directions ignore both.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sourceUrl: SOURCE_URL,

  input: z.object({
    from: nonBlankString('from').describe(
      'The source value: a code (for parents/children), a drug name, an NDC, or an RXCUI. Must not be blank or whitespace-only.',
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
        'Max results per page for the paginated directions (children, name_to_rxcui, rxcui_to_ndc). Defaults to MEDCODE_MAX_RESULTS (50), ceiling 200. Ignored by the point directions.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque continuation token from a previous response's `nextCursor`, for the paginated directions (children, name_to_rxcui, rxcui_to_ndc). Omit for the first page.",
      ),
  }),

  output: z.object({
    from: z.string().describe('The source value, echoed back.'),
    direction: z.string().describe('The mapping direction that was applied.'),
    resolvedSystem: z
      .string()
      .nullable()
      .describe('The system the source resolved in, or null when not system-scoped.'),
    alsoInSystems: z
      .array(z.string())
      .optional()
      .describe(
        'Other bundled systems holding the same `from` code string, present only when there is at least one (hierarchy directions only — a drug name, NDC, or RXCUI is not system-scoped). The hits above were walked in `resolvedSystem` alone; the code is a DIFFERENT code with a different hierarchy in each system listed here — "B00" is the ICD-10-CM category "Herpesviral [herpes simplex] infections" and also the ICD-10-PCS table row "Imaging, Central Nervous System, Plain Radiography". Re-call with `system` set to one of these values to walk it there.',
      ),
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
              .describe(
                'Description of the target when available: the code description for hierarchy hits, the official RxNorm name for the `name_to_rxcui`, `ndc_to_rxcui`, `rxcui_to_ingredients`, and `rxcui_to_brands` drug concepts. Absent for `rxcui_to_ndc`, whose targets are package identifiers with no description of their own.',
              ),
            conceptType: z
              .string()
              .optional()
              .describe(
                'The target concept\'s RxNorm type, present on `rxcui_to_ingredients` and `rxcui_to_brands` hits only: "IN" (ingredient), "PIN" (precise ingredient — a specific salt, ester, or isomer of an ingredient), "MIN" (multiple ingredients — a concept naming a combination, never a substance within it), or "BN" (brand name). Ingredient hits mix the first three, so the hit count is not the substance count: a "MIN" hit is the grouping concept and never counts, and a "PIN" names a form of a substance rather than an extra one — usually alongside the "IN" it refines, though two "PIN" esters can share a single "IN". Counting the "IN" hits is the closest reading, and under-counts those shared cases.',
              ),
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
        'Paginated directions (children, name_to_rxcui, rxcui_to_ndc) only: true when more results exist beyond this page.',
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
        'Guidance whenever a resolvable source returns no hits, naming which of the two causes applies: it has no edge in the requested direction (a top-level code has no parent; a leaf has no children; ICD-10-PCS codes have no prefix parent), or the `cursor` starts past the last page of a direction that does have results.',
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

    // The source resolved in one system while the same code string exists in
    // another — the hits below walk only the resolved one, so name the other on
    // every return path rather than letting a hierarchy read as the code's only one.
    const disclosure = result.alsoIn?.length ? { alsoInSystems: result.alsoIn } : {};

    // Disclose truncation + continuation for the paginated directions (even at zero
    // hits — a leaf's empty children page is still "complete"). The point directions
    // ignore the page and carry no continuation metadata.
    if (PAGINATED_DIRECTIONS.has(input.direction)) {
      ctx.enrich({ truncated: result.hasMore, shown: result.hits.length, cap: page.limit });
      if (result.hasMore) ctx.enrich({ nextCursor: encodeNextCursor(page) });
    }

    if (result.hits.length === 0) {
      // Resolved, but nothing on this page — a successful empty result with a
      // notice, consistent with search_codes / browse_hierarchy. Two distinct
      // causes reach here and the notice must not conflate them: a source with no
      // edge at all, or a cursor whose offset starts past the last page of a
      // source that does have edges. Only the service can tell them apart — an
      // offset alone cannot, since a childless code paged at any offset is still
      // childless — so `pastEnd` is read off the result, never re-derived here.
      const pastEnd = result.pastEnd === true;
      ctx.enrich.notice(
        pastEnd
          ? `"${input.from.trim()}" resolved in ${result.resolvedSystem}, but this page starts past the last ${input.direction} result. Re-call without a \`cursor\` to start from the first page.`
          : noEdgeNotice(input.from.trim(), input.direction, result.resolvedSystem),
      );
      ctx.log.info('Mapped code (no edge)', {
        from: input.from,
        direction: input.direction,
        resolvedSystem: result.resolvedSystem,
        pastEnd,
      });
      return {
        from: input.from.trim(),
        direction: input.direction,
        resolvedSystem: result.resolvedSystem,
        hits: [],
        ...disclosure,
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
        ...(h.conceptType ? { conceptType: h.conceptType } : {}),
      })),
      ...disclosure,
    };
  },

  format: (result) => {
    const lines = [
      `## ${result.direction}: ${result.from}`,
      result.resolvedSystem ? `**Resolved system:** ${result.resolvedSystem}` : '',
      // Text-only clients read this instead of structuredContent — without it the
      // walked hierarchy reads as the code's only one.
      result.alsoInSystems?.length
        ? `**Also in:** ${result.alsoInSystems.join(', ')} — the same code string is a different code with its own hierarchy there; re-call with that \`system\` to walk it.`
        : '',
      '',
    ].filter(Boolean);
    for (const h of result.hits) {
      // conceptType renders alongside the edge, not folded into the description —
      // a text-only client has no structuredContent to read it from, and without it
      // a combination product's `MIN` grouping hit is indistinguishable from the
      // ingredients it groups.
      lines.push(
        `- **${h.value}**${h.system ? ` (${h.system})` : ''} via ${h.source}${h.conceptType ? ` [${h.conceptType}]` : ''}${h.description ? `: ${h.description}` : ''}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
