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

import {
  CodeIndexService,
  getCodeIndexService,
  heldElsewhere,
  noMatch,
  unmappedNdcMessage,
} from '@/services/code-index/code-index-service.js';
import { isBareInteger, ndcCandidates } from '@/services/code-index/detect.js';
import {
  type MapDirection,
  SYSTEM_IDS,
  SYSTEM_LABELS,
  type SystemId,
} from '@/services/code-index/types.js';
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

/** The directions that walk a code's hierarchy — the only ones `system` steers. */
const HIERARCHY_DIRECTIONS: ReadonlySet<MapDirection> = new Set(['parents', 'children']);

/**
 * The directions whose result sets are unbounded in the corpus and therefore
 * paginate: hierarchy children, the drug-name substring crosswalk, and a
 * product's package NDCs (one RXCUI can carry thousands). They are the only ones
 * that accept `limit` / `cursor`; the point directions reject both.
 */
const PAGINATED_DIRECTIONS: ReadonlySet<MapDirection> = new Set([
  'children',
  'name_to_rxcui',
  'rxcui_to_ndc',
]);

/**
 * The input fields `direction` does not read, in declaration order. `system`
 * applies to the hierarchy directions; the drug directions all resolve in
 * RxNorm, so they accept `system: "RXNORM"` — the value medcode_get_code echoes —
 * and nothing else. `limit` and `cursor` apply to the paginated directions, and
 * an empty `cursor` counts as omitted.
 */
function inapplicableFields(input: {
  cursor?: string | undefined;
  direction: MapDirection;
  limit?: number | undefined;
  system?: SystemId | undefined;
}): ('system' | 'limit' | 'cursor')[] {
  const fields: ('system' | 'limit' | 'cursor')[] = [];
  if (input.system && !HIERARCHY_DIRECTIONS.has(input.direction) && input.system !== 'RXNORM') {
    fields.push('system');
  }
  if (!PAGINATED_DIRECTIONS.has(input.direction)) {
    if (input.limit !== undefined) fields.push('limit');
    if (input.cursor) fields.push('cursor');
  }
  return fields;
}

/** A system token compared the way callers vary it: case-insensitive, `-` `.` and whitespace dropped. */
function normalizeSystemToken(value: string): string {
  return value.toLowerCase().replace(/[-.\s]/g, '');
}

/**
 * Every bundled system's id and display label, normalized, mapped to the id —
 * so `ICD10CM`, `ICD-10-CM`, and `icd 10 cm` all name ICD10CM. Built from the
 * system enum and labels so a newly bundled system joins it.
 */
const SYSTEM_TOKENS: ReadonlyMap<string, SystemId> = new Map(
  SYSTEM_IDS.flatMap((id) => [
    [normalizeSystemToken(id), id],
    [normalizeSystemToken(SYSTEM_LABELS[id]), id],
  ]),
);

/** A code from each system, for the recovery that shows where a code goes. */
const EXAMPLE_CODE: Record<SystemId, string> = {
  ICD10CM: 'E11.9',
  ICD10PCS: '0DTJ4ZZ',
  HCPCS: 'J0120',
  RXNORM: '161',
};

/** Recovery for a bare integer no bundled system holds — likely a CPT / HCPCS Level I code. */
const OUT_OF_SCOPE_RECOVERY =
  'CPT and HCPCS Level I codes are not bundled. Find the procedure by description with medcode_search_codes instead — ICD-10-PCS covers inpatient procedures and HCPCS Level II covers supplies and services.';

/** Recovery for a hierarchy source an explicit `system` missed while another bundled system holds it. */
const HELD_ELSEWHERE_RECOVERY =
  'Re-call with `system` set to the system named above to walk the code there, or omit `system` to auto-detect it.';

/** Recovery for an NDC sent to a direction that reads `from` as a code or an RXCUI. */
const NDC_RECOVERY =
  "Map an NDC with direction ndc_to_rxcui, or decode it with medcode_get_code, to reach its RxNorm product; pass that product's RXCUI to the rxcui_to_* directions.";

/** Recovery for an `ndc_to_rxcui` source in no FDA segment configuration. */
const NDC_MALFORMED_RECOVERY =
  'Re-send the NDC as printed on the package, hyphenated in one of those FDA segment configurations or as bare 10/11 digits, with no other separator or prefix. To find a drug by name instead, use direction name_to_rxcui.';

/** Recovery for a well-formed NDC the bundled NDC map does not hold, on any direction. */
const NDC_UNMAPPED_RECOVERY =
  'The bundled RxNorm set lists no product for this package. Check the NDC against the package label, or find the drug by name with direction name_to_rxcui.';

/**
 * The `ndc_to_rxcui` miss, split by the same test the lookup ran: a spelling
 * ndcCandidates() refuses is named as malformed; a well-formed one (hyphenated,
 * or bare 10/11 digits) is named as unmapped, in medcode_get_code's words — with
 * the normalized key when the spelling fixes one. Neither recovers to
 * medcode_get_code, which refuses and misses on the same values.
 */
function ndcMiss(from: string): { message: string; recovery: string } {
  const { candidates } = ndcCandidates(from);
  if (candidates.length === 0) {
    return {
      message: `"${from}" is not an NDC spelling this server reads: an NDC is hyphenated in an FDA segment configuration (4-4-2, 5-3-2, 5-4-1, or 5-4-2) or written as bare 10 or 11 digits.`,
      recovery: NDC_MALFORMED_RECOVERY,
    };
  }
  return {
    message: unmappedNdcMessage(from, candidates.length === 1 ? (candidates[0] ?? null) : null),
    recovery: NDC_UNMAPPED_RECOVERY,
  };
}

/**
 * The miss for a source that resolved nowhere, worded for the most likely cause.
 * A code system named in `from` (letters always) is one, and an `ndc_to_rxcui`
 * source is always read as an NDC. A hierarchy source an explicit `system` missed
 * is named as the code of the bundled system that holds it, as medcode_check_code
 * and medcode_get_code name it. On a direction that reads `from` as a code or an
 * RXCUI, so are an NDC — one medcode_get_code decodes, or a well-formed one no
 * bundled drug maps to — and, failing that, a bare integer no bundled system
 * holds. Everything else keeps the generic message and the declared recovery
 * (`null` here).
 */
function sourceMiss(
  from: string,
  direction: MapDirection,
  system: SystemId | undefined,
  svc: CodeIndexService,
): { message: string; recovery: string | null } {
  const named = SYSTEM_TOKENS.get(normalizeSystemToken(from));
  if (named) {
    return {
      message: `"${from}" is a code system, not a code.`,
      recovery: HIERARCHY_DIRECTIONS.has(direction)
        ? `Put the code itself in \`from\` (e.g. ${EXAMPLE_CODE[named]}) and the system in \`system\` ("${named}"). To list a system's top-level codes, call medcode_browse_hierarchy with \`system\` and no \`node\`.`
        : '`from` takes a drug name, an NDC, or an RXCUI; the drug directions resolve in RxNorm without a `system`.',
    };
  }
  if (direction === 'ndc_to_rxcui') return ndcMiss(from);
  // name_to_rxcui reads the value as a drug name, not a code.
  if (direction === 'name_to_rxcui') {
    return { message: `No bundled code matches "${from}".`, recovery: null };
  }
  // Without a `system` the hierarchy lookup already searched every bundled system,
  // so only a named one can miss a code another system holds.
  const holders = system && HIERARCHY_DIRECTIONS.has(direction) ? svc.systemsHolding(from) : [];
  if (system && holders.length > 0) {
    return {
      message: `${noMatch(system, from)} — ${heldElsewhere(holders)} to walk it there.`,
      recovery: HELD_ELSEWHERE_RECOVERY,
    };
  }
  // A bare 10/11-digit NDC is also a bare integer, so it is named before the CPT
  // test — as the NDC it decodes as, or, when no bundled drug maps to it, in the
  // words ndc_to_rxcui gives the same value.
  const ndc = svc.ndcReading(from);
  if (ndc?.kind === 'mapped') {
    return {
      message: `"${from}" is a National Drug Code (NDC), not ${HIERARCHY_DIRECTIONS.has(direction) ? 'a code' : 'an RXCUI'}.`,
      recovery: NDC_RECOVERY,
    };
  }
  if (ndc?.kind === 'unmapped') {
    return {
      message: unmappedNdcMessage(from, ndc.normalized),
      recovery: NDC_UNMAPPED_RECOVERY,
    };
  }
  // The membership check keeps a bundled code of another system — a digits-only
  // ICD-10-PCS code on an rxcui_to_* direction — from being called an unbundled one.
  if (isBareInteger(from) && svc.systemsHolding(from).length === 0) {
    return {
      message: `No bundled code matches "${from}". ${svc.outOfScopeNote()}`,
      recovery: OUT_OF_SCOPE_RECOVERY,
    };
  }
  return { message: `No bundled code matches "${from}".`, recovery: null };
}

/**
 * The notice for a resolvable source that has no edges in `direction`. Every
 * direction states its own cause and next move, because the causes are not
 * interchangeable facts: an ingredient concept has no ingredients of its own, an
 * ICD-10-PCS code has no prefix parent, an RxNorm concept has no code hierarchy
 * at all, and wording any of them as "a leaf code with no children" would tell
 * the caller something untrue about its input.
 */
function noEdgeNotice(from: string, direction: MapDirection, system: string | null): string {
  const head = `"${from}" resolved in ${system} but has no ${direction}`;
  if (system === 'RXNORM' && HIERARCHY_DIRECTIONS.has(direction)) {
    return `${head} — RxNorm concepts have no code hierarchy in this index. Map its drug relationships with the rxcui_to_ingredients, rxcui_to_brands, or rxcui_to_ndc direction instead.`;
  }
  switch (direction) {
    case 'children':
      return `${head} — it is a leaf code with no children. Decode it with medcode_get_code, or map the opposite direction.`;
    case 'rxcui_to_ndc':
      return `${head} — no package in the bundled RxNorm set lists it. Ingredient and brand-name concepts carry no packages; map a drug product's RXCUI instead.`;
    case 'rxcui_to_ingredients':
      return `${head} — ingredient, precise-ingredient, multiple-ingredient, and brand-name concepts carry no ingredient edges. Map a drug product's RXCUI instead, or decode this one with medcode_get_code.`;
    case 'rxcui_to_brands':
      return `${head} — no branded form of it is in the bundled RxNorm set. Decode it with medcode_get_code.`;
    default:
      return system === 'ICD10PCS'
        ? `${head} — ICD-10-PCS codes are axis-based and have no prefix parent. Decode it with medcode_get_code.`
        : `${head} — it is a top-level code with no parent. Decode it with medcode_get_code, or map the opposite direction.`;
  }
}

export const mapCodesTool = tool('medcode_map_codes', {
  title: 'Map Medical Codes',
  description:
    "Crosswalk a US medical code or drug across systems and within a hierarchy. Hierarchy directions: `parents` and `children` walk a code's prefix hierarchy one level per call — immediate parent/children only (depth-1); call iteratively for the full ancestor or descendant path (ICD-10-CM/HCPCS; ICD-10-PCS codes have no prefix parent, and RxNorm concepts no code hierarchy). A resolvable source with no edge in the requested direction is a successful empty result with a notice, not an error. A source code string that also exists in another bundled system carries `alsoInSystems` naming it, since only the resolved system's hierarchy was walked. Drug directions (RxNorm): `name_to_rxcui` (drug name → RXCUI), `ndc_to_rxcui` and `rxcui_to_ndc` (NDC ↔ RXCUI; NDCs accepted hyphenated in an FDA segment configuration — 4-4-2, 5-3-2, 5-4-1, or the 11-digit 5-4-2 — or as bare 10/11 digits; `ndc_to_rxcui` names the product it decoded to), `rxcui_to_ingredients` and `rxcui_to_brands` (RXCUI → ingredient/brand RXCUIs, each with the target's RxNorm name and its `conceptType` — read that before counting a combination product's ingredients). Every result carries `source` provenance (which system or edge answered) so a chained call (e.g. into openfda with a resolved NDC) uses the right identifier. The `children`, `name_to_rxcui`, and `rxcui_to_ndc` directions can return large sets and paginate: a `nextCursor` in the response is passed back as `cursor` (with an optional `limit` page size) to walk the full set. A field the direction does not use is rejected with `field_not_applicable`: `limit` and `cursor` on the point directions, and a `system` other than RXNORM on the drug directions.",
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
        'For parents/children, force the source code into this system. Omit to auto-detect. The drug directions resolve in RxNorm and accept only "RXNORM" (no effect); any other value there is rejected.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Max results per page, for the paginated directions only (children, name_to_rxcui, rxcui_to_ndc). Defaults to MEDCODE_MAX_RESULTS (50), ceiling 200. Rejected on every other direction.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque continuation token from a previous response's `nextCursor`, for the paginated directions only (children, name_to_rxcui, rxcui_to_ndc). Omit for the first page; an empty string counts as omitted. A non-empty cursor on any other direction is rejected.",
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
        'Guidance whenever a resolvable source returns no hits, naming which of the two causes applies: it has no edge in the requested direction (a top-level code has no parent; a leaf has no children; ICD-10-PCS codes have no prefix parent; RxNorm concepts have no code hierarchy), or the `cursor` starts past the last page of a direction that does have results.',
      ),
  },

  errors: [
    {
      reason: 'field_not_applicable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A `system`, `limit`, or `cursor` was sent on a direction that does not use it.',
      recovery:
        'Drop the named fields and re-call. `system` steers only parents and children (the drug directions accept only "RXNORM", which changes nothing); `limit` and `cursor` apply only to children, name_to_rxcui, and rxcui_to_ndc.',
    },
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

    // First: a direction this build cannot run fails whatever fields it carries, so
    // a field rejection here would only send the caller to re-call into this error.
    if (CodeIndexService.isDrugDirection(input.direction) && !svc.hasRxNorm()) {
      throw ctx.fail(
        'direction_unavailable',
        `The "${input.direction}" crosswalk needs RxNorm, which is not present in this build of the index.`,
        { ...ctx.recoveryFor('direction_unavailable') },
      );
    }

    // Ahead of the cursor decode and every lookup: a field this direction would
    // silently drop is a caller mistake, not a query to answer.
    const rejected = inapplicableFields(input);
    if (rejected.length > 0) {
      const named = rejected.map((field) =>
        field === 'system' ? `\`system\` ("${input.system}")` : `\`${field}\``,
      );
      throw ctx.fail(
        'field_not_applicable',
        `Not used by direction "${input.direction}": ${named.join(', ')}.`,
        {
          direction: input.direction,
          fields: rejected,
          ...ctx.recoveryFor('field_not_applicable'),
        },
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
      const miss = sourceMiss(input.from.trim(), input.direction, input.system, svc);
      throw ctx.fail(
        'no_mapping',
        miss.message,
        miss.recovery ? { recovery: { hint: miss.recovery } } : ctx.recoveryFor('no_mapping'),
      );
    }

    // The source resolved in one system while the same code string exists in
    // another — the hits below walk only the resolved one, so name the other on
    // every return path rather than letting a hierarchy read as the code's only one.
    const disclosure = result.alsoIn?.length ? { alsoInSystems: result.alsoIn } : {};

    // Disclose truncation + continuation for the paginated directions (even at zero
    // hits — a leaf's empty children page is still "complete"). The point directions
    // take no page and carry no continuation metadata.
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
