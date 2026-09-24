/**
 * @fileoverview The class directions and the class-layer provenance on an index
 * whose class tables exist but hold no rows — what `build-index.ts` produces from
 * sources with an RxNav cache and no RxClass cache. That build carries no class
 * layer, so it must read exactly like one built before the layer existed: the
 * class directions fail with `direction_unavailable` rather than answering every
 * RXCUI with "no bundled RxClass source classifies it", and `classLayer` is null.
 * @module tests/tools/class-layer-empty.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { listSystemsTool } from '@/mcp-server/tools/definitions/list-systems.tool.js';
import { mapCodesTool } from '@/mcp-server/tools/definitions/map-codes.tool.js';
import {
  getCodeIndexService,
  initCodeIndexService,
} from '@/services/code-index/code-index-service.js';
import { ensureFixtureWithEmptyClassLayer } from '../helpers/index-fixture.ts';

interface ErrorEnvelope {
  error: { code: number; data?: { reason?: string }; message: string };
}

/** Sends an argument bag as a client would; the tools' parsed-input typing is beside the point here. */
const call = runToolContract as unknown as (
  tool: unknown,
  args: Record<string, unknown>,
) => ReturnType<typeof runToolContract>;

beforeAll(async () => {
  // Set before the service first reads getServerConfig(), which caches the path.
  process.env.MEDCODE_DB_PATH = ensureFixtureWithEmptyClassLayer();
  await initCodeIndexService();
});

describe('an index whose class tables are empty', () => {
  it('reports that it carries no class layer', () => {
    const svc = getCodeIndexService();
    expect(svc.dbPath).toMatch(/empty-class-layer\.fixture\.db$/);
    expect(svc.hasRxNorm()).toBe(true);
    expect(svc.hasClassLayer()).toBe(false);
    expect(svc.classLayer()).toBeNull();
  });

  it.each([
    [{ from: '198440', direction: 'rxcui_to_classes' }],
    [{ from: 'N0000008836', direction: 'class_to_rxcuis' }],
  ])('fails %j with direction_unavailable instead of an empty answer', async (args) => {
    const result = await call(mapCodesTool, args);
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as ErrorEnvelope;
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('direction_unavailable');
    expect(error.message).toBe(
      `The "${args.direction}" crosswalk needs the RxClass drug-class layer, which this build of the index does not carry.`,
    );
  });

  it('lists a null class layer', async () => {
    const result = await call(listSystemsTool, {});
    expect((result.structuredContent as { classLayer: unknown }).classLayer).toBeNull();
  });
});
