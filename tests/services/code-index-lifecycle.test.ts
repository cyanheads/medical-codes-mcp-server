/**
 * @fileoverview Startup contract of the code-index service: the accessor guard
 * before `setup()` runs, the fail-fast on a missing bundle, and the default
 * bundled path when no override is set. (The Node/`better-sqlite3` driver arm is
 * not exercised here — the Vitest workers run under Bun, where loading that
 * native addon aborts the process.)
 *
 * Each case needs its own module registry — the service caches the open handle and
 * the config caches the resolved env — so every test resets modules and imports
 * fresh rather than sharing a singleton.
 * @module tests/services/code-index-lifecycle.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_DB_PATH = process.env.MEDCODE_DB_PATH;

afterEach(() => {
  if (ORIGINAL_DB_PATH === undefined) delete process.env.MEDCODE_DB_PATH;
  else process.env.MEDCODE_DB_PATH = ORIGINAL_DB_PATH;
  vi.resetModules();
});

describe('CodeIndexService lifecycle', () => {
  it('refuses to hand out a service before setup() has opened the index', async () => {
    vi.resetModules();
    const { getCodeIndexService } = await import('@/services/code-index/code-index-service.js');
    expect(() => getCodeIndexService()).toThrow(/not initialized/i);
  });

  it('fails fast with the configured path when the bundle is missing', async () => {
    vi.resetModules();
    process.env.MEDCODE_DB_PATH = '/nonexistent/medical-codes-does-not-exist.db';
    const { CodeIndexService } = await import('@/services/code-index/code-index-service.js');
    await expect(CodeIndexService.open()).rejects.toThrow(
      /medical-codes-does-not-exist\.db|not found/,
    );
  });

  it.each([
    ['an empty override', ''],
    ['an unsubstituted MCPB placeholder', `\${user_config.db_path}`],
  ])('treats %s as no override at all', async (_label, value) => {
    vi.resetModules();
    process.env.MEDCODE_DB_PATH = value;
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig().dbPath).toBeUndefined();

    // …and the service still opens the packaged bundle rather than an empty path.
    const { CodeIndexService } = await import('@/services/code-index/code-index-service.js');
    const svc = await CodeIndexService.open();
    expect(svc.dbPath).toMatch(/data\/medical-codes\.db$/);
  });

  it('falls back to the packaged data/ path when no override is set', async () => {
    vi.resetModules();
    delete process.env.MEDCODE_DB_PATH;
    const { CodeIndexService } = await import('@/services/code-index/code-index-service.js');
    const svc = await CodeIndexService.open();
    expect(svc.dbPath).toMatch(/data\/medical-codes\.db$/);
    expect(svc.listSystems().map((s) => s.system)).toContain('ICD10CM');
  });
});
