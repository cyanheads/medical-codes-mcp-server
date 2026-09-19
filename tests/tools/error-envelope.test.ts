/**
 * @fileoverview The error envelope every `medcode_*` failure lands on, asserted
 * on both consumption surfaces — `structuredContent.error` (Claude Code) and the
 * rendered `content[]` text (Claude Desktop).
 *
 * Two classes of failure reach a caller, and they are not interchangeable:
 *
 *  - an **argument rejection**, which never reaches the handler, is
 *    `InvalidParams` (-32602) with `data.reason: 'invalid_arguments'` and a hint
 *    synthesized from the Zod issues and the root schema;
 *  - a **handler-thrown** `ctx.fail`, which carries the tool's own declared
 *    reason, its declared code, and the `recovery` text from the same contract
 *    entry — the `errors[]` block is the single source of both.
 *
 * Both surfaces close with a `(reason <reason>)` trailer so a content-only
 * client can branch on the same discriminator `structuredContent` carries.
 * Assertions are containment, never byte-exact: the framework owns the exact
 * sentence and refines it between releases, and pinning it back would trade a
 * real contract for a string compare.
 * @module tests/tools/error-envelope.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { ensureIndex } from '../helpers/index-fixture.ts';

/** Flatten format() blocks into the text a content-only client would receive. */
function textOf(blocks: unknown): string {
  return (blocks as { text?: string; type: string }[])
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n');
}

interface ErrorEnvelope {
  error: {
    code: number;
    data?: { reason?: string; recovery?: { hint?: string } };
    message: string;
  };
}

/**
 * `runToolContract` types its `input` as the tool's own parsed input, so an
 * argument set the schema rejects cannot be expressed at that signature. The
 * argument-rejection cases below send exactly that, which is what a client on
 * the wire does, so the cast is confined here.
 */
const callWithRawArgs = runToolContract as unknown as (
  tool: unknown,
  args: Record<string, unknown>,
) => ReturnType<typeof runToolContract>;

/** A code string the fixture holds in no system, in no system's shape. */
const ABSENT = 'ZZZZZZ9';
/** A code string the fixture holds in BOTH ICD-10-CM (A01.00) and HCPCS. */
const COLLIDING = 'A0100';

beforeAll(async () => {
  await ensureIndex();
});

describe('handler-thrown failures', () => {
  /**
   * Every declared reason, paired with a call that reaches it. The expected code
   * is read off the tool's own contract rather than restated, so a contract edit
   * that changes a code fails here instead of silently drifting from the test.
   */
  const CASES: {
    args: Record<string, unknown>;
    reason: string;
    tool: { errors?: readonly { code: number; reason: string; recovery: string }[]; name: string };
  }[] = [
    { tool: checkCodeTool, args: { code: ABSENT }, reason: 'unknown_code' },
    { tool: checkCodeTool, args: { code: COLLIDING }, reason: 'ambiguous_system' },
    { tool: getCodeTool, args: { codes: [ABSENT] }, reason: 'no_codes_found' },
    { tool: mapCodesTool, args: { from: ABSENT, direction: 'parents' }, reason: 'no_mapping' },
    {
      tool: mapCodesTool,
      args: { from: COLLIDING, direction: 'children' },
      reason: 'ambiguous_system',
    },
    {
      tool: browseHierarchyTool,
      args: { system: 'ICD10CM', node: ABSENT },
      reason: 'unknown_node',
    },
  ];

  for (const { tool, args, reason } of CASES) {
    it(`${tool.name} surfaces ${reason} with its declared code and recovery on both surfaces`, async () => {
      const declared = tool.errors?.find((entry) => entry.reason === reason);
      expect(declared, `${tool.name} declares no errors[] entry for ${reason}`).toBeDefined();

      const result = await callWithRawArgs(tool, args);
      expect(result.isError).toBe(true);

      const envelope = result.structuredContent as ErrorEnvelope;
      expect(envelope.error.code).toBe(declared?.code);
      expect(envelope.error.data?.reason).toBe(reason);
      // The declared `recovery` is what reaches the wire — a ctx.fail site that
      // forgot to forward ctx.recoveryFor() would leave this undefined.
      expect(envelope.error.data?.recovery?.hint).toBe(declared?.recovery);

      const text = textOf(result.content);
      expect(text).toContain(declared?.recovery);
      expect(text).toContain(`(reason ${reason})`);
    });
  }

  it('names the colliding systems so the caller can re-call with one', async () => {
    const result = await callWithRawArgs(checkCodeTool, { code: COLLIDING });
    const envelope = result.structuredContent as ErrorEnvelope & {
      error: { data?: { candidateSystems?: string[] } };
    };
    expect(envelope.error.data?.candidateSystems).toEqual(
      expect.arrayContaining(['ICD10CM', 'HCPCS']),
    );
    expect(envelope.error.message).toContain(COLLIDING);
  });
});

describe('argument rejections', () => {
  it('reports an omitted required field as missing, not as a wrong value', async () => {
    const result = await callWithRawArgs(checkCodeTool, {});

    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as ErrorEnvelope;
    expect(envelope.error.code).toBe(-32602);
    expect(envelope.error.data?.reason).toBe('invalid_arguments');
    expect(envelope.error.message).toContain('code');
    // The synthesized hint collapses missing fields into one instruction.
    expect(envelope.error.data?.recovery?.hint).toContain('code');
    expect(textOf(result.content)).toContain('(reason invalid_arguments)');
  });

  it('names the accepted values when an enum field is sent one outside the set', async () => {
    const result = await callWithRawArgs(checkCodeTool, { code: 'E11.9', system: 'SNOMED' });

    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as ErrorEnvelope;
    expect(envelope.error.code).toBe(-32602);
    expect(envelope.error.data?.reason).toBe('invalid_arguments');
    for (const accepted of ['ICD10CM', 'ICD10PCS', 'HCPCS', 'RXNORM']) {
      expect(envelope.error.message).toContain(accepted);
    }
    expect(textOf(result.content)).toContain('ICD10CM');
  });

  it('rejects a value that violates a declared bound', async () => {
    const result = await callWithRawArgs(getCodeTool, { codes: [] });

    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as ErrorEnvelope;
    expect(envelope.error.code).toBe(-32602);
    expect(envelope.error.data?.reason).toBe('invalid_arguments');
    expect(envelope.error.message).toContain('codes');
  });
});
