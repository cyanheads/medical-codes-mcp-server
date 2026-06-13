/**
 * @fileoverview medcode_get_code — decode one or more codes to their official
 * descriptions across ICD-10-CM, ICD-10-PCS, HCPCS Level II, and (phase 2)
 * RxNorm. The 80% entry point: resolve a code seen in a claim, EHR field, or
 * another health server's output into its meaning. Auto-detects the system from
 * each code's shape; an explicit `system` disambiguates. Array-in /
 * partial-success-out — one bad code never fails the rest.
 * @module mcp-server/tools/definitions/get-code.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { CodeIndexService, getCodeIndexService } from '@/services/code-index/code-index-service.js';
import { SYSTEM_IDS } from '@/services/code-index/types.js';
import { renderCodeBlock, renderCodeLine } from './_render.js';

const SOURCE_URL =
  'https://github.com/cyanheads/medical-codes-mcp-server/blob/main/src/mcp-server/tools/definitions/get-code.tool.ts';

const DecodedCodeSchema = z
  .object({
    system: z
      .string()
      .describe(
        'The system that answered, echoed for chaining: "ICD10CM", "ICD10PCS", "HCPCS", or "RXNORM".',
      ),
    code: z
      .string()
      .describe('The resolved code in display form (ICD-10-CM codes carry the dot, e.g. "E11.9").'),
    description: z
      .string()
      .nullable()
      .describe(
        'Official long description (falls back to the short description when no long form exists).',
      ),
    shortDescription: z
      .string()
      .nullable()
      .describe('Official short/abbreviated description, or null when none is on record.'),
    billable: z
      .boolean()
      .describe(
        'True when the code is a billable leaf. False for headers/categories and non-billable codes.',
      ),
    header: z
      .boolean()
      .describe(
        'True when the code is a non-billable category/header (ICD-10-CM) rather than a leaf code.',
      ),
    chapter: z
      .string()
      .nullable()
      .describe('Chapter/range bucket the code belongs to, or null when not applicable.'),
  })
  .describe('A decoded code with its official descriptions and derived flags.');

/** A found code, optionally carrying its hierarchy when includeHierarchy is set. */
const FoundCodeSchema = DecodedCodeSchema.extend({
  parent: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Immediate parent code (present only when includeHierarchy is true). Null at a root.',
    ),
  children: z
    .array(DecodedCodeSchema)
    .optional()
    .describe('Immediate child codes (present only when includeHierarchy is true).'),
}).describe('A decoded code, optionally with its parent and immediate children.');

/** A code that did not resolve, with a per-code reason. */
const NotFoundCodeSchema = z
  .object({
    code: z.string().describe('The input code that could not be resolved.'),
    reason: z
      .string()
      .describe(
        'Why it could not be resolved (unknown shape, not in the bundled release, or ambiguous).',
      ),
    candidateSystems: z
      .array(z.string())
      .optional()
      .describe(
        'When ambiguous, the systems whose shape/content the code matched — re-call with one as `system`.',
      ),
  })
  .describe('An input code that did not resolve, with the reason it failed.');

type FoundCode = z.infer<typeof FoundCodeSchema>;
type NotFoundCode = z.infer<typeof NotFoundCodeSchema>;

export const getCodeTool = tool('medcode_get_code', {
  title: 'medical-codes-mcp-server',
  description:
    "Decode one or more US medical codes to their official descriptions across ICD-10-CM (diagnoses), ICD-10-PCS (inpatient procedures), HCPCS Level II (supplies/drugs/services), and — when bundled — RxNorm (drugs). Auto-detects the system from each code's shape; pass an explicit `system` only when a value is genuinely ambiguous. Accepts 1–50 codes and returns partial success: resolved codes in `found`, unresolved in `notFound` with a per-code reason, so one bad code never fails the batch. Set `includeHierarchy` to attach each code's parent and immediate children. The resolved `system` is echoed on every result for chaining into medcode_map_codes or a billability check.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sourceUrl: SOURCE_URL,

  input: z.object({
    codes: z
      .array(z.string().min(1).describe('A single code to decode, with or without dots.'))
      .min(1)
      .max(50)
      .describe('Codes to decode (1–50). Mixed systems are fine — each is detected independently.'),
    system: z
      .enum(SYSTEM_IDS)
      .optional()
      .describe('Force every code to be looked up in this system. Omit to auto-detect per code.'),
    includeHierarchy: z
      .boolean()
      .default(false)
      .describe("When true, attach each found code's parent and immediate children."),
  }),

  output: z.object({
    found: z.array(FoundCodeSchema).describe('Successfully decoded codes, in request order.'),
    notFound: z
      .array(NotFoundCodeSchema)
      .describe('Codes that did not resolve, with per-code reasons.'),
  }),

  errors: [
    {
      reason: 'no_codes_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'None of the requested codes exist in any bundled system.',
      recovery:
        'Verify code formatting, or call medcode_search_codes with a description to find the right code.',
    },
  ],

  handler(input, ctx) {
    const svc = getCodeIndexService();
    const found: FoundCode[] = [];
    const notFound: NotFoundCode[] = [];

    for (const raw of input.codes) {
      const result = svc.getByCode(raw, input.system);
      if (result.kind === 'not_found') {
        const shapes = svc.detectSystem(raw);
        notFound.push({
          code: raw,
          reason:
            shapes.length === 0
              ? `"${raw}" does not match the shape of any bundled code system.`
              : `"${raw}" is not present in the bundled release (matched shape: ${shapes.join(', ')}).`,
        });
      } else if (result.kind === 'ambiguous') {
        notFound.push({
          code: raw,
          reason: `"${raw}" matches multiple systems — re-call with an explicit \`system\` to disambiguate.`,
          candidateSystems: result.systems,
        });
      } else if (input.includeHierarchy) {
        found.push(svc.getByCodeWithHierarchy(result.row));
      } else {
        found.push(CodeIndexService.project(result.row));
      }
    }

    ctx.log.info('Decoded codes', {
      requested: input.codes.length,
      found: found.length,
      notFound: notFound.length,
    });

    if (found.length === 0) {
      throw ctx.fail(
        'no_codes_found',
        `None of the ${input.codes.length} requested code(s) resolved in any bundled system.`,
        { ...ctx.recoveryFor('no_codes_found') },
      );
    }

    return { found, notFound };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const c of result.found) {
      lines.push(...renderCodeBlock(c));
      if (c.parent !== undefined) lines.push(`**Parent:** ${c.parent ?? '(none — root)'}`);
      if (c.children && c.children.length > 0) {
        lines.push(`**Children (${c.children.length}):**`);
        for (const k of c.children) lines.push(renderCodeLine(k));
      }
      lines.push('');
    }
    if (result.notFound.length > 0) {
      lines.push(`### Not found (${result.notFound.length})`);
      for (const n of result.notFound) {
        const cands = n.candidateSystems?.length ? ` [${n.candidateSystems.join(', ')}]` : '';
        lines.push(`- **${n.code}**: ${n.reason}${cands}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
