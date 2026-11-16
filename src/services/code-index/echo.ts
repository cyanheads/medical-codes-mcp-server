/**
 * @fileoverview The bound on a caller's value as the tools echo it, and on the code
 * inputs they look up. No bundled code, RXCUI, NDC, or RxClass class ID is longer
 * than 13 characters, so a code input past {@link ECHO_MAX_CHARS} once trimmed is
 * never looked up, and every miss, notice, `notFound` or `deferred` row, and log
 * field carries at most that many characters of the value, whatever its length.
 * Lengths are Unicode code points, the unit JSON Schema's `maxLength` counts, so a
 * cut never splits a surrogate pair. The service's miss builders echo through here
 * as well as the tools, which is why it sits in the service layer.
 * @module services/code-index/echo
 */

/**
 * The most characters of a caller's value a reply echoes, and the longest code
 * input the tools look up, counted in Unicode code points after trimming.
 */
export const ECHO_MAX_CHARS = 64;

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Where the first `count` code points of `text` end, as a UTF-16 index — past a
 * whole surrogate pair, never between its halves. Stops scanning at `count`, so it
 * costs at most `2 × count` steps whatever the text's length, and returns
 * `text.length` when the text holds fewer code points than that.
 */
function codePointEnd(text: string, count: number): number {
  let index = 0;
  for (let seen = 0; seen < count && index < text.length; seen++) {
    const pair =
      isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1));
    index += pair ? 2 : 1;
  }
  return index;
}

/** The number of code points in `text`: a surrogate pair is one, a lone half one. */
function codePointLength(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++, count++) {
    if (isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1))) {
      index++;
    }
  }
  return count;
}

/** Whether `text` holds more than {@link ECHO_MAX_CHARS} code points. */
const pastBound = (text: string) =>
  text.length > ECHO_MAX_CHARS && codePointEnd(text, ECHO_MAX_CHARS) < text.length;

/**
 * Whether a value is longer than {@link ECHO_MAX_CHARS} characters once trimmed:
 * longer than any code, RXCUI, NDC, or class ID, so the tools do not look it up.
 */
export function isOverlong(value: string): boolean {
  return pastBound(value.trim());
}

/**
 * A caller's value as a reply echoes it: as sent when it is at most
 * {@link ECHO_MAX_CHARS} characters; else trimmed, when that is short enough; else
 * its first {@link ECHO_MAX_CHARS} trimmed characters and `…`. Idempotent — an echo
 * echoes as itself — so a value a reply hands back, re-sent, is echoed the same.
 */
export function echoValue(value: string): string {
  if (!pastBound(value)) return value;
  const trimmed = value.trim();
  if (!pastBound(trimmed)) return trimmed;
  return `${trimmed.slice(0, codePointEnd(trimmed, ECHO_MAX_CHARS))}…`;
}

/** The trimmed length of a value, written for a sentence (`10,000`). */
function lengthOf(value: string): string {
  return codePointLength(value.trim()).toLocaleString('en-US');
}

/**
 * {@link echoValue} in double quotes, for a message: `"E11.9"`, and when the value
 * was cut, its whole trimmed length after it — `"qqq…" (10,000 characters)`.
 */
export function quoteValue(value: string): string {
  const quoted = `"${echoValue(value)}"`;
  return isOverlong(value) ? `${quoted} (${lengthOf(value)} characters)` : quoted;
}

/**
 * Why a value past the bound was not looked up, for a miss that echoes the value
 * beside it (a `notFound` row's `code`). It names neither the value nor its length:
 * a `deferred` row hands an overlong value back cut, and the cut value, re-sent,
 * must miss with this same entry, so the pages of a deferred batch add up to the
 * single answer.
 */
export function overlongReason(): string {
  return `Not looked up: longer than ${ECHO_MAX_CHARS} characters once trimmed, and no bundled code, RXCUI, NDC, or class ID is that long.`;
}

/** {@link overlongReason} as one message that leads with the value, cut. */
export function overlongMessage(value: string): string {
  return `${quoteValue(value)} was not looked up: no bundled code, RXCUI, NDC, or class ID is longer than ${ECHO_MAX_CHARS} characters.`;
}
