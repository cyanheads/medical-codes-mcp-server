/**
 * @fileoverview medcode_check_code — validate whether a code exists, is current,
 * and is billable in the active release. Returns a discriminated status with a
 * why-not for non-billable or terminated codes. Validity vs. existence is split:
 * a non-billable or terminated code is a SUCCESS result with a whyNot (the
 * recovery detail a coder needs), not an error. Only a code absent from every
 * detected system is an `unknown_code` failure.
 * @module mcp-server/tools/definitions/check-code.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getCodeIndexService } from '@/services/code-index/code-index-service.js';
import { SYSTEM_IDS, SYSTEM_LABELS } from '@/services/code-index/types.js';
import { nonBlankString } from './_schema.js';

const SOURCE_URL =
  'https://github.com/cyanheads/medical-codes-mcp-server/blob/main/src/mcp-server/tools/definitions/check-code.tool.ts';

export const checkCodeTool = tool('medcode_check_code', {
  title: 'medical-codes-mcp-server',
  description:
    'Validate whether a US medical code exists, is current, and is billable in the active bundled release. Returns a discriminated status — valid_billable, valid_not_billable, valid_header, or terminated — with a `whyNot` explaining non-billable and terminated cases (e.g. "valid ICD-10-CM category but not billable — submit a more specific child code"). This is the detail a coder needs before submitting a claim. Auto-detects the system from the code\'s shape; pass an explicit `system` to disambiguate. A non-billable or terminated code is a successful result with a whyNot, not an error — only a code that exists in no bundled system raises unknown_code.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sourceUrl: SOURCE_URL,

  input: z.object({
    code: nonBlankString('code').describe(
      'The code to validate, with or without dots. Must not be blank or whitespace-only.',
    ),
    system: z
      .enum(SYSTEM_IDS)
      .optional()
      .describe("Force the lookup into this system. Omit to auto-detect from the code's shape."),
  }),

  output: z.object({
    system: z.string().describe('The system the code was resolved in, echoed for chaining.'),
    code: z.string().describe('The code in display form (ICD-10-CM carries the dot).'),
    status: z
      .enum(['valid_billable', 'valid_not_billable', 'valid_header', 'terminated'])
      .describe(
        'Validity status. valid_billable = submit as-is; valid_header/valid_not_billable = needs a more specific code; terminated = retired.',
      ),
    billable: z.boolean().describe('True only when status is valid_billable.'),
    whyNot: z
      .string()
      .nullable()
      .describe('Explanation for non-billable/terminated statuses, or null when valid_billable.'),
  }),

  errors: [
    {
      reason: 'unknown_code',
      code: JsonRpcErrorCode.NotFound,
      when: 'The code does not exist in the named or detected system.',
      recovery: 'Check the code, or search by description with medcode_search_codes.',
    },
    {
      reason: 'ambiguous_system',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The code is present in more than one bundled system and no `system` was given.',
      recovery: 'Re-call with an explicit `system` to disambiguate.',
    },
  ],

  handler(input, ctx) {
    const outcome = getCodeIndexService().checkCode(input.code, input.system);

    if (outcome.kind === 'ambiguous') {
      throw ctx.fail(
        'ambiguous_system',
        `"${input.code.trim()}" exists in multiple systems: ${outcome.systems.join(', ')}.`,
        { candidateSystems: outcome.systems, ...ctx.recoveryFor('ambiguous_system') },
      );
    }

    const r = outcome.result;
    if (r.status === 'unknown') {
      throw ctx.fail('unknown_code', r.whyNot ?? `Unknown code "${input.code.trim()}".`, {
        ...ctx.recoveryFor('unknown_code'),
      });
    }

    ctx.log.info('Checked code', { code: r.code, system: r.system, status: r.status });
    return {
      system: r.system,
      code: r.code,
      status: r.status,
      billable: r.status === 'valid_billable',
      whyNot: r.whyNot ?? null,
    };
  },

  format: (result) => {
    const label = SYSTEM_LABELS[result.system as keyof typeof SYSTEM_LABELS] ?? result.system;
    const verdict: Record<typeof result.status, string> = {
      valid_billable: '✅ Valid and billable',
      valid_not_billable: '⚠️ Valid but not billable',
      valid_header: '⚠️ Valid category/header — not billable',
      terminated: '⛔ Terminated',
    };
    const lines = [
      `## ${result.code} — ${label}`,
      `**Status:** ${verdict[result.status]}`,
      `**Billable:** ${result.billable ? 'Yes' : 'No'}`,
    ];
    if (result.whyNot) lines.push('', result.whyNot);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
