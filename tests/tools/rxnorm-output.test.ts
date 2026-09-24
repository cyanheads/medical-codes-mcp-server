/**
 * @fileoverview The RxNorm row contract on every tool that returns a decoded code.
 * RxNorm has no billing concept and publishes no short description, so an RxNorm
 * concept carries `billable: null` (rendered `billable: n/a`) and
 * `shortDescription: null`, and `medcode_check_code` answers it with status
 * `valid` and no billing verdict. Every case runs through `runToolContract`, which
 * parses the result against the tool's own output schema and returns both the
 * `structuredContent` and the `content[]` a text-only client reads.
 * @module tests/tools/rxnorm-output.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import { ensureIndex } from '../helpers/index-fixture.ts';

type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** Every text block a content-only client receives, the enrichment trailer included. */
function textOf(result: ToolResult): string {
  return (result.content as { text?: string; type: string }[])
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n');
}

interface Row {
  billable: boolean | null;
  chapter: string | null;
  code: string;
  description: string | null;
  header: boolean;
  shortDescription: string | null;
  system: string;
}

interface SearchResult {
  codes: Row[];
  nextCursor?: string;
  notice?: string;
  truncated: boolean;
}

/** The fixture RxNorm concepts an RxNorm search for "a" returns (every one but the brand "Tylenol"). */
const RXNORM_CONCEPTS = ['161', '1191', '198440', '1049640'];

beforeAll(async () => {
  await ensureIndex();
});

describe('medcode_check_code on an RXCUI', () => {
  it.each([
    ['161', undefined],
    ['161', 'RXNORM'],
    ['198440', undefined],
    ['1049640', 'RXNORM'],
  ] as const)('answers %s (system %s) as valid with no billing verdict', async (code, system) => {
    const result = await runToolContract(checkCodeTool, { code, ...(system ? { system } : {}) });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      system: 'RXNORM',
      code,
      status: 'valid',
      billable: null,
      whyNot: null,
    });

    const text = textOf(result);
    expect(text).toContain(`## ${code} — RxNorm`);
    expect(text).toContain('**Billable:** n/a');
    // No billing verdict and no claim advice, in any wording.
    expect(text).not.toMatch(/not billable|billable: no|more specific|before submitting|claim/i);
    expect(text).not.toContain('null');
  });
});

describe('medcode_get_code on RxNorm', () => {
  it('decodes an RXCUI with billable and shortDescription null, the term type in chapter', async () => {
    const result = await runToolContract(getCodeTool, { codes: ['161'] });

    expect(result.structuredContent).toEqual({
      found: [
        {
          system: 'RXNORM',
          code: '161',
          description: 'acetaminophen',
          shortDescription: null,
          billable: null,
          header: false,
          chapter: 'IN',
        },
      ],
      notFound: [],
    });
    const text = textOf(result);
    expect(text).toContain('**billable: n/a, header: no** · chapter IN');
    expect(text).not.toContain('_Short:_');
    expect(text).not.toContain('null');
  });

  it('decodes an NDC to a product row with the same contract', async () => {
    const result = await runToolContract(getCodeTool, { codes: ['11111-2222-33'] });

    expect(result.structuredContent).toEqual({
      found: [
        {
          system: 'RXNORM',
          code: '198440',
          description: 'Acetaminophen 500 MG Oral Tablet',
          shortDescription: null,
          billable: null,
          header: false,
          chapter: 'SCD',
          source: 'NDC',
        },
      ],
      notFound: [],
    });
    const text = textOf(result);
    expect(text).toContain('billable: n/a');
    expect(text).toContain('**Resolved via:** NDC');
    expect(text).not.toContain('_Short:_');
  });

  it('attaches an empty, complete hierarchy to an RxNorm concept', async () => {
    const result = await runToolContract(getCodeTool, {
      codes: ['198440'],
      includeHierarchy: true,
    });
    const [found] = (result.structuredContent as { found: Record<string, unknown>[] }).found;
    expect(found).toMatchObject({
      billable: null,
      shortDescription: null,
      parent: null,
      children: [],
      childrenTruncated: false,
    });
    expect(textOf(result)).toContain('**Children (0):**');
  });

  it('keeps the yes/no rendering for a billing system in the same batch', async () => {
    const result = await runToolContract(getCodeTool, { codes: ['E11.9', '161', 'J0120'] });
    const found = (result.structuredContent as { found: Row[] }).found;
    expect(found.map(({ code, billable }) => ({ code, billable }))).toEqual([
      { code: 'E11.9', billable: true },
      { code: '161', billable: null },
      { code: 'J0120', billable: true },
    ]);
    const text = textOf(result);
    expect(text).toContain('## E11.9 — ICD-10-CM\n**billable: yes, header: no**');
    expect(text).toContain('## 161 — RxNorm\n**billable: n/a, header: no**');
    expect(text).toContain('## J0120 — HCPCS Level II\n**billable: yes, header: no**');
  });

  it('carries a no-billing-concept row through the nested children schema', () => {
    // No bundled RxNorm concept has children, so the nested arm is reachable only
    // through the schema — which is what a strict client validates against.
    const child = {
      system: 'RXNORM',
      code: '161',
      description: 'acetaminophen',
      shortDescription: null,
      billable: null,
      header: false,
      chapter: 'IN',
    };
    const out = getCodeTool.output.parse({
      found: [
        { ...child, code: '198440', parent: null, children: [child], childrenTruncated: false },
      ],
      notFound: [],
    });
    const text = (getCodeTool.format?.(out) ?? [])
      .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
      .join('\n');
    expect(text).toContain(
      '- **161** (RxNorm; billable: n/a, header: no · chapter IN): acetaminophen',
    );
  });
});

describe('medcode_search_codes on RxNorm', () => {
  it('returns every hit with billable and shortDescription null on both surfaces', async () => {
    const result = await runToolContract(searchCodesTool, {
      query: 'a',
      system: 'RXNORM',
      limit: 200,
    });
    const { codes } = result.structuredContent as SearchResult;

    expect(codes.map((row) => row.code).sort()).toEqual([...RXNORM_CONCEPTS].sort());
    for (const row of codes) {
      expect(row).toMatchObject({ system: 'RXNORM', billable: null, shortDescription: null });
    }
    const text = textOf(result);
    expect(text.match(/billable: n\/a/g)).toHaveLength(codes.length);
    expect(text).not.toContain('(short:');
    expect(text).not.toMatch(/billable: (yes|no)/);
  });

  it('holds the contract on every page of a cursor walk to the end', async () => {
    const walked: Row[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await runToolContract(searchCodesTool, {
        query: 'a',
        system: 'RXNORM',
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      const page = result.structuredContent as SearchResult;
      for (const row of page.codes) {
        expect(row.billable).toBeNull();
        expect(row.shortDescription).toBeNull();
      }
      walked.push(...page.codes);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(RXNORM_CONCEPTS.length);
    expect(walked.map((row) => row.code).sort()).toEqual([...RXNORM_CONCEPTS].sort());
  });

  it('discloses the cap when the RxNorm page is full', async () => {
    const result = await runToolContract(searchCodesTool, {
      query: 'a',
      system: 'RXNORM',
      limit: 1,
    });
    const page = result.structuredContent as SearchResult;
    expect(page.codes).toHaveLength(1);
    expect(page.codes[0]?.billable).toBeNull();
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('answers a cursor past the last RxNorm hit with an empty page', async () => {
    const pastEnd = Buffer.from(JSON.stringify({ offset: 999, limit: 2 })).toString('base64url');
    const result = await runToolContract(searchCodesTool, {
      query: 'a',
      system: 'RXNORM',
      limit: 2,
      cursor: pastEnd,
    });
    const page = result.structuredContent as SearchResult;
    expect(page.codes).toEqual([]);
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it('filters by the term type chapter carries, in any case', async () => {
    const result = await runToolContract(searchCodesTool, {
      query: 'a',
      system: 'RXNORM',
      chapter: 'scd',
    });
    const { codes } = result.structuredContent as SearchResult;
    expect(codes.map((row) => row.code).sort()).toEqual(['1049640', '198440']);
    expect(codes.every((row) => row.chapter === 'SCD' && row.shortDescription === null)).toBe(true);
  });

  it('names the missing billing concept when billableOnly meets RXNORM', async () => {
    const result = await runToolContract(searchCodesTool, {
      query: 'acetaminophen',
      system: 'RXNORM',
      billableOnly: true,
    });
    const page = result.structuredContent as SearchResult;
    expect(page.codes).toEqual([]);
    expect(page.notice).toMatch(/RxNorm has no billing concept/);
    expect(page.notice).not.toMatch(/Broaden the terms/);
    expect(textOf(result)).toContain(page.notice as string);
  });

  it('keeps the broaden-your-terms notice for an ordinary empty search', async () => {
    const result = await runToolContract(searchCodesTool, {
      query: 'zzzznotarealterm',
      system: 'RXNORM',
    });
    expect((result.structuredContent as SearchResult).notice).toMatch(/Broaden the terms/);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/45
  it('answers a term type the names do not hold with an ordinary empty search', async () => {
    for (const query of ['scd', 'SCD', 'bn']) {
      const result = await runToolContract(searchCodesTool, {
        query,
        system: 'RXNORM',
        limit: 1,
      });
      const page = result.structuredContent as SearchResult;
      expect(page.codes, query).toEqual([]);
      expect(page.truncated).toBe(false);
      expect(page.nextCursor).toBeUndefined();
      expect(page.notice).toMatch(/Broaden the terms/);
      expect(textOf(result)).toContain(page.notice as string);
    }
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/45
  it('discloses truncation over the name matches alone', async () => {
    // Two fixture names hold an "s" ("aspirin", "Aspirin 325 MG Oral Tablet"); the
    // SCD term type on 198440 no longer adds a third.
    const first = await runToolContract(searchCodesTool, {
      query: 's',
      system: 'RXNORM',
      limit: 1,
    });
    const page1 = first.structuredContent as SearchResult;
    expect(page1.codes.map((row) => row.code)).toEqual(['1049640']);
    expect(page1.truncated).toBe(true);

    const second = await runToolContract(searchCodesTool, {
      query: 's',
      system: 'RXNORM',
      limit: 1,
      cursor: page1.nextCursor as string,
    });
    const page2 = second.structuredContent as SearchResult;
    expect(page2.codes.map((row) => row.code)).toEqual(['1191']);
    expect(page2.truncated).toBe(false);
    expect(page2.nextCursor).toBeUndefined();
    expect(textOf(second)).toContain('aspirin');
  });

  it('rejects an out-of-range page size before any RxNorm lookup runs', async () => {
    const callRaw = runToolContract as unknown as (
      tool: unknown,
      args: Record<string, unknown>,
    ) => Promise<ToolResult>;
    const result = await callRaw(searchCodesTool, { query: 'a', system: 'RXNORM', limit: 0 });
    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error: { data?: { reason?: string } } }).error.data?.reason,
    ).toBe('invalid_arguments');
  });
});

describe('medcode_browse_hierarchy', () => {
  it('accepts and renders a code row from a system with no billing concept', () => {
    // RxNorm is flat, so browse never lists one of its concepts today; the row
    // schema is shared with the other decode surfaces and must not reject one.
    const out = browseHierarchyTool.output.parse({
      kind: 'codes',
      codes: [
        {
          system: 'RXNORM',
          code: '161',
          description: 'acetaminophen',
          shortDescription: null,
          billable: null,
          header: false,
          chapter: 'IN',
        },
      ],
      axes: [],
    });
    const text = (browseHierarchyTool.format?.(out) ?? [])
      .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
      .join('\n');
    expect(text).toContain(
      '- **161** (RxNorm; billable: n/a, header: no · chapter IN): acetaminophen',
    );
  });
});
