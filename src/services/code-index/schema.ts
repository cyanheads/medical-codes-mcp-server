/**
 * @fileoverview Shared SQLite schema and code-shape derivation for the bundled
 * medical-codes index. Imported by BOTH the runtime service (read) and the
 * build script (write) so the table layout, FTS configuration, and the
 * parent/chapter/header derivation rules can never drift between the two.
 * @module services/code-index/schema
 */

import type { SystemId } from './types.js';

/**
 * Full DDL for the bundled database. Run once by the build/fixture scripts.
 * `codes_fts` is an external-content FTS5 index over `codes` — triggers keep it
 * in sync on insert so the build script only writes `codes`.
 */
export const SCHEMA_SQL = `
CREATE TABLE codes (
  system      TEXT NOT NULL,
  code        TEXT NOT NULL,
  short_desc  TEXT,
  long_desc   TEXT,
  billable    INTEGER NOT NULL DEFAULT 0,
  header      INTEGER NOT NULL DEFAULT 0,
  chapter     TEXT,
  parent      TEXT,
  effective   TEXT,
  terminated  TEXT,
  PRIMARY KEY (system, code)
) WITHOUT ROWID;

CREATE INDEX idx_codes_parent ON codes (system, parent);
CREATE INDEX idx_codes_chapter ON codes (system, chapter);

CREATE VIRTUAL TABLE codes_fts USING fts5 (
  system UNINDEXED,
  code UNINDEXED,
  short_desc,
  long_desc,
  tokenize = 'unicode61'
);

CREATE TABLE pcs_axes (
  position INTEGER NOT NULL,
  value    TEXT NOT NULL,
  meaning  TEXT NOT NULL,
  PRIMARY KEY (position, value)
) WITHOUT ROWID;

CREATE TABLE rxnorm_rel (
  rxcui       TEXT NOT NULL,
  rel         TEXT NOT NULL,
  target      TEXT NOT NULL,
  target_type TEXT NOT NULL
);

CREATE INDEX idx_rxnorm_rel_rxcui ON rxnorm_rel (rxcui, rel);
CREATE INDEX idx_rxnorm_rel_target ON rxnorm_rel (target, rel);

CREATE TABLE ndc_map (
  ndc   TEXT NOT NULL,
  rxcui TEXT NOT NULL
);

CREATE INDEX idx_ndc_map_ndc ON ndc_map (ndc);
CREATE INDEX idx_ndc_map_rxcui ON ndc_map (rxcui);

CREATE TABLE build_meta (
  system          TEXT PRIMARY KEY,
  release_id      TEXT NOT NULL,
  effective_start TEXT,
  effective_end   TEXT,
  code_count      INTEGER NOT NULL DEFAULT 0,
  source_url      TEXT,
  built_at        TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE rxclass_class (
  class_type TEXT NOT NULL,
  class_id   TEXT NOT NULL,
  class_name TEXT NOT NULL,
  PRIMARY KEY (class_type, class_id)
) WITHOUT ROWID;

CREATE INDEX idx_rxclass_class_id ON rxclass_class (class_id);

CREATE TABLE rxclass_edge (
  rxcui      TEXT NOT NULL,
  class_type TEXT NOT NULL,
  class_id   TEXT NOT NULL,
  source     TEXT NOT NULL,
  relation   TEXT NOT NULL,
  PRIMARY KEY (rxcui, class_type, class_id, source, relation)
) WITHOUT ROWID;

CREATE INDEX idx_rxclass_edge_class ON rxclass_edge (class_id, class_type);

CREATE TABLE rxclass_source (
  source      TEXT PRIMARY KEY,
  version     TEXT,
  class_count INTEGER NOT NULL,
  edge_count  INTEGER NOT NULL,
  fetched_at  TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * The RxClass drug-class layer's tables. An index built before the layer existed
 * (a custom `MEDCODE_DB_PATH`) has none of them.
 *
 *  - `rxclass_class` — every class node of the bundled class types, including
 *    hierarchy nodes with no direct member. A class ID is unique within its type
 *    only (a few MeSH IDs are both `CHEM` and `DISEASE`), hence the composite key.
 *  - `rxclass_edge` — one row per RXCUI × class × asserting source × relation, for
 *    bundled RXCUIs only, exactly as RxClass attaches them (mostly at `IN`/`PIN`/
 *    `MIN`; CSA schedules only at the product, VA classes almost only there). No
 *    inherited rows: a product reaches its ingredients' classes through
 *    `rxnorm_rel has_ingredient`.
 *    `relation` is the RxClass rela, lowercased to RxClass's own `relas` vocabulary.
 *  - `rxclass_source` — per bundled source: its RxClass version (null when RxClass
 *    publishes none), the classes it asserts at least one edge to, its edge count,
 *    and when the snapshot was fetched.
 */
export const RXCLASS_TABLES = ['rxclass_class', 'rxclass_edge', 'rxclass_source'] as const;

/**
 * Insert a `codes` row and mirror it into the FTS index in one call. The build
 * and fixture scripts use this so FTS population is centralized. `code` is the
 * storage form (no dots).
 */
export const INSERT_CODE_SQL = `INSERT INTO codes (system, code, short_desc, long_desc, billable, header, chapter, parent, effective, terminated)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const INSERT_FTS_SQL = `INSERT INTO codes_fts (system, code, short_desc, long_desc) VALUES (?, ?, ?, ?)`;

/**
 * Re-insert a dot into an ICD-10-CM storage code for display: a dot after the
 * 3-character category when there are subsequent characters (`A0101` → `A01.01`).
 * Storage codes are dot-free; display codes carry the dot the way clinicians write
 * them. ICD-10-PCS, HCPCS, and RXCUI have no dot — returned unchanged.
 */
export function displayCode(system: SystemId, storageCode: string): string {
  if (system !== 'ICD10CM') return storageCode;
  if (storageCode.length <= 3) return storageCode;
  return `${storageCode.slice(0, 3)}.${storageCode.slice(3)}`;
}

/**
 * Normalize a user-supplied code to its storage form: uppercase, trimmed, and —
 * for ICD-10-CM — with the dot stripped so `A01.01` and `A0101` both match the
 * stored `A0101`.
 */
export function storageCode(rawCode: string): string {
  return rawCode.trim().toUpperCase().replace(/\./g, '');
}

/**
 * Derive the parent of an ICD-10-CM code: strip the last character. `A0101` →
 * `A010` → `A01`. Returns null at the 3-character category root (a category has
 * no parent code). Dots are already absent in storage form. This is the parent
 * the index stores; it can be a placeholder-X level that is not itself a code
 * (`S8266X` for `S8266XA`, see {@link ICD10CM_PLACEHOLDER}), so the hierarchy
 * tools step past such a level to the nearest ancestor the release holds.
 */
export function icd10cmParent(code: string): string | null {
  return code.length > 3 ? code.slice(0, -1) : null;
}

/**
 * The ICD-10-CM placeholder character. It pads a code out to the position a 7th
 * character occupies (`S82.66` → `S82.66XA`, `O32.0` → `O32.0XX0`), and the padded
 * level is usually not a code in the release: 3,355 stored parents in the FY2027
 * index (`S8266X`, `O320XX`) have no row. Some are codes (`T36.0X`).
 */
export const ICD10CM_PLACEHOLDER = 'X';

/** The longest ICD-10-CM code: a 3-character category plus up to 4 more characters. */
export const ICD10CM_MAX_LENGTH = 7;

/** A complete ICD-10-PCS code: 7 characters, one per axis. */
export const ICD10PCS_CODE_LENGTH = 7;

/**
 * An ICD-10-PCS table row: the first 3 characters of a complete code (section,
 * body system, root operation — `0DT`, "Gastrointestinal System, Resection").
 * The order file carries one row per table, and every complete code begins with
 * exactly one, so the table row is a complete code's parent and the complete
 * codes beginning with it are its children. Sections and body systems (1 and 2
 * characters) are not rows.
 */
export const ICD10PCS_TABLE_ROW_LENGTH = 3;

/**
 * The ICD-10-PCS table row a complete code belongs to (`0DTJ4ZZ` → `0DT`), or
 * null for a value that is not a complete code — a table row has no parent.
 */
export function icd10pcsTableRow(code: string): string | null {
  return code.length === ICD10PCS_CODE_LENGTH ? code.slice(0, ICD10PCS_TABLE_ROW_LENGTH) : null;
}

/**
 * Derive the parent of a HCPCS code: the single-letter range bucket it belongs
 * to (e.g. `J0120` → `J`). The bucket itself (a 1-char "code") has no parent.
 */
export function hcpcsParent(code: string): string | null {
  return code.length > 1 ? code.charAt(0) : null;
}

/**
 * Human-readable label for each HCPCS Level II single-letter range bucket. The
 * federal ANWEB source file lists individual codes but carries no row for the
 * letter ranges themselves, so the bucket rows the index materializes (parallel
 * to ICD-10-CM 3-char categories) are labeled from this map. Descriptions follow
 * the CMS HCPCS Level II section groupings. A letter absent here falls back to a
 * generic label in {@link hcpcsBucketLabel} so a range CMS introduces later is
 * still browsable rather than a dead branch.
 */
export const HCPCS_SECTION_LABELS: Record<string, string> = {
  A: 'Transportation services and medical & surgical supplies',
  B: 'Enteral and parenteral therapy',
  C: 'Outpatient prospective payment system (OPPS) temporary codes',
  E: 'Durable medical equipment (DME)',
  G: 'Procedures and professional services (temporary)',
  H: 'Behavioral health and substance abuse treatment services',
  J: 'Drugs administered other than oral method',
  K: 'Durable medical equipment (temporary)',
  L: 'Orthotic and prosthetic procedures and devices',
  M: 'Other medical services',
  P: 'Pathology and laboratory services',
  Q: 'Temporary codes',
  R: 'Diagnostic radiology services',
  S: 'Temporary national codes (non-Medicare)',
  T: 'National codes for state Medicaid agencies',
  U: 'Coronavirus diagnostic and laboratory tests',
  V: 'Vision and hearing services',
};

/**
 * Label a HCPCS letter-range bucket from {@link HCPCS_SECTION_LABELS}, falling
 * back to a generic section label for an unmapped letter so a range CMS adds in
 * a future quarterly revision is still materialized as a browsable header.
 */
export function hcpcsBucketLabel(letter: string): string {
  return HCPCS_SECTION_LABELS[letter] ?? `HCPCS Level II section ${letter}`;
}

/**
 * ICD-10-CM chapter label from the first character + leading digits of the
 * category. The 3-char category prefix (letter + 2 digits) is a coarse but
 * stable chapter bucket the order file doesn't carry explicitly; using the
 * category-letter range keeps `chapter` queryable without a separate lookup
 * table. Returns the leading letter, which buckets codes into their A/B/C…
 * alpha chapter — enough for browse grouping.
 */
export function icd10cmChapterLetter(code: string): string {
  return code.charAt(0).toUpperCase();
}
