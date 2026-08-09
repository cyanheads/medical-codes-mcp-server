/**
 * @fileoverview Test helper that opens the shipped medical-code index rather
 * than the small synthetic fixture. Used only by smoke and integration suites.
 * @module tests/helpers/bundled-index
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
