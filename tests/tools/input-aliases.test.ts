/**
 * @fileoverview Argument-key normalization, the stage that runs between the wire
 * and the Zod parse. An undeclared root key whose case-folded form (`-`/`_`
 * stripped, lowercased) names exactly one declared key is rewritten to it, so a
 * caller that reached for `billable_only` gets the `billableOnly` filter it meant
 * instead of a rejection it has to guess its way out of.
 *
 * This is deliberately narrow, and the boundaries are the point:
 *
 *  - it rewrites only when the declared key is ABSENT — a call that sends both
 *    keeps the declared value and the leftover alias is rejected by name, since
 *    the two could disagree and nothing can decide which the caller meant;
 *  - it never invents a target: a key that folds to no declared key, or that is
 *    simply a misspelling, still fails loudly;
 *  - `inputSchema` is byte-identical either way, so the advertised contract stays
 *    the declared spelling and no client learns to send the alias.
 * @module tests/tools/input-aliases.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import { ensureIndex } from '../helpers/index-fixture.ts';

/**
 * An alias is undeclared by construction, so it cannot be expressed at
 * `runToolContract`'s typed `input`. The cast is confined here — every call
 * hands the runner a raw argument bag, which is what a client sends.
 */
const callWithRawArgs = runToolContract as unknown as (
  tool: unknown,
  args: Record<string, unknown>,
) => ReturnType<typeof runToolContract>;

beforeAll(async () => {
  await ensureIndex();
});

describe('argument-key normalization', () => {
  it('applies a snake_case alias of a declared camelCase filter', async () => {
    const aliased = await callWithRawArgs(searchCodesTool, {
      query: 'cholera',
      billable_only: true,
    });
    const declared = await callWithRawArgs(searchCodesTool, {
      query: 'cholera',
      billableOnly: true,
    });

    expect(aliased.isError).toBeFalsy();
    // The filter actually ran: the echoed appliedFilters and the returned rows
    // match the declared-spelling call exactly, rather than the unfiltered set.
    expect(aliased.structuredContent).toEqual(declared.structuredContent);
    expect(
      (aliased.structuredContent as { appliedFilters: { billableOnly: boolean } }).appliedFilters
        .billableOnly,
    ).toBe(true);
  });

  it('carries the alias through to a flag that changes the returned shape', async () => {
    const aliased = await callWithRawArgs(getCodeTool, {
      codes: ['A00.0'],
      include_hierarchy: true,
    });

    expect(aliased.isError).toBeFalsy();
    const [found] = (aliased.structuredContent as { found: Record<string, unknown>[] }).found;
    // `parent` / `children` / `childrenTruncated` are present only when the flag
    // was honored — the plain lookup omits all three.
    expect(found).toMatchObject({ code: 'A00.0', parent: 'A00', childrenTruncated: false });
    expect(found?.children).toEqual([]);
  });

  it('keeps the declared key when a call sends both, and rejects the leftover alias', async () => {
    const result = await callWithRawArgs(searchCodesTool, {
      query: 'cholera',
      billableOnly: false,
      billable_only: true,
    });

    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as {
      error: { code: number; data?: { reason?: string }; message: string };
    };
    expect(envelope.error.code).toBe(-32602);
    expect(envelope.error.data?.reason).toBe('invalid_arguments');
    expect(envelope.error.message).toContain('billable_only');
  });

  it('still rejects a misspelling that folds to no declared key', async () => {
    const result = await callWithRawArgs(searchCodesTool, { query: 'cholera', billble_only: true });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32602, message: expect.stringContaining('billble_only') },
    });
  });

  it('advertises only the declared spelling — no alias reaches inputSchema', () => {
    const schema = z.toJSONSchema(searchCodesTool.input, { io: 'input' }) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties)).toContain('billableOnly');
    expect(Object.keys(schema.properties)).not.toContain('billable_only');
  });
});
