/**
 * @fileoverview The `content[]` surface every tool renders through `format()`.
 * Text-only clients (Claude Desktop) never see `structuredContent`, so anything
 * the model needs to act on — codes, descriptions, flags, provenance, hierarchy,
 * failures — has to survive into the markdown. Asserted per tool against the
 * fixture index, plus the sparse/edge shapes the handler cannot produce on demand.
 * @module tests/tools/format-rendering.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { literal, literalAtHeadingEnd, tableRow } from '@/mcp-server/tools/definitions/_render.js';
import { browseHierarchyTool } from '@/mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from '@/mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';
import { listSystemsTool } from '@/mcp-server/tools/definitions/list-systems.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from '@/mcp-server/tools/definitions/search-codes.tool.js';
import { readCommonMark } from '../helpers/commonmark.ts';
import { ensureIndex } from '../helpers/index-fixture.ts';

/** Flatten format() blocks into the text a content-only client would receive. */
function textOf(blocks: { text?: string; type: string }[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : [])).join('\n');
}

/**
 * A value carrying every construct CommonMark (with GFM tables) could read as
 * syntax: emphasis, an intraword-safe underscore pair, a code span, a link, a
 * table pipe, inline HTML, a backslash before punctuation and before a letter,
 * and a trailing ` #` an ATX heading would drop as its closing sequence. `lead`
 * opens the value with a list marker or a heading marker, for values that start
 * a line of their own. `tag` keeps each field's value distinct.
 */
function hazard(tag: string, lead: '-' | '#' = '-'): string {
  return `${lead} *${tag}* _u_ \`t\` [x](y) a|b <b>h</b> c:\\* \\q #`;
}

/** Assert a CommonMark parse of `text` reads every value back exactly as written. */
function expectReadsBack(text: string, values: readonly (string | null | undefined)[]): void {
  const read = readCommonMark(text);
  for (const value of values) {
    if (value) expect(read).toContain(value);
  }
}

beforeAll(async () => {
  await ensureIndex();
});

/**
 * The rendering seam every tool routes untrusted text through, tabled once in each
 * Markdown position it serves; the per-tool cases below prove only the wiring.
 */
describe('the _render literal seam', () => {
  const VALUES = [
    hazard('lead-dash'),
    hazard('lead-hash', '#'),
    'plain text stays plain',
    'on-q* pump',
    'aspirin 325 MG Oral Tablet [Bayer Aspirin]',
    'Pack [Kit < 40 KG]',
    ' edge spaces ',
    'ends in a backslash \\',
  ];

  it.each(VALUES)('reads %j back inside a bold label, a list item, and a paragraph', (value) => {
    expectReadsBack(`- **${literal(value)}**: ${literal(value)}`, [
      `⟨strong⟩${value}⟨/strong⟩: ${value}`,
    ]);
    expect(readCommonMark(literal(value))).toBe(value);
  });

  it('leaves plain text byte-identical', () => {
    expect(literal('Type 2 diabetes mellitus, snake_case <=50 AT&T')).toBe(
      'Type 2 diabetes mellitus, snake_case <=50 AT&T',
    );
  });

  it.each([
    ...VALUES,
    'foo #',
    '#',
    '##',
    '# lead and close #',
    'escaped hash \\#',
    'two backslashes \\\\#',
    'C#',
  ])('keeps %j whole at the end of a heading', (value) => {
    expect(readCommonMark(`## parents: ${literalAtHeadingEnd(value)}`)).toBe(
      `⟨heading_open⟩\n\nparents: ${value}\n\n⟨heading_close⟩`,
    );
  });

  it('renders table cells that keep their pipes and render numbers as themselves', () => {
    const value = hazard('cell', '#');
    const read = readCommonMark(`| A | B |\n|:--|--:|\n${tableRow([value, 42])}`);
    expect(read).toContain(`⟨td_open⟩\n\n${value}\n\n⟨td_close⟩`);
    expect(read).toContain('⟨td_open⟩\n\n42\n\n⟨td_close⟩');
    expect(tableRow(['ICD-10-CM (ICD10CM)', 'FY2027', 74_719])).toBe(
      '| ICD-10-CM (ICD10CM) | FY2027 | 74719 |',
    );
  });

  it('reads a URL back as the same text', () => {
    const url = 'https://www.cms.gov/files/zip/a_b_c.zip?x=1&amp=2';
    expect(readCommonMark(literal(url))).toBe(url);
  });

  /**
   * literalAtHeadingEnd walks the trailing backslash run before a final `#`; with
   * the escape it wraps, its cost must stay linear in the value's length. Each
   * shape doubles from its start size over a 64× span, checking an absolute CPU
   * bound at every size before the next and the full-span ratio at the end. The
   * digit run carries the span to 320k; the others stay at or below 80k.
   */
  it.each([
    ['a long digit run', 5_000, (n: number) => `${'7'.repeat(n)} #`],
    ['a backslash run before a closing hash', 1_250, (n: number) => `${'\\'.repeat(n)}#`],
    ['a run of hashes', 1_250, (n: number) => '#'.repeat(n)],
    ['one long line ending in a break', 1_250, (n: number) => `${'§1 x'.repeat(n / 4)}\ny #`],
    ['breaks throughout', 1_250, (n: number) => `${'  \r\n'.repeat(n / 4)}#`],
  ] as const)('timing: stays linear on %s', (_shape, start, make) => {
    const TRIALS = 3;
    const REPS = 5;
    const cpuMs = (value: string): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let trial = 0; trial < TRIALS; trial++) {
        const before = process.threadCpuUsage();
        for (let rep = 0; rep < REPS; rep++) literalAtHeadingEnd(value);
        const spent = process.threadCpuUsage(before);
        best = Math.min(best, (spent.user + spent.system) / 1000);
      }
      return best;
    };
    cpuMs(make(start)); // warm up
    const first = cpuMs(make(start));
    let last = first;
    for (let n = start * 2; n <= start * 64; n *= 2) {
      last = cpuMs(make(n));
      // 200 ms of thread CPU per call at most, at every size.
      expect(last).toBeLessThan(200 * REPS);
    }
    expect(last / Math.max(first, 0.05)).toBeLessThan(256);
  });
});

describe('content[] reads back what structuredContent carries', () => {
  it('get_code renders every decoded field and every miss as written', () => {
    const out = getCodeTool.output.parse({
      found: [
        {
          system: 'ICD10CM',
          code: hazard('code'),
          description: hazard('description', '#'),
          shortDescription: hazard('short'),
          billable: false,
          header: true,
          chapter: hazard('chapter'),
          parent: hazard('parent'),
          children: [
            {
              system: 'ICD10CM',
              code: hazard('child-code'),
              description: hazard('child-description'),
              shortDescription: hazard('child-short'),
              billable: true,
              header: false,
              chapter: hazard('child-chapter'),
            },
          ],
          childrenTruncated: false,
        },
      ],
      notFound: [{ code: hazard('missing'), reason: hazard('reason', '#') }],
    });
    const found = out.found[0];
    const child = found?.children?.[0];
    expectReadsBack(textOf(getCodeTool.format!(out)), [
      found?.code,
      found?.description,
      found?.shortDescription,
      found?.chapter,
      found?.parent,
      child?.code,
      child?.description,
      child?.shortDescription,
      child?.chapter,
      out.notFound[0]?.code,
      out.notFound[0]?.reason,
    ]);
  });

  it('get_code echoes caller codes and the reasons that quote them as written', async () => {
    const result = await runToolContract(getCodeTool, {
      codes: ['E11.9', '*Q*', '[x](y)', '<b>z</b>', '`t`', 'a|b'],
    } as never);
    const { notFound } = result.structuredContent as {
      notFound: { code: string; reason: string }[];
    };
    // structuredContent echoes each code, and the reason quoting it, as sent.
    const sent = ['*Q*', '[x](y)', '<b>z</b>', '`t`', 'a|b'];
    expect(notFound.map((miss) => miss.code)).toEqual(sent);
    for (const [i, miss] of notFound.entries()) expect(miss.reason).toContain(`"${sent[i]}"`);
    expectReadsBack(
      textOf(result.content as { text?: string; type: string }[]),
      notFound.flatMap((miss) => [miss.code, miss.reason]),
    );
  });

  it('search_codes renders each row, and the empty-result notice and filters echo the caller', async () => {
    const out = searchCodesTool.output.parse({
      codes: [
        {
          system: 'HCPCS',
          code: hazard('code'),
          description: hazard('description'),
          shortDescription: hazard('short'),
          billable: true,
          header: false,
          chapter: hazard('chapter'),
        },
      ],
    });
    const row = out.codes[0];
    expectReadsBack(textOf(searchCodesTool.format!(out)), [
      row?.code,
      row?.description,
      row?.shortDescription,
      row?.chapter,
    ]);

    const query = 'zzqx*nomatch* [x](y) `t` <b>h</b>';
    const result = await runToolContract(searchCodesTool, { query, chapter: 'c*|_d_' } as never);
    const page = result.structuredContent as {
      appliedFilters: { chapter: string };
      notice?: string;
    };
    expect(page.appliedFilters.chapter).toBe('C*|_D_');
    // structuredContent quotes the caller's query as sent; content[] reads the whole notice back.
    expect(page.notice).toContain(`No codes matched "${query}"`);
    expectReadsBack(textOf(result.content as { text?: string; type: string }[]), [
      page.notice,
      'chapter=C*|_D_',
    ]);
  });

  it('check_code renders the code and its why-not as written', () => {
    const out = checkCodeTool.output.parse({
      system: 'HCPCS',
      code: hazard('code'),
      status: 'terminated',
      billable: false,
      whyNot: hazard('why-not', '#'),
    });
    expectReadsBack(textOf(checkCodeTool.format!(out)), [out.code, out.whyNot]);
  });

  it('map_codes renders the source and every hit field as written', () => {
    const out = mapCodesTool.output.parse({
      from: hazard('from'),
      direction: 'rxcui_to_classes',
      resolvedSystem: 'RXNORM',
      hits: [
        {
          source: hazard('source'),
          system: null,
          value: hazard('value'),
          description: hazard('description'),
          conceptType: hazard('concept-type'),
          classType: 'EPC',
          relation: hazard('relation'),
          via: hazard('via'),
        },
      ],
    });
    const hit = out.hits[0];
    expectReadsBack(textOf(mapCodesTool.format!(out)), [
      out.from,
      hit?.source,
      hit?.value,
      hit?.description,
      hit?.conceptType,
      hit?.relation,
      hit?.via,
    ]);
  });

  it('browse_hierarchy renders child codes and axis table cells as written', () => {
    const out = browseHierarchyTool.output.parse({
      kind: 'axes',
      codes: [
        {
          system: 'HCPCS',
          code: hazard('code'),
          description: hazard('description'),
          shortDescription: hazard('short'),
          billable: false,
          header: true,
          chapter: hazard('chapter'),
        },
      ],
      axes: [{ position: 1, value: hazard('value'), meaning: hazard('meaning', '#') }],
    });
    const row = out.codes[0];
    expectReadsBack(textOf(browseHierarchyTool.format!(out)), [
      row?.code,
      row?.description,
      row?.shortDescription,
      row?.chapter,
      out.axes[0]?.value,
      out.axes[0]?.meaning,
    ]);
  });

  // The notice wiring, one case per tool that quotes input or data in it (search_codes above).
  it.each([
    [
      'browse_hierarchy',
      browseHierarchyTool,
      { system: 'ICD10CM', node: 'A00.0' },
      'No children under "A00.0" in ICD10CM — it may be a leaf code. Omit node to list the top level, or browse a parent category.',
    ],
    [
      'map_codes',
      mapCodesTool,
      { from: 'N0000008836', direction: 'class_to_rxcuis', classType: 'EPC' },
      '"N0000008836" is the PE class "Decreased Prostaglandin Production", not a class of type EPC. Re-call with classType "PE", or omit classType.',
    ],
  ] as const)(
    '%s carries its notice as written on both surfaces',
    async (_tool, def, args, notice) => {
      const result = await runToolContract(def as never, args as never);
      expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
      expectReadsBack(textOf(result.content as { text?: string; type: string }[]), [notice]);
    },
  );

  // A notice is escaped whole for content[], so a backtick in it would read back literally.
  it.each([
    [searchCodesTool, { query: 'fluoxetine', system: 'RXNORM', billableOnly: true }],
    [browseHierarchyTool, { system: 'ICD10PCS', node: '0DTJ4ZZ' }],
    [browseHierarchyTool, { system: 'ICD10PCS', node: '0DT' }],
    [browseHierarchyTool, { system: 'ICD10CM', node: 'A00.0' }],
    [mapCodesTool, { from: '161', direction: 'rxcui_to_classes', classType: 'EPC' }],
    [mapCodesTool, { from: 'N0000008836', direction: 'class_to_rxcuis', classType: 'EPC' }],
    [
      mapCodesTool,
      {
        from: 'N0000008836',
        direction: 'class_to_rxcuis',
        cursor: Buffer.from(JSON.stringify({ offset: 50, limit: 1 })).toString('base64url'),
      },
    ],
  ] as const)('names fields in plain text in the notice for %#', async (def, args) => {
    const result = await runToolContract(def as never, args as never);
    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toMatch(/\b(billableOnly|node|classType|cursor)\b/);
    expect(notice).not.toContain('`');
  });

  it('list_systems renders release metadata and table cells as written, and source URLs as links', () => {
    const out = listSystemsTool.output.parse({
      systems: [
        {
          system: 'HCPCS',
          label: 'HCPCS Level II',
          releaseId: hazard('release'),
          effectiveStart: hazard('start'),
          effectiveEnd: hazard('end'),
          codeCount: 3,
          sourceUrl: 'https://www.cms.gov/files/zip/a_b_c.zip?x=1&amp=2',
          builtAt: hazard('built'),
        },
      ],
      classLayer: {
        classCount: 2,
        edgeCount: 5,
        sourceUrl: 'https://rxnav.nlm.nih.gov/REST/rxclass/',
        sources: [
          {
            source: hazard('source'),
            version: hazard('version'),
            classCount: 2,
            edgeCount: 5,
            fetchedAt: hazard('fetched'),
          },
        ],
      },
    });
    const system = out.systems[0];
    const source = out.classLayer?.sources[0];
    expectReadsBack(textOf(listSystemsTool.format!(out)), [
      system?.releaseId,
      system?.effectiveStart,
      system?.effectiveEnd,
      '⟨a⟩https://www.cms.gov/files/zip/a_b_c.zip?x=1&amp=2⟨/a⟩',
      system?.builtAt,
      '⟨a⟩https://rxnav.nlm.nih.gov/REST/rxclass/⟨/a⟩',
      source?.source,
      source?.version,
      source?.fetchedAt,
    ]);
  });
});

describe('medcode_get_code format', () => {
  it('renders a root code with its hierarchy, flags, and both descriptions', async () => {
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['E11'], includeHierarchy: true }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    const text = textOf(getCodeTool.format!(out));

    expect(text).toContain('## E11 — ICD-10-CM');
    expect(text).toContain('billable: no, header: yes');
    expect(text).toContain('Type 2 diabetes mellitus');
    expect(text).toContain('**Parent:** (none — root)');
    expect(text).toContain('**Children (1):**');
    // A complete child list says so, so the text path never leaves the caller
    // guessing whether more children were withheld.
    expect(text).toContain('_Complete: no further children exist beyond those listed._');
    // Every child the structured path carries must be named in the text too.
    for (const child of out.found[0]?.children ?? []) expect(text).toContain(child.code);
  });

  it('names the immediate parent of a non-root code', async () => {
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['E11.9'], includeHierarchy: true }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    const text = textOf(getCodeTool.format!(out));
    expect(text).toContain('**Parent:** E11');
    // Short description differs from the long one here, so both must render.
    expect(text).toContain('Type 2 diabetes mellitus without complications');
    expect(text).toContain('_Short:_ Type 2 diab w/o complications');
  });

  it('discloses the NDC resolution path and the unresolved codes with their reasons', async () => {
    const out = await getCodeTool.handler(
      getCodeTool.input.parse({ codes: ['11111-2222-33', 'A0100', '99999-8888-77'] }),
      createMockContext({ errors: getCodeTool.errors }),
    );
    const text = textOf(getCodeTool.format!(out));

    expect(text).toContain('**Resolved via:** NDC');
    expect(text).toContain('### Not found (2)');
    // The ambiguous code must carry its candidate systems, or the caller cannot
    // re-issue the disambiguated call from the text path alone.
    expect(text).toContain('**A0100**');
    expect(text).toContain('[ICD10CM, HCPCS]');
    expect(text).toContain('**99999-8888-77**');
    expect(text).toMatch(/valid NDC format/i);
  });

  it('discloses a truncated child list rather than presenting it as complete', () => {
    const out = getCodeTool.output.parse({
      found: [
        {
          system: 'ICD10CM',
          code: 'A00',
          description: 'Cholera',
          shortDescription: 'Cholera',
          billable: false,
          header: true,
          chapter: 'A',
          parent: null,
          children: [
            {
              system: 'ICD10CM',
              code: 'A00.0',
              description: null,
              shortDescription: null,
              billable: true,
              header: false,
              chapter: null,
            },
          ],
          childrenTruncated: true,
        },
      ],
      notFound: [],
    });
    const text = textOf(getCodeTool.format!(out));

    expect(text).toContain('**Children (1):**');
    expect(text).toMatch(/More children exist/i);
    expect(text).toContain('medcode_browse_hierarchy');
    // The truncated and complete states are mutually exclusive renders — a caller
    // must never see both, or the disclosure is worthless.
    expect(text).not.toMatch(/^_Complete:/m);
    // A row with neither description must say so, not render an empty gap.
    expect(text).toContain('(no description)');
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/66
  it('points a truncated ICD-10-PCS table row at map_codes under its own system', () => {
    // 61 table rows (B00) are also ICD-10-CM categories, so a walk without the system
    // would list the ICD-10-CM category's children instead.
    const out = getCodeTool.output.parse({
      found: [
        {
          system: 'ICD10PCS',
          code: 'B00',
          description: 'Imaging, Central Nervous System, Plain Radiography',
          shortDescription: 'Imaging, Central Nervous System, Plain Radiography',
          billable: false,
          header: true,
          chapter: 'B',
          parent: null,
          children: [
            {
              system: 'ICD10PCS',
              code: 'B00B0ZZ',
              description: 'Plain Radiography of Spinal Cord using High Osmolar Contrast',
              shortDescription: null,
              billable: true,
              header: false,
              chapter: 'B',
            },
          ],
          childrenTruncated: true,
        },
      ],
      notFound: [],
    });
    const text = textOf(getCodeTool.format!(out));
    expect(text).toContain(
      '_More children exist beyond those shown — retrieve them with medcode_map_codes (direction children, system ICD10PCS)._',
    );
    // browse_hierarchy lists only the PCS sections, never a table row's codes.
    expect(text).not.toContain('medcode_browse_hierarchy');
  });

  it('renders a description-less, chapter-less code without emitting empty fields', () => {
    // RxNorm has no billing concept, so its `billable` is null — rendered as n/a,
    // never as the literal `null` and never as a "no" verdict (#37).
    const out = getCodeTool.output.parse({
      found: [
        {
          system: 'RXNORM',
          code: '161',
          description: null,
          shortDescription: null,
          billable: null,
          header: false,
          chapter: null,
        },
      ],
      notFound: [],
    });
    const text = textOf(getCodeTool.format!(out));

    expect(text).toContain('## 161 — RxNorm');
    expect(text).toContain('billable: n/a, header: no');
    expect(text).toContain('(no description)');
    expect(text).not.toContain('chapter');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  // A batch under the byte budget (#68) answers byte for byte as it always has:
  // blocks a blank line apart, the Not found section last, and no deferred field.
  it('composes an under-budget batch exactly, on both surfaces', async () => {
    const result = await runToolContract(getCodeTool, {
      codes: ['J0120', '11111-2222-33', 'A0100', 'ZZZ9'],
      includeHierarchy: true,
    } as never);
    expect(textOf(result.content as { text?: string; type: string }[])).toBe(
      [
        '## J0120 — HCPCS Level II',
        '**billable: yes, header: no** · chapter J',
        'Injection, tetracycline, up to 250 mg',
        '_Short:_ Tetracycline injection',
        '**Parent:** J',
        '**Children (0):**',
        '_Complete: no further children exist beyond those listed._',
        '',
        '## 198440 — RxNorm',
        '**billable: n/a, header: no** · chapter SCD',
        'Acetaminophen 500 MG Oral Tablet',
        '**Resolved via:** NDC',
        '',
        '### Not found (2)',
        '- **A0100**: "A0100" matches multiple systems — re-call with an explicit system to disambiguate. [ICD10CM, HCPCS]',
        '- **ZZZ9**: "ZZZ9" is not present in any bundled code system, and matches no bundled code shape.',
      ].join('\n'),
    );
    expect(JSON.stringify(result.structuredContent)).toBe(
      '{"found":[{"system":"HCPCS","code":"J0120","description":"Injection, tetracycline, up to 250 mg","shortDescription":"Tetracycline injection","billable":true,"header":false,"chapter":"J","parent":"J","children":[],"childrenTruncated":false},{"system":"RXNORM","code":"198440","description":"Acetaminophen 500 MG Oral Tablet","shortDescription":null,"billable":null,"header":false,"chapter":"SCD","source":"NDC"}],"notFound":[{"code":"A0100","reason":"\\"A0100\\" matches multiple systems — re-call with an explicit system to disambiguate.","candidateSystems":["ICD10CM","HCPCS"]},{"code":"ZZZ9","reason":"\\"ZZZ9\\" is not present in any bundled code system, and matches no bundled code shape."}]}',
    );
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/68
  it('renders deferred codes as written, last, with the re-call instruction', () => {
    const out = getCodeTool.output.parse({
      found: [
        {
          system: 'HCPCS',
          code: 'G',
          description: 'Procedures/professional services (temporary)',
          shortDescription: null,
          billable: false,
          header: true,
          chapter: 'G',
        },
      ],
      notFound: [{ code: 'ZZZ9', reason: 'absent' }],
      deferred: ['J', hazard('deferred'), hazard('deferred-hash', '#')],
    }) as { deferred?: string[] };
    // The field survives output parsing, so structuredContent carries it.
    expect(out.deferred).toEqual(['J', hazard('deferred'), hazard('deferred-hash', '#')]);
    const text = textOf(getCodeTool.format!(out as never));
    expect(text.indexOf('### Deferred (3)')).toBeGreaterThan(text.indexOf('### Not found (1)'));
    const section = text.slice(text.indexOf('### Deferred (3)'));
    expect(section).toContain(
      'Re-call medcode_get_code with these as `codes` and the same `system` and `includeHierarchy`',
    );
    expect(section).toContain('24,000-byte');
    expectReadsBack(section, out.deferred ?? []);
  });
});

describe('medcode_search_codes format', () => {
  it('renders every matched code with its system label, flags, and chapter', async () => {
    const out = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'diabetes', chapter: 'E', system: 'ICD10CM' }),
      createMockContext(),
    );
    const text = textOf(searchCodesTool.format!(out));

    expect(out.codes.length).toBeGreaterThan(0);
    expect(text).toContain(`## ${out.codes.length} matching code(s)`);
    for (const code of out.codes) expect(text).toContain(`**${code.code}**`);
    expect(text).toContain('· chapter E');
    expect(text).toContain('(ICD-10-CM;');
  });

  it('says nothing matched instead of rendering an empty list', async () => {
    const out = await searchCodesTool.handler(
      searchCodesTool.input.parse({ query: 'zzzznotarealterm' }),
      createMockContext(),
    );
    expect(textOf(searchCodesTool.format!(out))).toBe('No matching codes.');
  });

  it('renders the applied filters through the enrichment trailer', () => {
    const render = searchCodesTool.enrichmentTrailer?.appliedFilters?.render as (
      v: unknown,
    ) => string;
    expect(render({ system: 'HCPCS', billableOnly: true, chapter: 'J' })).toBe(
      '**Filters:** system=HCPCS, billableOnly=true, chapter=J',
    );
    // Unset filters read as "any" — never as an empty value the model could
    // misread as "filtered to nothing".
    expect(render({ system: null, billableOnly: false, chapter: null })).toBe(
      '**Filters:** system=any, billableOnly=false, chapter=any',
    );
  });
});

describe('medcode_check_code format', () => {
  it('renders the verdict, billability, and the why-not for a non-billable code', async () => {
    const out = await checkCodeTool.handler(
      checkCodeTool.input.parse({ code: 'E11' }),
      createMockContext({ errors: checkCodeTool.errors }),
    );
    const text = textOf(checkCodeTool.format!(out));
    expect(text).toContain('## E11 — ICD-10-CM');
    expect(text).toContain('Valid category/header');
    expect(text).toContain('**Billable:** No');
    expect(text).toContain(out.whyNot as string);
  });

  it('renders a billable verdict with no why-not paragraph', async () => {
    const out = await checkCodeTool.handler(
      checkCodeTool.input.parse({ code: 'E11.9' }),
      createMockContext({ errors: checkCodeTool.errors }),
    );
    const text = textOf(checkCodeTool.format!(out));
    expect(text).toContain('**Billable:** Yes');
    expect(text).toContain('Valid and billable');
    expect(text.trimEnd().endsWith('**Billable:** Yes')).toBe(true);
  });
});

describe('medcode_browse_hierarchy format', () => {
  it('renders child codes under a node', async () => {
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10CM', node: 'A00' }),
      createMockContext({ errors: browseHierarchyTool.errors }),
    );
    const text = textOf(browseHierarchyTool.format!(out));
    expect(text).toContain('## Browse result (codes)');
    expect(text).toContain('### 2 child code(s)');
    expect(text).toContain('**A00.0**');
    expect(text).toContain('**A00.1**');
  });

  it('renders PCS axis values as a position/value/meaning table', async () => {
    const out = await browseHierarchyTool.handler(
      browseHierarchyTool.input.parse({ system: 'ICD10PCS' }),
      createMockContext({ errors: browseHierarchyTool.errors }),
    );
    const text = textOf(browseHierarchyTool.format!(out));
    expect(text).toContain('### ICD-10-PCS axis values');
    expect(text).toContain('| 1 | 0 | Medical and Surgical |');
  });
});

describe('medcode_map_codes format', () => {
  it('renders each hit with its value, system, and edge', async () => {
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'E11.9', direction: 'parents' }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    const text = textOf(mapCodesTool.format!(out));
    expect(text).toContain('## parents: E11.9');
    expect(text).toContain('**Resolved system:** ICD10CM');
    expect(text).toContain('- **E11** (ICD10CM) via ICD10CM: Type 2 diabetes mellitus');
  });

  // The rendered text of every direction that predates the class directions, pinned
  // whole: a hit with no class fields must render exactly as it always has.
  it.each([
    [
      { from: 'E11.9', direction: 'parents' },
      '## parents: E11.9\n**Resolved system:** ICD10CM\n- **E11** (ICD10CM) via ICD10CM: Type 2 diabetes mellitus',
    ],
    [
      { from: 'A00', direction: 'children' },
      '## children: A00\n**Resolved system:** ICD10CM\n- **A00.0** (ICD10CM) via ICD10CM: Cholera due to Vibrio cholerae 01, biovar cholerae\n- **A00.1** (ICD10CM) via ICD10CM: Cholera due to Vibrio cholerae 01, biovar eltor',
    ],
    [
      { from: '1049640', direction: 'rxcui_to_ndc' },
      '## rxcui_to_ndc: 1049640\n**Resolved system:** RXNORM\n- **00904516140** via NDC\n- **00904516160** via NDC\n- **00904516161** via NDC\n- **00904516180** via NDC\n- **00904516189** via NDC',
    ],
    [
      { from: '198440', direction: 'rxcui_to_ingredients' },
      '## rxcui_to_ingredients: 198440\n**Resolved system:** RXNORM\n- **161** (RXNORM) via has_ingredient [IN]: acetaminophen',
    ],
    [
      { from: '198440', direction: 'rxcui_to_brands' },
      '## rxcui_to_brands: 198440\n**Resolved system:** RXNORM\n- **202433** (RXNORM) via has_tradename [BN]: Tylenol',
    ],
  ])('renders %j exactly as before', async (args, expected) => {
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse(args),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(textOf(mapCodesTool.format!(out))).toBe(expected);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/67
  it.each([
    [
      { from: 'a', direction: 'name_to_rxcui' },
      [
        ['161', 'IN'],
        ['1191', 'IN'],
        ['198440', 'SCD'],
        ['1049640', 'SCD'],
      ],
      '## name_to_rxcui: a\n**Resolved system:** RXNORM\n- **161** (RXNORM) via RXNORM [IN]: acetaminophen\n- **1191** (RXNORM) via RXNORM [IN]: aspirin\n- **198440** (RXNORM) via RXNORM [SCD]: Acetaminophen 500 MG Oral Tablet\n- **1049640** (RXNORM) via RXNORM [SCD]: Aspirin 325 MG Oral Tablet',
    ],
    [
      { from: 'tylenol', direction: 'name_to_rxcui' },
      [['202433', 'BN']],
      '## name_to_rxcui: tylenol\n**Resolved system:** RXNORM\n- **202433** (RXNORM) via RXNORM [BN]: Tylenol',
    ],
    [
      { from: '11111-2222-33', direction: 'ndc_to_rxcui' },
      [['198440', 'SCD']],
      '## ndc_to_rxcui: 11111-2222-33\n**Resolved system:** RXNORM\n- **198440** (RXNORM) via NDC [SCD]: Acetaminophen 500 MG Oral Tablet',
    ],
  ])('tags each %j hit with its term type, on both surfaces', async (args, types, expected) => {
    const result = await runToolContract(mapCodesTool, args as never);
    const out = result.structuredContent as { hits: { conceptType?: string; value: string }[] };
    expect(out.hits.map((hit) => [hit.value, hit.conceptType])).toEqual(types);
    // The paginated name_to_rxcui also closes with its truncation trailer.
    expect(textOf(result.content as { text?: string; type: string }[])).toContain(expected);
  });

  // https://github.com/cyanheads/medical-codes-mcp-server/issues/34
  it("renders a class hit's type, source, relation, and via, spelling out a contraindication", async () => {
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: '198440', direction: 'rxcui_to_classes' }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    const text = textOf(mapCodesTool.format!(out));
    expect(text).toContain('## rxcui_to_classes: 198440');
    expect(text).toContain(
      '- **N0000000108** via MEDRT · MOA · has_moa · inherited via ingredient 161: Prostaglandin Receptor Antagonists',
    );
    expect(text).toContain(
      '- **D004342** via MEDRT · DISEASE · ci_with (contraindication) · inherited via ingredient 161: Drug Hypersensitivity',
    );
    expect(text).toContain(
      '- **D010146** via MEDRT · DISEASE · may_treat · inherited via ingredient 161: Pain',
    );
    // The product's own class names no ingredient.
    expect(text).toContain('- **CN103** via VA · VA · has_vaclass: NON-OPIOID ANALGESICS');
  });

  it("renders a class member's RxNorm name, concept type, and edge", async () => {
    const out = await mapCodesTool.handler(
      mapCodesTool.input.parse({ from: 'N0000008836', direction: 'class_to_rxcuis' }),
      createMockContext({ errors: mapCodesTool.errors }),
    );
    expect(textOf(mapCodesTool.format!(out))).toBe(
      '## class_to_rxcuis: N0000008836\n- **161** (RXNORM) via MEDRT [IN] · PE · has_pe: acetaminophen\n- **1191** (RXNORM) via MEDRT [IN] · PE · has_pe: aspirin',
    );
  });

  it('omits the resolved-system line for a system-less crosswalk', () => {
    const out = mapCodesTool.output.parse({
      from: '198440',
      direction: 'rxcui_to_ndc',
      resolvedSystem: null,
      hits: [{ source: 'NDC', system: null, value: '11111222233' }],
    });
    const text = textOf(mapCodesTool.format!(out));
    expect(text).not.toContain('Resolved system');
    expect(text).toContain('- **11111222233** via NDC');
  });
});
