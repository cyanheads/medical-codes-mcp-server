/**
 * @fileoverview Test helper that opens the shipped medical-code index rather
 * than the small synthetic fixture. Used only by smoke and integration suites.
 * @module tests/helpers/bundled-index
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runtimeCaps } from '@cyanheads/mcp-ts-core/utils';

import {
  getCodeIndexService,
  initCodeIndexService,
} from '@/services/code-index/code-index-service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLED_INDEX_PATH = join(ROOT, 'data', 'medical-codes.db');

let ready = false;

/** Point the service at the immutable shipped database and initialize it once. */
export async function ensureBundledIndex(): Promise<ReturnType<typeof getCodeIndexService>> {
  if (!ready) {
    process.env.MEDCODE_DB_PATH = BUNDLED_INDEX_PATH;
    await initCodeIndexService();
    ready = true;
  }
  return getCodeIndexService();
}

type RawQuery = (sql: string, params: unknown[]) => unknown[];
let rawQuery: RawQuery | undefined;

/**
 * Rows read straight from the shipped database, bypassing the service: the
 * independent enumeration a derived result is checked against. Opens read-only
 * through the driver the runtime provides, as the service does, so it runs on
 * both the Bun and the Node test lanes.
 */
export async function bundledRows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  if (!rawQuery) {
    if (runtimeCaps.isBun) {
      const BUN_SQLITE = 'bun:sqlite';
      const { Database } = (await import(BUN_SQLITE)) as {
        Database: new (
          path: string,
          opts: { readonly: boolean },
        ) => { query(sql: string): { all(...p: unknown[]): unknown[] } };
      };
      const db = new Database(BUNDLED_INDEX_PATH, { readonly: true });
      rawQuery = (sql, p) => db.query(sql).all(...p);
    } else {
      const BETTER_SQLITE3 = 'better-sqlite3';
      const { default: Database } = (await import(BETTER_SQLITE3)) as {
        default: new (
          path: string,
          opts: object,
        ) => { prepare(sql: string): { all(...p: unknown[]): unknown[] } };
      };
      const db = new Database(BUNDLED_INDEX_PATH, { readonly: true, fileMustExist: true });
      rawQuery = (sql, p) => db.prepare(sql).all(...p);
    }
  }
  return rawQuery(sql, params) as T[];
}
