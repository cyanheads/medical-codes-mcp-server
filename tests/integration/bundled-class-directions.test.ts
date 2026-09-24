/**
 * @fileoverview The rxcui_to_classes and class_to_rxcuis directions of
 * medcode_map_codes, and the class-layer provenance of medcode_list_systems,
 * against the shipped index — the acceptance cases of #34 on real RxClass data:
 * metformin's classes through its ingredient and precise ingredient, CSA
 * schedule II walked page by page, the largest result sets, and the brand name
 * and class that resolve with nothing to return.
 * @module tests/integration/bundled-class-directions.test
 */

import { Database } from 'bun:sqlite';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listSystemsTool } from '@/mcp-server/tools/definitions/list-systems.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import type { CodeIndexService } from '@/services/code-index/code-index-service.js';
import { ensureBundledIndex } from '../helpers/bundled-index.ts';

interface Hit {
  classType?: string;
  conceptType?: string;
  description?: string;
  relation?: string;
  source: string;
  system: string | null;
  value: string;
  via?: string;
}

interface Page {
  hits: Hit[];
  nextCursor?: string;
  notice?: string;
  shown?: number;
  truncated?: boolean;
}

/** Sends an argument bag as a client would. */
const call = runToolContract as unknown as (
  tool: unknown,
  args: Record<string, unknown>,
) => ReturnType<typeof runToolContract>;

function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content as { text?: string; type: string }[])
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n');
}

/** One call through the full contract, returning structuredContent and the content[] text. */
async function mapPage(args: Record<string, unknown>) {
  const result = await call(mapCodesTool, args);
  expect(result.isError, JSON.stringify(args)).toBeFalsy();
  return { page: result.structuredContent as Page, text: textOf(result) };
}

/** Walk a direction to its last page through `nextCursor`, returning every hit and the page count. */
async function walk(args: Record<string, unknown>): Promise<{ hits: Hit[]; pages: number }> {
  const hits: Hit[] = [];
  let pages = 0;
  let cursor: string | undefined;
  do {
    const { page } = await mapPage({ ...args, ...(cursor ? { cursor } : {}) });
    hits.push(...page.hits);
    pages += 1;
    cursor = page.nextCursor;
  } while (cursor);
  return { hits, pages };
}

const key = (h: Hit) => `${h.classType}|${h.value}|${h.source}|${h.relation}`;

let svc: CodeIndexService;
let db: Database;

beforeAll(async () => {
  svc = await ensureBundledIndex();
  db = new Database(svc.dbPath, { readonly: true });
});

afterAll(() => db.close());

describe('rxcui_to_classes on the shipped index', () => {
  it('gives metformin (6809) its FDA class Biguanide directly, and no VA or schedule class', async () => {
    const { hits } = await walk({ from: '6809', direction: 'rxcui_to_classes' });
    expect(hits).toContainEqual({
      source: 'FDASPL',
      system: null,
      value: 'N0000175565',
      description: 'Biguanide',
      classType: 'EPC',
      relation: 'has_epc',
    });
    expect(hits.some((h) => h.classType === 'VA' || h.classType === 'SCHEDULE')).toBe(false);
    expect(hits.every((h) => h.via === undefined)).toBe(true);
  });

  it('gives the 500 MG tablet (861007) its own VA class and its ingredient classes once each, via the IN', async () => {
    const { hits } = await walk({ from: '861007', direction: 'rxcui_to_classes' });
    expect(hits).toContainEqual(
      expect.objectContaining({
        value: 'N0000175565',
        classType: 'EPC',
        source: 'FDASPL',
        relation: 'has_epc',
        via: '6809',
      }),
    );
    const va = hits.find((h) => h.value === 'HS502');
    expect(va).toEqual({
      source: 'VA',
      system: null,
      value: 'HS502',
      description: 'ORAL HYPOGLYCEMIC AGENTS,ORAL',
      classType: 'VA',
      relation: 'has_vaclass',
    });
    // One hit per class × source × relation, although 6809 (IN) and 235743 (PIN)
    // both carry the MED-RT edges — and a hit reached through both names the IN.
    expect(new Set(hits.map(key)).size).toBe(hits.length);
    const pinEdges = db
      .query('SELECT class_type, class_id, source, relation FROM rxclass_edge WHERE rxcui = ?')
      .all('235743') as {
      class_id: string;
      class_type: string;
      relation: string;
      source: string;
    }[];
    expect(pinEdges.length).toBeGreaterThan(0);
    for (const e of pinEdges) {
      const reached = hits.filter(
        (h) =>
          h.classType === e.class_type &&
          h.value === e.class_id &&
          h.source === e.source &&
          h.relation === e.relation,
      );
      expect(reached, `${e.class_type} ${e.class_id} ${e.relation}`).toHaveLength(1);
      expect(reached[0]?.via).toBe('6809');
    }
    // Every class of the product is its own or its ingredients', never anything else.
    const own = db
      .query('SELECT COUNT(*) AS n FROM rxclass_edge WHERE rxcui = ?')
      .get('861007') as {
      n: number;
    };
    const viaIn = hits.filter((h) => h.via === '6809').length;
    expect(hits.length).toBe(own.n + viaIn);
  });

  it('renders every class field in content[] as well as structuredContent', async () => {
    const { page, text } = await mapPage({ from: '861007', direction: 'rxcui_to_classes' });
    expect(page.hits.length).toBeGreaterThan(0);
    for (const h of page.hits) {
      expect(text).toContain(`**${h.value}** via ${h.source} · ${h.classType} · ${h.relation}`);
      if (h.via) expect(text).toContain(`inherited via ingredient ${h.via}`);
    }
    expect(text).toContain('ci_with (contraindication)');
  });

  it('narrows to one class type with classType', async () => {
    const { page } = await mapPage({
      from: '861007',
      direction: 'rxcui_to_classes',
      classType: 'EPC',
    });
    expect(page.hits).toEqual([
      expect.objectContaining({ value: 'N0000175565', classType: 'EPC', via: '6809' }),
    ]);
  });

  it("never reads an ingredient's missing DEA schedule as unscheduled (oxycodone, 7804)", async () => {
    // RxClass records CSA schedules on drug products only; oxycodone's are Schedule II.
    const product = db
      .query(
        `SELECT r.rxcui FROM rxnorm_rel r JOIN rxclass_edge e ON e.rxcui = r.rxcui
          WHERE r.target = '7804' AND r.rel = 'has_ingredient' AND e.class_id = 'SCHEDULE2' LIMIT 1`,
      )
      .get() as { rxcui: string } | null;
    expect(product).not.toBeNull();
    const { page, text } = await mapPage({
      from: '7804',
      direction: 'rxcui_to_classes',
      classType: 'SCHEDULE',
    });
    expect(page.hits).toEqual([]);
    expect(page.notice).toContain('DEA schedules on drug products');
    expect(page.notice).toContain('does not mean it is unscheduled');
    expect(page.notice).toContain('name_to_rxcui');
    expect(text).toContain(page.notice as string);
    const scheduled = await mapPage({
      from: product?.rxcui,
      direction: 'rxcui_to_classes',
      classType: 'SCHEDULE',
    });
    expect(scheduled.page.hits).toEqual([
      expect.objectContaining({ value: 'SCHEDULE2', relation: 'has_schedule' }),
    ]);
  });

  it('returns an empty success with a notice for the brand name Glucophage (151827)', async () => {
    const { page, text } = await mapPage({ from: '151827', direction: 'rxcui_to_classes' });
    expect(page.hits).toEqual([]);
    expect(page.notice).toMatch(/Brand-name concepts carry no classes/);
    expect(text).toContain(page.notice as string);
  });

  it('pages the largest class set (1116179, 178 classes) to the same set a single page holds', async () => {
    const whole = await mapPage({ from: '1116179', direction: 'rxcui_to_classes', limit: 200 });
    expect(whole.page.hits).toHaveLength(178);
    expect(whole.page.truncated).toBe(false);
    const { hits, pages } = await walk({ from: '1116179', direction: 'rxcui_to_classes' });
    expect(pages).toBe(4); // the default page of 50
    expect(hits).toEqual(whole.page.hits);
  });
});

describe('class_to_rxcuis on the shipped index', () => {
  it('walks CSA schedule II through nextCursor to its 628 direct members', async () => {
    const { hits, pages } = await walk({ from: 'SCHEDULE2', direction: 'class_to_rxcuis' });
    expect(pages).toBe(13);
    expect(hits).toHaveLength(628);
    expect(new Set(hits.map((h) => h.value)).size).toBe(628);
    const members = db
      .query("SELECT COUNT(DISTINCT rxcui) AS n FROM rxclass_edge WHERE class_id = 'SCHEDULE2'")
      .get() as { n: number };
    expect(hits).toHaveLength(members.n);
    for (const h of hits) {
      expect(h).toMatchObject({
        system: 'RXNORM',
        classType: 'SCHEDULE',
        source: 'RXNORM',
        relation: 'has_schedule',
      });
      expect(h.description).toEqual(expect.any(String));
      expect(h.conceptType).toMatch(/^(SCD|SBD|GPCK|BPCK|IN|PIN)$/);
    }
  });

  it('lists metformin among the members of Biguanide (N0000175565), with or without classType EPC', async () => {
    const { hits } = await walk({ from: 'N0000175565', direction: 'class_to_rxcuis' });
    expect(hits).toContainEqual(
      expect.objectContaining({ value: '6809', description: 'metformin', conceptType: 'IN' }),
    );
    const narrowed = await walk({
      from: 'N0000175565',
      direction: 'class_to_rxcuis',
      classType: 'EPC',
    });
    expect(narrowed.hits).toEqual(hits);
    const other = await mapPage({
      from: 'N0000175565',
      direction: 'class_to_rxcuis',
      classType: 'MOA',
    });
    expect(other.page.hits).toEqual([]);
    expect(other.page.notice).toContain('is the EPC class "Biguanide", not a class of type MOA');
  });

  it('narrows a class ID two types share to the requested one', async () => {
    // D007126 names both a CHEM and a DISEASE class, neither with a direct member.
    const both = await mapPage({ from: 'D007126', direction: 'class_to_rxcuis' });
    expect(both.page.notice).toMatch(
      /the CHEM class ".+" and the DISEASE class ".+", neither of which has a direct member/,
    );
    const chem = await mapPage({
      from: 'D007126',
      direction: 'class_to_rxcuis',
      classType: 'CHEM',
    });
    expect(chem.page.notice).toMatch(/resolved to the CHEM class ".+", which has no direct member/);
    expect(chem.page.notice).not.toContain('DISEASE');
  });

  it('returns an empty success with a notice for Diuretic (N0000193873), whose members attach to subclasses', async () => {
    const { page, text } = await mapPage({ from: 'N0000193873', direction: 'class_to_rxcuis' });
    expect(page.hits).toEqual([]);
    expect(page.notice).toContain('the EPC class "Diuretic", which has no direct member');
    expect(text).toContain(page.notice as string);
  });

  it('walks the largest class (D004342, 3,181 edges) to completion at the page ceiling', async () => {
    const { hits, pages } = await walk({
      from: 'D004342',
      direction: 'class_to_rxcuis',
      limit: 200,
    });
    expect(pages).toBe(16);
    expect(hits).toHaveLength(3181);
    expect(new Set(hits.map((h) => `${h.value}|${h.source}|${h.relation}`)).size).toBe(3181);
  });

  it('resolves a CVX class ID, a bare integer, as a class', async () => {
    const { page } = await mapPage({ from: '03', direction: 'class_to_rxcuis' });
    expect(page.hits.length).toBeGreaterThan(0);
    expect(page.hits.every((h) => h.classType === 'CVX' && h.source === 'CDC')).toBe(true);
  });

  it('reads a one-digit CVX code as its zero-padded class ID (3 is CVX 03, MMR)', async () => {
    const padded = await mapPage({ from: '03', direction: 'class_to_rxcuis' });
    const bare = await mapPage({ from: '3', direction: 'class_to_rxcuis' });
    expect(bare.page.hits).toEqual(padded.page.hits);
  });
});

describe('class-direction misses on the shipped index', () => {
  it.each([
    [{ from: '99999999', direction: 'rxcui_to_classes' }, /No bundled code matches "99999999"/],
    [{ from: 'N0000999999', direction: 'class_to_rxcuis' }, /No bundled RxClass class has the ID/],
    [{ from: 'A10BA02', direction: 'class_to_rxcuis' }, /No bundled RxClass class has the ID/],
  ])('fails %j with no_mapping', async (args, message) => {
    const result = await call(mapCodesTool, args);
    const { error } = result.structuredContent as {
      error: { code: number; data?: { reason?: string }; message: string };
    };
    expect(error.code).toBe(JsonRpcErrorCode.NotFound);
    expect(error.data?.reason).toBe('no_mapping');
    expect(error.message).toMatch(message);
  });

  it('rejects classType on a direction that does not read it', async () => {
    const result = await call(mapCodesTool, {
      from: '861007',
      direction: 'rxcui_to_ingredients',
      classType: 'EPC',
    });
    const { error } = result.structuredContent as {
      error: { code: number; data?: { reason?: string } };
    };
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('field_not_applicable');
  });
});

describe('the shipped class layer holds only what #34 bundles', () => {
  it('holds no excluded source and no edge to an unbundled RXCUI', () => {
    expect(
      db
        .query(
          "SELECT COUNT(*) AS n FROM rxclass_edge WHERE source IN ('ATC', 'ATCPROD', 'SNOMEDCT', 'DAILYMED')",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .query(
          "SELECT COUNT(*) AS n FROM rxclass_edge e WHERE NOT EXISTS (SELECT 1 FROM codes c WHERE c.system = 'RXNORM' AND c.code = e.rxcui)",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
});

describe('medcode_list_systems on the shipped index', () => {
  it('reports the class layer with each source’s version and class count', async () => {
    const result = await call(listSystemsTool, {});
    const out = result.structuredContent as {
      classLayer: {
        classCount: number;
        edgeCount: number;
        sources: {
          classCount: number;
          edgeCount: number;
          source: string;
          version: string | null;
        }[];
      };
      systems: { system: string }[];
    };
    expect(out.systems.map((s) => s.system)).toEqual(['ICD10CM', 'ICD10PCS', 'HCPCS', 'RXNORM']);
    const stored = db
      .query('SELECT source, version, class_count, edge_count FROM rxclass_source')
      .all() as {
      class_count: number;
      edge_count: number;
      source: string;
      version: string | null;
    }[];
    expect(out.classLayer.sources.map((s) => s.source)).toEqual([
      'MEDRT',
      'FDASPL',
      'FMTSME',
      'VA',
      'RXNORM',
      'CDC',
    ]);
    for (const row of stored) {
      expect(out.classLayer.sources).toContainEqual(
        expect.objectContaining({
          source: row.source,
          version: row.version,
          classCount: row.class_count,
          edgeCount: row.edge_count,
        }),
      );
    }
    expect(out.classLayer.classCount).toBe(20_707);
    expect(out.classLayer.edgeCount).toBe(86_837);

    const text = textOf(result);
    expect(text).toContain('| MEDRT | 2026.07.06 | 5803 | 55590 |');
    expect(text).toContain('| CDC | none published | 113 | 983 |');
  });

  it('dates RxNorm by its RxNav snapshot, not the index build', async () => {
    const result = await call(listSystemsTool, {});
    const text = textOf(result);
    expect(text).toContain(
      '- **RxNorm** source: https://rxnav.nlm.nih.gov/ (RxNav snapshot fetched 2026-06-22T00:44:15.018Z)',
    );
  });
});
