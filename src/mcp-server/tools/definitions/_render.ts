/**
 * @fileoverview Shared markdown rendering for a decoded code. Centralizes the
 * one place that must touch every field of the decoded-code shape so format()
 * parity holds identically across medcode_get_code, medcode_search_codes, and
 * medcode_browse_hierarchy (the linter walks each field; rendering them in one
 * helper keeps the three tools in sync).
 * @module mcp-server/tools/definitions/_render
 */

import { SYSTEM_LABELS } from '@/services/code-index/types.js';

/** The minimal decoded-code shape every render helper consumes. */
export interface RenderableCode {
  billable: boolean;
  chapter: string | null;
  code: string;
  description: string | null;
  header: boolean;
  shortDescription: string | null;
  system: string;
}

/** Human label for a system id, falling back to the raw id. */
function label(system: string): string {
  return SYSTEM_LABELS[system as keyof typeof SYSTEM_LABELS] ?? system;
}

/**
 * Billability phrase referencing both fields by their key names. The key names
 * ("billable", "header") must appear literally so the format-parity linter — which
 * checks for the key name of permissive boolean fields — sees them rendered.
 */
function flags(c: RenderableCode): string {
  return `billable: ${c.billable ? 'yes' : 'no'}, header: ${c.header ? 'yes' : 'no'}`;
}

/**
 * Render a decoded code as a single bullet line touching every field:
 * code, system, billable, header, chapter, description, shortDescription.
 */
export function renderCodeLine(c: RenderableCode): string {
  const desc = c.description ?? c.shortDescription ?? '(no description)';
  const short =
    c.shortDescription && c.shortDescription !== c.description
      ? ` _(short: ${c.shortDescription})_`
      : '';
  const chapter = c.chapter ? ` · chapter ${c.chapter}` : '';
  return `- **${c.code}** (${label(c.system)}; ${flags(c)}${chapter}): ${desc}${short}`;
}

/** Render a decoded code as a heading block touching every field. */
export function renderCodeBlock(c: RenderableCode): string[] {
  const lines = [
    `## ${c.code} — ${label(c.system)}`,
    `**${flags(c)}**${c.chapter ? ` · chapter ${c.chapter}` : ''}`,
  ];
  lines.push(c.description ?? c.shortDescription ?? '(no description)');
  if (c.shortDescription && c.shortDescription !== c.description)
    lines.push(`_Short:_ ${c.shortDescription}`);
  return lines;
}
