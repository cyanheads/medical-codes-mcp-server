/**
 * @fileoverview Domain types for the code-index service — the bundled medical
 * code systems, the row shapes the SQLite tables hold, and the query results
 * the tools consume.
 * @module services/code-index/types
 */

/** The four bundled US healthcare code systems. */
export type SystemId = 'ICD10CM' | 'ICD10PCS' | 'HCPCS' | 'RXNORM';

/** All system ids, in canonical display order. */
export const SYSTEM_IDS: readonly SystemId[] = ['ICD10CM', 'ICD10PCS', 'HCPCS', 'RXNORM'] as const;

/** Human-facing label for each system, surfaced in tool output and notices. */
export const SYSTEM_LABELS: Record<SystemId, string> = {
  ICD10CM: 'ICD-10-CM',
  ICD10PCS: 'ICD-10-PCS',
  HCPCS: 'HCPCS Level II',
  RXNORM: 'RxNorm',
};

/**
 * What each system's source release actually carries, for the decoded fields a
 * system can lack entirely. The `codes` table stores one column set for every
 * system, so a system without the concept still holds a value there — RxNorm rows
 * store `billable = 0` and repeat the term type (`SBD`, `IN`, …) in `short_desc`.
 * The service reads this record to publish `null` for those fields instead of
 * passing the stored placeholder off as a fact.
 *
 *  - `billing` — the release flags codes billable or not. RxNorm identifies drugs
 *    and has no billing concept, so its `billable` decodes to `null` and
 *    `medcode_check_code` answers it `valid` with no billing verdict.
 *  - `shortDescription` — the release publishes an abbreviated description. RxNorm
 *    publishes a single name; its term type is carried in `chapter`.
 */
export const SYSTEM_TRAITS: Record<SystemId, { billing: boolean; shortDescription: boolean }> = {
  ICD10CM: { billing: true, shortDescription: true },
  ICD10PCS: { billing: true, shortDescription: true },
  HCPCS: { billing: true, shortDescription: true },
  RXNORM: { billing: false, shortDescription: false },
};

/**
 * A single code row from the `codes` table. The spine of the index — one row
 * per code across all systems. `billable`/`header` are 0/1 integers in SQLite;
 * the service maps them to booleans at the boundary. `billable` and `shortDesc`
 * hold a placeholder for a system {@link SYSTEM_TRAITS} marks as lacking them.
 */
export interface CodeRow {
  /** 1 = billable leaf code. 0 = not billable (header/category or completeness-only). */
  billable: number;
  /** Chapter label (ICD-10-CM/PCS) or range bucket (HCPCS). NULL when not applicable. */
  chapter: string | null;
  /** Storage form of the code — no dots, as it appears in the source order file. */
  code: string;
  /** Effective date (YYYYMMDD) when known. NULL otherwise. */
  effective: string | null;
  /** 1 = non-billable header/category row (ICD-10-CM). 0 otherwise. */
  header: number;
  longDesc: string | null;
  /** Parent code (CM/HCPCS). NULL for ICD-10-PCS (axis-based, not prefix-based). */
  parent: string | null;
  shortDesc: string | null;
  system: SystemId;
  /** Termination date (YYYYMMDD) when the code is retired. NULL = active. */
  terminated: string | null;
}

/** A provenance row from `build_meta` — one per bundled system. */
export interface BuildMetaRow {
  builtAt: string;
  codeCount: number;
  effectiveEnd: string | null;
  effectiveStart: string | null;
  releaseId: string;
  sourceUrl: string | null;
  system: SystemId;
}

/**
 * A pagination window over a query result: the zero-based offset of the first
 * row and the page size. Shared by every paginated query path (search, browse,
 * children, drug-name crosswalk) so they route through one offset/limit contract.
 */
export interface Page {
  limit: number;
  offset: number;
}

/** An ICD-10-PCS axis-value row from `pcs_axes`. */
export interface PcsAxisRow {
  /** What that value means at that position. */
  meaning: string;
  /** Character position 1-7 in the PCS code. */
  position: number;
  /** The single-character axis value. */
  value: string;
}

/**
 * Discriminated validity status for `medcode_check_code`. `valid` is the verdict
 * for a current code in a system with no billing concept (RxNorm): it exists and
 * is current, and there is no billable/not-billable answer to give.
 */
export type CheckStatus =
  | 'valid_billable'
  | 'valid_not_billable'
  | 'valid_header'
  | 'valid'
  | 'terminated'
  | 'unknown';

/**
 * The RxClass relationship sources bundled in the class layer — all US government
 * works. ATC and ATCPROD (WHO terms bar commercial redistribution), SNOMEDCT
 * (SNOMED CT Affiliate license), and DAILYMED (a near-duplicate of FDASPL with no
 * published version) are excluded at build time.
 */
export const RXCLASS_SOURCES = ['MEDRT', 'FDASPL', 'FMTSME', 'VA', 'RXNORM', 'CDC'] as const;

/** A bundled RxClass relationship source. */
export type RxClassSource = (typeof RXCLASS_SOURCES)[number];

/**
 * The RxClass class types the bundled sources assert. `SCHEDULE` is the DEA CSA
 * schedule (source `RXNORM`); `CVX` the CDC vaccine code (source `CDC`).
 */
export const RXCLASS_CLASS_TYPES = [
  'EPC',
  'MOA',
  'PE',
  'PK',
  'TC',
  'CHEM',
  'DISEASE',
  'VA',
  'SCHEDULE',
  'CVX',
] as const;

/** A bundled RxClass class type. */
export type RxClassType = (typeof RXCLASS_CLASS_TYPES)[number];

/** One bundled RxClass source's provenance row from `rxclass_source`. */
export interface RxClassSourceRow {
  /** Distinct classes this source asserts at least one bundled edge to. */
  classCount: number;
  edgeCount: number;
  /** When the RxClass snapshot was fetched (ISO 8601), recorded by the fetcher. */
  fetchedAt: string;
  source: RxClassSource;
  /** The release RxClass reports for the source, or null when it publishes none (CDC). */
  version: string | null;
}

/**
 * Crosswalk directions for `medcode_map_codes`. The drug directions are
 * RxNorm-backed; the class directions also read the RxClass class layer.
 */
export type MapDirection =
  | 'parents'
  | 'children'
  | 'name_to_rxcui'
  | 'ndc_to_rxcui'
  | 'rxcui_to_ndc'
  | 'rxcui_to_ingredients'
  | 'rxcui_to_brands'
  | 'rxcui_to_classes'
  | 'class_to_rxcuis';

/** Map directions that read the RxClass class layer (the tool guards on hasClassLayer()). */
export const CLASS_DIRECTIONS: readonly MapDirection[] = [
  'rxcui_to_classes',
  'class_to_rxcuis',
] as const;

/**
 * Map directions that require the RxNorm tables (bundled; the tool guards on
 * hasRxNorm()). The class directions are among them: their members and
 * ingredient edges are RxNorm rows.
 */
export const DRUG_DIRECTIONS: readonly MapDirection[] = [
  'name_to_rxcui',
  'ndc_to_rxcui',
  'rxcui_to_ndc',
  'rxcui_to_ingredients',
  'rxcui_to_brands',
  ...CLASS_DIRECTIONS,
] as const;
