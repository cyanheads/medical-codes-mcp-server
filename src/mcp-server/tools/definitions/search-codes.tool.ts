/**
 * @fileoverview medcode_search_codes — find codes whose official descriptions
 * match a described concept, via full-text search over the bundled index.
 * Filter by system, billable status, and chapter. The reverse of
 * medcode_get_code: you have a clinical description and need the code.
 * @module mcp-server/tools/definitions/search-codes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getCodeIndexService } from '@/services/code-index/code-index-service.js';
import { SYSTEM_IDS } from '@/services/code-index/types.js';
import { encodeNextCursor, resolvePage } from './_pagination.js';
import { renderCodeLine } from './_render.js';
import { nonBlankString } from './_schema.js';

const SOURCE_URL =
  'https://github.com/cyanheads/medical-codes-mcp-server/blob/main/src/mcp-server/tools/definitions/search-codes.tool.ts';

export const searchCodesTool = tool('medcode_search_codes', {
  title: 'medical-codes-mcp-server',
  description:
    'Find US medical codes whose official descriptions match a described concept, via full-text search over the bundled index. Every search term must appear — matched first as a token prefix, then as a substring so inflected and compound forms are also found (a "neuropathy" search surfaces "mononeuropathy"/"polyneuropathy" siblings too, not only a standalone "neuropathy" token). Filter by `system` (ICD10CM/ICD10PCS/HCPCS/RXNORM), `billableOnly` to exclude headers/categories, and `chapter`. Use when you have a clinical description and need the code — the reverse of medcode_get_code. Results echo the resolved system per row for chaining, rank exact prefix matches ahead of substring-only matches with a deterministic tie-break, and disclose truncation with a `nextCursor`: pass it back as `cursor` to page through the full ranked set.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sourceUrl: SOURCE_URL,

  input: z.object({
    query: nonBlankString('query').describe(
      'Clinical description to match, e.g. "type 2 diabetes with neuropathy". Must not be blank or whitespace-only.',
    ),
    system: z
      .enum(SYSTEM_IDS)
      .optional()
      .describe('Restrict results to one system. Omit to search all bundled systems.'),
    billableOnly: z
      .boolean()
      .default(false)
      .describe('When true, return only billable leaf codes (exclude headers/categories).'),
    chapter: z
      .string()
      .optional()
      .describe(
        "Restrict to a chapter/range bucket (the value from a code's `chapter` field). Case-insensitive: surrounding whitespace is trimmed and the value is upper-cased to match how chapters are stored, and `appliedFilters.chapter` echoes the upper-cased value that actually ran. A blank or whitespace-only value carries no filtering intent and is treated as omitted, which the response discloses as `appliedFilters.chapter: null`.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Max codes per page. Defaults to the server's MEDCODE_MAX_RESULTS (50), ceiling 200.",
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque continuation token from a previous response's `nextCursor`, to fetch the next page of the same ranked result set. Omit for the first page.",
      ),
  }),

  output: z.object({
    codes: z
      .array(
        z
          .object({
            system: z.string().describe('The system the code belongs to, echoed for chaining.'),
            code: z.string().describe('The code in display form (ICD-10-CM carries the dot).'),
            description: z
              .string()
              .nullable()
              .describe(
                'Official long description (falls back to short when no long form exists).',
              ),
            shortDescription: z
              .string()
              .nullable()
              .describe('Official short description, or null when none is on record.'),
            billable: z.boolean().describe('True when the code is a billable leaf.'),
            header: z.boolean().describe('True when the code is a non-billable category/header.'),
            chapter: z.string().nullable().describe('Chapter/range bucket, or null.'),
          })
          .describe('A code matching the search query.'),
      )
      .describe('Matching codes, ranked by full-text relevance.'),
  }),

  enrichment: {
    effectiveQuery: z.string().describe('The query as the server parsed it for matching.'),
    appliedFilters: z
      .object({
        system: z.string().nullable().describe('System filter applied, or null.'),
        billableOnly: z.boolean().describe('Whether the billable-only filter was applied.'),
        chapter: z.string().nullable().describe('Chapter filter applied, or null.'),
      })
      .describe('Filters the server applied to the search.'),
    truncated: z.boolean().describe('True when more matches exist beyond this page.'),
    shown: z.number().describe('Number of codes returned on this page.'),
    cap: z.number().describe('The page size that was applied.'),
    nextCursor: z
      .string()
      .optional()
      .describe(
        'Opaque token to pass back as `cursor` for the next page. Present only when more matches exist beyond this page.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched — echoes the query and suggests how to broaden.'),
  },

  enrichmentTrailer: {
    appliedFilters: {
      render: (f: { system: string | null; billableOnly: boolean; chapter: string | null }) =>
        `**Filters:** system=${f.system ?? 'any'}, billableOnly=${f.billableOnly}, chapter=${f.chapter ?? 'any'}`,
    },
  },

  handler(input, ctx) {
    const page = resolvePage(input.cursor, input.limit);
    // One normalization feeds BOTH the SQL predicate and the echoed appliedFilters,
    // so the filter that ran and the filter that is reported cannot diverge. Blank
    // is omitted rather than rejected: `chapter` is an optional filter, so a value
    // with no content states no filtering intent, and dropping it is disclosed by
    // the echoed `chapter: null` — unlike `node`, where a normalized-away value
    // would silently change which subtree was walked. Upper-casing joins the trim
    // for the same reason `storageCode` upper-cases a code before comparison: the
    // predicate is an exact `chapter = ?`, and every stored chapter is derived at
    // build time from an upper-case code character or an RxNorm term type — so a
    // lower-cased chapter matches nothing and zero-hits a valid search in silence.
    const chapter = input.chapter?.trim().toUpperCase() || undefined;
    const { codes, hasMore } = getCodeIndexService().searchFts(input.query, {
      ...(input.system && { system: input.system }),
      billableOnly: input.billableOnly,
      ...(chapter && { chapter }),
      offset: page.offset,
      limit: page.limit,
    });

    ctx.enrich({
      effectiveQuery: input.query.trim(),
      appliedFilters: {
        system: input.system ?? null,
        billableOnly: input.billableOnly,
        chapter: chapter ?? null,
      },
    });

    ctx.enrich({ truncated: hasMore, shown: codes.length, cap: page.limit });
    if (hasMore) ctx.enrich({ nextCursor: encodeNextCursor(page) });

    if (codes.length === 0) {
      ctx.enrich.notice(
        `No codes matched "${input.query.trim()}"${input.system ? ` in ${input.system}` : ''}. ` +
          'Broaden the terms, drop the filters, or try clinical synonyms.',
      );
      ctx.log.info('Search returned no matches', { query: input.query });
      return { codes };
    }

    ctx.log.info('Search completed', { query: input.query, count: codes.length });
    return { codes };
  },

  format: (result) => {
    if (result.codes.length === 0) {
      return [{ type: 'text', text: 'No matching codes.' }];
    }
    const lines: string[] = [`## ${result.codes.length} matching code(s)`, ''];
    for (const c of result.codes) lines.push(renderCodeLine(c));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
