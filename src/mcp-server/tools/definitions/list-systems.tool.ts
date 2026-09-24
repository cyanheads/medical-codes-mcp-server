/**
 * @fileoverview medcode_list_systems — list the bundled code systems with their
 * release identifiers, effective dates, and code counts, plus the RxClass
 * drug-class layer with each source's version. Cheap orientation / provenance
 * call so a caller can confirm which ICD-10 fiscal year, HCPCS release, RxNorm
 * snapshot, and RxClass sources are active before acting on results.
 * @module mcp-server/tools/definitions/list-systems.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

import { getCodeIndexService } from '@/services/code-index/code-index-service.js';
import { SYSTEM_LABELS } from '@/services/code-index/types.js';

const SOURCE_URL =
  'https://github.com/cyanheads/medical-codes-mcp-server/blob/main/src/mcp-server/tools/definitions/list-systems.tool.ts';

/** The keyless API the RxClass layer is fetched from at build time. */
const RXCLASS_SOURCE_URL = 'https://rxnav.nlm.nih.gov/REST/rxclass/';

export const listSystemsTool = tool('medcode_list_systems', {
  title: 'List Code Systems',
  description:
    'List the bundled US medical code systems with their release identifiers, effective dates, and code counts, and the RxClass drug-class layer the class crosswalks read, with each source’s version. Confirms which ICD-10-CM fiscal year, ICD-10-PCS fiscal year, HCPCS Level II release, RxNorm normalized set, and RxClass sources are active before acting on any decode, search, or crosswalk result. The corpus is offline and built at package-build time — this call reports exactly which release is baked into the running server. ICD-10-CM/PCS are the US clinical modifications, not the ICD-10/ICD-11 base.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sourceUrl: SOURCE_URL,

  input: z.object({}),

  output: z.object({
    systems: z
      .array(
        z
          .object({
            system: z
              .string()
              .describe('System identifier, e.g. "ICD10CM", "ICD10PCS", "HCPCS", "RXNORM".'),
            label: z.string().describe('Human-readable system name, e.g. "ICD-10-CM".'),
            releaseId: z
              .string()
              .describe(
                'Release/version identifier baked into this build, e.g. "ICD-10-CM FY2026".',
              ),
            effectiveStart: z
              .string()
              .nullable()
              .describe(
                'First date this release is effective (YYYY-MM-DD), or null if not recorded.',
              ),
            effectiveEnd: z
              .string()
              .nullable()
              .describe('Last date this release is effective (YYYY-MM-DD), or null if open-ended.'),
            codeCount: z.number().describe('Number of code rows bundled for this system.'),
            sourceUrl: z
              .string()
              .nullable()
              .describe('Canonical .gov source the release was built from, or null.'),
            builtAt: z
              .string()
              .describe(
                'ISO 8601 timestamp of this system’s data. For ICD-10-CM, ICD-10-PCS, and HCPCS, the time the index was built from the release named in `releaseId`. For RxNorm, which publishes no release label, the date the RxNav snapshot was fetched — how current its drug data is, unchanged by a rebuild from the same snapshot.',
              ),
          })
          .describe('Provenance for one bundled code system.'),
      )
      .describe(
        'One entry per bundled code system, in canonical order — the systems the `system` inputs of the other tools accept.',
      ),
    classLayer: z
      .object({
        classCount: z
          .number()
          .describe(
            'RxClass class nodes bundled, including hierarchy nodes with no direct member.',
          ),
        edgeCount: z.number().describe('Drug–class edges bundled, across every source.'),
        sourceUrl: z.string().describe('The RxClass API the layer was fetched from.'),
        sources: z
          .array(
            z
              .object({
                source: z
                  .string()
                  .describe(
                    'The RxClass source, as class hits carry it in `source`: MEDRT, FDASPL, FMTSME, VA, RXNORM (DEA schedules), or CDC (CVX).',
                  ),
                version: z
                  .string()
                  .nullable()
                  .describe(
                    'The release RxClass reports for this source, or null when it publishes none.',
                  ),
                classCount: z
                  .number()
                  .describe('Classes this source asserts at least one bundled edge to.'),
                edgeCount: z.number().describe('Drug–class edges this source contributes.'),
                fetchedAt: z
                  .string()
                  .describe(
                    'ISO 8601 date the RxClass snapshot was fetched — how current the class edges are.',
                  ),
              })
              .describe('Provenance for one bundled RxClass source.'),
          )
          .describe('One entry per bundled RxClass source.'),
      })
      .nullable()
      .describe(
        'The RxClass drug-class layer the rxcui_to_classes and class_to_rxcuis directions of medcode_map_codes read — not a code system, so it has no entry in `systems`. Null when this build carries no class layer.',
      ),
  }),

  handler(_input, ctx) {
    const svc = getCodeIndexService();
    const systems = svc.listSystems().map((s) => ({
      system: s.system,
      label: SYSTEM_LABELS[s.system] ?? s.system,
      releaseId: s.releaseId,
      effectiveStart: s.effectiveStart,
      effectiveEnd: s.effectiveEnd,
      codeCount: s.codeCount,
      sourceUrl: s.sourceUrl,
      builtAt: s.builtAt,
    }));
    const layer = svc.classLayer();
    ctx.log.info('Listed bundled code systems', {
      count: systems.length,
      classLayer: layer !== null,
    });
    return {
      systems,
      classLayer: layer ? { ...layer, sourceUrl: RXCLASS_SOURCE_URL } : null,
    };
  },

  format: (result) => {
    const lines = ['## Bundled code systems', ''];
    lines.push('| System | Release | Effective | Codes |');
    lines.push('|:---|:---|:---|---:|');
    for (const s of result.systems) {
      const effective =
        s.effectiveStart && s.effectiveEnd
          ? `${s.effectiveStart} → ${s.effectiveEnd}`
          : (s.effectiveStart ?? s.effectiveEnd ?? '—');
      lines.push(`| ${s.label} (${s.system}) | ${s.releaseId} | ${effective} | ${s.codeCount} |`);
    }
    lines.push('');
    for (const s of result.systems) {
      // RxNorm has no release label; its date is when its snapshot was fetched.
      const dated =
        s.system === 'RXNORM' ? `RxNav snapshot fetched ${s.builtAt}` : `built ${s.builtAt}`;
      if (s.sourceUrl) lines.push(`- **${s.label}** source: ${s.sourceUrl} (${dated})`);
    }

    lines.push('', '## RxClass drug-class layer', '');
    const layer = result.classLayer;
    if (!layer) {
      lines.push(
        'Not present in this build — the rxcui_to_classes and class_to_rxcuis directions of medcode_map_codes are unavailable.',
      );
      return [{ type: 'text', text: lines.join('\n') }];
    }
    lines.push(
      `${layer.classCount} classes and ${layer.edgeCount} drug–class edges over the RxNorm concepts above, read by medcode_map_codes rxcui_to_classes and class_to_rxcuis. Source: ${layer.sourceUrl}`,
      '',
      '| Source | Version | Classes | Edges | Fetched |',
      '|:---|:---|---:|---:|:---|',
    );
    for (const s of layer.sources) {
      lines.push(
        `| ${s.source} | ${s.version ?? 'none published'} | ${s.classCount} | ${s.edgeCount} | ${s.fetchedAt} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
