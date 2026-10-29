/**
 * @fileoverview Multi-level hierarchy traversal for `medcode_browse_hierarchy`
 * and `medcode_map_codes`. Both tools are how an agent moves through a code
 * system it does not already know, and it moves more than one hop: browse to
 * find a category, browse again to reach its codes, map back up to confirm the
 * chain. A single-hop assertion cannot catch a walk that stalls, loops, or
 * changes shape below the first level — so the fixture's three-level
 * ICD-10-CM chain (A01 → A01.0 → A01.00) is walked end to end, in both
 * directions, on both the `structuredContent` and `content[]` surfaces.
 * @module tests/tools/hierarchy-traversal.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { encodeNextCursor } from '@/mcp-server/tools/definitions/_pagination.js';
import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import { ensureIndex } from '../helpers/index-fixture.ts';

/** The fixture's deepest ICD-10-CM chain, root-first. */
const CHAIN = ['A01', 'A01.0', 'A01.00'] as const;

interface BrowseResult {
  codes: { code: string; billable: boolean; header: boolean }[];
  kind: string;
  notice?: string;
  shown: number;
}

interface MapResult {
  hits: { system: string; value: string }[];
  notice?: string;
  resolvedSystem: string;
}

/** Flatten format() blocks into the text a content-only client would receive. */
function textOf(blocks: unknown): string {
  return (blocks as { text?: string; type: string }[])
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n');
}

async function browse(node?: string) {
  const result = await runToolContract(browseHierarchyTool, {
    system: 'ICD10CM',
    ...(node ? { node } : {}),
  });
  expect(result.isError).toBeFalsy();
  return {
    structured: result.structuredContent as unknown as BrowseResult,
    text: textOf(result.content),
  };
}

async function map(from: string, direction: 'children' | 'parents') {
  const result = await runToolContract(mapCodesTool, { from, direction, system: 'ICD10CM' });
  expect(result.isError).toBeFalsy();
  return {
    structured: result.structuredContent as unknown as MapResult,
    text: textOf(result.content),
  };
}

beforeAll(async () => {
  await ensureIndex();
});

describe('medcode_browse_hierarchy multi-level walk', () => {
  it('descends the full chain, one level at a time, without skipping or repeating', async () => {
    const top = await browse();
    expect(top.structured.codes.map((c) => c.code)).toContain(CHAIN[0]);

    // Each hop returns exactly the next link — never a grandchild pulled up a
    // level, and never the node itself echoed back as its own child.
    for (let i = 0; i < CHAIN.length - 1; i++) {
      const parent = CHAIN[i]!;
      const child = CHAIN[i + 1]!;
      const level = await browse(parent);
      expect(level.structured.kind).toBe('codes');
      expect(level.structured.codes.map((c) => c.code)).toEqual([child]);
      expect(level.structured.codes.map((c) => c.code)).not.toContain(parent);
      expect(level.structured.shown).toBe(1);
      // The text surface has to carry the same next hop, or a content-only
      // client cannot continue the walk it just started.
      expect(level.text).toContain(child);
    }
  });

  it('marks the billable leaf and the non-billable headers above it', async () => {
    const underRoot = await browse(CHAIN[0]);
    expect(underRoot.structured.codes[0]).toMatchObject({
      code: 'A01.0',
      header: true,
      billable: false,
    });
    expect(underRoot.text).toContain('billable: no, header: yes');

    const underMid = await browse(CHAIN[1]);
    expect(underMid.structured.codes[0]).toMatchObject({
      code: 'A01.00',
      header: false,
      billable: true,
    });
    expect(underMid.text).toContain('billable: yes, header: no');
  });

  it('terminates at the leaf with an empty page and a notice on both surfaces', async () => {
    const leaf = await browse(CHAIN[2]);
    expect(leaf.structured.codes).toEqual([]);
    expect(leaf.structured.shown).toBe(0);
    expect(leaf.structured.notice).toMatch(/leaf code/i);
    expect(leaf.text).toMatch(/leaf code/i);
  });
});

describe('medcode_map_codes multi-level walk', () => {
  it('climbs parents from the leaf to the root, one hop per call', async () => {
    for (let i = CHAIN.length - 1; i > 0; i--) {
      const child = CHAIN[i]!;
      const parent = CHAIN[i - 1]!;
      const hop = await map(child, 'parents');
      expect(hop.structured.resolvedSystem).toBe('ICD10CM');
      expect(hop.structured.hits.map((h) => h.value)).toEqual([parent]);
      expect(hop.text).toContain(parent);
    }

    const root = await map(CHAIN[0], 'parents');
    expect(root.structured.hits).toEqual([]);
    expect(root.structured.notice).toMatch(/top-level code with no parent/i);
    expect(root.text).toMatch(/top-level code with no parent/i);
  });

  it('descends children from the root to the leaf, mirroring the parents walk', async () => {
    for (let i = 0; i < CHAIN.length - 1; i++) {
      const parent = CHAIN[i]!;
      const child = CHAIN[i + 1]!;
      const hop = await map(parent, 'children');
      expect(hop.structured.hits.map((h) => h.value)).toEqual([child]);
      expect(hop.text).toContain(child);
    }

    const leaf = await map(CHAIN[2], 'children');
    expect(leaf.structured.hits).toEqual([]);
    expect(leaf.structured.notice).toMatch(/no children/i);
  });

  it('agrees with medcode_browse_hierarchy at every level of the chain', async () => {
    // Two independent code paths (browse pages the prefix hierarchy, map walks
    // the stored parent edge) must not disagree about the same tree, or an
    // agent that discovers a code one way and confirms it the other gets a
    // contradiction it has no way to resolve.
    for (const node of CHAIN.slice(0, -1)) {
      const browsed = await browse(node);
      const mapped = await map(node, 'children');
      expect(mapped.structured.hits.map((h) => h.value)).toEqual(
        browsed.structured.codes.map((c) => c.code),
      );
    }
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/44
  it('ends a walk from an RxNorm concept at once, and points to the drug directions', async () => {
    // RxNorm has no prefix hierarchy, so "top-level" and "leaf" would both be
    // claims about a tree that does not exist.
    for (const direction of ['parents', 'children'] as const) {
      const result = await runToolContract(mapCodesTool, { from: '161', direction });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as unknown as MapResult;
      expect(structured.resolvedSystem).toBe('RXNORM');
      expect(structured.hits).toEqual([]);
      const text = textOf(result.content);
      for (const surface of [structured.notice ?? '', text]) {
        expect(surface).toContain('RxNorm concepts have no code hierarchy');
        expect(surface).toMatch(/rxcui_to_ingredients.*rxcui_to_brands.*rxcui_to_ndc/);
        expect(surface).not.toMatch(/top-level code|leaf code/);
      }
    }
  });

  it('round-trips: the parent of each child is the node the child came from', async () => {
    for (const node of CHAIN.slice(0, -1)) {
      const children = await map(node, 'children');
      for (const hit of children.structured.hits) {
        const back = await map(hit.value, 'parents');
        expect(back.structured.hits.map((h) => h.value)).toEqual([node]);
      }
    }
  });
});

/** Run a tool through its full contract (input parse, handler, output parse, format). */
async function run(
  def:
    | typeof mapCodesTool
    | typeof browseHierarchyTool
    | typeof getCodeTool
    | typeof checkCodeTool
    | typeof searchCodesTool,
  input: Record<string, unknown>,
) {
  const result = await runToolContract(def as typeof mapCodesTool, input as never);
  return {
    isError: result.isError === true,
    structured: result.structuredContent as unknown as Record<string, unknown>,
    text: textOf(result.content),
  };
}

/** Every page of a children walk, following only the emitted cursors. */
async function walkChildren(from: string, system: string, limit: number) {
  const pages: { values: string[]; text: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await run(mapCodesTool, {
      from,
      direction: 'children',
      system,
      limit,
      ...(cursor ? { cursor } : {}),
    });
    expect(page.isError).toBe(false);
    const hits = page.structured.hits as MapResult['hits'];
    pages.push({ values: hits.map((h) => h.value), text: page.text });
    cursor = page.structured.nextCursor as string | undefined;
  } while (cursor);
  return pages;
}

describe('hierarchy derivations that stay as they are', () => {
  it('keeps the parent and siblings of a code whose stored parent is itself a code', async () => {
    // T36.0X is a placeholder level that IS a bundled code, so nothing is skipped.
    const chain = ['T36', 'T36.0', 'T36.0X', 'T36.0X1', 'T36.0X1A'];
    for (let i = chain.length - 1; i > 0; i--) {
      const hop = await map(chain[i]!, 'parents');
      expect(hop.structured.hits.map((h) => h.value)).toEqual([chain[i - 1]]);
      const siblings = await map(chain[i - 1]!, 'children');
      expect(siblings.structured.hits.map((h) => h.value)).toEqual([chain[i]]);
    }
  });

  it('keeps every ICD-10-PCS browse node on the section-only axes result', async () => {
    for (const node of ['0', '0D', '0DT', '0DTJ', '0DTJ4ZZ']) {
      const out = await run(browseHierarchyTool, { system: 'ICD10PCS', node });
      expect(out.isError).toBe(false);
      expect(out.structured).toMatchObject({ kind: 'axes', codes: [], axes: [] });
    }
  });

  it('keeps sections, body systems, and partial codes off the code hierarchy', async () => {
    // Reasons only: the wording of these misses is not the hierarchy's to fix.
    const reasonOf = (out: Awaited<ReturnType<typeof run>>) => {
      expect(out.isError).toBe(true);
      return (out.structured.error as { data: { reason: string } }).data.reason;
    };
    for (const from of ['0', '0D', '0DTJ']) {
      for (const direction of ['parents', 'children'] as const) {
        const out = await run(mapCodesTool, { from, direction, system: 'ICD10PCS' });
        expect(reasonOf(out)).toBe('no_mapping');
        expect(out.text).toContain('no_mapping');
      }
      const decoded = await run(getCodeTool, { codes: [from], system: 'ICD10PCS' });
      expect(reasonOf(decoded)).toBe('no_codes_found');
      const checked = await run(checkCodeTool, { code: from, system: 'ICD10PCS' });
      expect(reasonOf(checked)).toBe('unknown_code');
    }
  });

  it('walks B00 without a system as the ICD-10-CM category, naming the PCS table row', async () => {
    const out = await run(mapCodesTool, { from: 'B00', direction: 'children' });
    expect(out.structured).toMatchObject({
      resolvedSystem: 'ICD10CM',
      alsoInSystems: ['ICD10PCS'],
    });
    expect(out.text).toContain('**Also in:** ICD10PCS');
  });
});

/** A cursor whose page starts at `offset`, as a prior page of `limit` would emit it. */
function cursorAt(offset: number, limit: number): string {
  return encodeNextCursor({ offset: offset - limit, limit });
}

// https://github.com/cyanheads/medical-codes-mcp-server/issues/66
describe('ICD-10-PCS table rows and their complete codes', () => {
  /** The fixture's complete codes beginning `0DT`, in code order. */
  const TABLE_0DT = ['0DTJ0ZZ', '0DTJ4ZZ'];

  it('walks section → table row → complete codes → back up to the table row', async () => {
    const sections = await run(browseHierarchyTool, { system: 'ICD10PCS' });
    expect((sections.structured.axes as { value: string }[]).map((a) => a.value)).toContain('0');

    // A section is not a code, so the walk enters at a table row: browse names the
    // hop, and map_codes takes it, one code per page through the emitted cursors.
    const section = await run(browseHierarchyTool, { system: 'ICD10PCS', node: '0' });
    const table = await run(browseHierarchyTool, { system: 'ICD10PCS', node: '0DT' });
    for (const out of [section, table]) {
      for (const surface of [out.structured.notice as string, out.text]) {
        expect(surface).toContain('medcode_map_codes');
        expect(surface).toMatch(/direction children/);
        expect(surface).not.toMatch(/axis breakdown/);
      }
    }
    expect(table.structured.notice).toContain('"0DT" is an ICD-10-PCS table row');

    const pages = await walkChildren('0DT', 'ICD10PCS', 1);
    expect(pages.map((p) => p.values)).toEqual(TABLE_0DT.map((code) => [code]));
    for (const [i, page] of pages.entries()) expect(page.text).toContain(TABLE_0DT[i]);

    for (const code of TABLE_0DT) {
      const up = await run(mapCodesTool, { from: code, direction: 'parents' });
      expect(up.structured).toMatchObject({
        resolvedSystem: 'ICD10PCS',
        hits: [
          {
            system: 'ICD10PCS',
            value: '0DT',
            description: 'Gastrointestinal System, Resection',
          },
        ],
      });
      expect(up.text).toContain('**0DT** (ICD10PCS)');
    }

    const top = await run(mapCodesTool, { from: '0DT', direction: 'parents' });
    expect(top.structured.hits).toEqual([]);
    for (const surface of [top.structured.notice as string, top.text]) {
      expect(surface).toMatch(/table row/);
      expect(surface).not.toMatch(/no prefix parent|axis-based/);
    }
  });

  it('separates a page past the last code from a table row with no codes', async () => {
    const past = await run(mapCodesTool, {
      from: '0DT',
      direction: 'children',
      cursor: cursorAt(5, 1),
    });
    expect(past.structured.hits).toEqual([]);
    expect(past.structured.notice).toMatch(/starts past the last children result/);

    // A complete code has no children of its own — a true leaf, worded as one.
    const leaf = await run(mapCodesTool, { from: '0DTJ4ZZ', direction: 'children' });
    expect(leaf.structured.hits).toEqual([]);
    expect(leaf.structured.notice).toMatch(/leaf code with no children/);
  });

  it('attaches a table row’s codes and a complete code’s table row on get_code', async () => {
    const out = await run(getCodeTool, { codes: ['0DT', '0DTJ4ZZ'], includeHierarchy: true });
    const [table, code] = out.structured.found as Record<string, unknown>[];
    expect(table).toMatchObject({
      code: '0DT',
      header: true,
      billable: false,
      parent: null,
      childrenTruncated: false,
      children: TABLE_0DT.map((child) => expect.objectContaining({ code: child })),
    });
    expect(code).toMatchObject({
      code: '0DTJ4ZZ',
      header: false,
      parent: '0DT',
      children: [],
      childrenTruncated: false,
    });
    expect(out.text).toContain('**Parent:** 0DT');
    expect(out.text).toContain('header: yes');
  });

  it('checks a table row as a header, as a HCPCS range bucket checks', async () => {
    for (const [code, system] of [
      ['0DT', undefined],
      ['B00', 'ICD10PCS'],
      ['J', undefined],
    ] as const) {
      const out = await run(checkCodeTool, { code, ...(system ? { system } : {}) });
      expect(out.structured).toMatchObject({ code, status: 'valid_header', billable: false });
      expect(out.text).toContain('Valid category/header — not billable');
    }
  });

  it('walks B00 in ICD-10-PCS only when the system says so', async () => {
    const pcs = await run(mapCodesTool, { from: 'B00', direction: 'children', system: 'ICD10PCS' });
    expect(pcs.structured).toMatchObject({
      resolvedSystem: 'ICD10PCS',
      alsoInSystems: ['ICD10CM'],
      hits: [{ system: 'ICD10PCS', value: 'B00B0ZZ' }],
    });
    const back = await run(mapCodesTool, { from: 'B00B0ZZ', direction: 'parents' });
    expect(back.structured.hits).toMatchObject([{ system: 'ICD10PCS', value: 'B00' }]);
  });

  it('tells a partial node where a table row comes from, and the search reaches one', async () => {
    // A section, body system, or 4–6-character partial holds no table row to pass on,
    // so the notice must say how to find one, not only what to do with one.
    for (const node of ['0', '0D', '0DTJ']) {
      const out = await run(browseHierarchyTool, { system: 'ICD10PCS', node });
      for (const surface of [out.structured.notice as string, out.text]) {
        expect(surface, node).toContain('find one by description with medcode_search_codes');
      }
    }
    const found = await run(searchCodesTool, {
      query: 'Gastrointestinal System, Resection',
      system: 'ICD10PCS',
    });
    const codes = (found.structured.codes as { code: string }[]).map((r) => r.code);
    expect(codes).toContain('0DT');
    const walked = await walkChildren('0DT', 'ICD10PCS', 50);
    expect(walked.flatMap((p) => p.values)).toEqual(['0DTJ0ZZ', '0DTJ4ZZ']);
  });

  it('decodes a complete code to its title, never promising an axis breakdown', async () => {
    const complete = await run(browseHierarchyTool, { system: 'ICD10PCS', node: '0DTJ4ZZ' });
    for (const surface of [complete.structured.notice as string, complete.text]) {
      expect(surface).toMatch(/complete 7-character/);
      expect(surface).toMatch(/title/);
      expect(surface).not.toMatch(/axis breakdown/);
    }
  });
});

// https://github.com/cyanheads/medical-codes-mcp-server/issues/72
describe('ICD-10-CM levels padded with the placeholder X', () => {
  it('walks category → … → a code below a padding level that is not a code, and back', async () => {
    const chain = ['S82', 'S82.6', 'S82.66'];
    for (let i = 0; i < chain.length - 1; i++) {
      expect((await browse(chain[i])).structured.codes.map((c) => c.code)).toContain(chain[i + 1]);
    }
    const below = await browse('S82.66');
    expect(below.structured.codes.map((c) => c.code)).toEqual(['S82.66XA', 'S82.66XB']);
    expect(below.text).toContain('S82.66XA');

    for (const code of ['S82.66XA', 'S82.66XB']) {
      const up = await map(code, 'parents');
      expect(up.structured.hits.map((h) => h.value)).toEqual(['S82.66']);
      expect(up.text).toContain('**S82.66** (ICD10CM)');
    }
    const mapped = await map('S82.66', 'children');
    expect(mapped.structured.hits.map((h) => h.value)).toEqual(['S82.66XA', 'S82.66XB']);
  });

  it('reports a parent get_code can decode', async () => {
    const out = await run(getCodeTool, { codes: ['S82.66XA', 'O32.0XX1'], includeHierarchy: true });
    const parents = (out.structured.found as { parent: string }[]).map((c) => c.parent);
    expect(parents).toEqual(['S82.66', 'O32.0']);
    expect(out.text).toContain('**Parent:** S82.66');
    const decoded = await run(getCodeTool, { codes: parents });
    expect(decoded.structured.notFound).toEqual([]);

    const parent = await run(getCodeTool, { codes: ['S82.66'], includeHierarchy: true });
    expect(parent.structured.found).toMatchObject([
      {
        children: ['S82.66XA', 'S82.66XB'].map((child) => expect.objectContaining({ code: child })),
      },
    ]);
  });

  it('orders a child set merged across a two-level padding as one, page by page', async () => {
    // O32.0's direct children sort on either side of the codes below O32.0XX: the
    // walk must interleave them by code, not list one source after the other.
    const merged = ['O32.01', 'O32.0XX0', 'O32.0XX1', 'O32.0Z'];
    const pages = await walkChildren('O32.0', 'ICD10CM', 1);
    expect(pages.map((p) => p.values)).toEqual(merged.map((code) => [code]));
    const twoPerPage = await walkChildren('O32.0', 'ICD10CM', 3);
    expect(twoPerPage.map((p) => p.values)).toEqual([merged.slice(0, 3), merged.slice(3)]);
    expect((await browse('O32.0')).structured.codes.map((c) => c.code)).toEqual(merged);

    for (const code of merged) {
      expect((await map(code, 'parents')).structured.hits.map((h) => h.value)).toEqual(['O32.0']);
    }

    const past = await run(mapCodesTool, {
      from: 'O32.0',
      direction: 'children',
      cursor: cursorAt(4, 2),
    });
    expect(past.structured.hits).toEqual([]);
    expect(past.structured.notice).toMatch(/starts past the last children result/);
  });
});
