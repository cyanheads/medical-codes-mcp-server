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

import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
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
