/**
 * @fileoverview The tool-input strictness contract. Every `medcode_*` input
 * object is strict at its root: an argument key the schema does not declare is
 * rejected by name before the handler runs, rather than silently stripped, and
 * `inputSchema` advertises `additionalProperties: false` so a client can see the
 * rule before it calls. A misspelled filter used to run as an unfiltered query
 * and return plausible wrong results; now it fails loudly and names the key.
 *
 * Asserted on both consumption surfaces — `structuredContent.error` (Claude
 * Code) and the rendered `content[]` text (Claude Desktop) — because a client
 * that reads only one of them must still learn which key was rejected.
 * @module tests/tools/strict-inputs.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { listSystemsTool } from '@/mcp-server/tools/definitions/list-systems.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import { ensureIndex } from '../helpers/index-fixture.ts';

/** Flatten format() blocks into the text a content-only client would receive. */
function textOf(blocks: unknown): string {
  return (blocks as { text?: string; type: string }[])
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n');
}

/**
 * `runToolContract` types its `input` as the tool's own parsed input, so an
 * argument set the schema rejects cannot be expressed at that signature at all.
 * These tests exist precisely to send one, so the cast is confined here — every
 * call below hands the runner a raw argument bag and asserts on what comes back,
 * which is what a client on the wire actually does.
 */
const callWithRawArgs = runToolContract as unknown as (
  tool: unknown,
  args: Record<string, unknown>,
) => ReturnType<typeof runToolContract>;

/**
 * Every tool paired with a valid call and the undeclared key to bolt onto it.
 * The keys are the realistic failure: a near-miss of a real parameter
 * (`sytem`/`systems`), or a parameter borrowed from a sibling tool
 * (`medcode_search_codes` has `query`, `medcode_map_codes` does not).
 */
const CASES: {
  badKey: string;
  tool: { input: z.ZodType; name: string };
  valid: Record<string, unknown>;
}[] = [
  { tool: getCodeTool, valid: { codes: ['E11.9'] }, badKey: 'systems' },
  { tool: searchCodesTool, valid: { query: 'cholera' }, badKey: 'billable' },
  { tool: checkCodeTool, valid: { code: 'E11.9' }, badKey: 'sytem' },
  { tool: mapCodesTool, valid: { from: 'E11.9', direction: 'parents' }, badKey: 'query' },
  { tool: browseHierarchyTool, valid: { system: 'ICD10CM' }, badKey: 'chapter' },
  { tool: listSystemsTool, valid: {}, badKey: 'system' },
];

beforeAll(async () => {
  await ensureIndex();
});

describe('medcode_* input strictness', () => {
  for (const { tool, valid, badKey } of CASES) {
    describe(tool.name, () => {
      it('advertises additionalProperties: false on its input schema', () => {
        const schema = z.toJSONSchema(tool.input, { io: 'input' }) as {
          additionalProperties?: unknown;
        };
        expect(schema.additionalProperties).toBe(false);
      });

      it('rejects an undeclared argument key by name on both surfaces', async () => {
        const result = await callWithRawArgs(tool, { ...valid, [badKey]: 'ICD10CM' });

        expect(result.isError).toBe(true);
        // The key is named, not merely counted — a caller that misspelled one
        // argument has to be able to tell which one from the failure alone.
        // An argument rejection is InvalidParams (-32602), not ValidationError:
        // the call never reaches the handler, so nothing this server validated
        // failed. The envelope is asserted by containment, not byte-exactly —
        // the framework appends the recovery hint and the reason trailer to the
        // rendered text, and both grow as it refines the wording.
        expect(result.structuredContent).toMatchObject({
          error: {
            code: -32602,
            message: expect.stringContaining(badKey),
            data: {
              reason: 'invalid_arguments',
              recovery: { hint: expect.stringContaining(badKey) },
            },
          },
        });
        const text = textOf(result.content);
        expect(text).toContain(badKey);
        expect(text).toContain('Recovery:');
        expect(text).toContain('(reason invalid_arguments)');
      });

      it('accepts the same call once the undeclared key is dropped', async () => {
        const result = await callWithRawArgs(tool, valid);
        expect(result.isError).toBeFalsy();
      });
    });
  }

  it('names every undeclared key when a call carries more than one', async () => {
    const result = await callWithRawArgs(searchCodesTool, {
      query: 'cholera',
      billable: true,
      maxResults: 10,
    });

    expect(result.isError).toBe(true);
    const message = (result.structuredContent as { error: { message: string } }).error.message;
    expect(message).toContain('billable');
    expect(message).toContain('maxResults');
  });
});

/**
 * The one carve-out in the strict root. Clients attach their own bookkeeping to
 * a tool call, and a caller cannot drop what its host adds, so a strict schema
 * that rejected those keys would fail calls whose arguments were correct. The
 * carve-out is a fixed list plus an underscore heuristic — not a general
 * loosening — so the tests below pin both halves: what rides through, and that
 * an ordinary undeclared key alongside it still fails by name.
 */
describe('client bookkeeping keys', () => {
  /** The named list, plus one key the underscore heuristic has to catch. */
  const BOOKKEEPING = {
    _meta: { progressToken: 'p-1' },
    tool_call_description: 'Check whether E11.9 is billable',
    toolCallId: 'call_01',
    _clientTrace: 'trace-1',
  };

  it('ride through the strict root instead of being rejected by name', async () => {
    const result = await callWithRawArgs(checkCodeTool, { code: 'E11.9', ...BOOKKEEPING });

    expect(result.isError).toBeFalsy();
    // The call answered normally — the keys were dropped before the parse, not
    // carried into the handler as arguments.
    expect(result.structuredContent).toMatchObject({ code: 'E11.9', system: 'ICD10CM' });
  });

  it('do not license an ordinary undeclared key sent alongside them', async () => {
    const result = await callWithRawArgs(checkCodeTool, {
      code: 'E11.9',
      ...BOOKKEEPING,
      sytem: 'ICD10CM',
    });

    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as { error: { code: number; message: string } };
    expect(envelope.error.code).toBe(-32602);
    expect(envelope.error.message).toContain('sytem');
    // Only the misspelling is named — a dropped bookkeeping key is not an error
    // to report back.
    expect(envelope.error.message).not.toContain('toolCallId');
  });
});
