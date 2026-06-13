/**
 * @fileoverview Code-shape auto-detection. Each bundled system has a distinct
 * lexical shape; `detectSystems` returns every system a raw code could belong
 * to so the caller can disambiguate (one match → route directly; multiple →
 * `ambiguous_system`; zero → unknown shape).
 * @module services/code-index/detect
 */

import { storageCode } from './schema.js';
import type { SystemId } from './types.js';

/**
 * ICD-10-CM: a letter, two digits, then optionally a dot and up to four more
 * alphanumerics. Tested against the dot-stripped storage form. The first
 * character is a letter; the next two are digits; trailing characters are
 * alphanumeric. `D` and `U` are valid leading letters in ICD-10-CM.
 */
const ICD10CM_RE = /^[A-TV-Z][0-9][0-9AB][0-9A-Z]{0,4}$/;

/**
 * ICD-10-PCS: exactly 7 characters, alphanumeric, drawn from digits 0-9 and
 * letters A-H,J-N,P-Z (the letters `I` and `O` are excluded by design to avoid
 * confusion with 1 and 0).
 */
const ICD10PCS_RE = /^[0-9A-HJ-NP-Z]{7}$/;

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
 * Empty array ⇒ the code matches no known shape. The caller decides what a
 * single vs. multiple match means.
 *
 * Note the deliberate overlaps the design calls out: a 7-character ICD-10-PCS
 * code can also satisfy the ICD-10-CM pattern is NOT possible (CM caps at 3+4=7
 * but requires digits in positions 2-3 and a leading A-Z excluding nothing),
 * but a 5-char HCPCS code and a short ICD-10-CM category never collide because
 * HCPCS requires 4 trailing digits while CM position 2-3 are digits and 4-5 are
 * alphanumeric — `J0120` is HCPCS-only. The real ambiguity is a bare integer
 * (RXCUI) vs nothing else, and a 7-char alphanumeric that is PCS-shaped.
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
