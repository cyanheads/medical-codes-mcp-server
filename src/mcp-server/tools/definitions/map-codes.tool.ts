/**
 * @fileoverview medcode_map_codes — crosswalk a code or drug across systems and
 * within a hierarchy. Hierarchy directions (code → parents/children), the RxNorm
 * drug directions (drug name → RXCUI, NDC ↔ RXCUI, RXCUI → ingredients/brands),
 * and the RxClass class directions (RXCUI ↔ drug class) are all live against the
 * bundled corpus. The relational bridge between the bundled systems and a
 * composition point with the openfda server (NDC/labels).
 * @module mcp-server/tools/definitions/map-codes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import {
  type ClassNode,
  CodeIndexService,
  getCodeIndexService,
  heldElsewhere,
  type MapPage,
  noMatch,
  unmappedNdcMessage,
} from '@/services/code-index/code-index-service.js';
import { isBareInteger, ndcCandidates } from '@/services/code-index/detect.js';
import {
  CLASS_DIRECTIONS,
  type MapDirection,
  RXCLASS_CLASS_TYPES,
  type RxClassType,
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
  'rxcui_to_classes',
  'class_to_rxcuis',
] as const satisfies readonly MapDirection[];

/** The directions that walk a code's hierarchy — the only ones `system` steers. */
const HIERARCHY_DIRECTIONS: ReadonlySet<MapDirection> = new Set(['parents', 'children']);

/** The RxClass directions — the only ones `classType` narrows. */
const CLASS_DIRECTION_SET: ReadonlySet<MapDirection> = new Set(CLASS_DIRECTIONS);

/**
 * The directions whose result sets are unbounded in the corpus and therefore
 * paginate: hierarchy children, the drug-name substring crosswalk, a product's
 * package NDCs (one RXCUI can carry thousands), an RXCUI's classes (up to 178),
 * and a class's members (up to 3,181). They are the only ones that accept
 * `limit` / `cursor`; the point directions reject both.
 */
const PAGINATED_DIRECTIONS: ReadonlySet<MapDirection> = new Set([
  'children',
  'name_to_rxcui',
  'rxcui_to_ndc',
  ...CLASS_DIRECTIONS,
]);

type NarrowingField = 'system' | 'classType' | 'limit' | 'cursor';

/**
 * The input fields `direction` does not read, in declaration order. `system`
 * applies to the hierarchy directions; the drug and class directions all resolve
 * in RxNorm, so they accept `system: "RXNORM"` — the value medcode_get_code
 * echoes — and nothing else. `classType` applies to the class directions only.
 * `limit` and `cursor` apply to the paginated directions, and an empty `cursor`
 * counts as omitted.
 */
function inapplicableFields(input: {
  classType?: RxClassType | undefined;
  cursor?: string | undefined;
  direction: MapDirection;
  limit?: number | undefined;
  system?: SystemId | undefined;
}): NarrowingField[] {
  const fields: NarrowingField[] = [];
  if (input.system && !HIERARCHY_DIRECTIONS.has(input.direction) && input.system !== 'RXNORM') {
    fields.push('system');
  }
  if (input.classType && !CLASS_DIRECTION_SET.has(input.direction)) fields.push('classType');
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

/** Recovery for a `class_to_rxcuis` source that names no bundled class. */
const CLASS_ID_RECOVERY =
  'Pass a class ID as rxcui_to_classes returns it in `value` — e.g. N0000175565 (EPC "Biguanide"), SCHEDULE2, or VA class HS502 — and narrow by type with `classType`. ATC, SNOMED CT, and DailyMed classes are not bundled.';

/** Recovery for a class ID sent to `rxcui_to_classes`. */
const CLASS_ID_AS_RXCUI_RECOVERY =
  'List the class’s member drugs with direction class_to_rxcuis. rxcui_to_classes takes an RXCUI — find one by drug name with direction name_to_rxcui.';

/**
 * The `class_to_rxcuis` miss. A class ID is an RxClass identifier, not a code, so
 * no code-shape reading applies — a bare integer is no CPT code here (CVX class
 * IDs are bare integers). What it can be mistaken for is named instead: a code
 * system or a class type sent where the ID belongs, or an RXCUI sent in the
 * wrong direction.
 */
function classMiss(from: string, svc: CodeIndexService): { message: string; recovery: string } {
  const named = SYSTEM_TOKENS.get(normalizeSystemToken(from));
  if (named)
    return { message: `"${from}" is a code system, not a class ID.`, recovery: CLASS_ID_RECOVERY };
  const type = RXCLASS_CLASS_TYPES.find((t) => t === from.toUpperCase());
  if (type) {
    return {
      message: `"${from}" is a class type, not a class ID — pass it as \`classType\` alongside a class ID of that type.`,
      recovery: CLASS_ID_RECOVERY,
    };
  }
  if (svc.systemsHolding(from).includes('RXNORM')) {
    return {
      message: `"${from}" is an RxNorm concept (RXCUI), not a class ID.`,
      recovery: 'Map an RXCUI to its classes with direction rxcui_to_classes.',
    };
  }
  return { message: `No bundled RxClass class has the ID "${from}".`, recovery: CLASS_ID_RECOVERY };
}

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
 * The one input a drug direction reads `from` as, for the recovery that tells a
 * caller what goes there — never the inputs a sibling direction takes, which would
 * only miss again. An RXCUI names the two directions that produce one.
 */
function drugInput(direction: MapDirection): string {
  switch (direction) {
    case 'name_to_rxcui':
      return 'a drug name on name_to_rxcui (e.g. metformin)';
    case 'ndc_to_rxcui':
      return 'an NDC on ndc_to_rxcui, as printed on the package (e.g. 0002-3227-30)';
    default:
      return `an RXCUI on ${direction} (e.g. 6809) — find one from a drug name with direction name_to_rxcui, or from an NDC with ndc_to_rxcui`;
  }
}

/**
 * The miss for a source that resolved nowhere, worded for the most likely cause.
 * A `class_to_rxcuis` source is read as a class ID ({@link classMiss}); an
 * `rxcui_to_classes` source that is a class ID is named as one. Otherwise a code
 * system named in `from` (letters always) is one, and an `ndc_to_rxcui`
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
  if (direction === 'class_to_rxcuis') return classMiss(from, svc);
  const named = SYSTEM_TOKENS.get(normalizeSystemToken(from));
  if (named) {
    return {
      message: `"${from}" is a code system, not a code.`,
      recovery: HIERARCHY_DIRECTIONS.has(direction)
        ? `Put the code itself in \`from\` (e.g. ${EXAMPLE_CODE[named]}) and the system in \`system\` ("${named}"). To list a system's top-level codes, call medcode_browse_hierarchy with \`system\` and no \`node\`.`
        : `\`from\` takes ${drugInput(direction)}; the drug directions resolve in RxNorm without a \`system\`.`,
    };
  }
  if (direction === 'ndc_to_rxcui') return ndcMiss(from);
  // name_to_rxcui reads the value as a drug name, not a code.
  if (direction === 'name_to_rxcui') {
    return { message: `No bundled code matches "${from}".`, recovery: null };
  }
  // A class ID sent the wrong way — ahead of the bare-integer test, since a CVX
  // class ID is a bare integer that is no CPT code.
  if (direction === 'rxcui_to_classes' && svc.classNodes(from).length > 0) {
    return {
      message: `"${from}" is an RxClass class ID, not an RXCUI.`,
      recovery: CLASS_ID_AS_RXCUI_RECOVERY,
    };
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

/** `the EPC class "Biguanide"`, joined for an ID two class types share. */
function nameClasses(nodes: ClassNode[]): string {
  return nodes.map((n) => `the ${n.classType} class "${n.className}"`).join(' and ');
}

/** The ingredient term types, named as an empty `rxcui_to_classes` notice names its source. */
const INGREDIENT_CONCEPTS: Record<string, string> = {
  IN: 'an ingredient (IN)',
  PIN: 'a precise ingredient (PIN)',
  MIN: 'a multiple-ingredient concept (MIN)',
};

/**
 * The class types RxClass records on drug products rather than on ingredients:
 * where it records them, and what their absence on an ingredient does not mean.
 */
const PRODUCT_CLASS_TYPES: Partial<Record<RxClassType, { recorded: string; absence: string }>> = {
  SCHEDULE: {
    recorded:
      'DEA schedules on drug products (clinical and branded drugs and packs), never on ingredients',
    absence: 'having no SCHEDULE class here does not mean it is unscheduled',
  },
  VA: {
    recorded:
      'VA classes on drug products (clinical and branded drugs and packs), rarely on ingredients',
    absence: "having no VA class here says nothing about its products' VA classes",
  },
};

/**
 * The notice for a class-direction source that resolved with no hits on a page
 * that starts at its first result. Each cause says what is true of the input: a
 * brand name (RxClass classifies none), an ingredient asked for a class type
 * RxClass records on products alone — whose absence must never read as the drug
 * lacking it — an RXCUI no bundled source classifies, a `classType` that filtered
 * every class out, or a class whose members attach only to its subclasses — this
 * index lists direct members and does not walk the hierarchy.
 */
function classNotice(
  from: string,
  direction: MapDirection,
  classType: RxClassType | undefined,
  page: MapPage,
): string {
  if (direction === 'rxcui_to_classes') {
    if (page.sourceConceptType === 'BN') {
      return `"${from}" resolved in RXNORM but has no rxcui_to_classes — no bundled RxClass source classifies it or its ingredients. Brand-name concepts carry no classes: find the brand's products with direction name_to_rxcui and map one of those, or map an ingredient's RXCUI.`;
    }
    const ingredient = INGREDIENT_CONCEPTS[page.sourceConceptType ?? ''];
    const productLevel = classType ? PRODUCT_CLASS_TYPES[classType] : undefined;
    if (ingredient && productLevel) {
      return `"${from}" resolved in RXNORM as ${ingredient}, and RxClass records ${productLevel.recorded} — its ${productLevel.absence}. Find its products with direction name_to_rxcui and map one of those with \`classType\` "${classType}".`;
    }
    return classType
      ? `"${from}" resolved in RXNORM but has no ${classType} class in the bundled RxClass sources, on itself or its ingredients. Omit \`classType\` to list its classes of every type.`
      : `"${from}" resolved in RXNORM but has no rxcui_to_classes — no bundled RxClass source classifies it or its ingredients.`;
  }
  const nodes = page.sourceClasses ?? [];
  if (classType && !nodes.some((n) => n.classType === classType)) {
    return `"${from}" is ${nameClasses(nodes)}, not a class of type ${classType}. Re-call with \`classType\` "${nodes[0]?.classType}", or omit \`classType\`.`;
  }
  const named = classType ? nodes.filter((n) => n.classType === classType) : nodes;
  // Only MeSH IDs are shared, by the CHEM and DISEASE types — two classes at most.
  const which = named.length > 1 ? 'neither of which has a' : 'which has no';
  return `"${from}" resolved to ${nameClasses(named)}, ${which} direct member — its drugs attach to its subclasses, and this index lists direct members only, without walking the class hierarchy. Map a drug to its more specific classes with direction rxcui_to_classes.`;
}

export const mapCodesTool = tool('medcode_map_codes', {
  title: 'Map Medical Codes',
  description:
    "Crosswalk a US medical code or drug across systems and within a hierarchy. Hierarchy directions: `parents` and `children` walk a code's prefix hierarchy one level per call — immediate parent/children only (depth-1); call iteratively for the full ancestor or descendant path (ICD-10-CM/HCPCS; ICD-10-PCS codes have no prefix parent, and RxNorm concepts no code hierarchy). A resolvable source with no edge in the requested direction is a successful empty result with a notice, not an error. A source code string that also exists in another bundled system carries `alsoInSystems` naming it, since only the resolved system's hierarchy was walked. Drug directions (RxNorm): `name_to_rxcui` (drug name → RXCUI), `ndc_to_rxcui` and `rxcui_to_ndc` (NDC ↔ RXCUI; NDCs accepted hyphenated in an FDA segment configuration — 4-4-2, 5-3-2, 5-4-1, or the 11-digit 5-4-2 — or as bare 10/11 digits; `ndc_to_rxcui` names the product it decoded to), `rxcui_to_ingredients` and `rxcui_to_brands` (RXCUI → ingredient/brand RXCUIs, each with the target's RxNorm name and its `conceptType` — read that before counting a combination product's ingredients). Drug-class directions (RxClass): `rxcui_to_classes` (RXCUI → its classes: pharmacologic class, mechanism of action, physiologic effect, pharmacokinetics, therapeutic category, chemical structure, the diseases it may treat, prevent, diagnose, or induce or is contraindicated with, VA class, DEA controlled-substance schedule, CDC vaccine code; a drug product also carries its ingredients' classes, naming the ingredient in `via`, while DEA schedules and VA classes are recorded on drug products rather than ingredients, so map a product for those) and `class_to_rxcuis` (class ID → its direct member RXCUIs, each with its RxNorm name and `conceptType`). Each class hit carries `classType`, `source` (the RxClass source asserting it), and `relation` — a `ci_` relation is a contraindication, not an indication; narrow either direction with `classType`. Every result carries `source` provenance (which system or edge answered) so a chained call (e.g. into openfda with a resolved NDC) uses the right identifier. The `children`, `name_to_rxcui`, `rxcui_to_ndc`, `rxcui_to_classes`, and `class_to_rxcuis` directions can return large sets and paginate: a `nextCursor` in the response is passed back as `cursor` (with an optional `limit` page size) to walk the full set. A field the direction does not use is rejected with `field_not_applicable`: `limit` and `cursor` on the point directions, `classType` outside the class directions, and a `system` other than RXNORM on the drug and class directions.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sourceUrl: SOURCE_URL,

  input: z.object({
    from: nonBlankString('from').describe(
      'The source value: a code (for parents/children), a drug name, an NDC, an RXCUI, or an RxClass class ID (for class_to_rxcuis). Must not be blank or whitespace-only.',
    ),
    direction: z
      .enum(DIRECTIONS)
      .describe(
        'What to map to. parents/children return the immediate parent or children only (depth-1) — call iteratively to walk a full path; the rxcui/ndc/name directions are RxNorm drug crosswalks; rxcui_to_classes and class_to_rxcuis are RxClass drug-class crosswalks.',
      ),
    system: z
      .enum(SYSTEM_IDS)
      .optional()
      .describe(
        'For parents/children, force the source code into this system. Omit to auto-detect. The drug and class directions resolve in RxNorm and accept only "RXNORM" (no effect); any other value there is rejected.',
      ),
    classType: z
      .enum(RXCLASS_CLASS_TYPES)
      .optional()
      .describe(
        'For rxcui_to_classes and class_to_rxcuis only: keep only classes of this RxClass type — EPC (FDA established pharmacologic class), MOA (mechanism of action), PE (physiologic effect), PK (pharmacokinetics), TC (therapeutic category), CHEM (chemical structure), DISEASE (diseases the drug may treat, prevent, diagnose, or induce, or is contraindicated with), VA (VA drug class, recorded on drug products), SCHEDULE (DEA controlled-substance schedule, recorded on drug products only), CVX (CDC vaccine code). Omit for every type. Rejected on every other direction.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Max results per page, for the paginated directions only (children, name_to_rxcui, rxcui_to_ndc, rxcui_to_classes, class_to_rxcuis). Defaults to MEDCODE_MAX_RESULTS (50), ceiling 200. Rejected on every other direction.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque continuation token from a previous response's `nextCursor`, for the paginated directions only (children, name_to_rxcui, rxcui_to_ndc, rxcui_to_classes, class_to_rxcuis). Omit for the first page; an empty string counts as omitted. A non-empty cursor on any other direction is rejected.",
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
                'Which system or relationship edge produced this hit (e.g. "ICD10CM", "has_ingredient", "NDC"). On the class directions, the RxClass source asserting the drug–class edge: "MEDRT" (VA MED-RT), "FDASPL" (FDA structured product labels), "FMTSME" (Federal Medication Terminologies), "VA" (VA National Formulary classes), "RXNORM" (DEA schedules as RxNorm records them), or "CDC" (CVX vaccine codes).',
              ),
            system: z
              .string()
              .nullable()
              .describe(
                'The code system of the target value, or null when the target is not a system code (an NDC, or an RxClass class ID).',
              ),
            value: z
              .string()
              .describe('The mapped target value (a code, RXCUI, NDC, or RxClass class ID).'),
            description: z
              .string()
              .optional()
              .describe(
                'Description of the target when available: the code description for hierarchy hits, the official RxNorm name for the `name_to_rxcui`, `ndc_to_rxcui`, `rxcui_to_ingredients`, `rxcui_to_brands`, and `class_to_rxcuis` drug concepts, and the class name for `rxcui_to_classes`. Absent for `rxcui_to_ndc`, whose targets are package identifiers with no description of their own.',
              ),
            conceptType: z
              .string()
              .optional()
              .describe(
                'The target concept\'s RxNorm type, present on `rxcui_to_ingredients`, `rxcui_to_brands`, and `class_to_rxcuis` hits only. A class member may be any drug concept: an ingredient type below, or a drug product — "SCD"/"SBD" (clinical/branded drug) or "GPCK"/"BPCK" (generic/branded pack). Otherwise "IN" (ingredient), "PIN" (precise ingredient — a specific salt, ester, or isomer of an ingredient), "MIN" (multiple ingredients — a concept naming a combination, never a substance within it), or "BN" (brand name). Ingredient hits mix the first three, so the hit count is not the substance count: a "MIN" hit is the grouping concept and never counts, and a "PIN" names a form of a substance rather than an extra one — usually alongside the "IN" it refines, though two "PIN" esters can share a single "IN". Counting the "IN" hits is the closest reading, and under-counts those shared cases.',
              ),
            classType: z
              .enum(RXCLASS_CLASS_TYPES)
              .optional()
              .describe(
                'The RxClass class type, on `rxcui_to_classes` and `class_to_rxcuis` hits only — the values the `classType` input takes.',
              ),
            relation: z
              .string()
              .optional()
              .describe(
                'The RxClass relationship between the drug and the class, on `rxcui_to_classes` and `class_to_rxcuis` hits only: has_epc, has_moa, has_pe, has_pk, site_of_metabolism, has_tc, has_ingredient / has_chemical_structure / has_active_metabolites (CHEM), may_treat / may_prevent / may_diagnose / induces (DISEASE), has_vaclass / has_vaclass_extended, has_schedule, isa_cvx. A `ci_` relation (ci_with, ci_moa, ci_pe, ci_chemclass) is a contraindication: the drug is contraindicated with that disease or class — never an indication, and never class membership.',
              ),
            via: z
              .string()
              .optional()
              .describe(
                'On `rxcui_to_classes` hits only: the ingredient RXCUI a drug product inherits this class through — RxClass attaches most classes to ingredients. Absent when the class attaches to the source RXCUI itself. When several ingredients carry the same class, names an ingredient ("IN") over its precise ingredient ("PIN"), then the lowest RXCUI.',
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
        'Paginated directions (children, name_to_rxcui, rxcui_to_ndc, rxcui_to_classes, class_to_rxcuis) only: true when more results exist beyond this page.',
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
        'Guidance whenever a resolvable source returns no hits, naming which of the two causes applies: it has no edge in the requested direction (a top-level code has no parent; a leaf has no children; ICD-10-PCS codes have no prefix parent; RxNorm concepts have no code hierarchy; no bundled class, or none of the requested `classType`, covers the RXCUI; a class has no direct member), or the `cursor` starts past the last page of a direction that does have results.',
      ),
  },

  errors: [
    {
      reason: 'field_not_applicable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A `system`, `classType`, `limit`, or `cursor` was sent on a direction that does not use it.',
      recovery:
        'Drop the named fields and re-call. `system` steers only parents and children (the drug and class directions accept only "RXNORM", which changes nothing); `classType` applies only to rxcui_to_classes and class_to_rxcuis; `limit` and `cursor` apply only to children, name_to_rxcui, rxcui_to_ndc, rxcui_to_classes, and class_to_rxcuis.',
    },
    {
      reason: 'no_mapping',
      code: JsonRpcErrorCode.NotFound,
      when: 'The source value did not resolve to any bundled code, drug, or class.',
      recovery:
        'Check the code, or decode it with medcode_get_code first. A resolvable code with no edge in the requested direction returns an empty result with a notice, not this error.',
    },
    {
      reason: 'direction_unavailable',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A drug-crosswalk direction was requested but this build carries no RxNorm tables, or a class direction was requested but it carries no RxClass class layer.',
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
    if (CLASS_DIRECTION_SET.has(input.direction) && !svc.hasClassLayer()) {
      throw ctx.fail(
        'direction_unavailable',
        `The "${input.direction}" crosswalk needs the RxClass drug-class layer, which this build of the index does not carry.`,
        {
          recovery: {
            hint: 'Use another direction — the RxNorm drug directions and parents/children still run on this build — or unset MEDCODE_DB_PATH to use the shipped index, which carries the RxClass layer.',
          },
        },
      );
    }

    // Ahead of the cursor decode and every lookup: a field this direction would
    // silently drop is a caller mistake, not a query to answer.
    const rejected = inapplicableFields(input);
    if (rejected.length > 0) {
      const named = rejected.map((field) =>
        field === 'system' || field === 'classType'
          ? `\`${field}\` ("${input[field]}")`
          : `\`${field}\``,
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
    const result = svc.mapCode(input.from, input.direction, input.system, page, input.classType);

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
      const from = input.from.trim();
      // A class ID resolves to a class, not into a system, so its lead names the class.
      const resolved = result.sourceClasses
        ? `resolved to ${nameClasses(result.sourceClasses)}`
        : `resolved in ${result.resolvedSystem}`;
      ctx.enrich.notice(
        pastEnd
          ? `"${from}" ${resolved}, but this page starts past the last ${input.direction} result. Re-call without a \`cursor\` to start from the first page.`
          : CLASS_DIRECTION_SET.has(input.direction)
            ? classNotice(from, input.direction, input.classType, result)
            : noEdgeNotice(from, input.direction, result.resolvedSystem),
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
        ...(h.classType ? { classType: h.classType } : {}),
        ...(h.relation ? { relation: h.relation } : {}),
        ...(h.via ? { via: h.via } : {}),
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
      // ingredients it groups. The class fields follow for the same reason, with a
      // contraindication spelled out so a `ci_` edge never reads as an indication.
      const classFields = [
        h.classType,
        h.relation &&
          (h.relation.startsWith('ci_') ? `${h.relation} (contraindication)` : h.relation),
        h.via && `inherited via ingredient ${h.via}`,
      ].filter(Boolean);
      lines.push(
        `- **${h.value}**${h.system ? ` (${h.system})` : ''} via ${h.source}${h.conceptType ? ` [${h.conceptType}]` : ''}${classFields.length > 0 ? ` · ${classFields.join(' · ')}` : ''}${h.description ? `: ${h.description}` : ''}`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
