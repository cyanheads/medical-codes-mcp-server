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
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getCodeIndexService,
  initCodeIndexService,
} from '@/services/code-index/code-index-service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_PATH = join(ROOT, 'tests', 'fixtures', 'medical-codes.fixture.db');
const BUILDER_PATH = join(ROOT, 'scripts', 'build-fixture-db.ts');

/**
 * Refuse to run against a fixture built before the script that defines its rows.
 * The DB is gitignored and built on demand, so a working copy can hold one built
 * before a row was added — and an existence check alone keeps serving it, failing
 * whichever tests assert on the new row for a reason nothing in the diff explains.
 *
 * This reports rather than rebuilds, deliberately. Vitest runs its projects in
 * parallel workers that each reach this helper, and replacing the file underneath
 * them is not safe at any granularity: an in-place rebuild unlinks the path a
 * sibling is about to open, and swapping a freshly built copy in by atomic rename
 * makes SQLite fail an already-open connection with `disk I/O error` when it
 * notices the file changed identity. A rebuild has to happen before any worker
 * opens the DB, which this helper — running inside the workers — cannot do.
 */
function assertFixtureCurrent(): void {
  if (!existsSync(FIXTURE_PATH)) return;
  if (statSync(BUILDER_PATH).mtimeMs <= statSync(FIXTURE_PATH).mtimeMs) return;
  throw new Error(
    `The cached test fixture at ${FIXTURE_PATH} is older than scripts/build-fixture-db.ts, ` +
      'so it is missing rows the tests expect. Delete it and re-run — it is gitignored and ' +
      'rebuilt automatically when absent.',
  );
}

/**
 * Build the fixture, publishing it so that concurrent builders cannot disturb each
 * other. Vitest's projects run in parallel workers that all reach this helper, so
 * on a cold checkout several of them build at once; letting the builder write the
 * shared path directly means one worker unlinks and rewrites the file a sibling is
 * reading, which surfaces as `disk I/O error` and `vtable constructor failed:
 * codes_fts` from whichever suites lost the race.
 *
 * So each worker builds to a private scratch path and publishes with `linkSync`,
 * which fails with EEXIST rather than overwriting. The first worker to finish wins
 * and every other one discards its identical copy — the published inode is created
 * once and never replaced, which is the part that matters: swapping a new file over
 * the path (even atomically, by rename) makes SQLite fail connections that are
 * already open on the old one.
 */
function buildFixture(): void {
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  const scratch = `${FIXTURE_PATH}.${randomUUID()}.tmp`;
  try {
    execFileSync('bun', ['run', BUILDER_PATH, scratch], { cwd: ROOT, stdio: 'ignore' });
    try {
      linkSync(scratch, FIXTURE_PATH);
    } catch (error) {
      // EEXIST — a sibling worker published first. Its build is byte-identical
      // input to ours, so adopt it; anything else is a real filesystem failure.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    rmSync(scratch, { force: true });
  }
}

let ready = false;

/** Build the fixture DB if missing, point the service at it, and init once. */
export async function ensureIndex(): Promise<ReturnType<typeof getCodeIndexService>> {
  if (!ready) {
    // Must be set before the service first reads getServerConfig() (lazy-cached).
    process.env.MEDCODE_DB_PATH = FIXTURE_PATH;
    assertFixtureCurrent();
    if (!existsSync(FIXTURE_PATH)) buildFixture();
    await initCodeIndexService();
    ready = true;
  }
  return getCodeIndexService();
}
