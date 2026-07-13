/**
 * @fileoverview Shared input-schema helpers for the medcode_* tools. Sits
 * alongside _pagination.ts / _render.ts as the common tool-definition glue.
 * @module mcp-server/tools/definitions/_schema
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * A required string that must carry non-whitespace content. `.min(1)` alone lets a
 * whitespace-only value through — it then trims to `""` at the service edge, where
 * the worst case is a `LIKE '%%'` drug-name lookup that matches everything. The
 * `.refine()` rejects it at the Zod boundary — the MCP SDK parses the tool input
 * schema and throws `InvalidParams` before any handler runs.
 *
 * The refinement predicate is intentionally absent from the advertised JSON Schema
 * — Zod's `toJSONSchema()` omits `.refine()` rather than failing — so the caller's
 * `.describe()` must state the non-blank requirement in prose for the schema to
 * carry it. `fieldLabel` names the field in the rejection message so the error is
 * actionable.
 */
export function nonBlankString(fieldLabel: string) {
  return z
    .string()
    .min(1)
    .refine((s) => s.trim().length > 0, {
      message: `${fieldLabel} must not be blank or whitespace-only.`,
    });
}
