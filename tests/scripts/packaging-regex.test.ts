/**
 * @fileoverview The bundle-entry patterns are declared twice on purpose — once
 * in the strip step (`scripts/clean-mcpb.ts`) and once in the post-bundle check
 * that verifies the strip worked (`scripts/lint-packaging.ts`). Neither imports
 * the other, so nothing but this test stops them from drifting apart into a
 * check that passes over entries the strip never removed.
 * @module tests/scripts/packaging-regex.test
 */

import { describe, expect, it } from 'vitest';

import {
  filterAgentDocEntries,
  filterNativeBindingEntries,
  AGENT_DOC_ENTRY as STRIP_AGENT_DOC,
  NATIVE_BINDING_ENTRY as STRIP_NATIVE_BINDING,
} from '../../scripts/clean-mcpb.ts';

/**
 * `lint-packaging.ts` is loaded by URL at run time so `tsc` never follows it:
 * the framework copy carries a repo-only `import('../src/mcp-server/skills.js')`
 * fallback that does not resolve in a server (mcp-ts-core#797).
 */
const LINT_PACKAGING_URL = new URL('../../scripts/lint-packaging.ts', import.meta.url).href;
const { AGENT_DOC_ENTRY: CHECK_AGENT_DOC, NATIVE_BINDING_ENTRY: CHECK_NATIVE_BINDING } =
  (await import(LINT_PACKAGING_URL)) as { AGENT_DOC_ENTRY: RegExp; NATIVE_BINDING_ENTRY: RegExp };

describe('bundle-entry patterns stay in sync across the two scripts', () => {
  it('declares the same agent-doc pattern in the strip and the check', () => {
    expect(CHECK_AGENT_DOC.source).toBe(STRIP_AGENT_DOC.source);
    expect(CHECK_AGENT_DOC.flags).toBe(STRIP_AGENT_DOC.flags);
  });

  it('declares the same native-binding pattern in the strip and the check', () => {
    expect(CHECK_NATIVE_BINDING.source).toBe(STRIP_NATIVE_BINDING.source);
    expect(CHECK_NATIVE_BINDING.flags).toBe(STRIP_NATIVE_BINDING.flags);
  });

  it('matches the entry shapes each pattern exists to catch', () => {
    expect(filterAgentDocEntries(['node_modules/pkg/skills/x.md'])).toHaveLength(1);
    expect(filterAgentDocEntries(['src/skills/x.md'])).toHaveLength(0);
    expect(
      filterNativeBindingEntries(['node_modules/@duckdb/node-bindings-darwin-arm64/x.node']),
    ).toHaveLength(1);
    expect(filterNativeBindingEntries(['node_modules/@duckdb/node-api/index.js'])).toHaveLength(0);
  });
});

describe('agent-doc strip is anchored to package roots', () => {
  // The MCP SDK imports these at startup; stripping them kills the bundle at boot (mcp-ts-core#794).
  it.each([
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/node.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.cjs',
    'node_modules/pkg/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
    'node_modules/@scope/skills/index.js',
  ])('keeps runtime module %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(CHECK_AGENT_DOC.test(entry)).toBe(false);
  });

  it.each([
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
    'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
    'node_modules/dotenv/skills/dotenv/SKILL.md',
    'node_modules/dotenv/skills/dotenvx/README.md',
    'node_modules/@scope/pkg/skills/x/SKILL.md',
    'node_modules/pkg/.claude/settings.json',
    'node_modules/pkg/.agents/skills/x/SKILL.md',
    'node_modules/pkg/node_modules/inner/skills/x/SKILL.md',
    'node_modules/pkg/node_modules/@scope/inner/.agents/notes.md',
    'node_modules/pkg/docs/SKILL.md',
  ])('strips package-root agent doc %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(CHECK_AGENT_DOC.test(entry)).toBe(true);
  });
});
