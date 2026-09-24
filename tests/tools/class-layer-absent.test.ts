/**
 * @fileoverview The class directions and the class-layer provenance on an index
 * built before the RxClass layer existed — the no-class-layer fixture, which has
 * every code row and none of the class tables, as a custom `MEDCODE_DB_PATH`
 * pointing at an older build would. The class directions fail with
 * `direction_unavailable` on both surfaces; every other direction still runs.
 * @module tests/tools/class-layer-absent.test
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
import { ensureFixtureWithoutClassLayer } from '../helpers/index-fixture.ts';

interface ErrorEnvelope {
  error: {
    code: number;
    data?: { fields?: string[]; reason?: string; recovery?: { hint?: string } };
    message: string;
  };
}

/** Sends an argument bag as a client would; the tools' parsed-input typing is beside the point here. */
const call = runToolContract as unknown as (
  tool: unknown,
  args: Record<string, unknown>,
) => ReturnType<typeof runToolContract>;

function textOf(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content as { text?: string; type: string }[])
    .flatMap((block) => (block.type === 'text' ? [block.text ?? ''] : []))
    .join('\n');
}

beforeAll(async () => {
  // Set before the service first reads getServerConfig(), which caches the path.
  process.env.MEDCODE_DB_PATH = ensureFixtureWithoutClassLayer();
  await initCodeIndexService();
});

describe('an index without the RxClass layer', () => {
  it('opens, and reports that it carries no class layer', () => {
    const svc = getCodeIndexService();
    expect(svc.dbPath).toMatch(/no-class-layer\.fixture\.db$/);
    expect(svc.hasRxNorm()).toBe(true);
    expect(svc.hasClassLayer()).toBe(false);
    expect(svc.classLayer()).toBeNull();
  });

  it.each([
    [{ from: '198440', direction: 'rxcui_to_classes' }],
    [{ from: 'N0000008836', direction: 'class_to_rxcuis' }],
    // The fields are not the news: dropping them would only reach this same error.
    [{ from: 'N0000008836', direction: 'class_to_rxcuis', classType: 'PE', limit: 1 }],
    [{ from: '198440', direction: 'rxcui_to_classes', system: 'HCPCS', cursor: 'not-a-cursor' }],
  ])('fails %j with direction_unavailable on both surfaces', async (args) => {
    const result = await call(mapCodesTool, args);
    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as ErrorEnvelope;
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('direction_unavailable');
    expect(error.message).toBe(
      `The "${args.direction}" crosswalk needs the RxClass drug-class layer, which this build of the index does not carry.`,
    );
    const hint = error.data?.recovery?.hint ?? '';
    expect(hint).toContain('MEDCODE_DB_PATH');
    const text = textOf(result);
    expect(text).toContain(error.message);
    expect(text).toContain(hint);
    expect(text).toContain('(reason direction_unavailable)');
  });

  it('still runs every other direction, and still rejects classType on them', async () => {
    const ingredients = await call(mapCodesTool, {
      from: '198440',
      direction: 'rxcui_to_ingredients',
    });
    expect(ingredients.isError).toBeFalsy();
    expect(ingredients.structuredContent).toMatchObject({ hits: [{ value: '161' }] });

    const rejected = await call(mapCodesTool, {
      from: 'E11.9',
      direction: 'parents',
      classType: 'EPC',
    });
    const { error } = rejected.structuredContent as ErrorEnvelope;
    expect(error.data?.reason).toBe('field_not_applicable');
    expect(error.data?.fields).toEqual(['classType']);
  });

  it('lists the four code systems and a null class layer on both surfaces', async () => {
    const result = await call(listSystemsTool, {});
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { classLayer: unknown; systems: { system: string }[] };
    expect(out.systems.map((s) => s.system)).toEqual(['ICD10CM', 'ICD10PCS', 'HCPCS', 'RXNORM']);
    expect(out.classLayer).toBeNull();
    expect(textOf(result)).toContain(
      'Not present in this build — the rxcui_to_classes and class_to_rxcuis directions of medcode_map_codes are unavailable.',
    );
  });
});
