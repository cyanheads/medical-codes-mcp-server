/**
 * @fileoverview Test helper: build a small synthetic fixture DB and initialize
 * the code-index service against it once for the whole run.
 *
 * The fixture is deliberately SEPARATE from the real bundled corpus the package
 * ships (`data/medical-codes.db`, baked from the federal source files by
 * scripts/build-index.ts). Tests assert on hand-curated rows (specific billable
 * flags, a terminated HCPCS code, complete parent chains, a handful of
 * top-level categories) that only the fixture guarantees — the real corpus has
 * ~187k rows where, e.g., `browse('ICD10CM')` capped at 50 returns A00-range
 * codes, not E11. So the helper writes the fixture to its own path under
 * `tests/fixtures/` and points `MEDCODE_DB_PATH` at it, leaving the shipped real
 * DB untouched.
 * @module tests/helpers/index-fixture
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getCodeIndexService,
  initCodeIndexService,
} from '@/services/code-index/code-index-service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_PATH = join(ROOT, 'tests', 'fixtures', 'medical-codes.fixture.db');

let ready = false;

/** Build the fixture DB if missing, point the service at it, and init once. */
export async function ensureIndex(): Promise<ReturnType<typeof getCodeIndexService>> {
  if (!ready) {
    // Must be set before the service first reads getServerConfig() (lazy-cached).
    process.env.MEDCODE_DB_PATH = FIXTURE_PATH;
    if (!existsSync(FIXTURE_PATH)) {
      mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
      execFileSync('bun', ['run', join(ROOT, 'scripts', 'build-fixture-db.ts'), FIXTURE_PATH], {
        cwd: ROOT,
        stdio: 'ignore',
      });
    }
    await initCodeIndexService();
    ready = true;
  }
  return getCodeIndexService();
}
