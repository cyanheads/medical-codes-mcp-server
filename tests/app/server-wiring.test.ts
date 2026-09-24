/**
 * @fileoverview What `src/index.ts` hands `createApp()`. Three of those options
 * are decisions rather than plumbing, and none of them is observable from a tool
 * call, so they are asserted here against the entry point itself:
 *
 *  - `sessionMode: 'stateless'` — the HTTP session posture declared in `src/`
 *    rather than left to a deployment's `MCP_SESSION_MODE`. It is correct here
 *    only because no handler calls `ctx.requestInput`: every tool answers from
 *    the bundled index in one round, so there is no mid-handler prompt a
 *    stateless connection could fail to carry.
 *  - `setup()` / `teardown()` — the open/close pair for the read-only SQLite
 *    handle. `setup()` was already load-bearing; `teardown()` is what releases
 *    the handle on shutdown, and an unwired one is invisible until a long-lived
 *    process leaks it.
 *  - the six `medcode_*` tools, which are the whole advertised surface.
 *
 * `createApp` is mocked so importing the entry point captures its options
 * without standing up a transport; everything else in the framework barrel is
 * the real module, so the tool definitions build exactly as they do in
 * production.
 * @module tests/app/server-wiring.test
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

const { createAppMock } = vi.hoisted(() => ({ createAppMock: vi.fn() }));

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core')>();
  return { ...actual, createApp: createAppMock };
});

interface AppOptions {
  name: string;
  sessionMode?: string;
  setup?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
  title: string;
  tools: { name: string; title?: string }[];
}

let options: AppOptions;

beforeAll(async () => {
  createAppMock.mockResolvedValue({});
  // No override — the entry point's setup() must find the packaged bundle the
  // same way a published install does.
  delete process.env.MEDCODE_DB_PATH;
  await import('@/index.js');

  expect(createAppMock).toHaveBeenCalledTimes(1);
  options = createAppMock.mock.calls[0]?.[0] as AppOptions;
});

describe('createApp() wiring', () => {
  it('declares the stateless HTTP session posture in src/', () => {
    expect(options.sessionMode).toBe('stateless');
  });

  it('carries the hyphenated repo name on both identity fields', () => {
    expect(options.name).toBe('medical-codes-mcp-server');
    expect(options.title).toBe('medical-codes-mcp-server');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/41
  it('gives each tool its own UI title, distinct from the server identity', () => {
    // `title` on a tool is the row a client lists it under; the hyphenated repo
    // name belongs to createApp() alone, so six tools sharing it read as one.
    expect(Object.fromEntries(options.tools.map((t) => [t.name, t.title]))).toEqual({
      medcode_get_code: 'Get Medical Code',
      medcode_search_codes: 'Search Medical Codes',
      medcode_check_code: 'Check Medical Code',
      medcode_map_codes: 'Map Medical Codes',
      medcode_browse_hierarchy: 'Browse Code Hierarchy',
      medcode_list_systems: 'List Code Systems',
    });
  });

  it('registers the six medcode_* tools', () => {
    expect(options.tools.map((t) => t.name).sort()).toEqual([
      'medcode_browse_hierarchy',
      'medcode_check_code',
      'medcode_get_code',
      'medcode_list_systems',
      'medcode_map_codes',
      'medcode_search_codes',
    ]);
  });

  it('opens the index in setup() and closes it in teardown()', async () => {
    const { getCodeIndexService } = await import('@/services/code-index/code-index-service.js');

    expect(() => getCodeIndexService()).toThrow(/not initialized/i);

    await options.setup?.();
    expect(
      getCodeIndexService()
        .listSystems()
        .map((s) => s.system),
    ).toContain('ICD10CM');

    await options.teardown?.();
    expect(() => getCodeIndexService()).toThrow(/not initialized/i);
  });
});
