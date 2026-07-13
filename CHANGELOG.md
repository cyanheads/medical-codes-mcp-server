# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-07-13

Cursor pagination (with nextCursor continuation) for medcode_search_codes, medcode_browse_hierarchy, and medcode_map_codes's children/name_to_rxcui directions, a childrenTruncated flag on medcode_get_code, and a fix for browse_hierarchy's capped children and inaccurate truncation metadata.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-07-13

RxNorm wording reconciled to the active normalized set, a dead no_match error contract removed from medcode_search_codes, and mcp-ts-core bumped to ^0.10.14 with bunfig supply-chain hardening (Socket scanner, minimumReleaseAge) and a Docker build fix.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-21

RxNorm is now bundled and live: the five medcode_map_codes drug directions resolve against the offline index, and medcode_get_code decodes an NDC directly to its RxNorm product. Build-time acquisition moved from the UMLS-gated RRF files to the keyless RxNav REST API.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-20

mcp-ts-core ^0.10.6 → ^0.10.9 maintenance: check-dependency-specifiers devcheck step + pluginManifests packaging check, ctx.content media collector and Canvas SQL gate classification land upstream, six scripts and the framework skill set re-synced. No server behavior change.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-19

map_codes returns ok-empty with a notice for a resolvable code with no edge (no_mapping reserved for an unresolvable source); check_code names RxNorm as unbundled for out-of-scope numeric codes; PCS browse and depth-1 hierarchy walking documented accurately.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-15

Fix unreachable HCPCS hierarchy by seeding letter-range bucket rows, and make the map_codes no_mapping example match the requested direction.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-15

Add public hosted endpoint at medical-codes.caseyjhand.com/mcp and Install in Claude Desktop badge.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-14

Scope the README title to the published npm name, @cyanheads/medical-codes-mcp-server.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-13

Offline US medical code lookup and crosswalk over a bundled SQLite+FTS5 index: ICD-10-CM, ICD-10-PCS, and HCPCS Level II across six medcode_* tools (RxNorm in a later release).
