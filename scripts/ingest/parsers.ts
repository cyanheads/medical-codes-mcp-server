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

import {
  hcpcsBucketLabel,
  hcpcsParent,
  icd10cmChapterLetter,
  icd10cmParent,
} from '@/services/code-index/schema.js';
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

/**
 * Synthesize the HCPCS Level II letter-range bucket rows. HCPCS codes carry a
 * single-letter parent (`J0120` → `J`), but the federal ANWEB file has no row
 * for the bucket itself — so without these synthesized headers the top of the
 * HCPCS hierarchy is unreachable (`browse` with no node finds no `parent IS
 * NULL` rows, and `node="J"` 404s). Emit one header per distinct first letter
 * present: `code` = the letter, `parent` = null (a top-level root), `header` =
 * true, `billable` = false, labeled via {@link hcpcsBucketLabel}. Pass the first
 * characters of the parsed code set so only buckets that have children are
 * seeded. Parallels the ICD-10-CM 3-char categories, keeping `browse`,
 * `map_codes parents/children`, and the `parent IS NULL` root query consistent.
 */
export function hcpcsSectionRows(presentLetters: Iterable<string>): CodeInput[] {
  const letters = [...new Set(presentLetters)].sort();
  return letters.map((letter) => {
    const label = hcpcsBucketLabel(letter);
    return {
      system: 'HCPCS',
      code: letter,
      shortDesc: label,
      longDesc: label,
      billable: false,
      header: true,
      chapter: letter,
      parent: null,
      effective: null,
      terminated: null,
    };
  });
}

/** A parsed RxNorm prescribable bundle: code rows + relationship + NDC edges. */
export interface RxNormParseResult {
  codes: CodeInput[];
  ndcs: { ndc: string; rxcui: string }[];
  rels: { rxcui: string; rel: string; target: string; targetType: string }[];
}

/** A single RxNorm concept from the RxNav cache (`{rxcui,name,tty}`). */
export interface RxNavConcept {
  name: string;
  rxcui: string;
  tty: string;
}

/** One product's fetched edges — one line of `products.jsonl` from the fetcher. */
export interface RxNavProduct {
  brands: RxNavConcept[];
  ingredients: RxNavConcept[];
  ndcs: string[];
  rxcui: string;
}

/**
 * Parse the cached RxNorm Prescribable Content acquired over the keyless RxNav
 * REST API (see `scripts/ingest/fetch-rxnav.ts`). NLM gates the RxNorm RRF bulk
 * files behind UMLS/UTS auth, so the offline, keyless, redistributable build is
 * sourced from RxNav — which serves the public-domain RxNorm normalized
 * vocabulary, not the UMLS-licensed source vocabularies.
 *
 *  - `concepts` (from `allconcepts`) → one `codes(RXNORM)` row per RXCUI (name +
 *    TTY); powers name→RXCUI search and get_code on an RXCUI.
 *  - each product's `ndcs` (from `ndcs.json`, already 11-digit) → the NDC↔RXCUI map.
 *  - each product's `ingredients`/`brands` (from `related.json?tty=IN+PIN+MIN+BN`)
 *    → `has_ingredient` / `has_tradename` edges keyed by the product RXCUI, the
 *    direction `rxcui_to_ingredients` / `rxcui_to_brands` query.
 *
 * Pure: takes already-parsed JSON, returns rows. Dedups concepts by RXCUI and
 * edges/NDCs by their natural key so a resumed/re-fetched cache cannot duplicate.
 */
export function parseRxNav(concepts: RxNavConcept[], products: RxNavProduct[]): RxNormParseResult {
  const codes: CodeInput[] = [];
  const seen = new Set<string>();
  for (const c of concepts) {
    if (!c?.rxcui || !c?.name || seen.has(c.rxcui)) continue;
    seen.add(c.rxcui);
    codes.push({
      system: 'RXNORM',
      code: c.rxcui,
      shortDesc: c.tty || null,
      longDesc: c.name,
      billable: false,
      header: false,
      chapter: c.tty || null,
      parent: null,
      effective: null,
      terminated: null,
    });
  }

  const ndcs: { ndc: string; rxcui: string }[] = [];
  const ndcSeen = new Set<string>();
  const rels: { rxcui: string; rel: string; target: string; targetType: string }[] = [];
  const relSeen = new Set<string>();
  const addRel = (rxcui: string, rel: string, t: RxNavConcept, fallbackType: string) => {
    if (!t?.rxcui) return;
    const key = `${rxcui}|${rel}|${t.rxcui}`;
    if (relSeen.has(key)) return;
    relSeen.add(key);
    rels.push({ rxcui, rel, target: t.rxcui, targetType: t.tty || fallbackType });
  };
  for (const p of products) {
    if (!p?.rxcui) continue;
    for (const raw of p.ndcs ?? []) {
      const ndc = String(raw).replace(/[^0-9]/g, '');
      const key = `${ndc}|${p.rxcui}`;
      if (!ndc || ndcSeen.has(key)) continue;
      ndcSeen.add(key);
      ndcs.push({ ndc, rxcui: p.rxcui });
    }
    for (const ing of p.ingredients ?? []) addRel(p.rxcui, 'has_ingredient', ing, 'IN');
    for (const bn of p.brands ?? []) addRel(p.rxcui, 'has_tradename', bn, 'BN');
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
