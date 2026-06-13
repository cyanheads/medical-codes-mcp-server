/**
 * @fileoverview Pure parsers for the federal source-file formats the index is
 * built from. Each takes raw file text and yields normalized rows — no I/O, no
 * DB, so they unit-test against fixture slices. Column positions are 1-based in
 * the comments (matching the CMS/CDC documentation) and converted to 0-based
 * slice offsets in code.
 *
 * Format references (verified against primary .gov sources):
 *  - ICD-10-CM / ICD-10-PCS order files: fixed-width, variable-length lines.
 *    pos 1-5 order#, pos 7-13 code (no dot, space-padded to 7), pos 15 flag
 *    (1=billable/valid leaf, 0=header), pos 17-76 short desc, pos 78+ long desc.
 *  - HCPCS ANWEB.txt: fixed-width, 320 chars/row (verified against the CMS
 *    record-layout doc in the annual ZIP). pos 1-5 code, pos 12-91 long desc,
 *    pos 92-119 short desc, pos 269-276 Code Added Date (effective), pos 277-284
 *    Action Effective Date, pos 285-292 Termination Date (YYYYMMDD, blank=active).
 *  - RxNorm RRF: pipe-delimited. RXNCONSO (RXCUI,LAT,…,SAB,TTY,CODE,STR,…),
 *    RXNSAT (RXCUI,…,ATN,SAB,ATV,…), RXNREL (RXCUI1,…,REL,RXCUI2,…,RELA,…).
 * @module scripts/ingest/parsers
 */

import { hcpcsParent, icd10cmChapterLetter, icd10cmParent } from '@/services/code-index/schema.js';
import type { CodeInput } from '../_db-writer.ts';

/** Slice a fixed-width field by 1-based inclusive [start, end] (CMS doc convention). */
function field(line: string, start1: number, end1: number): string {
  return line.slice(start1 - 1, end1).trimEnd();
}

/** Slice from a 1-based start to end of line. */
function fieldFrom(line: string, start1: number): string {
  return line.slice(start1 - 1).trimEnd();
}

/**
 * Parse an ICD-10-CM order file (`icd10cm-order-<FY>.txt`). Each non-blank line
 * is one code; the pos-15 flag is the billable signal (1 = billable leaf, 0 =
 * non-billable header). Parent and chapter are derived from code structure.
 */
export function parseIcd10cmOrder(text: string): CodeInput[] {
  const rows: CodeInput[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 16) continue; // need at least through the flag column
    const code = field(line, 7, 13).replace(/\s+/g, '');
    if (!code) continue;
    const flag = line.charAt(14); // pos 15, 0-based index 14
    const billable = flag === '1';
    const shortDesc = field(line, 17, 76);
    const longDesc = fieldFrom(line, 78) || shortDesc;
    rows.push({
      system: 'ICD10CM',
      code,
      shortDesc: shortDesc || null,
      longDesc: longDesc || null,
      billable,
      header: !billable,
      chapter: icd10cmChapterLetter(code),
      parent: icd10cmParent(code),
      effective: null,
      terminated: null,
    });
  }
  return rows;
}

/**
 * Parse an ICD-10-PCS order file (`icd10pcs_order_<FY>.txt`). Same column layout
 * as ICD-10-CM. Every complete 7-char code is billable; the pos-15 flag marks
 * completeness. PCS has no prefix parent (axis-based hierarchy), so `parent` is
 * null and the chapter is the section character.
 */
export function parseIcd10pcsOrder(text: string): CodeInput[] {
  const rows: CodeInput[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 16) continue;
    const code = field(line, 7, 13).replace(/\s+/g, '');
    if (!code) continue;
    const valid = line.charAt(14) === '1';
    const shortDesc = field(line, 17, 76);
    const longDesc = fieldFrom(line, 78) || shortDesc;
    rows.push({
      system: 'ICD10PCS',
      code,
      shortDesc: shortDesc || null,
      longDesc: longDesc || null,
      billable: valid && code.length === 7,
      header: false,
      chapter: code.charAt(0),
      parent: null,
      effective: null,
      terminated: null,
    });
  }
  return rows;
}

/** One ICD-10-PCS axis value: position 1-7, single-char value, its meaning. */
export interface PcsAxisInput {
  meaning: string;
  position: number;
  value: string;
}

/**
 * Parse the ICD-10-PCS tabular XML (`icd10pcs_tables_<FY>.xml`) for the
 * position-1 **Section** axis only.
 *
 * Why only position 1: ICD-10-PCS is a multi-axial grammar where the meaning of
 * a value at positions 2-7 depends on the full preceding axis path (the unique
 * Section/Body-System/Operation table it appears in). The same value carries
 * different meanings across tables — verified against the FY2026 tables XML, the
 * code "6" at position 4 means "Cerebral Ventricle", "Radial Nerve", "Atrium,
 * Right", and others depending on context. The flat `pcs_axes (position, value,
 * meaning)` table can hold one meaning per `(position, value)`, so populating
 * positions 2-7 from it would store an arbitrary, often-wrong meaning. Position 1
 * (the 17 Sections) is the one axis whose meaning is globally unambiguous, so it
 * is the only one baked. `medcode_browse_hierarchy` surfaces these Sections at
 * the PCS top level and returns an explicit notice (not wrong/empty data) for
 * deeper positions, where per-table context is required — decode a specific PCS
 * code with `medcode_get_code` for its axis breakdown instead.
 */
export function parseIcd10pcsAxes(xml: string): PcsAxisInput[] {
  const out: PcsAxisInput[] = [];
  const seen = new Set<string>();
  // Each <pcsTable> opens with its position-1 <axis>; pull the Section labels.
  const axisRe = /<axis\s+pos="1"[^>]*>([\s\S]*?)<\/axis>/g;
  const labelRe = /<label\s+code="([^"]*)"\s*>([^<]*)<\/label>/g;
  for (let am = axisRe.exec(xml); am !== null; am = axisRe.exec(xml)) {
    const inner = am[1] ?? '';
    for (let lm = labelRe.exec(inner); lm !== null; lm = labelRe.exec(inner)) {
      const value = (lm[1] ?? '').trim();
      const meaning = (lm[2] ?? '').trim();
      if (!value || !meaning || seen.has(value)) continue;
      seen.add(value);
      out.push({ position: 1, value, meaning });
    }
  }
  return out;
}

/**
 * Parse a HCPCS Level II `ANWEB.txt` annual file (fixed-width, 320 chars/row).
 * Column positions verified against the CMS record-layout doc shipped in the
 * annual ZIP (`HCPC<yr>_recordlayout.txt`):
 *  - pos 1-5    HCPCS code (a 5-char code row). The modifier rows carry a 2-char
 *               modifier at pos 4-5 with pos 1-3 blank; they trim to a sub-5-char
 *               value and are filtered out (modifiers aren't lookup codes — the
 *               design scopes HCPCS Level II codes, not modifiers).
 *  - pos 6-10   sequence number, pos 11 record id (3 = primary row, 4 = a
 *               long-description continuation row).
 *  - pos 12-91  long description, pos 92-119 short description.
 *  - pos 269-276 Code Added Date (effective), pos 277-284 Action Effective Date
 *               (NOT termination — a past date here is normal for active codes),
 *               pos 285-292 Termination Date (blank = active).
 *
 * A code's long description is split across rows by sequence number (one primary
 * RECID-3 row plus zero or more RECID-4 continuation rows); they are concatenated
 * in sequence order into one description. Short description and the dates live on
 * the primary row. So the parser groups rows by code and emits ONE row per code —
 * inserting per-row would collide on the `(system, code)` primary key and truncate
 * the long description to its first 80-char chunk.
 *
 * Terminated codes remain in the file with a termination date; the row carries it
 * so `medcode_check_code` can report `terminated`. A code is billable when its
 * termination date is blank or in the future relative to `asOf`.
 */
export function parseHcpcsAnweb(text: string, asOf = todayYyyymmdd()): CodeInput[] {
  /** Accumulator per code: primary-row fields + ordered long-desc chunks. */
  interface Acc {
    chunks: { seq: string; text: string }[];
    effective: string;
    shortDesc: string;
    terminated: string;
  }
  // Map preserves insertion order, so iterating it later yields codes in
  // first-seen (file) order without a parallel index array.
  const byCode = new Map<string, Acc>();

  for (const line of text.split(/\r?\n/)) {
    if (line.length < 119) continue; // need through the short-description column
    const code = field(line, 1, 5).replace(/\s+/g, '');
    // Real Level II codes are 5 chars at pos 1-5. Modifier rows (2-char value at
    // pos 4-5, blank pos 1-3) trim short — skip them.
    if (code.length !== 5) continue;

    const seq = field(line, 6, 10);
    const recId = field(line, 11, 11);
    const longChunk = field(line, 12, 91);

    let acc = byCode.get(code);
    if (!acc) {
      acc = { chunks: [], shortDesc: '', effective: '', terminated: '' };
      byCode.set(code, acc);
    }
    if (longChunk) acc.chunks.push({ seq, text: longChunk });
    // Short description and dates come from the primary row (RECID 3); a code's
    // first-seen row is its primary, but guard on RECID so a stray ordering never
    // lets a blank continuation row clobber real values.
    if (recId === '3' || !acc.shortDesc) {
      const shortDesc = field(line, 92, 119);
      if (shortDesc) acc.shortDesc = shortDesc;
      const effective = digits(field(line, 269, 276));
      if (effective) acc.effective = effective;
      const terminated = digits(field(line, 285, 292));
      if (terminated) acc.terminated = terminated;
    }
  }

  const rows: CodeInput[] = [];
  for (const [code, acc] of byCode) {
    const longDesc = acc.chunks
      .sort((a, b) => a.seq.localeCompare(b.seq))
      .map((c) => c.text)
      .join(' ')
      .trim();
    const active = !acc.terminated || acc.terminated > asOf;
    rows.push({
      system: 'HCPCS',
      code,
      shortDesc: acc.shortDesc || null,
      longDesc: longDesc || acc.shortDesc || null,
      billable: active,
      header: false,
      chapter: code.charAt(0),
      effective: acc.effective || null,
      terminated: acc.terminated || null,
      parent: hcpcsParent(code),
    });
  }
  return rows;
}

/** A parsed RxNorm prescribable bundle: code rows + relationship + NDC edges. */
export interface RxNormParseResult {
  codes: CodeInput[];
  ndcs: { ndc: string; rxcui: string }[];
  rels: { rxcui: string; rel: string; target: string; targetType: string }[];
}

/**
 * Parse the RxNorm Prescribable Content RRF bundle. `RXNCONSO.RRF` →
 * RXCUI/name rows; `RXNSAT.RRF` rows where `ATN='NDC'` → NDC map; `RXNREL.RRF`
 * (with RELA labels) → ingredient/brand edges. Only the prescribable subset
 * (SAB='RXNORM' normalized names) is bundled — never the full release (UMLS-
 * licensed source vocabularies would poison redistribution).
 */
export function parseRxNorm(files: {
  rxnconso: string;
  rxnsat: string;
  rxnrel: string;
}): RxNormParseResult {
  const codes: CodeInput[] = [];
  const seen = new Set<string>();
  // RXNCONSO columns (0-based): 0 RXCUI, 1 LAT, …, 11 SAB, 12 TTY, 13 CODE, 14 STR
  for (const line of files.rxnconso.split(/\r?\n/)) {
    if (!line) continue;
    const c = line.split('|');
    const rxcui = c[0];
    const lat = c[1];
    const sab = c[11];
    const tty = c[12];
    const str = c[14];
    if (!rxcui || lat !== 'ENG' || sab !== 'RXNORM' || !str) continue;
    if (seen.has(rxcui)) continue;
    seen.add(rxcui);
    codes.push({
      system: 'RXNORM',
      code: rxcui,
      shortDesc: tty ?? null,
      longDesc: str,
      billable: false,
      header: false,
      chapter: tty ?? null,
      parent: null,
      effective: null,
      terminated: null,
    });
  }

  // RXNSAT columns (0-based): 0 RXCUI, …, 8 ATN, 9 SAB, 10 ATV
  const ndcs: { ndc: string; rxcui: string }[] = [];
  for (const line of files.rxnsat.split(/\r?\n/)) {
    if (!line) continue;
    const c = line.split('|');
    if (c[8] !== 'NDC') continue;
    const rxcui = c[0];
    const ndc = (c[10] ?? '').replace(/[^0-9]/g, '');
    if (rxcui && ndc) ndcs.push({ ndc, rxcui });
  }

  // RXNREL columns (0-based): 0 RXCUI1, 1 RXAUI1, 2 STYPE1, 3 REL, 4 RXCUI2,
  // 5 RXAUI2, 6 STYPE2, 7 RELA, 8 RUI, … The directed relationship reads
  // "RXCUI1 <RELA> RXCUI2"; we keep the ingredient/brand RELA labels.
  const rels: { rxcui: string; rel: string; target: string; targetType: string }[] = [];
  const RELA_MAP: Record<string, string> = {
    has_ingredient: 'has_ingredient',
    has_tradename: 'has_tradename',
    ingredient_of: 'ingredient_of',
    tradename_of: 'tradename_of',
  };
  for (const line of files.rxnrel.split(/\r?\n/)) {
    if (!line) continue;
    const c = line.split('|');
    const rela = c[7] ?? '';
    const mapped = RELA_MAP[rela];
    if (!mapped) continue;
    const rxcui1 = c[0];
    const rxcui2 = c[4];
    if (rxcui1 && rxcui2)
      rels.push({ rxcui: rxcui1, rel: mapped, target: rxcui2, targetType: 'RXCUI' });
  }

  return { codes, rels, ndcs };
}

/** Keep only digits (date columns may carry stray spaces). */
function digits(s: string): string {
  return s.replace(/[^0-9]/g, '');
}

/** Today as YYYYMMDD, for the HCPCS active/terminated cutoff. */
function todayYyyymmdd(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
