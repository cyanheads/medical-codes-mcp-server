/**
 * @fileoverview Shared DB-writing helpers for the index build and fixture
 * scripts. Centralizes schema creation, the `codes` + FTS insert, and
 * `build_meta` / `pcs_axes` / `rxnorm_rel` / `ndc_map` writes so the real build
 * and the synthetic fixture produce byte-compatible databases.
 *
 * Bun-only (uses `bun:sqlite`). Run via `bun run`.
 * @module scripts/_db-writer
 */

import { Database } from 'bun:sqlite';

import { INSERT_CODE_SQL, INSERT_FTS_SQL, SCHEMA_SQL } from '@/services/code-index/schema.js';
import type { SystemId } from '@/services/code-index/types.js';

/** A code row to insert (storage form — no dots). */
export interface CodeInput {
  billable: boolean;
  chapter: string | null;
  code: string;
  effective: string | null;
  header: boolean;
  longDesc: string | null;
  parent: string | null;
  shortDesc: string | null;
  system: SystemId;
  terminated: string | null;
}

/** A build_meta provenance row. */
export interface MetaInput {
  codeCount: number;
  effectiveEnd: string | null;
  effectiveStart: string | null;
  releaseId: string;
  sourceUrl: string | null;
  system: SystemId;
}

/**
 * A thin writer around a fresh SQLite DB. Create with `createDbWriter(path)`,
 * stream rows in, then `finalize()` to write provenance and close.
 */
export class DbWriter {
  private readonly insertCode;
  private readonly insertFts;
  private readonly insertAxis;
  private readonly insertRel;
  private readonly insertNdc;
  private readonly insertMeta;
  private readonly counts = new Map<SystemId, number>();

  constructor(private readonly db: Database) {
    // No WAL: the output is a read-only single-file artifact that ships in the
    // package/image. WAL would leave -shm/-wal sidecars that don't get bundled.
    db.run('PRAGMA journal_mode = MEMORY');
    db.run('PRAGMA synchronous = OFF');
    db.run(SCHEMA_SQL);
    this.insertCode = db.query(INSERT_CODE_SQL);
    this.insertFts = db.query(INSERT_FTS_SQL);
    this.insertAxis = db.query(
      'INSERT OR IGNORE INTO pcs_axes (position, value, meaning) VALUES (?, ?, ?)',
    );
    this.insertRel = db.query(
      'INSERT INTO rxnorm_rel (rxcui, rel, target, target_type) VALUES (?, ?, ?, ?)',
    );
    this.insertNdc = db.query('INSERT INTO ndc_map (ndc, rxcui) VALUES (?, ?)');
    this.insertMeta = db.query(
      `INSERT OR REPLACE INTO build_meta
       (system, release_id, effective_start, effective_end, code_count, source_url, built_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  /** Begin a transaction — wrap bulk inserts for speed. */
  begin(): void {
    this.db.run('BEGIN');
  }

  /** Commit the open transaction. */
  commit(): void {
    this.db.run('COMMIT');
  }

  /** Insert one code row and mirror it into FTS. */
  addCode(row: CodeInput): void {
    this.insertCode.run(
      row.system,
      row.code,
      row.shortDesc,
      row.longDesc,
      row.billable ? 1 : 0,
      row.header ? 1 : 0,
      row.chapter,
      row.parent,
      row.effective,
      row.terminated,
    );
    this.insertFts.run(row.system, row.code, row.shortDesc, row.longDesc);
    this.counts.set(row.system, (this.counts.get(row.system) ?? 0) + 1);
  }

  /** Insert a PCS axis-value row. */
  addPcsAxis(position: number, value: string, meaning: string): void {
    this.insertAxis.run(position, value, meaning);
  }

  /** Insert an RxNorm relationship edge. */
  addRxNormRel(rxcui: string, rel: string, target: string, targetType: string): void {
    this.insertRel.run(rxcui, rel, target, targetType);
  }

  /** Insert an NDC ↔ RXCUI mapping. */
  addNdc(ndc: string, rxcui: string): void {
    this.insertNdc.run(ndc, rxcui);
  }

  /** Number of `codes` rows inserted for a system so far. */
  countFor(system: SystemId): number {
    return this.counts.get(system) ?? 0;
  }

  /** Write a build_meta row. Pass an explicit count or let it use the running tally. */
  writeMeta(meta: MetaInput): void {
    this.insertMeta.run(
      meta.system,
      meta.releaseId,
      meta.effectiveStart,
      meta.effectiveEnd,
      meta.codeCount,
      meta.sourceUrl,
      new Date().toISOString(),
    );
  }

  /** Optimize FTS and close the handle. */
  finalize(): void {
    this.db.run("INSERT INTO codes_fts(codes_fts) VALUES('optimize')");
    this.db.close();
  }
}

/** Create a writer over a brand-new DB file at `path` (overwrites if present). */
export function createDbWriter(path: string): DbWriter {
  const db = new Database(path, { create: true });
  return new DbWriter(db);
}
