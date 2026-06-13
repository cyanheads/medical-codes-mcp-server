/**
 * @fileoverview Unit tests for the fixed-width / RRF source parsers. Each parser
 * is exercised against a hand-built fixture slice matching the documented column
 * positions, including a sparse case (missing long description) and the
 * billable/terminated edge cases the service depends on.
 * @module tests/ingest/parsers.test
 */

import { describe, expect, it } from 'vitest';

import {
  parseHcpcsAnweb,
  parseIcd10cmOrder,
  parseIcd10pcsAxes,
  parseIcd10pcsOrder,
  parseRxNorm,
} from '../../scripts/ingest/parsers.ts';

/** Build an ICD-10-CM/PCS order line by 1-based column positions. */
function orderLine(order: string, code: string, flag: string, short: string, long: string): string {
  const buf = ' '.repeat(76).split('');
  const put = (str: string, start1: number) => {
    for (let i = 0; i < str.length; i++) buf[start1 - 1 + i] = str[i]!;
  };
  put(order.padStart(5, '0'), 1);
  put(code.padEnd(7, ' '), 7);
  put(flag, 15);
  put(short.padEnd(60, ' ').slice(0, 60), 17);
  return `${buf.join('')} ${long}`;
}

/**
 * Build a HCPCS ANWEB line by the verified 1-based column positions (per the
 * CMS record-layout doc): pos 1-5 code, pos 6-10 sequence number, pos 11 record
 * id, pos 12-91 long, pos 92-119 short, pos 269-276 Code Added Date (effective),
 * pos 277-284 Action Effective Date, pos 285-292 Termination Date.
 */
function anwebLine(opts: {
  code: string;
  long: string;
  short?: string;
  effective?: string;
  /** Action Effective Date (pos 277-284) — a normal past date for active codes. */
  actionEffective?: string;
  /** Termination Date (pos 285-292) — blank = active. */
  terminated?: string;
  seq?: string;
  recId?: string;
}): string {
  const buf = ' '.repeat(292).split('');
  const put = (str: string, start1: number) => {
    for (let i = 0; i < str.length; i++) buf[start1 - 1 + i] = str[i]!;
  };
  put(opts.code.padEnd(5, ' '), 1);
  put((opts.seq ?? '00100').padEnd(5, ' '), 6);
  put(opts.recId ?? '3', 11);
  put(opts.long.padEnd(80, ' ').slice(0, 80), 12);
  put((opts.short ?? '').padEnd(28, ' ').slice(0, 28), 92);
  if (opts.effective) put(opts.effective, 269);
  if (opts.actionEffective) put(opts.actionEffective, 277);
  if (opts.terminated) put(opts.terminated, 285);
  return buf.join('');
}

describe('parseIcd10cmOrder', () => {
  it('parses billable leaf and non-billable header with derived parent/chapter', () => {
    const text = [
      orderLine(
        '12345',
        'E1140',
        '1',
        'Type 2 diab w neuro',
        'Type 2 diabetes mellitus with diabetic neuropathy, unspecified',
      ),
      orderLine('12300', 'E11', '0', 'Type 2 diabetes', 'Type 2 diabetes mellitus'),
    ].join('\n');
    const rows = parseIcd10cmOrder(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      system: 'ICD10CM',
      code: 'E1140',
      billable: true,
      header: false,
      parent: 'E114',
      chapter: 'E',
    });
    expect(rows[1]).toMatchObject({ code: 'E11', billable: false, header: true, parent: null });
  });

  it('falls back to short description when long is absent (sparse row)', () => {
    const text = orderLine('00001', 'A00', '0', 'Cholera', '');
    const [row] = parseIcd10cmOrder(text);
    expect(row?.longDesc).toBe('Cholera');
  });
});

describe('parseIcd10pcsOrder', () => {
  it('marks complete 7-char codes billable with null prefix parent', () => {
    const text = orderLine(
      '00001',
      '0DTJ4ZZ',
      '1',
      'Resection appendix',
      'Resection of Appendix, Perc Endo Approach',
    );
    const [row] = parseIcd10pcsOrder(text);
    expect(row).toMatchObject({
      system: 'ICD10PCS',
      code: '0DTJ4ZZ',
      billable: true,
      parent: null,
      chapter: '0',
    });
  });
});

describe('parseIcd10pcsAxes', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ICD10PCS.tabular>
  <pcsTable>
    <axis pos="1" values="1"><title>Section</title><label code="0">Medical and Surgical</label></axis>
    <axis pos="2" values="1"><title>Body System</title><label code="0">Central Nervous System</label></axis>
    <axis pos="3" values="1"><title>Operation</title><label code="1">Bypass</label></axis>
  </pcsTable>
  <pcsTable>
    <axis pos="1" values="1"><title>Section</title><label code="B">Imaging</label></axis>
    <axis pos="2" values="1"><title>Body System</title><label code="0">Central Nervous System</label></axis>
  </pcsTable>
</ICD10PCS.tabular>`;

  it('extracts only the position-1 Section axis, deduped across tables', () => {
    const axes = parseIcd10pcsAxes(xml);
    // Only position 1 — positions 2-7 are context-dependent and not baked.
    expect(axes.every((a) => a.position === 1)).toBe(true);
    expect(axes).toEqual([
      { position: 1, value: '0', meaning: 'Medical and Surgical' },
      { position: 1, value: 'B', meaning: 'Imaging' },
    ]);
  });

  it('returns nothing for XML with no position-1 axes', () => {
    expect(parseIcd10pcsAxes('<ICD10PCS.tabular></ICD10PCS.tabular>')).toEqual([]);
  });
});

describe('parseHcpcsAnweb', () => {
  it('parses active and terminated codes, deriving billable from term date', () => {
    const text = [
      anwebLine({
        code: 'J0120',
        long: 'Injection, tetracycline, up to 250 mg',
        short: 'Tetracycline inj',
        effective: '20020101',
      }),
      anwebLine({
        code: 'K0552',
        long: 'Old supply code',
        short: 'Old supply',
        effective: '20100101',
        terminated: '20191231',
      }),
    ].join('\n');
    const rows = parseHcpcsAnweb(text, '20260101');
    expect(rows[0]).toMatchObject({ code: 'J0120', billable: true, terminated: null, parent: 'J' });
    expect(rows[1]).toMatchObject({ code: 'K0552', billable: false, terminated: '20191231' });
  });

  it('treats a future termination date as still billable', () => {
    const text = anwebLine({
      code: 'A4206',
      long: 'Syringe',
      short: 'Syringe',
      effective: '20200101',
      terminated: '20991231',
    });
    const [row] = parseHcpcsAnweb(text, '20260101');
    expect(row?.billable).toBe(true);
  });

  it('reads the code from pos 1-5, not pos 4-8', () => {
    // Regression: a real code row has the code at pos 1-5 (no leading filler).
    const [row] = parseHcpcsAnweb(anwebLine({ code: 'J0120', long: 'Injection' }), '20260101');
    expect(row?.code).toBe('J0120');
  });

  it('does NOT treat the Action Effective Date (pos 277-284) as termination', () => {
    // Regression: active codes carry a past Action Effective Date at 277-284;
    // termination lives at 285-292. A populated 277-284 must not mark the code
    // terminated.
    const [row] = parseHcpcsAnweb(
      anwebLine({
        code: 'J0120',
        long: 'Injection, tetracycline',
        effective: '19860101',
        actionEffective: '20180101', // past — would falsely terminate if mis-read
      }),
      '20260101',
    );
    expect(row?.billable).toBe(true);
    expect(row?.terminated).toBeNull();
  });

  it('concatenates a long description split across sequence rows into one code', () => {
    // Regression: a code's long description spans a primary row (RECID 3) plus
    // continuation rows (RECID 4); they must merge into one row, not collide on
    // the primary key or truncate to the first chunk.
    const text = [
      anwebLine({
        code: 'A0080',
        long: 'Non-emergency transportation, per mile - vehicle provided by volunteer',
        short: 'Non-emer transport',
        seq: '00100',
        recId: '3',
        effective: '20020101',
      }),
      anwebLine({
        code: 'A0080',
        long: '(individual or organization), with no vested interest',
        seq: '00200',
        recId: '4',
      }),
    ].join('\n');
    const rows = parseHcpcsAnweb(text, '20260101');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.longDesc).toBe(
      'Non-emergency transportation, per mile - vehicle provided by volunteer ' +
        '(individual or organization), with no vested interest',
    );
    expect(rows[0]?.shortDesc).toBe('Non-emer transport');
  });

  it('skips modifier rows (2-char value at pos 4-5, blank pos 1-3)', () => {
    // Modifier rows trim to a sub-5-char code at pos 1-5 and are not lookup codes.
    const modifierLine = `   A1${'00100'}7${'Dressing for one wound'.padEnd(80)}`.padEnd(292);
    const rows = parseHcpcsAnweb(modifierLine, '20260101');
    expect(rows).toEqual([]);
  });
});

describe('parseRxNorm', () => {
  const conso = (rxcui: string, sab: string, tty: string, str: string) =>
    [rxcui, 'ENG', 'S', '', '', '', 'Y', '', '', '', '', sab, tty, rxcui, str, '', 'N', ''].join(
      '|',
    );
  const sat = (rxcui: string, atn: string, sab: string, atv: string) =>
    [rxcui, '', '', '', '', '', '', '', atn, sab, atv, '', ''].join('|');
  const rel = (r1: string, rela: string, r2: string) =>
    [r1, '', 'CUI', '', r2, '', 'CUI', rela, '', '', '', ''].join('|');

  it('keeps only the RXNORM/ENG normalized names, skipping other vocabularies', () => {
    const res = parseRxNorm({
      rxnconso: [
        conso('161', 'RXNORM', 'IN', 'Acetaminophen'),
        conso('9999', 'MTHSPL', 'XX', 'Skip'),
      ].join('\n'),
      rxnsat: '',
      rxnrel: '',
    });
    expect(res.codes).toHaveLength(1);
    expect(res.codes[0]).toMatchObject({
      system: 'RXNORM',
      code: '161',
      longDesc: 'Acetaminophen',
    });
  });

  it('extracts NDC maps and ingredient/brand edges with correct columns', () => {
    const res = parseRxNorm({
      rxnconso: '',
      rxnsat: [
        sat('161', 'NDC', 'RXNORM', '0000-0000-01'),
        sat('161', 'OTHER', 'RXNORM', 'ignore'),
      ].join('\n'),
      rxnrel: [rel('161', 'has_ingredient', '1191'), rel('1191', 'unrelated_rela', '2')].join('\n'),
    });
    expect(res.ndcs).toEqual([{ ndc: '0000000001', rxcui: '161' }]);
    expect(res.rels).toEqual([
      { rxcui: '161', rel: 'has_ingredient', target: '1191', targetType: 'RXCUI' },
    ]);
  });
});
