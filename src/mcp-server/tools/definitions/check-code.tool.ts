/**
 * @fileoverview medcode_check_code — validate whether a code exists, is current,
 * and is billable in the active release. Returns a discriminated status with a
 * why-not for non-billable or terminated codes. Validity vs. existence is split:
 * a non-billable or terminated code is a SUCCESS result with a whyNot (the
 * recovery detail a coder needs), not an error. A current RxNorm concept is
 * `valid` with `billable: null` — RxNorm has no billing concept. Only a code
 * absent from every detected system is an `unknown_code` failure, and a National
 * Drug Code that lands there recovers to the tools that decode it.
 * @module mcp-server/tools/definitions/check-code.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { getCodeIndexService } from '@/services/code-index/code-index-service.js';
import { SYSTEM_IDS, SYSTEM_LABELS } from '@/services/code-index/types.js';
import { nonBlankString } from './_schema.js';

const SOURCE_URL =
  'https://github.com/cyanheads/medical-codes-mcp-server/blob/main/src/mcp-server/tools/definitions/check-code.tool.ts';

/**
 * Recovery for an `unknown_code` whose value is a National Drug Code. It replaces
 * the contract's generic hint, which points at a description search — the wrong
 * next step for a package identifier the other tools decode directly.
 */
const NDC_RECOVERY =
  'Decode the NDC to its RxNorm product with medcode_get_code, or crosswalk it with medcode_map_codes (direction ndc_to_rxcui); the resulting RXCUI can be checked here.';

export const checkCodeTool = tool('medcode_check_code', {
  title: 'Check Medical Code',
  description:
    'Validate whether a US medical code exists, is current, and is billable in the active bundled release. Returns a discriminated status — valid_billable, valid_not_billable, valid_header, valid, or terminated — with a `whyNot` explaining non-billable and terminated cases (e.g. "valid ICD-10-CM category but not billable — submit a more specific child code"). This is the detail a coder needs before submitting a claim. RxNorm has no billing concept, so a current RxNorm concept is `valid` with `billable: null` and no billing verdict. Auto-detects the system from the code\'s shape; pass an explicit `system` to disambiguate. A non-billable or terminated code is a successful result with a whyNot, not an error — only a code absent from the named or detected system raises unknown_code, which names the other bundled system when one holds the code. A code string that also exists in another bundled system carries `alsoInSystems` naming it, since the verdict applies only to the system that answered.',
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
      .enum(['valid_billable', 'valid_not_billable', 'valid_header', 'valid', 'terminated'])
      .describe(
        'Validity status. valid_billable = submit as-is; valid_header/valid_not_billable = needs a more specific code; valid = exists and is current in a system with no billing concept (RxNorm), so there is no billing verdict; terminated = retired.',
      ),
    billable: z
      .boolean()
      .nullable()
      .describe(
        'True only when status is valid_billable. Null when status is valid — the system has no billing concept.',
      ),
    whyNot: z
      .string()
      .nullable()
      .describe(
        'Explanation for non-billable/terminated statuses, or null when valid_billable or valid.',
      ),
    alsoInSystems: z
      .array(z.string())
      .optional()
      .describe(
        'Other bundled systems holding this same code string, present only when there is at least one. The verdict above is for the system this code resolved in; the code is a DIFFERENT code in each system listed here, with its own billability — "B00" is the ICD-10-CM category "Herpesviral [herpes simplex] infections" and also the ICD-10-PCS table row "Imaging, Central Nervous System, Plain Radiography". Re-call with `system` set to one of these values to validate it there.',
      ),
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
      throw ctx.fail(
        'unknown_code',
        r.whyNot ?? `Unknown code "${input.code.trim()}".`,
        r.ndc ? { recovery: { hint: NDC_RECOVERY } } : { ...ctx.recoveryFor('unknown_code') },
      );
    }

    ctx.log.info('Checked code', { code: r.code, system: r.system, status: r.status });
    return {
      system: r.system,
      code: r.code,
      status: r.status,
      billable: r.status === 'valid' ? null : r.status === 'valid_billable',
      whyNot: r.whyNot ?? null,
      ...(r.alsoIn?.length ? { alsoInSystems: r.alsoIn } : {}),
    };
  },

  format: (result) => {
    const label = SYSTEM_LABELS[result.system as keyof typeof SYSTEM_LABELS] ?? result.system;
    const verdict: Record<typeof result.status, string> = {
      valid_billable: '✅ Valid and billable',
      valid_not_billable: '⚠️ Valid but not billable',
      valid_header: '⚠️ Valid category/header — not billable',
      valid: '✅ Valid and current',
      terminated: '⛔ Terminated',
    };
    const billable =
      result.billable === null
        ? `n/a — ${label} has no billing concept`
        : result.billable
          ? 'Yes'
          : 'No';
    const lines = [
      `## ${result.code} — ${label}`,
      `**Status:** ${verdict[result.status]}`,
      `**Billable:** ${billable}`,
    ];
    if (result.whyNot) lines.push('', result.whyNot);
    // The verdict is system-specific, so a text-only client must see that another
    // system holds the same string — otherwise this reads as the code's only status.
    if (result.alsoInSystems?.length)
      lines.push(
        '',
        `**Also in:** ${result.alsoInSystems.join(', ')} — the same code string is a different code there, with its own billability; re-call with that \`system\` to validate it.`,
      );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
