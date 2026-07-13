/**
 * @fileoverview The code-index service — the single source of truth for the
 * server. Opens the bundled SQLite + FTS5 database read-only at startup and
 * exposes typed query methods the six tools compose: decode, search, validate,
 * crosswalk, and hierarchy-browse. No network, no tenant state — the corpus is
 * global, read-only, and built at package-build time.
 * @module services/code-index/code-index-service
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { internalError } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService, runtimeCaps } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { detectSystems, ndcCandidates } from './detect.js';
import { displayCode, icd10cmParent, storageCode } from './schema.js';
import {
  type BuildMetaRow,
  type CheckStatus,
  type CodeRow,
  DRUG_DIRECTIONS,
  type MapDirection,
  type Page,
  type PcsAxisRow,
  type RxNormRelRow,
  SYSTEM_IDS,
  type SystemId,
} from './types.js';

/**
 * Uniform read-only SQLite handle the service queries through. Both drivers
 * (`bun:sqlite` under Bun, `better-sqlite3` under Node/Vitest) are normalized to
 * this `query(sql) → { all, get }` shape by {@link openDriver} — the only place
 * the two driver APIs differ (`.query()` vs `.prepare()`).
 */
interface SqliteDb {
  close(): void;
  query(sql: string): SqliteStatement;
}
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

/** `better-sqlite3` Database surface used here — `.prepare()` prepares a statement. */
interface BetterDb {
  close(): void;
  prepare(sql: string): SqliteStatement;
}

/**
 * Open the bundled DB read-only with whichever driver the runtime provides, and
 * normalize it to {@link SqliteDb}. Bun uses the built-in `bun:sqlite`; Node and
 * the Vitest worker (which runs as Node) use the `better-sqlite3` optional dep.
 * Both are loaded via variable-specifier dynamic import so the project typechecks
 * without `bun-types` and builds without `better-sqlite3` resolved at compile time.
 */
async function openDriver(dbPath: string): Promise<SqliteDb> {
  if (runtimeCaps.isBun) {
    const BUN_SQLITE = 'bun:sqlite';
    const { Database } = (await import(BUN_SQLITE)) as {
      Database: new (path: string, opts: { readonly: boolean }) => SqliteDb;
    };
    const db = new Database(dbPath, { readonly: true });
    return { query: (sql) => db.query(sql), close: () => db.close() };
  }

  const BETTER_SQLITE3 = 'better-sqlite3';
  let mod: { default: new (path: string, opts: object) => BetterDb };
  try {
    mod = (await import(BETTER_SQLITE3)) as typeof mod;
  } catch (err) {
    throw internalError(
      'medical-codes-mcp-server needs a SQLite driver: the built-in `bun:sqlite` (run with Bun — the published Docker image and npm bin both do) or the `better-sqlite3` optional dependency for Node. Neither was found.',
      { dbPath },
      { cause: err },
    );
  }
  const db = new mod.default(dbPath, { readonly: true, fileMustExist: true });
  return { query: (sql) => db.prepare(sql), close: () => db.close() };
}

/** A decoded code with display form and derived flags, the shape tools return. */
export interface DecodedCode {
  billable: boolean;
  chapter: string | null;
  code: string;
  description: string | null;
  header: boolean;
  shortDescription: string | null;
  system: SystemId;
}

/** A decoded code plus its immediate hierarchy neighbours. */
export interface DecodedCodeWithHierarchy extends DecodedCode {
  children: DecodedCode[];
  /** True when the code has more immediate children than `children` carries (the list was capped). */
  childrenTruncated: boolean;
  parent: string | null;
}

/** Result of a validity check — discriminated status plus optional why-not. */
export interface CheckResult {
  code: string;
  status: CheckStatus;
  system: SystemId;
  whyNot?: string;
}

/** One crosswalk hit with the edge/provenance that produced it. */
export interface MapHit {
  description?: string;
  /** The system or relationship that answered (e.g. 'ICD10CM', 'has_ingredient'). */
  source: string;
  system: SystemId | null;
  value: string;
}

/** A FTS search hit. */
export interface SearchHit extends DecodedCode {}

const FALLBACK_DB_FILENAME = 'medical-codes.db';

/**
 * Resolve the bundled DB path. An explicit `MEDCODE_DB_PATH` wins; otherwise the
 * packaged `data/medical-codes.db`, resolved relative to this module's location
 * so it works from both `src/` (tests, bun) and `dist/` (production build).
 */
function resolveDbPath(): string {
  const configured = getServerConfig().dbPath;
  if (configured) return configured;
  const here = dirname(fileURLToPath(import.meta.url));
  // here is …/src/services/code-index or …/dist/services/code-index → up 3 to root.
  return join(here, '..', '..', '..', 'data', FALLBACK_DB_FILENAME);
}

/**
 * Read-only handle over the bundled medical-codes index. Constructed once in
 * `setup()`. All query methods are synchronous SQLite reads — fast enough to
 * call inline from handlers.
 */
export class CodeIndexService {
  private constructor(
    private readonly db: SqliteDb,
    readonly dbPath: string,
  ) {}

  /**
   * Open the bundled DB read-only and assert it is a populated build. Fails fast
   * (throws) on a missing file, an unreadable DB, or an empty `build_meta` — a
   * broken bundle should crash loudly at startup, not serve empty results.
   */
  static async open(): Promise<CodeIndexService> {
    const dbPath = resolveDbPath();
    if (!existsSync(dbPath)) {
      throw internalError(
        `Bundled code index not found at ${dbPath}. The package ships data/medical-codes.db; set MEDCODE_DB_PATH to override, or rebuild it with \`bun run scripts/build-index.ts\`.`,
        { dbPath },
      );
    }

    const db = await openDriver(dbPath);

    const meta = db.query('SELECT COUNT(*) AS n FROM build_meta').get() as { n: number };
    if (!meta || meta.n === 0) {
      db.close();
      throw internalError(
        `Bundled code index at ${dbPath} has no build_meta rows — the database is empty or corrupt.`,
        { dbPath },
      );
    }

    logger.info(
      'Code index opened',
      requestContextService.createRequestContext({
        operation: 'CodeIndexOpen',
        dbPath,
        systems: meta.n,
      }),
    );
    return new CodeIndexService(db, dbPath);
  }

  /** Map a raw `codes` row (snake_case, 0/1 ints) to a typed CodeRow. */
  private static toCodeRow(raw: Record<string, unknown>): CodeRow {
    return {
      system: raw.system as SystemId,
      code: raw.code as string,
      shortDesc: (raw.short_desc as string | null) ?? null,
      longDesc: (raw.long_desc as string | null) ?? null,
      billable: Number(raw.billable ?? 0),
      header: Number(raw.header ?? 0),
      chapter: (raw.chapter as string | null) ?? null,
      parent: (raw.parent as string | null) ?? null,
      effective: (raw.effective as string | null) ?? null,
      terminated: (raw.terminated as string | null) ?? null,
    };
  }

  /** Project a CodeRow into the display shape tools return. */
  private static decode(row: CodeRow): DecodedCode {
    return {
      system: row.system,
      code: displayCode(row.system, row.code),
      shortDescription: row.shortDesc,
      description: row.longDesc ?? row.shortDesc,
      billable: row.billable === 1,
      header: row.header === 1,
      chapter: row.chapter,
    };
  }

  /** Lexically-plausible systems for a raw code (no DB hit). */
  detectSystem(rawCode: string): SystemId[] {
    return detectSystems(rawCode);
  }

  /** Fetch the raw row for a code in a specific system, or null. */
  private getRow(code: string, system: SystemId): CodeRow | null {
    const raw = this.db
      .query('SELECT * FROM codes WHERE system = ? AND code = ?')
      .get(system, code) as Record<string, unknown> | undefined;
    return raw ? CodeIndexService.toCodeRow(raw) : null;
  }

  /**
   * Find which systems actually contain a code string. Narrows by lexical shape
   * first (cheap), then confirms membership in the DB. The lexical candidates
   * may overlap (a letter+4-digit code is shaped like both ICD-10-CM and HCPCS);
   * DB membership is the real disambiguator — a code present in exactly one
   * system is unambiguous regardless of shape overlap.
   */
  private resolveSystems(rawCode: string, explicit?: SystemId): SystemId[] {
    const code = storageCode(rawCode);
    const candidates = explicit ? [explicit] : detectSystems(rawCode);
    return candidates.filter((sys) => this.getRow(code, sys) !== null);
  }

  /**
   * Decode one code. Returns `{ kind: 'found' }` with the row, `'ambiguous'`
   * with the colliding systems, or `'not_found'`. When `system` is given it is
   * authoritative; otherwise membership across detected systems decides.
   */
  getByCode(
    rawCode: string,
    system?: SystemId,
  ):
    | { kind: 'found'; row: CodeRow }
    | { kind: 'ambiguous'; systems: SystemId[] }
    | { kind: 'not_found' } {
    const code = storageCode(rawCode);
    const present = this.resolveSystems(rawCode, system);
    const [sys] = present;
    if (!sys) return { kind: 'not_found' };
    if (present.length > 1) return { kind: 'ambiguous', systems: present };
    const row = this.getRow(code, sys);
    return row ? { kind: 'found', row } : { kind: 'not_found' };
  }

  /**
   * Decode a National Drug Code to its RxNorm product(s) via `ndc_map` — the
   * offline first-class NDC decode. NDC is an identifier, not a bundled system,
   * so it is resolved here rather than through {@link getByCode}'s system path.
   *
   *  - `found` — one or more `RXNORM` rows the NDC maps to (usually one).
   *  - `no_match` — an UNAMBIGUOUS NDC (hyphenated) that isn't in the bundled
   *    prescribable set. A hyphenated drug code is never an RXCUI, so this is a
   *    real NDC miss, not a fall-through case.
   *  - `not_ndc` — the input isn't NDC-shaped, OR is a bare-digit NDC candidate
   *    with no map hit (it may instead be an RXCUI — the caller tries that next).
   */
  getByNdc(
    rawCode: string,
  ):
    | { kind: 'found'; ndc: string; rows: CodeRow[] }
    | { kind: 'no_match'; ndc: string }
    | { kind: 'not_ndc' } {
    const { candidates, unambiguous } = ndcCandidates(rawCode);
    if (candidates.length === 0) return { kind: 'not_ndc' };

    const { matched, rxcuis } = this.ndcMapLookup(candidates);
    if (rxcuis.size === 0)
      return unambiguous ? { kind: 'no_match', ndc: matched } : { kind: 'not_ndc' };

    const rows: CodeRow[] = [];
    for (const rxcui of rxcuis) {
      const row = this.getRow(rxcui, 'RXNORM');
      if (row) rows.push(row);
    }
    if (rows.length === 0)
      return unambiguous ? { kind: 'no_match', ndc: matched } : { kind: 'not_ndc' };
    return { kind: 'found', ndc: matched, rows };
  }

  /**
   * Resolve every RXCUI any of the candidate 11-digit NDCs maps to in `ndc_map`,
   * tracking the candidate that actually hit (for the no-match NDC echo). Shared
   * by {@link getByNdc} and the `ndc_to_rxcui` crosswalk so the map query stays
   * identical between the two NDC paths.
   */
  private ndcMapLookup(candidates: string[]): { matched: string; rxcuis: Set<string> } {
    const rxcuis = new Set<string>();
    let matched = candidates[0] ?? '';
    for (const ndc of candidates) {
      const hits = this.db.query('SELECT rxcui FROM ndc_map WHERE ndc = ?').all(ndc) as {
        rxcui: string;
      }[];
      if (hits.length > 0) {
        matched = ndc;
        for (const h of hits) rxcuis.add(h.rxcui);
      }
    }
    return { matched, rxcuis };
  }

  /**
   * The single SQL pagination primitive behind every capped query path
   * (children, FTS search, drug-name crosswalk, browse). Appends
   * `LIMIT ? OFFSET ?` to the caller's `sql` — which must already carry a fully
   * deterministic `ORDER BY` — fetches `limit + 1` rows, and slices back to
   * `limit`. Whether the extra row came back IS `hasMore`: an exact signal that
   * replaces the `rows.length >= limit` heuristic (which false-positives when the
   * corpus holds exactly `limit` matches). One primitive, many callers; each
   * builds its own `WHERE`/`ORDER BY`, only the offset/limit mechanics are shared.
   */
  private fetchPage(
    sql: string,
    params: readonly unknown[],
    page: Page,
  ): { rows: Record<string, unknown>[]; hasMore: boolean } {
    const rows = this.db
      .query(`${sql} LIMIT ? OFFSET ?`)
      .all(...params, page.limit + 1, page.offset) as Record<string, unknown>[];
    const hasMore = rows.length > page.limit;
    return { rows: hasMore ? rows.slice(0, page.limit) : rows, hasMore };
  }

  /**
   * Immediate children of a code within its system (prefix hierarchy), one page
   * at a time. `ORDER BY code` is already a full deterministic order — `(system,
   * code)` is the table's primary key — so no tie-breaker is needed. `hasMore`
   * reports whether children beyond this page exist, so callers can paginate or
   * disclose truncation exactly.
   */
  childrenOf(
    system: SystemId,
    parentCode: string,
    page: Page,
  ): { children: DecodedCode[]; hasMore: boolean } {
    const { rows, hasMore } = this.fetchPage(
      'SELECT * FROM codes WHERE system = ? AND parent = ? ORDER BY code',
      [system, parentCode],
      page,
    );
    return {
      children: rows.map((r) => CodeIndexService.decode(CodeIndexService.toCodeRow(r))),
      hasMore,
    };
  }

  /**
   * Decode with parent + immediate children attached. The children list is
   * capped at `childrenLimit` (the server cap by default); `childrenTruncated`
   * discloses when a code has more children than were attached, so a batched
   * decode never silently hides a large child set — the caller retrieves the rest
   * via `medcode_browse_hierarchy` / `medcode_map_codes` for that node.
   */
  getByCodeWithHierarchy(
    row: CodeRow,
    childrenLimit: number = getServerConfig().maxResults,
  ): DecodedCodeWithHierarchy {
    const base = CodeIndexService.decode(row);
    const parentStorage = row.system === 'ICD10CM' ? icd10cmParent(row.code) : row.parent;
    const { children, hasMore } = this.childrenOf(row.system, row.code, {
      offset: 0,
      limit: childrenLimit,
    });
    return {
      ...base,
      parent: parentStorage ? displayCode(row.system, parentStorage) : null,
      children,
      childrenTruncated: hasMore,
    };
  }

  /**
   * Full-text search over code descriptions, one page at a time. Translates the
   * user's text into a safe FTS5 MATCH expression (every token required,
   * prefix-matched), applies the system/billable/chapter filters, and returns the
   * requested page plus an exact `hasMore`. The `ORDER BY` carries a `c.system,
   * c.code` tie-breaker after the bm25 rank so the total order is deterministic —
   * bm25 ties (same-length, same-term-frequency descriptions) would otherwise let
   * offset-based pages skip or repeat rows.
   */
  searchFts(
    queryText: string,
    filters: {
      system?: SystemId;
      billableOnly?: boolean;
      chapter?: string;
      offset?: number;
      limit: number;
    },
  ): { codes: SearchHit[]; hasMore: boolean } {
    const match = toFtsMatch(queryText);
    if (!match) return { codes: [], hasMore: false };

    const where: string[] = ['codes_fts MATCH ?'];
    const params: unknown[] = [match];
    if (filters.system) {
      where.push('c.system = ?');
      params.push(filters.system);
    }
    if (filters.billableOnly) {
      where.push('c.billable = 1');
    }
    if (filters.chapter) {
      where.push('c.chapter = ?');
      params.push(filters.chapter);
    }

    const { rows, hasMore } = this.fetchPage(
      `SELECT c.* FROM codes_fts f
         JOIN codes c ON c.system = f.system AND c.code = f.code
         WHERE ${where.join(' AND ')}
         ORDER BY bm25(codes_fts), c.system, c.code`,
      params,
      { offset: filters.offset ?? 0, limit: filters.limit },
    );
    return {
      codes: rows.map((r) => CodeIndexService.decode(CodeIndexService.toCodeRow(r))),
      hasMore,
    };
  }

  /**
   * Validate a code's existence, currency, and billability. Existence vs.
   * validity are split: a non-billable or terminated code is a *successful*
   * status with a why-not, NOT a failure. Only a code absent from every detected
   * system is `unknown`.
   */
  checkCode(
    rawCode: string,
    system?: SystemId,
  ): { kind: 'resolved'; result: CheckResult } | { kind: 'ambiguous'; systems: SystemId[] } {
    const code = storageCode(rawCode);
    const present = this.resolveSystems(rawCode, system);
    if (present.length > 1) return { kind: 'ambiguous', systems: present };

    if (present.length === 0) {
      // Echo a best-guess system for the caller's orientation, if shape suggests one.
      const detected = system ?? detectSystems(rawCode)[0];
      // A bare integer matches only the RXCUI shape. If this build carries no
      // RxNorm (hasRxNorm() false — e.g. a custom MEDCODE_DB_PATH), "No RXNORM
      // code matches X" would imply we searched a populated table; instead name
      // RxNorm as absent and flag the likely CPT / HCPCS Level I origin. With
      // RxNorm bundled the gate falls through to a genuine per-concept not-found.
      const trimmed = rawCode.trim();
      const whyNot =
        detected === 'RXNORM'
          ? this.hasRxNorm()
            ? `No RxNorm concept matches "${trimmed}". If this is a CPT or HCPCS Level I code, those are out of scope — this server bundles ICD-10-CM, ICD-10-PCS, HCPCS Level II, and RxNorm.`
            : `"${trimmed}" looks like an RxNorm RXCUI or a CPT / HCPCS Level I code. RxNorm is not present in this build, and CPT / HCPCS Level I are out of scope — this build carries ICD-10-CM, ICD-10-PCS, and HCPCS Level II.`
          : detected
            ? `No ${detected} code matches "${trimmed}" in the bundled release.`
            : `"${trimmed}" does not match the shape of any bundled code system.`;
      return {
        kind: 'resolved',
        result: {
          system: detected ?? 'ICD10CM',
          code: rawCode.trim().toUpperCase(),
          status: 'unknown',
          whyNot,
        },
      };
    }

    // Exactly one system remains (zero and >1 handled above); resolveSystems only
    // returns systems whose row exists, so getRow cannot be null here.
    const [sys] = present;
    const row = sys ? this.getRow(code, sys) : null;
    if (!row)
      return { kind: 'resolved', result: { system: sys ?? 'ICD10CM', code, status: 'unknown' } };
    const display = displayCode(row.system, row.code);

    if (row.terminated) {
      return {
        kind: 'resolved',
        result: {
          system: row.system,
          code: display,
          status: 'terminated',
          whyNot: `Code terminated effective ${formatDate(row.terminated)}; no longer valid for current claims.`,
        },
      };
    }
    if (row.header === 1) {
      return {
        kind: 'resolved',
        result: {
          system: row.system,
          code: display,
          status: 'valid_header',
          whyNot:
            'Valid category/header, but not billable — submit a more specific child code instead.',
        },
      };
    }
    if (row.billable === 1) {
      return {
        kind: 'resolved',
        result: { system: row.system, code: display, status: 'valid_billable' },
      };
    }
    return {
      kind: 'resolved',
      result: {
        system: row.system,
        code: display,
        status: 'valid_not_billable',
        whyNot:
          'Valid code, but not flagged billable in this release — verify a more specific code is not required before submitting.',
      },
    };
  }

  /**
   * Crosswalk a value across systems or within a hierarchy. The hierarchy
   * directions (`parents`/`children`) and the RxNorm-backed drug directions both
   * resolve here; the tool guards drug directions on `hasRxNorm()` (a graceful
   * fallback for a build without the RxNorm tables) before calling.
   */
  mapCode(
    from: string,
    direction: MapDirection,
    system?: SystemId,
    page: Page = { offset: 0, limit: getServerConfig().maxResults },
  ):
    | { kind: 'ok'; hits: MapHit[]; resolvedSystem: SystemId | null; hasMore: boolean }
    | { kind: 'ambiguous'; systems: SystemId[] }
    | { kind: 'source_not_found' } {
    if (direction === 'parents' || direction === 'children') {
      const present = this.resolveSystems(from, system);
      const [sys] = present;
      if (!sys) return { kind: 'source_not_found' };
      if (present.length > 1) return { kind: 'ambiguous', systems: present };
      const code = storageCode(from);
      const row = this.getRow(code, sys);
      if (!row) return { kind: 'source_not_found' };

      if (direction === 'children') {
        const { children, hasMore } = this.childrenOf(sys, code, page);
        return {
          kind: 'ok',
          resolvedSystem: sys,
          hasMore,
          hits: children.map((k) => ({
            source: sys,
            system: sys,
            value: k.code,
            ...(k.description ? { description: k.description } : {}),
          })),
        };
      }
      // parents — single immediate parent for prefix systems; PCS has none.
      const parentStorage = sys === 'ICD10CM' ? icd10cmParent(code) : row.parent;
      if (!parentStorage) return { kind: 'ok', resolvedSystem: sys, hasMore: false, hits: [] };
      const parentRow = this.getRow(parentStorage, sys);
      if (!parentRow) return { kind: 'ok', resolvedSystem: sys, hasMore: false, hits: [] };
      const parentDesc = parentRow.longDesc ?? parentRow.shortDesc;
      return {
        kind: 'ok',
        resolvedSystem: sys,
        hasMore: false,
        hits: [
          {
            source: sys,
            system: sys,
            value: displayCode(sys, parentRow.code),
            ...(parentDesc ? { description: parentDesc } : {}),
          },
        ],
      };
    }

    // Drug directions — RxNorm-backed. The tool short-circuits these with
    // `direction_unavailable` only when the RxNorm tables are absent from the
    // build; with RxNorm bundled (the shipped default) they resolve here.
    return this.mapDrug(from, direction, page);
  }

  /** Whether the RxNorm tables carry any rows (i.e. RxNorm is bundled in this build). */
  hasRxNorm(): boolean {
    const row = this.db.query('SELECT COUNT(*) AS n FROM rxnorm_rel').get() as { n: number };
    return (row?.n ?? 0) > 0;
  }

  /** RxNorm crosswalk resolution. */
  private mapDrug(
    from: string,
    direction: MapDirection,
    page: Page,
  ):
    | { kind: 'ok'; hits: MapHit[]; resolvedSystem: SystemId | null; hasMore: boolean }
    | { kind: 'source_not_found' } {
    const value = from.trim();
    switch (direction) {
      case 'name_to_rxcui': {
        // Escape LIKE wildcards in the user value so `%` / `_` / `\` match
        // literally instead of acting as operators (an unescaped `%` would match
        // every drug name). Bind the escaped term inside `%…%` and declare the
        // escape char with ESCAPE. A broad substring can match tens of thousands
        // of concepts, so this direction paginates. `ORDER BY length(code)` is not
        // unique (many RXCUIs share a string length), so `, code` makes the total
        // order deterministic — offset pages would otherwise skip or repeat rows.
        const term = `%${escapeLike(value)}%`;
        const { rows, hasMore } = this.fetchPage(
          `SELECT code, long_desc, short_desc FROM codes
             WHERE system = 'RXNORM' AND (long_desc LIKE ? ESCAPE '\\' OR short_desc LIKE ? ESCAPE '\\')
             ORDER BY length(code), code`,
          [term, term],
          page,
        );
        if (rows.length === 0) return { kind: 'source_not_found' };
        return {
          kind: 'ok',
          resolvedSystem: 'RXNORM',
          hasMore,
          hits: rows.map((r) => ({
            source: 'RXNORM',
            system: 'RXNORM' as const,
            value: r.code as string,
            ...(r.long_desc || r.short_desc
              ? { description: (r.long_desc ?? r.short_desc) as string }
              : {}),
          })),
        };
      }
      case 'ndc_to_rxcui': {
        // Normalize to the 11-digit form(s) the map stores (RxNav emits 11-digit)
        // so a 10-digit hyphenated NDC off a package label resolves; fall back to
        // a plain digit-strip when the value isn't NDC-shaped.
        const { candidates } = ndcCandidates(value);
        const keys = candidates.length > 0 ? candidates : [value.replace(/[^0-9]/g, '')];
        const { rxcuis } = this.ndcMapLookup(keys);
        if (rxcuis.size === 0) return { kind: 'source_not_found' };
        return {
          kind: 'ok',
          resolvedSystem: 'RXNORM',
          hasMore: false,
          hits: [...rxcuis].map((rxcui) => ({
            source: 'NDC',
            system: 'RXNORM' as const,
            value: rxcui,
          })),
        };
      }
      case 'rxcui_to_ndc': {
        const rows = this.db.query('SELECT ndc FROM ndc_map WHERE rxcui = ?').all(value) as {
          ndc: string;
        }[];
        if (rows.length === 0) return { kind: 'source_not_found' };
        return {
          kind: 'ok',
          resolvedSystem: 'RXNORM',
          hasMore: false,
          hits: rows.map((r) => ({ source: 'NDC', system: null, value: r.ndc })),
        };
      }
      case 'rxcui_to_ingredients':
      case 'rxcui_to_brands': {
        const rel = direction === 'rxcui_to_ingredients' ? 'has_ingredient' : 'has_tradename';
        const rows = this.db
          .query('SELECT rel, target, target_type FROM rxnorm_rel WHERE rxcui = ? AND rel = ?')
          .all(value, rel) as RxNormRelRow[];
        if (rows.length === 0) return { kind: 'source_not_found' };
        return {
          kind: 'ok',
          resolvedSystem: 'RXNORM',
          hasMore: false,
          hits: rows.map((r) => ({
            source: r.rel,
            system: 'RXNORM' as const,
            value: r.target,
            ...(r.targetType ? { description: r.targetType } : {}),
          })),
        };
      }
      default:
        return { kind: 'source_not_found' };
    }
  }

  /** True when `direction` needs the RxNorm tables. */
  static isDrugDirection(direction: MapDirection): boolean {
    return DRUG_DIRECTIONS.includes(direction);
  }

  /**
   * Browse a system's hierarchy. With no `node`: top-level entries (3-char
   * ICD-10-CM categories grouped by chapter letter, HCPCS range buckets, PCS
   * section axis values). With a `node`: that node's children — for ICD-10-PCS,
   * the valid next-position axis values rather than prefix children.
   */
  browse(
    system: SystemId,
    node: string | undefined,
    page: Page,
  ):
    | { kind: 'codes'; codes: DecodedCode[]; hasMore: boolean }
    | { kind: 'axes'; axes: PcsAxisRow[]; hasMore: boolean }
    | { kind: 'unknown_node' } {
    if (system === 'ICD10PCS') {
      return this.browsePcs(node, page);
    }

    if (system === 'RXNORM') {
      // RxNorm is a flat drug vocabulary in this index — concepts carry no prefix
      // parent, so there is no hierarchy to walk. Return empty (rather than a
      // meaningless capped dump of all concepts) and let the tool steer the caller
      // to search_codes / get_code / map_codes via its notice.
      return { kind: 'codes', codes: [], hasMore: false };
    }

    if (!node) {
      // Top level: codes with no parent (roots). For ICD10CM these are 3-char
      // categories; for HCPCS the single-letter range buckets (if seeded) or the
      // distinct chapters. `ORDER BY code` is unique (the table primary key), so
      // the page is deterministic and offset/limit walk it cleanly.
      const { rows, hasMore } = this.fetchPage(
        'SELECT * FROM codes WHERE system = ? AND parent IS NULL ORDER BY code',
        [system],
        page,
      );
      return {
        kind: 'codes',
        codes: rows.map((r) => CodeIndexService.decode(CodeIndexService.toCodeRow(r))),
        hasMore,
      };
    }

    const code = storageCode(node);
    if (!this.getRow(code, system)) return { kind: 'unknown_node' };
    const { children, hasMore } = this.childrenOf(system, code, page);
    return { kind: 'codes', codes: children, hasMore };
  }

  /**
   * PCS axis browse. Only the position-1 Section axis is baked into `pcs_axes`
   * (positions 2-7 are context-dependent on the full preceding axis path and a
   * flat table can't represent them without storing wrong meanings — see
   * `parseIcd10pcsAxes`). So the top level (no node) returns the 17 Sections;
   * a partial code asks for a deeper position, which has no rows — the caller
   * gets an explicit notice (handled in the tool), not silent-empty or wrong data.
   */
  private browsePcs(
    node: string | undefined,
    page: Page,
  ): { kind: 'axes'; axes: PcsAxisRow[]; hasMore: boolean } | { kind: 'unknown_node' } {
    const partial = node ? storageCode(node) : '';
    if (partial.length >= 7) return { kind: 'unknown_node' };
    const position = partial.length + 1; // next axis position to enumerate
    const { rows, hasMore } = this.fetchPage(
      'SELECT position, value, meaning FROM pcs_axes WHERE position = ? ORDER BY value',
      [position],
      page,
    );
    return {
      kind: 'axes',
      axes: rows.map((r) => ({
        position: Number(r.position),
        value: r.value as string,
        meaning: r.meaning as string,
      })),
      hasMore,
    };
  }

  /** Provenance for every bundled system. */
  listSystems(): BuildMetaRow[] {
    const rows = this.db.query('SELECT * FROM build_meta ORDER BY system').all() as Record<
      string,
      unknown
    >[];
    const order = new Map(SYSTEM_IDS.map((s, i) => [s, i]));
    return rows
      .map((r) => ({
        system: r.system as SystemId,
        releaseId: r.release_id as string,
        effectiveStart: (r.effective_start as string | null) ?? null,
        effectiveEnd: (r.effective_end as string | null) ?? null,
        codeCount: Number(r.code_count ?? 0),
        sourceUrl: (r.source_url as string | null) ?? null,
        builtAt: r.built_at as string,
      }))
      .sort((a, b) => (order.get(a.system) ?? 99) - (order.get(b.system) ?? 99));
  }

  /** Expose the decode projection for tools that already hold a CodeRow. */
  static project(row: CodeRow): DecodedCode {
    return CodeIndexService.decode(row);
  }
}

/**
 * Translate free user text into a safe FTS5 MATCH expression. Strips FTS5
 * operator characters, splits into tokens, and ANDs prefix-matched tokens so
 * "diabetic neuropathy" requires both stems. Returns null when nothing usable
 * remains (caller treats that as an empty result, not an error).
 */
export function toFtsMatch(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .replace(/["()*:^-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  // Quote each token (defuses any residual special handling) and prefix-match.
  return tokens.map((t) => `"${t}"*`).join(' AND ');
}

/**
 * Escape SQL LIKE wildcards (`%`, `_`) and the escape char (`\`) in a
 * user-supplied substring so it matches literally inside a `LIKE '%…%'` pattern.
 * Pair with `ESCAPE '\'` in the query. Without this a value like `%` would match
 * every row; `_` would match any single character.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Format a YYYYMMDD storage date as YYYY-MM-DD; pass through anything else. */
function formatDate(yyyymmdd: string): string {
  return /^\d{8}$/.test(yyyymmdd)
    ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    : yyyymmdd;
}

// ─── Init / Accessor ────────────────────────────────────────────────────────

let _service: CodeIndexService | undefined;

/** Open the bundled index and cache the handle. Called once from `setup()`. */
export async function initCodeIndexService(): Promise<void> {
  _service = await CodeIndexService.open();
}

/** Return the initialized service, throwing if `setup()` hasn't run. */
export function getCodeIndexService(): CodeIndexService {
  if (!_service) {
    throw new Error('CodeIndexService not initialized — call initCodeIndexService() in setup()');
  }
  return _service;
}
