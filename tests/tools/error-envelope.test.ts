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
import { readCommonMark } from '../helpers/commonmark.ts';
import { ensureIndex } from '../helpers/index-fixture.ts';

/**
 * The text blocks of an error result as a content-only client renders them. The
 * framework Markdown-escapes the message, hint, and reason, so the parse reads
 * them back exactly as `structuredContent.error` carries them.
 */
function textOf(blocks: unknown): string {
  return readCommonMark(
    (blocks as { text?: string; type: string }[])
      .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
      .join('\n'),
  );
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
    // https://github.com/cyanheads/medical-codes-mcp-server/issues/58
    { tool: getCodeTool, args: { codes: [COLLIDING] }, reason: 'ambiguous_system' },
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
    {
      tool: mapCodesTool,
      args: { from: '11111-2222-33', direction: 'ndc_to_rxcui', limit: 1 },
      reason: 'field_not_applicable',
    },
    // https://github.com/cyanheads/medical-codes-mcp-server/issues/34
    {
      tool: mapCodesTool,
      args: { from: 'E11.9', direction: 'parents', classType: 'EPC' },
      reason: 'field_not_applicable',
    },
    {
      tool: mapCodesTool,
      args: { from: ABSENT, direction: 'rxcui_to_classes' },
      reason: 'no_mapping',
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
      // The declared `recovery` is what reaches the wire when the throw site
      // carries no hint of its own — the framework fills it from the contract.
      expect(envelope.error.data?.recovery?.hint).toBe(declared?.recovery);

      const text = textOf(result.content);
      expect(text).toContain(declared?.recovery);
      expect(text).toContain(`(reason ${reason})`);
    });
  }

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/63
  it('names fields as plain text in every declared recovery and handler message', async () => {
    // The framework escapes error text into content[], so a backtick a handler
    // writes reaches both surfaces as a literal backtick, never a code span.
    for (const tool of [checkCodeTool, getCodeTool, mapCodesTool, browseHierarchyTool]) {
      for (const entry of tool.errors ?? []) expect(entry.recovery, tool.name).not.toContain('`');
    }
    for (const [tool, args] of [
      [getCodeTool, { codes: ['161'], system: 'ICD10CM' }],
      [getCodeTool, { codes: ['A0100', 'ZZZZZZ9'] }],
      [getCodeTool, { codes: ['11111222233'], system: 'RXNORM' }],
      [mapCodesTool, { from: 'ICD10CM', direction: 'parents' }],
      [mapCodesTool, { from: 'ICD10CM', direction: 'rxcui_to_ndc' }],
      [mapCodesTool, { from: 'epc', direction: 'class_to_rxcuis' }],
      [mapCodesTool, { from: 'E11.9', direction: 'parents', system: 'HCPCS' }],
      [mapCodesTool, { from: COLLIDING, direction: 'rxcui_to_classes' }],
      [mapCodesTool, { from: 'E11.9', direction: 'parents', classType: 'EPC', limit: 1 }],
    ] as const) {
      const { error } = (await callWithRawArgs(tool, args)).structuredContent as ErrorEnvelope;
      expect(error.message, JSON.stringify(args)).not.toContain('`');
      expect(error.data?.recovery?.hint ?? '', JSON.stringify(args)).not.toContain('`');
    }
    const partial = await callWithRawArgs(getCodeTool, {
      codes: ['E11.9', COLLIDING, '11111222233', '161'],
      system: 'ICD10CM',
    });
    const { notFound } = partial.structuredContent as { notFound: { reason: string }[] };
    expect(notFound.length).toBeGreaterThan(0);
    for (const miss of notFound) expect(miss.reason).not.toContain('`');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/38
  // https://github.com/cyanheads/medical-codes-mcp-server/issues/39
  it.each([
    [{ from: '43239', direction: 'parents' }, 'medcode_search_codes'],
    [{ from: 'ICD10CM', direction: 'children' }, 'medcode_browse_hierarchy'],
    // https://github.com/cyanheads/medical-codes-mcp-server/issues/50
    [{ from: '11-1112-22233', direction: 'ndc_to_rxcui' }, 'name_to_rxcui'],
    [{ from: '99999-8888-77', direction: 'ndc_to_rxcui' }, 'name_to_rxcui'],
    // https://github.com/cyanheads/medical-codes-mcp-server/issues/34
    [{ from: 'N9999999999', direction: 'class_to_rxcuis' }, 'rxcui_to_classes'],
    [{ from: 'N0000008836', direction: 'rxcui_to_classes' }, 'class_to_rxcuis'],
    // https://github.com/cyanheads/medical-codes-mcp-server/issues/56
    [
      { from: 'ICD10CM', direction: 'rxcui_to_ingredients' },
      'takes an RXCUI on rxcui_to_ingredients',
    ],
    [{ from: 'ICD10CM', direction: 'name_to_rxcui' }, 'takes a drug name on name_to_rxcui'],
    [{ from: 'ICD10CM', direction: 'ndc_to_rxcui' }, 'takes an NDC on ndc_to_rxcui'],
    // https://github.com/cyanheads/medical-codes-mcp-server/issues/62
    [{ from: COLLIDING, direction: 'rxcui_to_classes' }, 'system "ICD10CM" or "HCPCS"'],
  ])('replaces the declared no_mapping recovery for %j on both surfaces', async (args, names) => {
    const declared = mapCodesTool.errors?.find((entry) => entry.reason === 'no_mapping');
    const result = await callWithRawArgs(mapCodesTool, args);
    const envelope = result.structuredContent as ErrorEnvelope;
    expect(envelope.error.code).toBe(declared?.code);
    expect(envelope.error.data?.reason).toBe('no_mapping');

    const hint = envelope.error.data?.recovery?.hint ?? '';
    expect(hint).toContain(names);
    expect(hint).not.toBe(declared?.recovery);

    const text = textOf(result.content);
    expect(text).toContain(hint);
    expect(text).not.toContain(declared?.recovery);
    expect(text).toContain('(reason no_mapping)');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/49
  it.each([
    [{ codes: ['161'], system: 'ICD10CM' }, 'ICD-10-CM', '"161" (RxNorm)'],
    [{ codes: ['E11.9'], system: 'HCPCS' }, 'HCPCS Level II', '"E11.9" (ICD-10-CM)'],
  ])(
    'names the named system and the holder for %j on both surfaces',
    async (args, named, holder) => {
      const declared = getCodeTool.errors?.find((entry) => entry.reason === 'no_codes_found');
      const result = await callWithRawArgs(getCodeTool, args);
      const envelope = result.structuredContent as ErrorEnvelope;
      expect(envelope.error.data?.reason).toBe('no_codes_found');
      expect(envelope.error.message).toContain(`resolved in ${named}, the system this call named`);
      expect(envelope.error.message).toContain(holder);
      expect(envelope.error.message).not.toContain('any bundled system');
      expect(envelope.error.data?.recovery?.hint).toBe(declared?.recovery);

      const text = textOf(result.content);
      expect(text).toContain(`resolved in ${named}`);
      expect(text).toContain(holder);
      expect(text).toContain('(reason no_codes_found)');
    },
  );

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/48
  describe('medcode_check_code under an explicit system', () => {
    const declared = checkCodeTool.errors?.find((entry) => entry.reason === 'unknown_code');

    it.each([
      ['E11.9', 'ICD-10-CM'],
      ['J0120', 'HCPCS Level II'],
      ['0DTJ4ZZ', 'ICD-10-PCS'],
    ])(
      'names the system holding %s on both surfaces, with no CPT sentence',
      async (code, label) => {
        const result = await callWithRawArgs(checkCodeTool, { code, system: 'RXNORM' });
        expect(result.isError).toBe(true);
        const envelope = result.structuredContent as ErrorEnvelope;
        expect(envelope.error.code).toBe(declared?.code);
        expect(envelope.error.data?.reason).toBe('unknown_code');
        expect(envelope.error.message).toContain(`it is a code in ${label}`);
        expect(envelope.error.message).not.toMatch(/CPT/);

        const text = textOf(result.content);
        expect(text).toContain(`it is a code in ${label}`);
        expect(text).not.toMatch(/CPT/);
        expect(text).toContain('(reason unknown_code)');
      },
    );

    it.each([
      [
        { code: '99213', system: 'RXNORM' },
        'No RxNorm concept matches "99213". If this is a CPT or HCPCS Level I code, those are out of scope — this server bundles ICD-10-CM, ICD-10-PCS, HCPCS Level II, and RxNorm.',
      ],
      [
        { code: 'ZZ9Q', system: 'RXNORM' },
        'No RxNorm concept matches "ZZ9Q" in the bundled release.',
      ],
    ])('words %j the same on both surfaces', async (args, message) => {
      const result = await callWithRawArgs(checkCodeTool, args);
      const envelope = result.structuredContent as ErrorEnvelope;
      expect(envelope.error.data?.reason).toBe('unknown_code');
      expect(envelope.error.message).toBe(message);
      expect(textOf(result.content)).toContain(message);
    });
  });

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

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/59
  describe('medcode_check_code missing a value no system was named for', () => {
    const declared = checkCodeTool.errors?.find((entry) => entry.reason === 'unknown_code');
    const CPT = /If this is a CPT or HCPCS Level I code, those are out of scope/;

    it.each([
      ['1049631', ['ICD-10-PCS', 'RxNorm'], true],
      ['R9999', ['ICD-10-CM', 'HCPCS Level II'], false],
      ['E11.99', ['ICD-10-CM'], false],
    ] as const)('names every shape %s fits on both surfaces', async (code, labels, cpt) => {
      const result = await callWithRawArgs(checkCodeTool, { code });
      expect(result.isError).toBe(true);
      const envelope = result.structuredContent as ErrorEnvelope;
      expect(envelope.error.code).toBe(declared?.code);
      expect(envelope.error.data?.reason).toBe('unknown_code');
      expect(envelope.error.data?.recovery?.hint).toBe(declared?.recovery);

      const lead = envelope.error.message.split(' matches ')[0] ?? '';
      for (const label of ['ICD-10-CM', 'ICD-10-PCS', 'HCPCS Level II', 'RxNorm'])
        expect(lead.includes(label), `${label} in ${lead}`).toBe(labels.includes(label as never));
      expect(CPT.test(envelope.error.message)).toBe(cpt);

      const text = textOf(result.content);
      expect(text).toContain(envelope.error.message);
      expect(text).toContain('(reason unknown_code)');
    });
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/43
  describe('medcode_check_code on a National Drug Code', () => {
    const declared = checkCodeTool.errors?.find((entry) => entry.reason === 'unknown_code');

    it.each([
      ['11111-2222-33', /product 198440/], // hyphenated, maps to a bundled product
      ['11111222233', /product 198440/], // the same NDC as bare 11 digits
      ['99999-8888-77', /no bundled drug maps to it/i], // well-formed, maps to nothing
      // https://github.com/cyanheads/medical-codes-mcp-server/issues/53
      ['99999888877', /no bundled drug maps to it/i], // bare 11 digits, maps to nothing
    ])('names %s as an NDC and recovers to the tools that decode one', async (ndc, detail) => {
      const result = await callWithRawArgs(checkCodeTool, { code: ndc });
      expect(result.isError).toBe(true);

      // The failure itself is unchanged: same code, same reason.
      const envelope = result.structuredContent as ErrorEnvelope;
      expect(envelope.error.code).toBe(declared?.code);
      expect(envelope.error.data?.reason).toBe('unknown_code');

      expect(envelope.error.message).toContain(`"${ndc}" is`);
      expect(envelope.error.message).toMatch(/National Drug Code \(NDC\)/);
      expect(envelope.error.message).toMatch(detail);
      expect(envelope.error.message).not.toMatch(/matches no bundled code shape/);

      const hint = envelope.error.data?.recovery?.hint ?? '';
      expect(hint).toContain('medcode_get_code');
      expect(hint).toContain('ndc_to_rxcui');
      expect(hint).not.toBe(declared?.recovery);

      const text = textOf(result.content);
      expect(text).toContain('National Drug Code (NDC)');
      expect(text).toContain('medcode_get_code');
      expect(text).toContain('ndc_to_rxcui');
      expect(text).toContain('(reason unknown_code)');
    });

    it.each(['2-152-1', '0002-152-01'])(
      'keeps the generic message and recovery for the malformed %s',
      async (malformed) => {
        const result = await callWithRawArgs(checkCodeTool, { code: malformed });
        const envelope = result.structuredContent as ErrorEnvelope;
        expect(envelope.error.data?.reason).toBe('unknown_code');
        expect(envelope.error.message).toBe(
          `"${malformed}" is not present in any bundled code system (ICD-10-CM, ICD-10-PCS, HCPCS Level II, RxNorm), and matches no bundled code shape.`,
        );
        expect(envelope.error.data?.recovery?.hint).toBe(declared?.recovery);
        expect(textOf(result.content)).not.toContain('NDC');
      },
    );
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

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/34
  it.each([
    ['a value outside the class types', 'ATC'],
    ['a blank value, which the enum does not read as omitted', ''],
  ])('rejects a classType that is %s, naming the accepted types', async (_label, classType) => {
    const result = await callWithRawArgs(mapCodesTool, {
      from: '161',
      direction: 'rxcui_to_classes',
      classType,
    });
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as ErrorEnvelope;
    expect(envelope.error.code).toBe(-32602);
    expect(envelope.error.data?.reason).toBe('invalid_arguments');
    for (const accepted of ['EPC', 'MOA', 'DISEASE', 'SCHEDULE', 'CVX']) {
      expect(envelope.error.message).toContain(accepted);
    }
    expect(textOf(result.content)).toContain('(reason invalid_arguments)');
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
