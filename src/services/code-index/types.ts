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
 * A single code row from the `codes` table. The spine of the index — one row
 * per code across all systems. `billable`/`header` are 0/1 integers in SQLite;
 * the service maps them to booleans at the boundary.
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

/** An ICD-10-PCS axis-value row from `pcs_axes`. */
export interface PcsAxisRow {
  /** What that value means at that position. */
  meaning: string;
  /** Character position 1-7 in the PCS code. */
  position: number;
  /** The single-character axis value. */
  value: string;
}

/** An RXCUI relationship edge from `rxnorm_rel`. */
export interface RxNormRelRow {
  /** Relationship/attribute label, e.g. 'has_ingredient', 'tradename_of', 'NDC'. */
  rel: string;
  rxcui: string;
  target: string;
  /** Concept type of the target, e.g. 'IN', 'BN', 'SCD', 'NDC'. */
  targetType: string;
}

/** Discriminated validity status for `medcode_check_code`. */
export type CheckStatus =
  | 'valid_billable'
  | 'valid_not_billable'
  | 'valid_header'
  | 'terminated'
  | 'unknown';

/** Crosswalk directions for `medcode_map_codes`. The drug directions are RxNorm-backed. */
export type MapDirection =
  | 'parents'
  | 'children'
  | 'name_to_rxcui'
  | 'ndc_to_rxcui'
  | 'rxcui_to_ndc'
  | 'rxcui_to_ingredients'
  | 'rxcui_to_brands';

/** Map directions that require the RxNorm tables (bundled; the tool guards on hasRxNorm()). */
export const DRUG_DIRECTIONS: readonly MapDirection[] = [
  'name_to_rxcui',
  'ndc_to_rxcui',
  'rxcui_to_ndc',
  'rxcui_to_ingredients',
  'rxcui_to_brands',
] as const;
