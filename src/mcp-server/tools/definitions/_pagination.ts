/**
 * @fileoverview Shared cursor pagination glue for the list tools
 * (medcode_search_codes, medcode_browse_hierarchy, medcode_map_codes). Wraps the
 * framework's opaque-cursor codec (`encodeCursor`/`decodeCursor`, PaginationState
 * { offset, limit }) so every paginated tool resolves its page window and next
 * cursor through one contract — the SQL-side paging happens in CodeIndexService.
 * @module mcp-server/tools/definitions/_pagination
 */

import { decodeCursor, encodeCursor, requestContextService } from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import type { Page } from '@/services/code-index/types.js';

/**
 * Hard ceiling on page size, mirroring the tools' `limit` `.max(200)` and the
 * config ceiling. A cursor is a client-supplied opaque token that could be
 * tampered to carry an outsized `limit`, so the resolved page size is clamped
 * here at the trust boundary — the same 200 the input schemas enforce.
 */
const MAX_PAGE_SIZE = 200;

/**
 * Resolve the page window for a list tool from an optional opaque cursor and an
 * optional explicit `limit`. The offset comes from the cursor (0 on the first
 * page). Page-size precedence: an explicit `limit` this call wins; else the size
 * remembered in the cursor; else the server default (MEDCODE_MAX_RESULTS). A
 * malformed cursor throws `InvalidParams` via `decodeCursor` — the framework
 * catches and classifies it, no try/catch here.
 */
export function resolvePage(cursor: string | undefined, limit: number | undefined): Page {
  const state = cursor
    ? decodeCursor(
        cursor,
        requestContextService.createRequestContext({ operation: 'medcode.decodeCursor' }),
      )
    : undefined;
  const size = limit ?? state?.limit ?? getServerConfig().maxResults;
  return { offset: state?.offset ?? 0, limit: Math.min(size, MAX_PAGE_SIZE) };
}

/**
 * Opaque continuation token for the page after `page`. Call only when the query
 * reported more rows exist (`hasMore`); the MCP spec omits `nextCursor` entirely
 * on the last page rather than emitting an empty/terminal token.
 */
export function encodeNextCursor(page: Page): string {
  return encodeCursor({ offset: page.offset + page.limit, limit: page.limit });
}
