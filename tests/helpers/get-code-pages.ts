/**
 * @fileoverview Test helper: drive medcode_get_code through the framework contract
 * (handler, output parse, format) and measure each reply the way a client receives
 * it — the UTF-8 bytes of the `content[]` text and of the serialized
 * `structuredContent`. Walks a batch through its `deferred` continuation, and builds
 * the unbudgeted reference a walk is checked against from one-input calls, which a
 * byte budget never cuts.
 * @module tests/helpers/get-code-pages
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';

import { getCodeTool } from '@/mcp-server/tools/definitions/get-code.tool.js';

/** The per-surface reply budget the tool holds a batch to. */
export const REPLY_BUDGET_BYTES = 24_000;

export interface GetCodeArgs {
  codes: string[];
  includeHierarchy?: boolean;
  system?: string;
}

interface Found {
  children?: unknown[];
  code: string;
  system: string;
}
interface NotFound {
  code: string;
  reason: string;
}

export interface GetCodePage {
  contentBytes: number;
  deferred: string[] | undefined;
  found: Found[];
  notFound: NotFound[];
  sent: string[];
  structured: Record<string, unknown>;
  structuredBytes: number;
  text: string;
}

/** One successful medcode_get_code call, measured on both surfaces. */
export async function getCodePage(args: GetCodeArgs): Promise<GetCodePage> {
  const result = await runToolContract(getCodeTool, args as never);
  expect(result.isError, JSON.stringify(result.structuredContent).slice(0, 400)).toBeFalsy();
  const structured = result.structuredContent as Record<string, unknown> & {
    deferred?: string[];
    found: Found[];
    notFound: NotFound[];
  };
  const text = (result.content as { text?: string; type: string }[])
    .map((block) => block.text ?? '')
    .join('');
  return {
    sent: args.codes,
    structured,
    found: structured.found,
    notFound: structured.notFound,
    deferred: structured.deferred,
    text,
    contentBytes: Buffer.byteLength(text, 'utf8'),
    structuredBytes: Buffer.byteLength(JSON.stringify(structured), 'utf8'),
  };
}

/** A value's length in Unicode code points, the unit the tool's 64-character echo bound counts. */
const chars = (value: string) => [...value].length;

/** Whether a code is past the bound once trimmed, so the tool never looks it up. */
const tooLong = (code: string) => chars(code.trim()) > 64;

/**
 * A caller value as the tool echoes it: as sent at 64 characters or fewer, else
 * trimmed when that fits, else its first 64 trimmed characters and `…`. Written
 * here from the documented rule, not imported, so the walk checks the tool against
 * the contract rather than against itself.
 */
function echoed(code: string): string {
  if (chars(code) <= 64) return code;
  const trimmed = code.trim();
  return tooLong(trimmed) ? `${[...trimmed].slice(0, 64).join('')}…` : trimmed;
}

/**
 * Check one page's `deferred` against the codes it was sent: exactly their tail, in
 * order, each code as {@link echoed} — as sent, trimmed when its padding alone ran
 * past the bound, or cut when it is longer than the bound once trimmed.
 */
function expectDeferredOf(page: GetCodePage, codes: readonly string[]): void {
  const deferred = page.deferred ?? [];
  expect(deferred).toEqual(codes.slice(codes.length - deferred.length).map(echoed));
}

/**
 * Follow the documented continuation verbatim — re-call with `codes: deferred` and
 * the same `system` and `includeHierarchy` until no `deferred` comes back —
 * asserting on every page that `deferred`, when present, is non-empty, shorter than
 * the codes that page was sent, and their tail as {@link expectDeferredOf} reads it.
 */
export async function walkGetCode(args: GetCodeArgs): Promise<{
  found: Found[];
  notFound: NotFound[];
  pages: GetCodePage[];
}> {
  const pages: GetCodePage[] = [];
  let codes = args.codes;
  for (;;) {
    const page = await getCodePage({ ...args, codes });
    pages.push(page);
    if (page.deferred === undefined) break;
    // Every page consumes at least one input, so the walk terminates.
    expect(page.deferred.length).toBeGreaterThan(0);
    expect(page.deferred.length).toBeLessThan(codes.length);
    expectDeferredOf(page, codes);
    codes = page.deferred;
  }
  return {
    pages,
    found: pages.flatMap((page) => page.found),
    notFound: pages.flatMap((page) => page.notFound),
  };
}

/**
 * The reply a batch would get with no byte budget: each input decoded on its own,
 * in request order. A lone resolving input is never deferred; a lone miss fails the
 * whole call, so a miss is decoded behind `anchor`, a small code that resolves
 * under the same `system`, and only the miss's entry is kept.
 */
export async function unbudgetedGetCode(
  args: GetCodeArgs,
  anchor: string,
): Promise<{ found: Found[]; notFound: NotFound[] }> {
  const found: Found[] = [];
  const notFound: NotFound[] = [];
  for (const code of args.codes) {
    const alone = await runToolContract(getCodeTool, { ...args, codes: [code] } as never);
    if (!alone.isError) {
      const out = alone.structuredContent as {
        deferred?: string[];
        found: Found[];
        notFound: NotFound[];
      };
      expect(out.deferred).toBeUndefined();
      found.push(...out.found);
      notFound.push(...out.notFound);
      continue;
    }
    const behind = await getCodePage({ ...args, codes: [anchor, code] });
    expect(behind.deferred).toBeUndefined();
    expect(behind.notFound).toHaveLength(1);
    notFound.push(...behind.notFound);
  }
  return { found, notFound };
}
