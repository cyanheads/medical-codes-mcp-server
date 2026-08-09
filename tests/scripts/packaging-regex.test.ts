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
import {
  AGENT_DOC_ENTRY as CHECK_AGENT_DOC,
  NATIVE_BINDING_ENTRY as CHECK_NATIVE_BINDING,
} from '../../scripts/lint-packaging.ts';

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
