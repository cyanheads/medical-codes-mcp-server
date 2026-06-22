#!/usr/bin/env node
/**
 * @fileoverview medical-codes-mcp-server MCP server entry point. Registers the
 * six medcode_* tools and opens the bundled SQLite + FTS5 code index read-only
 * in setup(). Offline, keyless, single-tenant — no runtime network I/O.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';

import { browseHierarchyTool } from './mcp-server/tools/definitions/browse-hierarchy.tool.js';
import { checkCodeTool } from './mcp-server/tools/definitions/check-code.tool.js';
import { getCodeTool } from './mcp-server/tools/definitions/get-code.tool.js';
import { listSystemsTool } from './mcp-server/tools/definitions/list-systems.tool.js';
import { mapCodesTool } from './mcp-server/tools/definitions/map-codes.tool.js';
import { searchCodesTool } from './mcp-server/tools/definitions/search-codes.tool.js';
import { initCodeIndexService } from './services/code-index/code-index-service.js';

await createApp({
  name: 'medical-codes-mcp-server',
  title: 'medical-codes-mcp-server',
  tools: [
    getCodeTool,
    searchCodesTool,
    checkCodeTool,
    mapCodesTool,
    browseHierarchyTool,
    listSystemsTool,
  ],
  instructions:
    'Offline US healthcare code lookup and crosswalk over a bundled SQLite index — keyless, no rate limit, deterministic. Bundled systems: ICD-10-CM (diagnoses), ICD-10-PCS (inpatient procedures), HCPCS Level II (supplies/drugs/services), and RxNorm drugs (the Prescribable Content subset). Decode a code with medcode_get_code (the 80% entry point; accepts a batch, auto-detects the system per code, and decodes an NDC directly to its RxNorm product). Go description → code with medcode_search_codes. Validate billability with medcode_check_code — a non-billable or terminated code is a successful result with a whyNot, not an error. Walk the hierarchy with medcode_browse_hierarchy (prefix for ICD-10-CM/HCPCS, axis-based for ICD-10-PCS). Crosswalk with medcode_map_codes — code parents/children, plus the RxNorm drug directions (drug name → RXCUI, NDC ↔ RXCUI, RXCUI → ingredients/brands). Confirm which release is active with medcode_list_systems. ICD-10-CM/PCS are the US clinical modifications, not the ICD-10/ICD-11 base.',
  landing: {
    requireAuth: false,
    tagline:
      'Offline US healthcare code lookup and crosswalk — ICD-10-CM, ICD-10-PCS, HCPCS Level II, and RxNorm drugs, keyless and deterministic.',
    repoRoot: 'https://github.com/cyanheads/medical-codes-mcp-server',
    links: [
      {
        label: 'ICD-10-CM (CDC/NCHS)',
        href: 'https://www.cdc.gov/nchs/icd/icd-10-cm/index.html',
        external: true,
      },
      {
        label: 'ICD-10-PCS & HCPCS (CMS)',
        href: 'https://www.cms.gov/medicare/coding-billing/icd-10-codes',
        external: true,
      },
      {
        label: 'RxNorm (NLM)',
        href: 'https://www.nlm.nih.gov/research/umls/rxnorm/',
        external: true,
      },
    ],
  },
  async setup() {
    await initCodeIndexService();
  },
});
