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
`;

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
 * no parent code). Dots are already absent in storage form.
 */
export function icd10cmParent(code: string): string | null {
  return code.length > 3 ? code.slice(0, -1) : null;
}

/**
 * Derive the parent of a HCPCS code: the single-letter range bucket it belongs
 * to (e.g. `J0120` → `J`). The bucket itself (a 1-char "code") has no parent.
 */
export function hcpcsParent(code: string): string | null {
  return code.length > 1 ? code.charAt(0) : null;
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
