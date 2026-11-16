/**
 * @fileoverview The caller-value echo bound (#75) as each tool wires it, against the
 * fixture DB: a code input longer than 64 characters once trimmed is not looked up
 * and misses with its tool's usual reason, every miss, notice, notFound or deferred
 * row, and log field carries at most the value's first 64 trimmed characters and
 * `…`, and a value of 64 characters or fewer echoes as it always has. The echo
 * helper's own branches are tabled once, in tests/services/echo.test.ts; these
 * tests take one case per side of each branch a tool adds.
 * @module tests/tools/caller-echo.test
 */

import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import type { CodeIndexService } from '@/services/code-index/code-index-service.js';
import { readCommonMark } from '../helpers/commonmark.ts';
import {
  type GetCodeArgs,
  type GetCodePage,
  getCodePage,
  REPLY_BUDGET_BYTES,
  unbudgetedGetCode,
  walkGetCode,
} from '../helpers/get-code-pages.ts';
import { ensureIndex } from '../helpers/index-fixture.ts';

/** A value no code could be: 10,000 characters of one letter. */
const Q = 'q'.repeat(10_000);
/** How every reply echoes {@link Q}: its first 64 characters, then `…`. */
const CUT = `${'q'.repeat(64)}…`;
/**
 * medcode_get_code's reason for a value it did not look up. It names neither the
 * value nor its length, so the cut value a `deferred` row hands back, re-sent,
 * misses with this same entry.
 */
const NOT_LOOKED_UP =
  'Not looked up: longer than 64 characters once trimmed, and no bundled code, RXCUI, NDC, or class ID is that long.';
const spaces = (count: number) => ' '.repeat(count);
/** `code` behind and ahead of 100 spaces: past 64 characters as sent, short once trimmed. */
const padded = (code: string) => `${spaces(100)}${code}${spaces(100)}`;

/** Calls a tool the way a client does, including values its schema type does not name. */
const call = runToolContract as unknown as (
  tool: unknown,
  args: Record<string, unknown>,
) => ReturnType<typeof runToolContract>;

interface Reply {
  error: { data?: { reason?: string }; message: string } | undefined;
  json: string;
  structured: Record<string, unknown>;
  text: string;
}

/** One call, with both surfaces as a client receives them. */
async function reply(tool: unknown, args: Record<string, unknown>): Promise<Reply> {
  const result = await call(tool, args);
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  const text = (result.content as { text?: string }[]).map((block) => block.text ?? '').join('');
  return {
    structured,
    json: JSON.stringify(structured),
    text,
    error: result.isError ? (structured.error as Reply['error']) : undefined,
  };
}

/** The longest run of `unit` in `text` — how much of a one-character value a surface carries. */
function longestRun(text: string, unit: string): number {
  let best = 0;
  let run = 0;
  for (const char of text) {
    run = char === unit ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** One field of every ctx.log call's metadata, in call order. */
function logged(ctx: { log: unknown }, field: string): unknown[] {
  return (ctx.log as MockContextLogger).calls.map(
    (call) => (call.data as Record<string, unknown> | undefined)?.[field],
  );
}

/**
 * Both surfaces carry at most 64 characters of {@link Q}, and fewer than `max` bytes.
 * content[] is read as a CommonMark client reads it, its escapes resolved.
 */
function expectBounded(r: Reply, max: number): void {
  expect(longestRun(readCommonMark(r.text), 'q')).toBeLessThanOrEqual(64);
  expect(longestRun(r.json, 'q')).toBeLessThanOrEqual(64);
  expect(bytes(r.text)).toBeLessThan(max);
  expect(bytes(r.json)).toBeLessThan(max);
}

let svc: CodeIndexService;
beforeAll(async () => {
  svc = await ensureIndex();
});

describe('medcode_get_code', () => {
  it('misses a value past 64 characters unlooked-up: code cut, reason naming neither value nor length', async () => {
    const lookup = vi.spyOn(svc, 'getByCode');
    try {
      const r = await reply(getCodeTool, { codes: ['E11.9', Q] });
      const out = r.structured as {
        found: { code: string }[];
        notFound: { code: string; reason: string }[];
      };
      expect(out.found.map((f) => f.code)).toEqual(['E11.9']);
      expect(out.notFound).toEqual([{ code: CUT, reason: NOT_LOOKED_UP }]);
      expect(readCommonMark(r.text)).toContain(`⟨strong⟩${CUT}⟨/strong⟩: ${NOT_LOOKED_UP}`);
      expectBounded(r, 1_000);
      expect(lookup.mock.calls.map(([code]) => code)).toEqual(['E11.9']);
    } finally {
      lookup.mockRestore();
    }
  });

  it('echoes a miss of 64 characters or fewer as sent, padding included', async () => {
    const sent = ` ${'Z'.repeat(62)} `;
    const out = (await getCodePage({ codes: ['E11.9', sent] })).notFound;
    expect(out).toEqual([
      {
        code: sent,
        reason: `"${sent}" is not present in any bundled code system, and matches no bundled code shape.`,
      },
    ]);
  });

  it('trims a miss whose padding alone carries it past 64 characters', async () => {
    const page = await getCodePage({ codes: ['E11.9', `${spaces(100)}ZZZ9${spaces(100)}`] });
    const reason =
      '"ZZZ9" is not present in any bundled code system, and matches no bundled code shape.';
    expect(page.notFound).toEqual([{ code: 'ZZZ9', reason }]);
    expect(readCommonMark(page.text)).toContain(`⟨strong⟩ZZZ9⟨/strong⟩: ${reason}`);
    // content[] writes a code's edge spaces as character references, so it is read back.
    expect(readCommonMark(page.text)).not.toContain(spaces(65));
  });

  /** Every notFound row a shaped or system-scoped miss writes, each sent padded past 64 characters. */
  const BRANCHES: [
    string,
    GetCodeArgs,
    { candidateSystems?: string[]; code: string; reason: string },
  ][] = [
    [
      'an NDC nothing maps to',
      { codes: ['E11.9', padded('99999-8888-77')] },
      {
        code: '99999-8888-77',
        reason:
          '"99999-8888-77" is a valid NDC format but no bundled drug maps to it (normalized 99999888877).',
      },
    ],
    [
      'a bare integer out of scope',
      { codes: ['E11.9', padded('99213')] },
      {
        code: '99213',
        reason:
          '"99213" is not present in the bundled release (matched shape: RXNORM). If this is a CPT or HCPCS Level I code, those are out of scope — this server bundles ICD-10-CM, ICD-10-PCS, HCPCS Level II, and RxNorm.',
      },
    ],
    [
      'a value in ICD-9-CM form',
      { codes: ['E11.9', padded('250.00')] },
      {
        code: '250.00',
        reason:
          '"250.00" is not present in any bundled code system, and matches no bundled code shape. ICD-9-CM codes (diagnoses written NNN.NN, external causes ENNN.N, procedures NN.NN) are not bundled — find the current ICD-10-CM or ICD-10-PCS code by description with medcode_search_codes.',
      },
    ],
    [
      'a code in several systems',
      { codes: ['E11.9', padded('A0100')] },
      {
        code: 'A0100',
        reason:
          '"A0100" matches multiple systems — re-call with an explicit system to disambiguate.',
        candidateSystems: ['ICD10CM', 'HCPCS'],
      },
    ],
    [
      'a code the named system misses and another holds',
      { codes: [padded('J0120'), 'E11.9'], system: 'ICD10CM' },
      {
        code: 'J0120',
        reason:
          'No ICD-10-CM code matches "J0120" — it is a code in HCPCS Level II. Re-call with system "HCPCS" to decode it there.',
      },
    ],
    [
      'an ICD-10-PCS section value under ICD10PCS',
      { codes: ['0DTJ4ZZ', padded('0')], system: 'ICD10PCS' },
      {
        code: '0',
        reason:
          'No ICD-10-PCS code matches "0" in the bundled release. "0" is the ICD-10-PCS section "Medical and Surgical", not a code. medcode_browse_hierarchy lists the sections (system ICD10PCS, no node); find a complete 7-character ICD-10-PCS code by description with medcode_search_codes.',
      },
    ],
    [
      'bare NDC digits no system holds and nothing maps to',
      { codes: ['E11.9', padded('99999888877')] },
      {
        code: '99999888877',
        reason:
          '"99999888877" is a valid NDC format but no bundled drug maps to it (normalized 99999888877).',
      },
    ],
    [
      'an NDC under a named system',
      { codes: ['E11.9', padded('11111-2222-33')], system: 'ICD10CM' },
      {
        code: '11111-2222-33',
        reason:
          '"11111-2222-33" is not present in any bundled code system, and matches no bundled code shape. It is a National Drug Code (NDC): omit system to decode it to its RxNorm product.',
      },
    ],
  ];

  it.each(BRANCHES)(
    'trims %s padded past 64 characters, in its code and its reason',
    async (_case, args, miss) => {
      const page = await getCodePage(args);
      expect(page.found).toHaveLength(1);
      expect(page.notFound).toEqual([miss]);
      const systems = miss.candidateSystems ? ` [${miss.candidateSystems.join(', ')}]` : '';
      expect(readCommonMark(page.text)).toContain(
        `⟨strong⟩${miss.code}⟨/strong⟩: ${miss.reason}${systems}`,
      );
    },
  );

  it('still resolves a code padded far past 64 characters', async () => {
    const page = await getCodePage({ codes: [`${spaces(100)}E11.9${spaces(100)}`] });
    expect(page.found.map((f) => f.code)).toEqual(['E11.9']);
  });

  it('resolves a dot-padded value of 64 characters, and looks none up at 65', async () => {
    const at64 = `E${'.'.repeat(59)}11.9`;
    expect([...at64]).toHaveLength(64);
    expect((await getCodePage({ codes: [at64] })).found.map((f) => f.code)).toEqual(['E11.9']);

    const at65 = `E${'.'.repeat(60)}11.9`;
    const page = await getCodePage({ codes: ['E11.9', at65] });
    expect(page.found.map((f) => f.code)).toEqual(['E11.9']);
    expect(page.notFound).toEqual([{ code: `E${'.'.repeat(60)}11.…`, reason: NOT_LOOKED_UP }]);
  });

  it('holds 49 values of 10,000 characters and a code that resolves under the budget', async () => {
    const page = await getCodePage({ codes: [...Array.from({ length: 49 }, () => Q), 'E11.9'] });
    expect(page.found.map((f) => f.code)).toEqual(['E11.9']);
    expect(page.notFound.map((n) => n.code)).toEqual(Array.from({ length: 49 }, () => CUT));
    expect(page.contentBytes).toBeLessThanOrEqual(REPLY_BUDGET_BYTES);
    expect(page.structuredBytes).toBeLessThanOrEqual(REPLY_BUDGET_BYTES);
  });

  it('answers a 30,000-character value among codes that resolve in one reply, its echo sized cut', async () => {
    const page = await getCodePage({ codes: ['E11.9', 'E11.9', 'q'.repeat(30_000), 'E11.9'] });
    expect(page.deferred).toBeUndefined();
    expect(page.found.map((f) => f.code)).toEqual(['E11.9', 'E11.9', 'E11.9']);
    expect(page.notFound).toEqual([{ code: CUT, reason: NOT_LOOKED_UP }]);
    expect(page.contentBytes).toBeLessThanOrEqual(REPLY_BUDGET_BYTES);
    expect(page.structuredBytes).toBeLessThanOrEqual(REPLY_BUDGET_BYTES);
  });

  it('names a long value cut, with its length, in no_codes_found', async () => {
    const r = await reply(getCodeTool, { codes: [Q] });
    expect(r.error?.data?.reason).toBe('no_codes_found');
    expect(r.error?.message).toContain(`"${CUT}" (10,000 characters)`);
    expectBounded(r, 1_000);
  });

  // The heaviest fixture decode under includeHierarchy, ~0.8 KB on each surface.
  const HEAVY = 'S8266';
  const heavies = (count: number) => Array.from({ length: count }, () => HEAVY);
  const withinBudget = (page: GetCodePage) => {
    expect(page.contentBytes).toBeLessThanOrEqual(REPLY_BUDGET_BYTES);
    expect(page.structuredBytes).toBeLessThanOrEqual(REPLY_BUDGET_BYTES);
  };

  it('defers past the cut a long value cut, a padded one trimmed, and a short one as sent, on both surfaces', async () => {
    const sent = [...heavies(30), Q, padded(HEAVY), ' ZZZ8 ', HEAVY];
    const page = await getCodePage({ codes: sent, includeHierarchy: true });
    withinBudget(page);
    // The cut falls among the heavy codes, and every input from it on comes back unprocessed.
    const deferred = page.deferred ?? [];
    expect(deferred.length).toBeGreaterThan(4);
    expect(page.found).toHaveLength(sent.length - deferred.length);
    expect(page.notFound).toEqual([]);
    expect(deferred).toEqual([...heavies(deferred.length - 4), CUT, HEAVY, ' ZZZ8 ', HEAVY]);
    const listed = readCommonMark(page.text.slice(page.text.indexOf('### Deferred')))
      .split('\n')
      .filter((line) => line.startsWith('⟨strong⟩'));
    expect(listed.slice(-4, -2)).toEqual([`⟨strong⟩${CUT}⟨/strong⟩`, `⟨strong⟩${HEAVY}⟨/strong⟩`]);
    // content[] writes a code's edge spaces as character references, so it is read back.
    for (const surface of [readCommonMark(page.text), JSON.stringify(page.structured)]) {
      expect(longestRun(surface, 'q')).toBe(64);
      expect(longestRun(surface, ' ')).toBeLessThan(64);
    }
  });

  it('pages long and padded values before, between, and after the codes that resolve to the single call, byte for byte', async () => {
    const args = {
      codes: [
        // Before the first code that resolves: never deferred.
        Q,
        padded('ZZZ1'),
        ...heavies(18),
        // Between codes that resolve, ahead of the cut.
        Q,
        padded(HEAVY),
        padded('ZZZ2'),
        ' ZZZ3 ',
        ...heavies(18),
        // Between codes that resolve, past the cut: deferred, and re-sent as echoed.
        Q,
        padded(HEAVY),
        padded('ZZZ4'),
        HEAVY,
        // After the last code that resolves: deferred with it, answered on the last page.
        Q,
        padded('ZZZ5'),
      ],
      includeHierarchy: true,
    };
    const walk = await walkGetCode(args);
    expect(walk.pages.length).toBeGreaterThan(1);
    for (const page of walk.pages) withinBudget(page);
    // Later pages were sent the long value cut and the padded ones trimmed.
    const resent = walk.pages.slice(1).flatMap((page) => page.sent);
    expect(resent.filter((code) => code === CUT)).toHaveLength(2);
    expect(resent).toEqual(expect.arrayContaining(['ZZZ4', 'ZZZ5']));
    expect(resent.filter((code) => [...code].length > 65)).toEqual([]);

    const reference = await unbudgetedGetCode(args, 'E11.9');
    expect(JSON.stringify(walk.found)).toBe(JSON.stringify(reference.found));
    expect(JSON.stringify(walk.notFound)).toBe(JSON.stringify(reference.notFound));
    expect(walk.notFound.map((n) => n.code)).toEqual([
      CUT,
      'ZZZ1',
      CUT,
      'ZZZ2',
      ' ZZZ3 ',
      CUT,
      'ZZZ4',
      CUT,
      'ZZZ5',
    ]);
  });
});

describe('medcode_check_code', () => {
  it('raises unknown_code for a value past 64 characters without a lookup, cut and named by length', async () => {
    const lookup = vi.spyOn(svc, 'checkCode');
    try {
      const r = await reply(checkCodeTool, { code: Q });
      expect(r.error?.data?.reason).toBe('unknown_code');
      const message = `"${CUT}" (10,000 characters) was not looked up: no bundled code, RXCUI, NDC, or class ID is longer than 64 characters.`;
      expect(r.error?.message).toBe(message);
      expect(readCommonMark(r.text)).toContain(message);
      expectBounded(r, 1_000);
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it('echoes a miss of 64 characters whole', async () => {
    const value = 'Z'.repeat(64);
    const r = await reply(checkCodeTool, { code: value });
    const lead = `"${value}" is not present in any bundled code system`;
    expect(r.error?.message).toContain(lead);
    expect(readCommonMark(r.text)).toContain(lead);
  });

  it('names a code in several systems in the ambiguity message as sent, trimmed', async () => {
    const r = await reply(checkCodeTool, { code: `${spaces(100)}A0100` });
    expect(r.error?.data?.reason).toBe('ambiguous_system');
    expect(r.error?.message).toBe('"A0100" exists in multiple systems: ICD10CM, HCPCS.');
    expect(readCommonMark(r.text)).toContain('"A0100" exists in multiple systems');
  });

  it('still resolves a code padded with 10,000 spaces on each side', async () => {
    const r = await reply(checkCodeTool, { code: `${spaces(10_000)}E11.9${spaces(10_000)}` });
    expect(r.structured).toMatchObject({ code: 'E11.9', status: 'valid_billable' });
  });

  it('does not look up a dot-padded value of 65 characters', async () => {
    const r = await reply(checkCodeTool, { code: `E${'.'.repeat(60)}11.9` });
    expect(r.error?.data?.reason).toBe('unknown_code');
    expect(r.error?.message).toContain('(65 characters)');
  });
});

describe('medcode_map_codes', () => {
  it.each([
    'parents',
    'children',
    'ndc_to_rxcui',
    'rxcui_to_ndc',
    'rxcui_to_ingredients',
    'rxcui_to_brands',
    'rxcui_to_classes',
    'class_to_rxcuis',
  ])(
    'raises no_mapping on %s for a value past 64 characters, without a lookup',
    async (direction) => {
      const lookup = vi.spyOn(svc, 'mapCode');
      try {
        const r = await reply(mapCodesTool, { from: Q, direction });
        expect(r.error?.data?.reason).toBe('no_mapping');
        const lead = `"${CUT}" (10,000 characters) was not looked up`;
        expect(r.error?.message).toContain(lead);
        expect(readCommonMark(r.text)).toContain(lead);
        expectBounded(r, 1_000);
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    },
  );

  it('looks a drug name up whole on name_to_rxcui, cutting only its miss echo', async () => {
    const lookup = vi.spyOn(svc, 'mapCode');
    try {
      const r = await reply(mapCodesTool, { from: Q, direction: 'name_to_rxcui' });
      expect(lookup).toHaveBeenCalledWith(
        Q,
        'name_to_rxcui',
        undefined,
        expect.anything(),
        undefined,
      );
      expect(r.error?.data?.reason).toBe('no_mapping');
      const message = `No bundled code matches "${CUT}" (10,000 characters).`;
      expect(r.error?.message).toBe(message);
      expect(readCommonMark(r.text)).toContain(message);
      expectBounded(r, 1_000);
    } finally {
      lookup.mockRestore();
    }
  });

  it('cuts a drug name that resolves in its past-the-end notice and log, keeping from whole', async () => {
    // No fixture drug name is longer than 64 characters, so a resolving lookup of a
    // long name is stubbed at the service seam; the handler's notice and log run as shipped.
    const lookup = vi.spyOn(svc, 'mapCode').mockReturnValue({
      kind: 'ok',
      resolvedSystem: 'RXNORM',
      hasMore: false,
      pastEnd: true,
      hits: [],
    });
    try {
      const notice = `"${CUT}" (10,000 characters) resolved in RXNORM, but this page starts past the last name_to_rxcui result. Re-call without a cursor to start from the first page.`;
      const r = await reply(mapCodesTool, { from: Q, direction: 'name_to_rxcui' });
      expect(r.structured.notice).toBe(notice);
      expect(r.structured.from).toBe(Q);
      expect(readCommonMark(r.text)).toContain(notice);

      const ctx = createMockContext({ errors: mapCodesTool.errors });
      await mapCodesTool.handler(
        mapCodesTool.input.parse({ from: Q, direction: 'name_to_rxcui' }),
        ctx,
      );
      expect(logged(ctx, 'from')).toEqual([CUT]);
    } finally {
      lookup.mockRestore();
    }
  });

  it('echoes a drug name of 64 characters or fewer whole in its past-the-end notice', async () => {
    const r = await reply(mapCodesTool, {
      from: 'aspirin',
      direction: 'name_to_rxcui',
      cursor: Buffer.from(JSON.stringify({ offset: 999_999, limit: 1 })).toString('base64url'),
    });
    const notice =
      '"aspirin" resolved in RXNORM, but this page starts past the last name_to_rxcui result. Re-call without a cursor to start from the first page.';
    expect(r.structured.notice).toBe(notice);
    expect(readCommonMark(r.text)).toContain(notice);
  });

  it.each(['parents', 'children'])(
    'looks a source of 64 characters up on %s, and none of 65',
    async (direction) => {
      const lookup = vi.spyOn(svc, 'mapCode');
      try {
        const at64 = 'Z'.repeat(64);
        const miss = await reply(mapCodesTool, { from: at64, direction });
        expect(miss.error?.data?.reason).toBe('no_mapping');
        expect(miss.error?.message).toBe(`No bundled code matches "${at64}".`);
        expect(readCommonMark(miss.text)).toContain(`No bundled code matches "${at64}".`);
        expect(lookup.mock.calls.map(([from]) => from)).toEqual([at64]);

        const at65 = 'Z'.repeat(65);
        const refused = await reply(mapCodesTool, { from: at65, direction });
        expect(refused.error?.message).toBe(
          `"${'Z'.repeat(64)}…" (65 characters) was not looked up: no bundled code, RXCUI, NDC, or class ID is longer than 64 characters.`,
        );
        expect(lookup).toHaveBeenCalledTimes(1);
      } finally {
        lookup.mockRestore();
      }
    },
  );

  it('walks E11 written with dots to 64 characters, and not at 65', async () => {
    const at64 = `E${'.'.repeat(61)}11`;
    expect([...at64]).toHaveLength(64);
    const r = await reply(mapCodesTool, { from: at64, direction: 'children' });
    expect(r.error).toBeUndefined();
    expect(r.structured.from).toBe(at64);
    expect((r.structured.hits as { value: string }[]).map((hit) => hit.value)).toEqual(['E11.9']);

    const at65 = await reply(mapCodesTool, { from: `E${'.'.repeat(62)}11`, direction: 'children' });
    expect(at65.error?.data?.reason).toBe('no_mapping');
    expect(at65.error?.message).toContain('(65 characters) was not looked up');
  });

  it('logs a padded source trimmed when its padding carries it past 64 characters', async () => {
    const ctx = createMockContext({ errors: mapCodesTool.errors });
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: `E11${spaces(100)}`, direction: 'children' }),
      ctx,
    );
    expect(out.from).toBe('E11');
    expect(logged(ctx, 'from')).toEqual(['E11']);
  });
});

describe('medcode_browse_hierarchy', () => {
  it.each(['ICD10CM', 'ICD10PCS', 'HCPCS'])(
    'raises unknown_node in %s for a node past 64 characters, without a lookup',
    async (system) => {
      const lookup = vi.spyOn(svc, 'browse');
      try {
        const r = await reply(browseHierarchyTool, { system, node: Q });
        expect(r.error?.data?.reason).toBe('unknown_node');
        const lead = `"${CUT}" (10,000 characters) was not looked up`;
        expect(r.error?.message).toContain(lead);
        expect(readCommonMark(r.text)).toContain(lead);
        expectBounded(r, 1_000);
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
    },
  );

  it('names a padded node that does not exist trimmed', async () => {
    const r = await reply(browseHierarchyTool, { system: 'ICD10CM', node: `ZZZ9${spaces(100)}` });
    expect(r.error?.data?.reason).toBe('unknown_node');
    expect(r.error?.message).toBe('Node "ZZZ9" does not exist in ICD10CM.');
    expect(readCommonMark(r.text)).toContain('Node "ZZZ9" does not exist in ICD10CM.');
  });

  it('echoes a node of 64 characters or fewer as sent when it does not exist', async () => {
    const r = await reply(browseHierarchyTool, { system: 'ICD10CM', node: 'ZZZ9 ' });
    expect(r.error?.message).toBe('Node "ZZZ9 " does not exist in ICD10CM.');
  });

  it('looks a node of 64 characters up, and none of 65', async () => {
    const lookup = vi.spyOn(svc, 'browse');
    try {
      const at64 = 'Z'.repeat(64);
      const miss = await reply(browseHierarchyTool, { system: 'ICD10CM', node: at64 });
      expect(miss.error?.data?.reason).toBe('unknown_node');
      expect(miss.error?.message).toBe(`Node "${at64}" does not exist in ICD10CM.`);
      expect(readCommonMark(miss.text)).toContain(`Node "${at64}" does not exist in ICD10CM.`);
      expect(lookup.mock.calls.map(([, node]) => node)).toEqual([at64]);

      const refused = await reply(browseHierarchyTool, { system: 'ICD10CM', node: 'Z'.repeat(65) });
      expect(refused.error?.message).toBe(
        `"${'Z'.repeat(64)}…" (65 characters) was not looked up: no bundled code, RXCUI, NDC, or class ID is longer than 64 characters.`,
      );
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      lookup.mockRestore();
    }
  });

  it('lists the children of E11 written with dots to 64 characters, and not at 65', async () => {
    const at64 = await reply(browseHierarchyTool, {
      system: 'ICD10CM',
      node: `E${'.'.repeat(61)}11`,
    });
    expect(at64.error).toBeUndefined();
    expect((at64.structured.codes as { code: string }[]).map((c) => c.code)).toEqual(['E11.9']);

    const at65 = await reply(browseHierarchyTool, {
      system: 'ICD10CM',
      node: `E${'.'.repeat(62)}11`,
    });
    expect(at65.error?.data?.reason).toBe('unknown_node');
    expect(at65.error?.message).toContain('(65 characters) was not looked up');
  });

  it.each([
    ['0DT', '"0DT" is an ICD-10-PCS table row: list the complete codes in it'],
    ['0DTJ4ZZ', '"0DTJ4ZZ" is a complete 7-character ICD-10-PCS code'],
  ])('names a padded ICD-10-PCS node %s trimmed in its notice', async (node, lead) => {
    const r = await reply(browseHierarchyTool, { system: 'ICD10PCS', node: padded(node) });
    expect(r.structured.notice).toContain(lead);
    expect(readCommonMark(r.text)).toContain(lead);
    expect(longestRun(r.json, ' ')).toBeLessThan(64);
  });

  it('keeps RxNorm’s empty answer for any node, logging the node cut', async () => {
    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'RXNORM', node: Q }),
      ctx,
    );
    expect(out.codes).toEqual([]);
    expect(getEnrichment(ctx)?.notice).toContain('RxNorm is a flat drug vocabulary');
    expect(logged(ctx, 'node')).toEqual([CUT]);
  });

  it('names a padded leaf trimmed in its notice, and logs it trimmed', async () => {
    const r = await reply(browseHierarchyTool, { system: 'ICD10CM', node: `E11.9${spaces(100)}` });
    const lead = 'No children under "E11.9" in ICD10CM';
    expect(r.structured.notice).toContain(lead);
    expect(readCommonMark(r.text)).toContain(lead);

    const ctx = createMockContext({ errors: browseHierarchyTool.errors });
    await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10PCS', node: padded('0DT') }),
      ctx,
    );
    expect(logged(ctx, 'node')).toEqual(['0DT']);
  });
});

describe('medcode_search_codes', () => {
  it('looks a query up whole, cutting its notice echo and keeping effectiveQuery', async () => {
    const lookup = vi.spyOn(svc, 'searchFts');
    try {
      const ctx = createMockContext();
      const out = await searchCodesTool.handler(searchCodesTool.input.parse({ query: Q }), ctx);
      expect(out.codes).toEqual([]);
      expect(lookup.mock.calls[0]?.[0]).toBe(Q);
      const notice = `No codes matched "${CUT}" (10,000 characters). Broaden the terms, drop the filters, or try clinical synonyms.`;
      const enrichment = getEnrichment(ctx);
      expect(enrichment?.notice).toBe(notice);
      expect(enrichment?.effectiveQuery).toBe(Q);
      expect(logged(ctx, 'query')).toEqual([CUT]);

      const r = await reply(searchCodesTool, { query: Q, system: 'HCPCS' });
      const scoped = `No codes matched "${CUT}" (10,000 characters) in HCPCS. Broaden the terms, drop the filters, or try clinical synonyms.`;
      expect(r.structured.notice).toBe(scoped);
      expect(readCommonMark(r.text)).toContain(scoped);
    } finally {
      lookup.mockRestore();
    }
  });

  it('echoes a query of 64 characters or fewer whole in its notice, trimmed', async () => {
    const r = await reply(searchCodesTool, { query: ` ${'q'.repeat(64)} ` });
    const notice = `No codes matched "${'q'.repeat(64)}". Broaden the terms, drop the filters, or try clinical synonyms.`;
    expect(r.structured.notice).toBe(notice);
    expect(readCommonMark(r.text)).toContain(notice);
  });

  it('logs a matching query of 64 characters or fewer as sent', async () => {
    const ctx = createMockContext();
    const out = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: ' diabetes ' }),
      ctx,
    );
    expect(out.codes.length).toBeGreaterThan(0);
    expect(logged(ctx, 'query')).toEqual([' diabetes ']);
  });

  it('finds a code by a whole description longer than 64 characters, logging it cut', async () => {
    const query =
      'Nondisplaced fracture of lateral malleolus of unspecified fibula, initial encounter for closed fracture';
    const ctx = createMockContext();
    const out = await searchCodesTool.handler(searchCodesTool.input.parse({ query }), ctx);
    expect(out.codes.map((c) => c.code)).toContain('S82.66XA');
    expect(getEnrichment(ctx)?.effectiveQuery).toBe(query);
    expect(logged(ctx, 'query')).toEqual([
      'Nondisplaced fracture of lateral malleolus of unspecified fibula…',
    ]);
  });

  it('cuts appliedFilters.chapter past 64 characters on both surfaces', async () => {
    const r = await reply(searchCodesTool, { query: 'diabetes', chapter: Q });
    expect((r.structured.appliedFilters as { chapter: string }).chapter).toBe(`${'Q'.repeat(64)}…`);
    expect(longestRun(r.text, 'Q')).toBe(64);
    expect(longestRun(r.json, 'Q')).toBe(64);
  });

  it('echoes a chapter of 64 characters whole', async () => {
    const r = await reply(searchCodesTool, { query: 'diabetes', chapter: 'q'.repeat(64) });
    expect((r.structured.appliedFilters as { chapter: string }).chapter).toBe('Q'.repeat(64));
  });
});
