/**
 * @fileoverview medcode_get_code — decode one or more codes to their official
 * descriptions across ICD-10-CM, ICD-10-PCS, HCPCS Level II, and RxNorm. The 80%
 * entry point: resolve a code seen in a claim, EHR field, or another health
 * server's output into its meaning. Auto-detects the system from each code's
 * shape; an explicit `system` disambiguates. Also decodes a National Drug Code
 * (NDC) directly to its RxNorm product via the bundled NDC↔RxNorm map. Array-in /
 * partial-success-out — one bad code never fails the rest.
 * @module mcp-server/tools/definitions/get-code.tool
 */

import { Buffer } from 'node:buffer';

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { DEFAULT_OUTLINE_BUDGET_BYTES } from '@cyanheads/mcp-ts-core/utils';

import {
  CodeIndexService,
  getCodeIndexService,
  heldElsewhere,
  ICD9CM_NOTE,
  noMatch,
  PCS_SECTION_GUIDANCE,
  unmappedNdcMessage,
} from '@/services/code-index/code-index-service.js';
import { isBareInteger, isIcd9cmForm } from '@/services/code-index/detect.js';
import { SYSTEM_IDS, SYSTEM_LABELS, type SystemId } from '@/services/code-index/types.js';
import { literal, renderCodeBlock, renderCodeLine } from './_render.js';
import { nonBlankString } from './_schema.js';

const SOURCE_URL =
  'https://github.com/cyanheads/medical-codes-mcp-server/blob/main/src/mcp-server/tools/definitions/get-code.tool.ts';

/** Appended to the miss for an NDC a forced `system` kept from the NDC decode. */
const FORCED_NDC_NOTE =
  'It is a National Drug Code (NDC): omit system to decode it to its RxNorm product.';

const DecodedCodeSchema = z
  .object({
    system: z
      .string()
      .describe(
        'The system that answered: "ICD10CM", "ICD10PCS", "HCPCS", or "RXNORM". Pass it as `system` to medcode_check_code, or to medcode_map_codes on a parents/children walk; the map_codes drug directions accept only "RXNORM", which they need no `system` to reach.',
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
      .describe(
        'Official short/abbreviated description, or null when none is on record. Always null for RxNorm, which publishes a single name.',
      ),
    billable: z
      .boolean()
      .nullable()
      .describe(
        'True when the code is a billable leaf. False for headers/categories, non-billable codes, and HCPCS codes whose last valid date has passed. Null when the system has no billing concept (RxNorm).',
      ),
    header: z
      .boolean()
      .describe(
        'True when the code is a non-billable header with codes below it — an ICD-10-CM category, a HCPCS range bucket, or a three-character ICD-10-PCS table row — rather than a leaf code.',
      ),
    chapter: z
      .string()
      .nullable()
      .describe(
        'Chapter/range bucket the code belongs to, or null when not applicable. For RxNorm, the concept term type (IN, PIN, MIN, BN, SCD, SBD, GPCK, BPCK).',
      ),
  })
  .describe('A decoded code with its official descriptions and derived flags.');

/** A found code, optionally carrying its hierarchy when includeHierarchy is set. */
const FoundCodeSchema = DecodedCodeSchema.extend({
  parent: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Immediate parent code, always one medcode_get_code decodes (present only when includeHierarchy is true): an ICD-10-CM code padded with the placeholder X names the nearest code above the padding (`S82.66XA` → `S82.66`), and a complete ICD-10-PCS code names its three-character table row (`0DTJ4ZZ` → `0DT`). Null at a root — an ICD-10-CM category, a HCPCS range bucket, an ICD-10-PCS table row — and for RxNorm.',
    ),
  children: z
    .array(DecodedCodeSchema)
    .optional()
    .describe(
      'Immediate child codes (present only when includeHierarchy is true). For an ICD-10-PCS table row, the complete codes that begin with it.',
    ),
  childrenTruncated: z
    .boolean()
    .optional()
    .describe(
      'True when the code has more immediate children than `children` carries — the list was capped at the server cap (present only when includeHierarchy is true). Retrieve the full child list with medcode_map_codes (children) for this code, passing its `system`, or medcode_browse_hierarchy outside ICD-10-PCS.',
    ),
  source: z
    .string()
    .optional()
    .describe(
      'Resolution provenance when the input was not a direct code: "NDC" when an NDC was decoded to its RxNorm product via the NDC↔RxNorm map. Omitted for direct code lookups.',
    ),
  alsoInSystems: z
    .array(z.string())
    .optional()
    .describe(
      'Other bundled systems holding this same code string, present only when there is at least one. The result above is the system this code resolved in; the code is a DIFFERENT code in each system listed here — "B00" is the ICD-10-CM category "Herpesviral [herpes simplex] infections" and also the ICD-10-PCS table row "Imaging, Central Nervous System, Plain Radiography". Re-call with `system` set to one of these values to decode it there.',
    ),
}).describe('A decoded code, optionally with its parent/children and resolution source.');

/** A code that did not resolve, with a per-code reason. */
const NotFoundCodeSchema = z
  .object({
    code: z.string().describe('The input code that could not be resolved.'),
    reason: z
      .string()
      .describe(
        'Why it could not be resolved (absent from every bundled system — for a bare integer, with a note that CPT / HCPCS Level I codes are out of scope, and for a dotted all-digit value in ICD-9-CM form such as "250.00", with a note that ICD-9-CM is not bundled — absent from the explicit `system` while another bundled system holds it, which is named, an ICD-10-PCS section value looked up as a code under system ICD10PCS, which is named as that section, a well-formed NDC nothing maps to, hyphenated or as bare 10/11 digits, an NDC looked up under an explicit `system` that skips the NDC decode, or ambiguous across systems).',
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

/**
 * The most either surface of one reply carries — the serialized
 * `structuredContent`, and the `content[]` text — in UTF-8 bytes. A batch past it
 * is answered in request order up to the budget and the rest named in `deferred`.
 */
const REPLY_BUDGET_BYTES = DEFAULT_OUTLINE_BUDGET_BYTES;

const DEFERRED_INSTRUCTION = `Not processed: this reply reached its ${REPLY_BUDGET_BYTES.toLocaleString('en-US')}-byte budget. Re-call medcode_get_code with these as \`codes\` and the same \`system\` and \`includeHierarchy\`, until no codes are deferred.`;

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** A found code's content[] block — everything format() writes for it. */
function renderFound(c: FoundCode): string {
  const lines = renderCodeBlock(c);
  if (c.source) lines.push(`**Resolved via:** ${c.source}`);
  // A text-only client has no structuredContent to read alsoInSystems from,
  // and without this line the one meaning it was handed reads as the only one.
  if (c.alsoInSystems?.length)
    lines.push(
      `**Also in:** ${c.alsoInSystems.join(', ')} — the same code string is a different code there; re-call with that \`system\` to decode it.`,
    );
  // Each hierarchy field renders on presence, not on truthiness: an empty child
  // list and a `childrenTruncated: false` are facts the caller asked for, and
  // gating them on content would render them exactly like the absent hierarchy
  // of a plain lookup. Presence is the only signal that separates "hierarchy
  // requested, child set empty and complete" from "hierarchy not requested".
  if (c.parent !== undefined)
    lines.push(`**Parent:** ${c.parent === null ? '(none — root)' : literal(c.parent)}`);
  if (c.children !== undefined) {
    lines.push(`**Children (${c.children.length}):**`);
    for (const k of c.children) lines.push(renderCodeLine(k));
  }
  if (c.childrenTruncated !== undefined) {
    // medcode_browse_hierarchy lists only ICD-10-PCS sections, never a table row's
    // codes, and the walk names the system: B00 is also an ICD-10-CM category.
    const retrieve =
      c.system === 'ICD10PCS'
        ? 'medcode_map_codes (direction children, system ICD10PCS)'
        : 'medcode_browse_hierarchy or medcode_map_codes (children)';
    lines.push(
      c.childrenTruncated
        ? `_More children exist beyond those shown — retrieve them with ${retrieve}._`
        : '_Complete: no further children exist beyond those listed._',
    );
  }
  return lines.join('\n');
}

/** A miss's line in the Not found section. */
function renderNotFound(n: NotFoundCode): string {
  const cands = n.candidateSystems?.length ? ` [${n.candidateSystems.join(', ')}]` : '';
  return `- **${literal(n.code)}**: ${literal(n.reason)}${cands}`;
}

const notFoundHeading = (count: number) => `### Not found (${count})`;
const deferredHeading = (count: number) => `### Deferred (${count})`;
const renderDeferredCode = (code: string) => `- **${literal(code)}**`;

/**
 * Summed sizes of the found codes and misses a reply holds, in UTF-8 bytes: their
 * JSON, and their content[] blocks or lines. A miss's line is counted with the line
 * break before it.
 */
interface EntryBytes {
  foundCount: number;
  foundJson: number;
  foundText: number;
  missCount: number;
  missJson: number;
  missText: number;
}

/**
 * A run of deferred codes' size: its count, its JSON strings, and its content[]
 * lines, each with the line break before it.
 */
interface DeferredBytes {
  count: number;
  json: number;
  text: number;
}

const NO_ENTRIES: EntryBytes = {
  foundCount: 0,
  foundJson: 0,
  foundText: 0,
  missCount: 0,
  missJson: 0,
  missText: 0,
};
const NO_DEFERRED: DeferredBytes = { count: 0, json: 0, text: 0 };

/** `bytes` with one input's entries added, each measured once. */
function addEntries(
  bytes: EntryBytes,
  found: readonly FoundCode[],
  notFound: readonly NotFoundCode[],
): EntryBytes {
  const next = { ...bytes };
  for (const c of found) {
    next.foundCount++;
    next.foundJson += utf8Bytes(JSON.stringify(c));
    next.foundText += utf8Bytes(renderFound(c));
  }
  for (const n of notFound) {
    next.missCount++;
    next.missJson += utf8Bytes(JSON.stringify(n));
    next.missText += 1 + utf8Bytes(renderNotFound(n));
  }
  return next;
}

const EMPTY_REPLY_JSON = utf8Bytes('{"found":[],"notFound":[]}');
const DEFERRED_KEY_JSON = utf8Bytes(',"deferred":[]');
const DEFERRED_INSTRUCTION_BYTES = utf8Bytes(DEFERRED_INSTRUCTION);

/**
 * Whether a reply of `entries` with `deferred` appended fits the budget on both
 * surfaces. The structure around the entries — JSON brackets and commas, the blank
 * line between content[] sections, the Not found and Deferred headings with their
 * counts, the re-call instruction — is added exactly as JSON.stringify and format()
 * write it, so the size judged here is the size the caller receives (format()'s
 * closing trim() can only shorten the text).
 */
function replyFits(entries: EntryBytes, deferred: DeferredBytes): boolean {
  const commas = (count: number) => Math.max(0, count - 1);
  let json =
    EMPTY_REPLY_JSON +
    entries.foundJson +
    commas(entries.foundCount) +
    entries.missJson +
    commas(entries.missCount);
  let text = entries.foundText;
  let sections = entries.foundCount;
  if (entries.missCount > 0) {
    text += utf8Bytes(notFoundHeading(entries.missCount)) + entries.missText;
    sections++;
  }
  if (deferred.count > 0) {
    json += DEFERRED_KEY_JSON + deferred.json + commas(deferred.count);
    text +=
      utf8Bytes(deferredHeading(deferred.count)) + 1 + DEFERRED_INSTRUCTION_BYTES + deferred.text;
    sections++;
  }
  text += 2 * commas(sections);
  return json <= REPLY_BUDGET_BYTES && text <= REPLY_BUDGET_BYTES;
}

/**
 * Each input code paired with the size of the inputs after it, measured as
 * `deferred` would carry and render them. Built back to front in one pass.
 */
function withTails(codes: readonly string[]): { code: string; after: DeferredBytes }[] {
  let after = NO_DEFERRED;
  const paired: { code: string; after: DeferredBytes }[] = [];
  for (const code of codes.toReversed()) {
    paired.push({ code, after });
    after = {
      count: after.count + 1,
      json: after.json + utf8Bytes(JSON.stringify(code)),
      text: after.text + 1 + utf8Bytes(renderDeferredCode(code)),
    };
  }
  return paired.reverse();
}

export const getCodeTool = tool('medcode_get_code', {
  title: 'Get Medical Code',
  description: `Decode one or more US medical codes to their official descriptions across ICD-10-CM (diagnoses), ICD-10-PCS (inpatient procedures), HCPCS Level II (supplies/drugs/services), and RxNorm (drugs, by RXCUI). Also decodes a National Drug Code (NDC) directly to its RxNorm product offline, tagged \`source: "NDC"\` — hyphenated in an FDA segment configuration (4-4-2, 5-3-2, 5-4-1, or the 11-digit 5-4-2) or as bare 10/11 digits; any other segment widths are malformed and stay unresolved. Auto-detects the system from each code's shape, and a code written in ICD-10-CM dotted form (\`A01.00\`) resolves to ICD-10-CM; pass an explicit \`system\` only when a value is genuinely ambiguous. Accepts 1–50 codes and returns partial success: resolved codes in \`found\`, unresolved in \`notFound\` with a per-code reason, so one bad code never fails the batch. Each reply holds \`structuredContent\` and the text to ${REPLY_BUDGET_BYTES.toLocaleString('en-US')} bytes apiece: codes are decoded in request order, and once one has resolved, a code that would carry the reply past that budget is returned unprocessed in \`deferred\`, as sent, with every code after it — re-call with \`codes\` set to \`deferred\` and the same \`system\` and \`includeHierarchy\` until no \`deferred\` comes back. Three kinds of code are never deferred and can carry a reply past the budget: the first code that resolves, returned whole; the codes before it; and the unresolved codes after the last one that resolves, so a re-call always holds a code that resolves. Only a batch where nothing resolves fails: with ambiguous_system and \`candidateSystems\` when every code exists in more than one bundled system, otherwise with no_codes_found. Set \`includeHierarchy\` to attach each code's parent and immediate children (with a \`childrenTruncated\` flag when a code has more children than the cap returns — walk the full set via medcode_map_codes, or medcode_browse_hierarchy outside ICD-10-PCS); an ICD-10-PCS table row's children are the complete codes that begin with it. The resolved \`system\` is echoed on every result for chaining into a billability check or a medcode_map_codes parents/children walk; a bare integer that resolves nowhere is named as a possible CPT / HCPCS Level I code, which is out of scope, except a bare 10/11-digit one, which is named as an NDC no bundled drug maps to; a dotted all-digit value in ICD-9-CM form (\`250.00\`) is never read as an RXCUI and is named as ICD-9-CM, which is not bundled; an ICD-10-PCS section value from medcode_browse_hierarchy (\`0\`) looked up under system ICD10PCS is named as a section, not a code; a code string that also exists in another bundled system carries \`alsoInSystems\` naming it, so a single answer to a colliding code is never mistaken for the only one.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  sourceUrl: SOURCE_URL,

  input: z.object({
    codes: z
      .array(
        nonBlankString('Each code').describe(
          'A single code to decode (with or without dots), an RXCUI, or an NDC. Must not be blank or whitespace-only.',
        ),
      )
      .min(1)
      .max(50)
      .describe(
        'Codes to decode (1–50). Mixed systems are fine — each is detected independently. An NDC decodes to its RxNorm product: hyphenated as 4-4-2, 5-3-2, 5-4-1, or 5-4-2, or as bare 10/11 digits.',
      ),
    system: z
      .enum(SYSTEM_IDS)
      .optional()
      .describe(
        'Force every code to be looked up in this system, which also skips the NDC decode. Omit to auto-detect per code.',
      ),
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
    deferred: z
      .array(z.string())
      .optional()
      .describe(
        'Input codes not processed because the reply reached its byte budget, in request order and as sent. Re-call with these as codes and the same system and includeHierarchy, until no deferred comes back. Absent when every code was processed.',
      ),
  }),

  errors: [
    {
      reason: 'no_codes_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'None of the requested codes resolved — in any bundled system, or in the explicit `system` when one is given. The message names each code another bundled system holds and each code present in more than one system, with those systems, and each ICD-10-PCS section value, bare integer, value in ICD-9-CM form, and NDC among the misses.',
      recovery:
        'Verify code formatting, or call medcode_search_codes with a description to find the right code.',
    },
    {
      reason: 'ambiguous_system',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Every requested code is present in more than one bundled system and no `system` was given; `candidateSystems` lists the union of those systems.',
      recovery: 'Re-call with an explicit system to disambiguate.',
    },
  ],

  handler(input, ctx) {
    const svc = getCodeIndexService();
    const found: FoundCode[] = [];
    const notFound: NotFoundCode[] = [];
    // Bare integers that resolved nowhere — each likely a CPT / HCPCS Level I code.
    const outOfScope: string[] = [];
    // NDCs a forced `system` kept from the NDC decode below.
    const forcedNdcs: string[] = [];
    // Well-formed NDCs — hyphenated, or bare 10/11 digits — no bundled drug maps to.
    const unmappedNdcs: string[] = [];
    // Codes a forced `system` missed that another bundled system holds, with the holders.
    const heldCodes: string[] = [];
    // ICD-10-PCS section values looked up as codes under ICD10PCS, with their meaning.
    const pcsSections: string[] = [];
    // Values in ICD-9-CM form that resolved nowhere — ICD-9-CM is not bundled.
    const icd9: string[] = [];
    // Codes present in more than one bundled system, with those systems.
    const ambiguous: { code: string; systems: SystemId[] }[] = [];

    /** Decode one input, adding its entries to `found` or `notFound`. */
    const decodeInto = (raw: string, found: FoundCode[], notFound: NotFoundCode[]): void => {
      // First-class offline NDC decode: an NDC (hyphenated, or bare 10/11-digit)
      // resolves to its RxNorm product via the NDC↔RxNorm map. Only when no
      // explicit `system` is forced — an explicit system means a direct lookup.
      if (!input.system) {
        const ndc = svc.getByNdc(raw);
        if (ndc.kind === 'found') {
          for (const row of ndc.rows)
            found.push({ ...CodeIndexService.project(row), source: 'NDC' });
          return;
        }
        if (ndc.kind === 'no_match') {
          unmappedNdcs.push(raw.trim());
          notFound.push({ code: raw, reason: unmappedNdcMessage(raw, ndc.ndc) });
          return;
        }
        // 'not_ndc' → fall through to the normal system-detection path below.
      }

      const result = svc.getByCode(raw, input.system);
      if (result.kind === 'not_found') {
        // An ICD-10-PCS section value, as medcode_browse_hierarchy lists it, passed
        // back as a code under ICD10PCS is named as the section it is.
        const section = input.system === 'ICD10PCS' ? svc.pcsSection(raw) : null;
        const sectionNote = section ? ` ${svc.pcsSectionNote(raw.trim())}` : '';
        if (section) pcsSections.push(`"${raw.trim()}" (${section})`);
        // A forced `system` can miss a code another bundled system holds — a real
        // code there, not an absent one — so that system is named, as check_code does.
        const holders = input.system ? svc.systemsHolding(raw) : [];
        if (input.system && holders.length > 0) {
          heldCodes.push(
            `"${raw.trim()}" (${holders.map((sys) => SYSTEM_LABELS[sys]).join(' and ')})`,
          );
          notFound.push({
            code: raw,
            reason: `${noMatch(input.system, raw.trim())} — ${heldElsewhere(holders)} to decode it there.${sectionNote}`,
          });
          return;
        }
        if (section) {
          notFound.push({
            code: raw,
            reason: `${noMatch('ICD10PCS', raw.trim())} in the bundled release.${sectionNote}`,
          });
          return;
        }
        // Otherwise no bundled system holds the value. A well-formed NDC no bundled
        // drug maps to — bare 10/11 digits being a bare integer too — is named as
        // one, in the words ndc_to_rxcui gives it, never as a possible CPT code.
        const ndc = svc.ndcReading(raw);
        if (ndc?.kind === 'unmapped') {
          unmappedNdcs.push(raw.trim());
          notFound.push({ code: raw, reason: unmappedNdcMessage(raw, ndc.normalized) });
          return;
        }
        // DB membership (not the shape) found the code in no bundled system; the
        // shape list is a hint about what the value looks like, never the reason it
        // failed.
        const shapes = svc.detectSystem(raw);
        const reason =
          shapes.length === 0
            ? `"${raw}" is not present in any bundled code system, and matches no bundled code shape.`
            : `"${raw}" is not present in the bundled release (matched shape: ${shapes.join(', ')}).`;
        // A forced `system` skips the NDC decode, so an NDC it would have decoded is
        // named as one rather than as a possible CPT code.
        if (ndc?.kind === 'mapped') {
          forcedNdcs.push(raw.trim());
          notFound.push({ code: raw, reason: `${reason} ${FORCED_NDC_NOTE}` });
          return;
        }
        // No bundled system writes a dotted all-digit code, so one in ICD-9-CM form
        // is named as that unbundled system's.
        if (isIcd9cmForm(raw)) {
          icd9.push(raw.trim());
          notFound.push({ code: raw, reason: `${reason} ${ICD9CM_NOTE}` });
          return;
        }
        // No bundled system holds it, so a bare integer is a likely CPT code.
        if (!isBareInteger(raw)) {
          notFound.push({ code: raw, reason });
          return;
        }
        outOfScope.push(raw.trim());
        notFound.push({ code: raw, reason: `${reason} ${svc.outOfScopeNote()}` });
      } else if (result.kind === 'ambiguous') {
        ambiguous.push({ code: raw.trim(), systems: result.systems });
        notFound.push({
          code: raw,
          reason: `"${raw}" matches multiple systems — re-call with an explicit system to disambiguate.`,
          candidateSystems: result.systems,
        });
      } else {
        const decoded = input.includeHierarchy
          ? svc.getByCodeWithHierarchy(result.row)
          : CodeIndexService.project(result.row);
        found.push({
          ...decoded,
          ...(result.alsoIn.length > 0 ? { alsoInSystems: result.alsoIn } : {}),
        });
      }
    };

    /** Each input's entries by position, decoded once, when first needed. */
    const decoded = new Map<number, { found: FoundCode[]; notFound: NotFoundCode[] }>();
    const decodeAt = (i: number, raw: string) => {
      let entry = decoded.get(i);
      if (!entry) {
        entry = { found: [], notFound: [] };
        decodeInto(raw, entry.found, entry.notFound);
        decoded.set(i, entry);
      }
      return entry;
    };
    /** Whether the input at `i` or any after it resolves. */
    const resolvesFrom = (i: number) =>
      input.codes.some((raw, j) => j >= i && decodeAt(j, raw).found.length > 0);

    // Inputs are decoded in request order against the reply budget. Deferral starts
    // only once a code has resolved — the first one returns whole however large it
    // is, and a batch where nothing resolves reaches the errors below having seen
    // every input — and an input is kept only if the reply still fits with it and
    // with every input after it listed as deferred, so the reply returned when a
    // later input stops the batch always fits. A remainder is deferred only if a
    // code in it resolves: a re-call of misses alone would fail with no_codes_found
    // or ambiguous_system instead of returning their entries, so the misses after
    // the last code that resolves stay in this reply, past the budget if need be.
    let entries = NO_ENTRIES;
    let deferred: string[] | undefined;
    for (const [i, { code: raw, after }] of withTails(input.codes).entries()) {
      const entry = decodeAt(i, raw);
      const next = addEntries(entries, entry.found, entry.notFound);
      if (found.length > 0 && !replyFits(next, after) && resolvesFrom(i)) {
        // The input's entries go, all of them together (an NDC's several products
        // included). Anything decodeInto() noted for the error messages stays
        // unread: those fire only when nothing resolved, and here something has.
        deferred = input.codes.slice(i);
        break;
      }
      found.push(...entry.found);
      notFound.push(...entry.notFound);
      entries = next;
    }

    ctx.log.info('Decoded codes', {
      requested: input.codes.length,
      found: found.length,
      notFound: notFound.length,
      deferred: deferred?.length ?? 0,
    });

    if (found.length === 0) {
      const ambiguousList = ambiguous
        .map(({ code, systems }) => `"${code}" (${systems.join(', ')})`)
        .join(', ');
      // Every code failed on ambiguity alone, so one re-call with a `system` from
      // the union — which applies to every code — resolves the batch, as the sibling
      // tools' ambiguous_system recovers.
      if (ambiguous.length === input.codes.length) {
        throw ctx.fail(
          'ambiguous_system',
          `Every requested code exists in more than one bundled system: ${ambiguousList}.`,
          {
            candidateSystems: SYSTEM_IDS.filter((sys) =>
              ambiguous.some(({ systems }) => systems.includes(sys)),
            ),
          },
        );
      }
      // The per-code reasons do not travel with this error, so the held-elsewhere,
      // ambiguity, section, out-of-scope, ICD-9-CM, and NDC notes do — naming their
      // inputs, since a batch can fail for mixed causes. Under a named `system`, only
      // that system was searched.
      const quoted = (codes: string[]) => codes.map((code) => `"${code}"`).join(', ');
      const scope = input.system
        ? `${SYSTEM_LABELS[input.system]}, the system this call named`
        : 'any bundled system';
      const notes = [
        heldCodes.length > 0
          ? ` Codes another bundled system holds: ${heldCodes.join(', ')}. Re-call with that system to decode each one.`
          : '',
        ambiguous.length > 0
          ? ` Codes in more than one bundled system: ${ambiguousList}. Re-call with one of those as system to decode each one.`
          : '',
        pcsSections.length > 0
          ? ` ICD-10-PCS sections, not codes: ${pcsSections.join(', ')}. ${PCS_SECTION_GUIDANCE}`
          : '',
        outOfScope.length > 0
          ? ` Bare integers with no match: ${quoted(outOfScope)}. ${svc.outOfScopeNote()}`
          : '',
        icd9.length > 0
          ? ` Values in ICD-9-CM form with no match: ${quoted(icd9)}. ${ICD9CM_NOTE}`
          : '',
        unmappedNdcs.length > 0
          ? ` NDCs in a valid format that no bundled drug maps to: ${quoted(unmappedNdcs)}.`
          : '',
        forcedNdcs.length > 0
          ? ` National Drug Codes (NDC) looked up under an explicit system: ${quoted(forcedNdcs)}. Omit system to decode an NDC to its RxNorm product.`
          : '',
      ].join('');
      throw ctx.fail(
        'no_codes_found',
        `None of the ${input.codes.length} requested code(s) resolved in ${scope}.${notes}`,
      );
    }

    return { found, notFound, ...(deferred ? { deferred } : {}) };
  },

  // Sections — each found code's block, then the Not found and Deferred lists —
  // sit a blank line apart. replyFits() sizes this exact composition, so a change
  // here changes it too.
  format: (result) => {
    const sections = result.found.map(renderFound);
    if (result.notFound.length > 0)
      sections.push(
        [notFoundHeading(result.notFound.length), ...result.notFound.map(renderNotFound)].join(
          '\n',
        ),
      );
    if (result.deferred)
      sections.push(
        [
          deferredHeading(result.deferred.length),
          DEFERRED_INSTRUCTION,
          ...result.deferred.map(renderDeferredCode),
        ].join('\n'),
      );
    return [{ type: 'text', text: sections.join('\n\n').trim() }];
  },
});
