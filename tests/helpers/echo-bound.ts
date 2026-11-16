/**
 * @fileoverview Test helper: read a tool reply for a caller value carried past the
 * 64-character echo bound (#75), shared by the suites that walk every tool's reply
 * for an overlong value.
 * @module tests/helpers/echo-bound
 */

import { readCommonMark } from './commonmark.ts';

/** Whether `surface` holds more than 64 consecutive characters of `value`. */
export function carriesPast64(surface: string, value: string): boolean {
  const points = [...value];
  const runs = new Set<string>();
  for (let i = 0; i + 65 <= points.length; i++) runs.add(points.slice(i, i + 65).join(''));
  const read = [...surface];
  for (let i = 0; i + 65 <= read.length; i++) {
    if (runs.has(read.slice(i, i + 65).join(''))) return true;
  }
  return false;
}

/**
 * A reply's `content[]` text as a CommonMark client reads it, and the JSON of its
 * `structuredContent`, both less search's `effectiveQuery`, which echoes the query
 * whole by design. The text is read back because the raw Markdown hides a value
 * behind its escapes: an edge space is written `&#32;`, a `*` as `\*`.
 */
export function echoSurfaces(
  structured: Record<string, unknown>,
  text: string,
): { json: string; text: string } {
  return {
    text: readCommonMark(
      text
        .split('\n')
        .filter((line) => !line.startsWith('**effectiveQuery:**'))
        .join('\n'),
    ),
    json: JSON.stringify(
      Object.fromEntries(Object.entries(structured).filter(([key]) => key !== 'effectiveQuery')),
    ),
  };
}
