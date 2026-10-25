/**
 * @fileoverview Shared markdown rendering for the tools' `content[]` text. Two
 * jobs live here. First, the one seam every value the tools did not author passes
 * through on its way into Markdown — a code, a description, an RxNorm or RxClass
 * name, release metadata, echoed caller input — so a CommonMark parse of
 * `content[]` reads it back exactly as `structuredContent` carries it, while the
 * Markdown the tools write (headings, `**labels**`, bullets, table syntax) keeps
 * rendering. Second, the decoded-code renderers that must touch every field of
 * that shape so format() parity holds identically across medcode_get_code,
 * medcode_search_codes, and medcode_browse_hierarchy (the linter walks each
 * field; rendering them in one helper keeps the three tools in sync).
 * @module mcp-server/tools/definitions/_render
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

import { SYSTEM_LABELS } from '@/services/code-index/types.js';

/**
 * A value the tool did not author, as inline Markdown that reads back as written:
 * `*`, `_`, backticks, `[x](y)`, `|`, `<b>`, and a line-leading `-` or `#` come
 * back literally, while plain text is unchanged.
 */
export function literal(value: string): string {
  return escapeMarkdownInline(value);
}

/**
 * {@link literal} for a value that closes an ATX heading line. A trailing run of
 * `#` after a space is the heading's optional closing sequence, which CommonMark
 * drops, so the last `#` is backslash-escaped to keep it as text — unless
 * {@link literal} already escaped it (a lone `#` value), which an odd run of
 * backslashes before it marks: literal doubles every backslash it keeps as text.
 */
export function literalAtHeadingEnd(value: string): string {
  const text = literal(value);
  if (!text.endsWith('#')) return text;
  let backslashes = 0;
  for (let i = text.length - 2; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 0 ? `${text.slice(0, -1)}\\#` : text;
}

/**
 * One GFM table row. Every string cell renders through {@link literal}, which
 * escapes `|` so a cell value cannot split its row; numbers render as themselves.
 * A table cell holds one line, so cells take single-line values — the release
 * metadata and axis meanings the tools tabulate are.
 */
export function tableRow(cells: readonly (number | string)[]): string {
  return `| ${cells.map((cell) => (typeof cell === 'number' ? String(cell) : literal(cell))).join(' | ')} |`;
}

/** The minimal decoded-code shape every render helper consumes. */
export interface RenderableCode {
  /** Null when the code's system has no billing concept (RxNorm). */
  billable: boolean | null;
  chapter: string | null;
  code: string;
  description: string | null;
  header: boolean;
  shortDescription: string | null;
  system: string;
}

/** Human label for a system id, falling back to the raw id. */
function label(system: string): string {
  return SYSTEM_LABELS[system as keyof typeof SYSTEM_LABELS] ?? literal(system);
}

/**
 * Billability phrase referencing both fields by their key names. The key names
 * ("billable", "header") must appear literally so the format-parity linter — which
 * checks for the key name of permissive boolean fields — sees them rendered. A null
 * `billable` (no billing concept in the system) reads `n/a`, never `no`.
 */
function flags(c: RenderableCode): string {
  const billable = c.billable === null ? 'n/a' : c.billable ? 'yes' : 'no';
  return `billable: ${billable}, header: ${c.header ? 'yes' : 'no'}`;
}

/** The description line's text: the long form, else the short one, else a placeholder. */
function descriptionText(c: RenderableCode): string {
  const desc = c.description ?? c.shortDescription;
  return desc === null ? '(no description)' : literal(desc);
}

/**
 * Render a decoded code as a single bullet line touching every field:
 * code, system, billable, header, chapter, description, shortDescription.
 */
export function renderCodeLine(c: RenderableCode): string {
  const short =
    c.shortDescription && c.shortDescription !== c.description
      ? ` _(short: ${literal(c.shortDescription)})_`
      : '';
  const chapter = c.chapter ? ` · chapter ${literal(c.chapter)}` : '';
  return `- **${literal(c.code)}** (${label(c.system)}; ${flags(c)}${chapter}): ${descriptionText(c)}${short}`;
}

/** Render a decoded code as a heading block touching every field. */
export function renderCodeBlock(c: RenderableCode): string[] {
  const lines = [
    `## ${literal(c.code)} — ${label(c.system)}`,
    `**${flags(c)}**${c.chapter ? ` · chapter ${literal(c.chapter)}` : ''}`,
    descriptionText(c),
  ];
  if (c.shortDescription && c.shortDescription !== c.description)
    lines.push(`_Short:_ ${literal(c.shortDescription)}`);
  return lines;
}
