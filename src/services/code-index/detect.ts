/**
 * @fileoverview Code-shape auto-detection. Each bundled system has a distinct
 * lexical shape; `detectSystems` returns every system a raw code could belong
 * to so the caller can disambiguate (one match → route directly; multiple →
 * `ambiguous_system`; zero → unknown shape). The shape patterns for a single
 * system live together here, so the partial-node character class the ICD-10-PCS
 * hierarchy browse validates against sits beside the complete-code one it mirrors.
 * @module services/code-index/detect
 */

import { storageCode } from './schema.js';
import type { SystemId } from './types.js';

/**
 * ICD-10-CM: a letter, two digits, then optionally a dot and up to four more
 * alphanumerics. Tested against the dot-stripped storage form. The first
 * character is a letter (`U` excluded, so the emergency-use `U07`/`U09` chapters
 * do not match); the next two are digits (`A`/`B` also allowed in position 3);
 * trailing characters are alphanumeric. Real release codes fall outside this —
 * the `U07`/`U09` emergency-use chapters and the FY2026 `QA0…` genetic codes,
 * whose second character is a letter — which is why `resolveSystems` falls back
 * to DB membership rather than treating an unmatched shape as "not a code".
 */
const ICD10CM_RE = /^[A-TV-Z][0-9][0-9AB][0-9A-Z]{0,4}$/;

/**
 * ICD-10-PCS: exactly 7 characters, alphanumeric, drawn from digits 0-9 and
 * letters A-H,J-N,P-Z (the letters `I` and `O` are excluded by design to avoid
 * confusion with 1 and 0).
 */
const ICD10PCS_RE = /^[0-9A-HJ-NP-Z]{7}$/;

/**
 * A partial ICD-10-PCS node: one or more characters from the SAME 34-value axis
 * alphabet as {@link ICD10PCS_RE} — keep the two character classes in step. Every
 * position of every bundled PCS code draws from that set, so a value outside it
 * can never prefix a real code and is rejected rather than walked as a hierarchy
 * node. Length is deliberately unconstrained: this is a lexical test only, and the
 * caller (`browsePcs`) already discriminates complete codes from partial paths.
 */
export const ICD10PCS_PARTIAL_RE = /^[0-9A-HJ-NP-Z]+$/;

/**
 * HCPCS Level II: one letter A-V, then exactly four digits (e.g. `J0120`,
 * `E0110`). The leading-letter range A-V is what separates it from a generic
 * 5-char alphanumeric.
 */
const HCPCS_RE = /^[A-V][0-9]{4}$/;

/** RXCUI: a pure integer (RxNorm concept identifier). */
const RXCUI_RE = /^[0-9]+$/;

/**
 * Return every system whose shape the raw code matches, in canonical order.
 * Empty array ⇒ the code matches no COMPLETE code shape — which is not the same
 * as "not a code", since the index also materializes header rows (HCPCS letter
 * buckets, 3-character ICD-10-PCS table rows) that no complete shape describes.
 * This is a cheap narrowing; `resolveSystems` confirms against DB membership and
 * widens to every system when no shaped candidate is a member.
 *
 * The overlaps are deliberate. A 5-char HCPCS code and a short ICD-10-CM category
 * DO collide — `A0100` is shaped as both, and only membership separates the
 * typhoid leaf from the transport code — as does `J0120`, which is shaped as both
 * but exists in HCPCS alone. A 7-char alphanumeric is PCS-shaped and can also be a
 * 7-char CM code, and a 7-DIGIT integer is both RXCUI- and PCS-shaped, since the
 * PCS axis alphabet includes every digit; integers of any other length are
 * RXCUI-shaped alone. No bundled RXCUI collides with a PCS code, so membership
 * settles each of these to one system.
 */
export function detectSystems(rawCode: string): SystemId[] {
  const code = storageCode(rawCode);
  if (code.length === 0) return [];

  const matches: SystemId[] = [];
  if (ICD10CM_RE.test(code)) matches.push('ICD10CM');
  if (ICD10PCS_RE.test(code)) matches.push('ICD10PCS');
  if (HCPCS_RE.test(code)) matches.push('HCPCS');
  if (RXCUI_RE.test(code)) matches.push('RXNORM');
  return matches;
}

/**
 * The only segment-width configurations the FDA assigns: the three 10-digit forms
 * (`4-4-2`, `5-3-2`, `5-4-1`) plus the normalized 11-digit `5-4-2`. Matched as an
 * exact tuple, not as per-segment upper bounds — an undersized segment is not a
 * short spelling of a valid NDC, it is a malformed identifier, and left-padding it
 * anyway turns junk like `2-152-1` into the real key `00002015201`, a package the
 * caller never named.
 * @see https://www.fda.gov/drugs/development-approval-process-drugs/national-drug-code-database-background-information
 */
const NDC_SEGMENT_WIDTHS: ReadonlySet<string> = new Set(['4-4-2', '5-3-2', '5-4-1', '5-4-2']);

/**
 * Expand a National Drug Code to the 11-digit HIPAA form(s) the `ndc_map` stores
 * (RxNav emits 11-digit). NDC is not a {@link SystemId} — it is an identifier the
 * server decodes to its RxNorm product (see `getByNdc`), so it is detected here
 * rather than in `detectSystems`. Returns the candidate 11-digit keys plus
 * whether the input is an UNAMBIGUOUS NDC.
 *
 * - **Hyphenated** `4-4-2` / `5-3-2` / `5-4-1` / `5-4-2`: the segment widths fix
 *   the 5-4-2 left-padding deterministically → one candidate, `unambiguous: true`
 *   (a hyphenated drug code is never an RXCUI, so a miss is a real NDC miss). Any
 *   other width combination is rejected outright.
 * - **Bare 11 digits**: already the 11-digit form → one candidate, but
 *   `unambiguous: false` — it also satisfies the RXCUI shape (no current RXCUI is
 *   that long, but the caller still falls back to RXCUI on a map miss).
 * - **Bare 10 digits**: segmentation unknown → the three standard `4-4-2` /
 *   `5-3-2` / `5-4-1` expansions, `unambiguous: false`.
 * - Anything else → no candidates (not NDC-shaped).
 */
export function ndcCandidates(rawCode: string): { candidates: string[]; unambiguous: boolean } {
  const trimmed = rawCode.trim();
  const segs = trimmed.split('-');

  if (segs.length === 3 && segs.every((s) => /^[0-9]+$/.test(s))) {
    const [a, b, c] = segs as [string, string, string];
    if (!NDC_SEGMENT_WIDTHS.has(`${a.length}-${b.length}-${c.length}`)) {
      return { candidates: [], unambiguous: false };
    }
    return {
      candidates: [a.padStart(5, '0') + b.padStart(4, '0') + c.padStart(2, '0')],
      unambiguous: true,
    };
  }

  if (/^[0-9]+$/.test(trimmed)) {
    if (trimmed.length === 11) return { candidates: [trimmed], unambiguous: false };
    if (trimmed.length === 10) {
      return {
        candidates: [
          `0${trimmed}`, // 4-4-2 → pad segment 1
          `${trimmed.slice(0, 5)}0${trimmed.slice(5)}`, // 5-3-2 → pad segment 2
          `${trimmed.slice(0, 9)}0${trimmed.slice(9)}`, // 5-4-1 → pad segment 3
        ],
        unambiguous: false,
      };
    }
  }
  return { candidates: [], unambiguous: false };
}
