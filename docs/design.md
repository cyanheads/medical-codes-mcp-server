# medical-codes-mcp-server — Design

US healthcare code systems as one offline lookup-and-crosswalk server. Decode a code, find the code for a described condition/procedure/drug, validate billability, and crosswalk across systems — keyless, offline, no rate limit. Backed by a SQLite + FTS5 index built at package-build time from public-domain federal code sets.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `medcode_get_code` | Decode one or more codes to their official descriptions across ICD-10-CM, ICD-10-PCS, HCPCS Level II, and RxNorm. Auto-detects the system from each code's shape, or accepts an explicit `system` to disambiguate. The 80% entry point — resolve a code seen in a claim, EHR field, or another health server's output into its meaning. | `codes` (1–50 codes), `system?` (enum), `includeHierarchy?` | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |
| `medcode_search_codes` | Find codes whose official descriptions match a described concept, via full-text search over the bundled index. Filter by system, billable status, and chapter. Use when you have a clinical description ("type 2 diabetes with diabetic neuropathy") and need the code, not the other way round. | `query`, `system?`, `billableOnly?`, `chapter?`, `limit?` | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |
| `medcode_check_code` | Validate whether a code exists, is current, and is billable in the active release. Returns status with a why-not for invalid or non-billable codes ("valid ICD-10-CM category but not billable — requires more specific child code"). The caller-facing detail a coder needs before submitting a claim. | `code`, `system?` | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |
| `medcode_map_codes` | Crosswalk a code or drug across systems and within a hierarchy: drug name → RxNorm RXCUI, NDC ↔ RXCUI, RXCUI → ingredients/brands, and any code → its parent/child codes. The relational bridge between the bundled systems and a composition point with `openfda` (NDC/labels). | `from` (value), `direction` (enum), `system?` | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |
| `medcode_browse_hierarchy` | Walk a code system's hierarchy (chapter → section → category → code) for discovery without a search term. Returns the children of a node, or the top-level chapters when no node is given. Lets an agent orient in an unfamiliar system or enumerate a category's specific codes. | `system`, `node?`, `limit?` | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |
| `medcode_list_systems` | List the bundled code systems with their release identifiers, effective dates, and code counts. Lets a caller confirm which ICD-10 fiscal year, HCPCS quarter, and RxNorm month are active before acting on results. Cheap orientation / provenance call. | _(none)_ | `readOnlyHint`, `idempotentHint`, `openWorldHint:false` |

**Total: 6 tools. No resources, no prompts** (rationale in Design Decisions). All read-only — no `destructiveHint`, no elicitation, no auth scopes (offline, single-tenant).

### Resources

None. The server is tool-only by design — see Design Decisions §6.

### Prompts

None — see Design Decisions §7.

## Overview

**What it does.** Indexes four US federal healthcare code systems from disk and exposes lookup, search, validation, crosswalk, and hierarchy-browse over them. Every tool is a local SQLite query; there is **no runtime API, no network call, no API key, no rate limit**.

**What it wraps.** Bulk public-domain file releases, built into a bundled SQLite + FTS5 database at package-build time:

| System | Owner / license | Covers | Update cadence |
|:-------|:----------------|:-------|:---------------|
| ICD-10-CM | CDC/NCHS — US federal public domain | Diagnoses (~75k billable leaf codes; ~98k total rows including non-billable headers) | Annual (Oct 1), mid-year addenda (Apr 1) |
| ICD-10-PCS | CMS — US federal public domain | Inpatient procedures (78,986 codes FY2026) | Annual (Oct 1), mid-year addenda (Apr 1) |
| HCPCS Level II | CMS — US federal public domain | Supplies, drugs, non-physician services (~5k active codes; ~12k total rows including terminated) | Annual (Jan 1) for the main Alpha-Numeric file; temporary codes (G, K, Q prefixes) update on a flow basis |
| RxNorm (Prescribable Content subset) | NLM — no licensing restrictions, public domain | Normalized drug names, ingredients, RXCUIs, NDC links (~30k prescribable concepts) | Monthly |

**Deliberately excluded:** CPT (AMA copyright), SNOMED CT / LOINC (UMLS-license-gated). The server's value is the union of the *freely-redistributable* code sets — bundling a license-gated set would poison the package. See Design Decisions §1.

**Who it's for.** Medical coders and billers; health-IT and claims engineers; clinical-NLP and research teams; and agents decoding a diagnosis/procedure/drug code or mapping a described condition to its code. The fleet has rich health *data* (`openfda`, `clinicaltrials`, `pubmed`, `cdc-health`, `who-gho`) but nothing that resolves or decodes the **codes** those domains run on. This is the reference layer that grounds the rest.

**US scope.** ICD-10-CM/PCS are the US clinical modifications; the name doesn't say "US" but the code sets do. The server description and `medcode_list_systems` output flag this so an agent doesn't mistake it for ICD-10/ICD-11 base or another country's modification.

## User Goals

The surface is designed goal-first. The outcomes an agent (and its human) will accomplish:

1. **Decode** a code to its official description, category, and hierarchy → `medcode_get_code`
2. **Find** the code(s) matching a described diagnosis, procedure, supply, or drug → `medcode_search_codes`
3. **Validate** whether a code exists, is current, and is billable — with a why-not → `medcode_check_code`
4. **Crosswalk** across systems (drug name → RXCUI, NDC ↔ RXCUI, RXCUI → ingredients) and within a hierarchy (code → parents/children) → `medcode_map_codes`
5. **Browse** a system's hierarchy without a search term → `medcode_browse_hierarchy`
6. **Ground** a code referenced by another health server (`openfda` NDC, `clinicaltrials` condition) into its meaning → `medcode_get_code` + `medcode_map_codes`
7. **Confirm provenance** — which release/fiscal-year is active before acting on a result → `medcode_list_systems`

Goals 1–7 are fully covered by the six tools. A tool-only agent can accomplish everything the server is for.

## Requirements

- **Offline, keyless, deterministic.** No runtime network I/O. Same inputs + same bundled DB → same output. No auth, no rate limit, single-tenant.
- **Bundled corpus.** The SQLite DB ships inside the package and Docker image — the server reads it read-only at startup. No fetch-at-install, no first-run download. (Build-time ingest; see Services + Design Decisions §2.)
- **Code-shape auto-detection.** ICD-10-CM (`A00`–`Z99` letter + 2 digits + optional `.` + up to 4 more alphanumerics), ICD-10-PCS (7-char alphanumeric, no letters `I`/`O`), HCPCS Level II (1 letter `A`–`V` + 4 digits), RXCUI (pure integer) have distinct shapes. `medcode_get_code`/`medcode_check_code`/`medcode_map_codes` route by pattern; an explicit `system` overrides when a value is ambiguous (e.g. a short string that could be a partial ICD-10-CM category or an HCPCS code).
- **Billable/validity is real signal.** ICD-10-CM carries a billable flag (order-file position 15: `1` = billable leaf, `0` = non-billable header). `medcode_check_code` surfaces "valid category but not billable — needs a more specific child" rather than a bare hit. This is the caller-DX detail a smaller model needs to avoid submitting an unbillable code.
- **Release transparency.** Each system's release identifier (e.g. "ICD-10-CM FY2026", "HCPCS 2026", "RxNorm 2026-06-01"), effective date range, and code count are queryable via `medcode_list_systems` and stamped into a build-metadata row.
- **Licensing posture.** Only freely-redistributable public-domain sets are bundled. The RxNorm *Prescribable Content* subset (not the full monthly release) is used — confirmed "no licensing restrictions … public domain" by NLM, no UMLS login. The build script must pull the Prescribable subset specifically; pulling the full release would drag in UMLS-licensed source vocabularies and break redistribution. See Design Decisions §1.

## Services

One service. The server *is* the source of truth (server-as-service pattern) — there is no upstream to retry, no resilience/backoff layer, no API-efficiency table. The design questions are storage-shaped, not network-shaped.

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `code-index` | The bundled SQLite + FTS5 database (read-only handle, opened once in `setup()`) | all six tools |

**`code-index-service`** responsibilities:
- Open the bundled DB read-only at startup (`bun:sqlite`, `readonly: true`), assert the build-metadata table exists and is non-empty (fail-fast on a missing/empty DB — a broken bundle should crash loudly, not serve empty results).
- Expose typed query methods the tools compose: `getByCode(code, system?)`, `searchFts(query, filters)`, `checkCode(code, system?)`, `mapCode(from, direction, system?)`, `browseChildren(system, node?)`, `listSystems()`.
- Own code-shape detection (`detectSystem(code): SystemId | null`) and the FTS5 query translation (sanitize user text → FTS5 `MATCH` expression).
- No `ctx.state` — the corpus is global and read-only, not tenant-scoped. (No per-tenant data exists; `ctx.state` would be the wrong tool.)

**Schema (one DB, a handful of tables):**

- `codes` — `system TEXT, code TEXT, short_desc TEXT, long_desc TEXT, billable INTEGER, header INTEGER, chapter TEXT, parent TEXT, effective TEXT, terminated TEXT`, PK `(system, code)`. The spine. Note: `parent` is meaningful for ICD-10-CM (parent = code with last character stripped) and HCPCS (parent = first letter range); for ICD-10-PCS it is `NULL` — PCS hierarchy is axis-based and lives in a separate `pcs_axes` table (or is derived at query time from the 7-character axis structure), not prefix-based.
- `codes_fts` — FTS5 external-content index over `short_desc, long_desc` (mirrors `codes`), for `medcode_search_codes`.
- `pcs_axes` — `position INTEGER, value TEXT, meaning TEXT` — ICD-10-PCS axis-value lookup table (derived from the PCS tabular XML). Used by `medcode_browse_hierarchy` for PCS axis traversal (e.g. "what are valid body-system values for a given section?"). Built from the PCS tabular XML (`icd10pcs_tabular_<FY>.xml`, also in the CMS download) rather than the order file.
- `rxnorm_rel` — `rxcui TEXT, rel TEXT, target TEXT, target_type TEXT` — RXCUI ↔ ingredient/brand/NDC edges, for `medcode_map_codes` drug crosswalks (built from RXNREL/RXNSAT).
- `ndc_map` — `ndc TEXT, rxcui TEXT` (built from RXNSAT `ATN=NDC`), the NDC ↔ RXCUI index that composes with `openfda`.
- `build_meta` — `system TEXT, release_id TEXT, effective_start TEXT, effective_end TEXT, code_count INTEGER, source_url TEXT, built_at TEXT` — one row per system, the provenance `medcode_list_systems` returns.

**Ingest (build-time, not runtime).** A `scripts/build-index.ts` (run on the federal update cadence, output committed/baked into the image — *not* executed at server startup) that, per system:
1. Downloads the canonical release file from its `.gov` source (URLs in Config / Design Decisions §2).
2. Parses the format: ICD-10-CM/PCS order files = fixed-width slice by documented column positions; HCPCS `ANWEB.txt` = fixed-width (320 chars/row — not delimited, despite the "columns" label in CMS docs); RxNorm = pipe-delimited RRF (`RXNCONSO`, `RXNSAT`, `RXNREL`).
3. Normalizes into the `codes`/`rxnorm_rel`/`ndc_map` rows, derives `parent`/`chapter`/`header` from code structure (CM/HCPCS only; PCS `parent` stays NULL and hierarchy data populates `pcs_axes` from the tabular XML), writes `build_meta`.
4. Emits the single `.db` file the package ships.

This is the `MirrorService`'s ingester role done **at build time** rather than at runtime — see Design Decisions §3 for why a build-time bake beats the runtime `MirrorService` here.

## Config

Runtime config is nearly empty — the server reads a bundled file and serves it. Server-specific env vars live in `src/config/server-config.ts` (separate Zod schema, `parseEnvConfig`).

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `MEDCODE_DB_PATH` | no | Absolute path override for the bundled SQLite DB. Defaults to the packaged `data/medical-codes.db` resolved relative to the build output. Override only for a custom-built or externally-mounted index. |
| `MEDCODE_MAX_RESULTS` | no | Cap on rows returned by `medcode_search_codes` / `medcode_browse_hierarchy` (default 50, hard ceiling 200). Bounds context budget. |

Build-time-only inputs (source URLs, release year/quarter/month) are **script arguments / constants in `scripts/build-index.ts`**, not runtime env vars — the server never downloads anything, so they have no place in `server-config.ts`.

## Implementation Order

Each step is independently testable.

1. **Config + server setup** — `server-config.ts` (DB path, max results), `index.ts` `createApp({ name: 'medical-codes-mcp-server', title: 'medical-codes-mcp-server', ... })`, empty definition barrels.
2. **Build script + a seed DB** — `scripts/build-index.ts` for ICD-10-CM first (smallest blast radius, exercises fixed-width parse + billable flag + FTS), produce a checked-in `data/medical-codes.db`. Unit-test the parser against a fixture slice of the order file.
3. **`code-index-service`** — open the seed DB read-only, implement `getByCode` / `searchFts` / `listSystems` / `detectSystem`. Test against the seed DB.
4. **Read-only tools, in goal order:** `medcode_list_systems` → `medcode_get_code` → `medcode_search_codes` → `medcode_check_code` → `medcode_browse_hierarchy`. Each ships with a sparse-payload test (a code with no short desc, a header row, an empty-result search).
5. **Extend the build to ICD-10-PCS + HCPCS** — add the two parsers, re-bake, verify counts in `build_meta` match the published totals (78,986 PCS; HCPCS active-code count varies by release — verify against CMS quarterly release notes rather than a fixed expected number).
6. **RxNorm (phase 2)** — add the Prescribable-subset RRF parse (`codes` + `rxnorm_rel` + `ndc_map`), then `medcode_map_codes`. This is the only system with relational crosswalk complexity; landing it last keeps v1 unambiguously public-domain (see Design Decisions §4).

(No "write tools / resources / prompts" steps — the server has none.)

## Domain Mapping

Four systems (nouns) × the operations each supports. Operations are raw material; not all become distinct tools — most fold into the six workflow/lookup tools via the `system` parameter.

| System (noun) | Operations the index supports | Served by |
|:--------------|:------------------------------|:----------|
| ICD-10-CM | get-by-code, search-by-desc, check-billable, browse chapter→category→code, code→parent/children | get / search / check / browse / map |
| ICD-10-PCS | get-by-code, search-by-desc, validate (7-char completeness), browse axis structure (not prefix hierarchy — each character is an axis: section/body-system/operation/body-part/approach/device/qualifier) | get / search / check / browse |
| HCPCS Level II | get-by-code, search-by-desc, check-current (term date), browse by range (A–V) | get / search / check / browse |
| RxNorm (prescribable) | get-by-RXCUI, search-by-drug-name, name→RXCUI, NDC↔RXCUI, RXCUI→ingredients/brands | get / search / map |

The `system` enum on each tool is what collapses 4 nouns × ~5 operations into 6 tools instead of ~20 — one `medcode_get_code` decodes all four systems, not `medcode_get_icd10cm` + `medcode_get_pcs` + … (Design Decisions §5).

## Design Decisions

### 1. Licensing is the whole architecture — the exclusions are load-bearing

The server's value proposition is *the union of the freely-redistributable US code sets, bundled offline*. That only works if every bundled set is genuinely redistributable:

- **ICD-10-CM** (CDC/NCHS), **ICD-10-PCS** (CMS), **HCPCS Level II** (CMS) — US federal works, public domain, no anti-redistribution or anti-AI clause. Clean to bundle.
- **RxNorm Prescribable Content subset** (NLM) — verified against NLM's own page: *"no licensing restrictions … public domain,"* "you do not need to log into the UMLS Terminology Services to access the subset." The subset draws from only three sources (SAB=RXNORM normalized names/RXCUIs, FDA SPL, a small CMS set), all redistributable. **This is the only nuance in the whole server**, and it's a sequencing detail, not a blocker.
- **CPT** (AMA copyright), **SNOMED CT / LOINC** (UMLS-license-gated) — *excluded*. Bundling any of them would require a license we can't redistribute under — the same trap that would sink a "bundle BoardGameGeek's data" server. They are out, permanently, by design.

The hard build-time rule: pull the RxNorm **Prescribable Content** subset, *never* the full monthly release. The full release bundles UMLS-licensed source vocabularies; shipping it would silently convert a clean public-domain package into a license-violating one. The build script targets the Prescribable subset file specifically and the design notes the distinction at the ingest step so a future maintainer doesn't "upgrade" to the full release.

### 2. Data sources — exact files, formats, and parse points

Verified against primary `.gov` sources (June 2026). Each is a static bulk download, no key, no runtime API:

| System | Canonical source | File | Format / parse |
|:-------|:-----------------|:-----|:---------------|
| ICD-10-CM | CDC NCHS FTP: `ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM/<FY>/` | `icd10cm-Code Descriptions-<FY>.zip` → `icd10cm-order-<FY>.txt` (dashes, not underscores) | Fixed-width, variable-length lines (observed 81–305 chars). **Pos 1–5** order#, **pos 7–13** code (no dot, right-padded with spaces to 7 chars), **pos 15** billable flag (`1`/`0`), **pos 17–76** short desc (space-padded to 60 chars), **pos 78+** long desc. The pos-15 flag is the billable signal `medcode_check_code` depends on. FY2026 file: 98,186 lines — 74,719 billable leaf codes + 23,467 non-billable header/category rows. An `icd10cm-order-addenda-<FY>.txt` change list ships in the same ZIP, but the published order file already incorporates it (see the note below the table), so the build bakes the order file directly. |
| ICD-10-PCS | CMS ICD-10 page (cms.gov — blocks programmatic access; use direct file URL) | `<FY>-icd-10-pcs-order-file.zip` → `icd10pcs_order_<FY>.txt` | Fixed-width. Same column layout as ICD-10-CM order files: **pos 1–5** order#, **pos 7–13** code (7-char alphanumeric, no spaces), **pos 15** valid flag, **pos 17–76** short desc, **pos 78+** long desc. Every complete 7-char PCS code is billable — the valid flag marks completeness (no non-billable category rows the way CM has). 78,986 codes (FY2026). Hierarchy is axis-based (7 characters × axis meanings), not parent-code-prefix based. |
| HCPCS Level II | CMS HCPCS page — annual file; quarterly updates are separate downloads | Annual: `HCPC<yr>_<MON>_ANWEB_<MMDDYYYY>.txt` (inside the annual ZIP, e.g. `january-2026-alpha-numeric-hcpcs-file.zip`). Quarterly update ZIP naming varies by year. | **Fixed-width** (320 chars/row — not delimited). Column positions verified against the record-layout doc shipped in the ZIP (`HCPC<yr>_recordlayout.txt`): **pos 1–5** HCPC code (5 chars; modifier rows instead carry a 2-char value at pos 4–5 with pos 1–3 blank — filtered out), **pos 6–10** SEQNUM, **pos 11** RECID (`3` = primary row, `4` = long-description continuation), **pos 12–91** LONG_DESCRIPTION (80 chars), **pos 92–119** SHORT_DESCRIPTION (28 chars), **pos 269–276** Code Added Date (effective), **pos 277–284** Action Effective Date (NOT termination — a past date here is normal for active codes), **pos 285–292** Termination Date (YYYYMMDD, blank = active). A code's long description spans the primary row plus continuation rows (same code, successive SEQNUMs) and must be concatenated; terminated codes remain in the file (filter by empty/future term date for active). FY2026 file: 16,615 lines → 8,623 distinct codes (7,323 active). |
| RxNorm Prescribable | NLM RxNorm Files page (`nlm.nih.gov/research/umls/rxnorm/docs/rxnormfiles.html`) | `RxNorm_full_prescribe_<MMDDYYYY>.zip` → `RXNCONSO.RRF`, `RXNSAT.RRF`, `RXNREL.RRF` | Pipe-delimited UTF-8 RRF. RXNCONSO (18 cols: RXCUI, LAT, …, SAB, TTY, CODE, STR, …) → drug names + RXCUIs; RXNSAT (13 cols: RXCUI, …, ATN, SAB, ATV, …) where `ATN='NDC'` and `ATV`=NDC value → `ndc_map`; RXNREL → `rxnorm_rel` (ingredient/brand edges). |

ICD-10's mid-year addenda (Apr 1) means the "active" FY file can change twice a year — the build cadence and `build_meta.release_id` capture which revision is baked. Verified for FY2026: the published order file **already incorporates** the April addenda (all 630 addenda "Add" codes are present in the base file, none net-new), so the build bakes the base file directly and does **not** apply the separate `*-order-addenda-*.txt` change list — that file uses a different layout (Add/Delete/Revise actions, code at a shifted column) and trailing summary lines, and re-parsing it with the order-file parser yields colliding garbage rows. If a future release ships an order file that predates its addenda, an addenda-specific parser would be needed.

### 3. Ingest strategy — build-time bake, not the runtime MirrorService

The corpus is **tiny and changes on a slow, scheduled cadence**: on the order of ~225k rows total (ICD-10-CM ~98k rows / ~75k billable, ICD-10-PCS ~79k, HCPCS ~12k rows / ~5k active, RxNorm prescribable ~30k concepts + edges; exact counts land in `build_meta` at build time), updated annually (ICD-10), quarterly (HCPCS), monthly (RxNorm) — never intra-day, never per-request. The design skill's backend-by-corpus-size guidance maps three ways, and this corpus sits at the small end:

| Option | Fit here |
|:-------|:---------|
| In-memory index (≲ tens of thousands of rows) | Borderline on row count, but loses FTS5 and forces a parse on every cold start. |
| **Build-time SQLite + FTS5, baked into the image** | **Chosen.** Corpus is bounded and slow-changing; bake it once, ship the `.db`, open read-only. Zero cold-start parse, FTS5 search for free, fully offline, deterministic. |
| `MirrorService` (runtime sync, 10⁴–10⁷) | Designed for a *live upstream queried more than it changes*, with a runtime `sync` generator + scheduler. Overkill here: there is no live API to mirror at runtime, and the federal cadence is far slower than any refresh loop. Its machinery (cursor/checkpoint, runtime scheduler, init-vs-refresh) solves problems this corpus doesn't have. |
| External store (≳ 10⁸) | Irrelevant at ~225k rows. |

So the architecture borrows the `MirrorService` *shape* — SQLite + FTS5, an ingester per source — but runs the ingester **at build time** and ships the result. The federal update cadence is a CI/rebuild trigger, not a runtime concern. `mirror: "T1 — entire code set built into SQLite+FTS5 at build time"` in the fleet entry already names this; this design pins the mechanics.

**Bundle vs. fetch-at-install:** bundle. The full DB is on the order of tens of MB — small enough to ship in the npm tarball and Docker image, and bundling preserves the offline/keyless/deterministic guarantee. A fetch-at-install step would add a network dependency and a failure mode the whole design exists to avoid.

### 4. Clean v1, then RxNorm (phase 2)

ICD-10-CM/PCS + HCPCS are unambiguously public domain and parse from fixed-width/columnar text → they ship as a clean v1 with zero licensing nuance and no relational crosswalk. RxNorm adds the only cross-system relational tables (`rxnorm_rel`, `ndc_map`). Landing it as a second phase kept the first release simple and unambiguous. The server identity is "US medical codes" either way — this was a sequencing call, not a scope change. `medcode_map_codes`'s drug directions shipped inert (`direction_unavailable`) in v1, with the hierarchy directions live.

**Update (0.2.0 — RxNorm landed):** the acquisition pivoted from the RRF files to the **keyless RxNav REST API** (`scripts/ingest/fetch-rxnav.ts`), because NLM moved the RxNorm RRF bulk downloads — including the prescribable subset — behind UMLS/UTS authentication, which an offline keyless package can't depend on. RxNav serves the public-domain RxNorm *normalized* vocabulary (never the UMLS-licensed source vocabularies), so the bundled scope is the **current normalized drug set** (ingredients, brands, clinical/branded drugs, packs) with their NDC + ingredient/brand edges — a superset of the prescribable subset, and still fully redistributable. The drug directions and first-class NDC → drug decode in `medcode_get_code` are now live.

### 5. The `system` enum collapses the surface; auto-detection keeps it ergonomic

Four code systems could have produced a per-system tool explosion (`medcode_get_icd10cm`, `medcode_search_hcpcs`, …) — ~20 tools mirroring nouns. Instead, one tool per *user action*, with a `system` discriminator. `medcode_get_code` decodes any of the four; the handler routes by code shape and only needs `system` when a value is genuinely ambiguous. This is the goal-first surface the skill prescribes: the agent says "decode this code," not "which of four lookup tools matches this code's system." Output always echoes the resolved `system` so the agent knows which system answered — provenance the server can know and the agent can't infer reliably from the code alone.

### 6. No resources — tool-only by design

Every datum is reachable through the tool surface, and the primary clients (Claude Code, Cursor, chat UIs) are tool-only. A `medcode://icd10cm/{code}` resource would duplicate `medcode_get_code` with no added reach — and data locked behind a resource is invisible to tool-only clients, the exact trap the skill flags. Stable-URI injectable context isn't a meaningful win for a code-lookup server where the agent already drives every lookup by tool call. Skipped.

### 7. No prompts

No recurring multi-step interaction pattern that a reusable message template would structure. Lookups and crosswalks are direct tool calls; there's no "analysis framework" or "report template" shape here. The "clinical-concept resolver" moonshot (free text → candidate ICD-10-CM + RXCUI + procedure codes in one call) *could* one day be a workflow **tool** (not a prompt) — deferred, noted, out of v1 scope.

### 8. No DataCanvas

The skill gates DataCanvas on *analytical shape* — would an agent run SQL (aggregate/group/join) over the result? No. This is a lookup/crosswalk/discovery surface returning a handful of codes per call, the categorical-metadata case the skill explicitly says does *not* qualify regardless of corpus size. Results return inline; FTS5 over the bundled DB is the search backend. A `dataframe_query` tool would be dead surface here.

### 9. Output design — built for the agent's next move

- `medcode_get_code` returns, per code: resolved `system`, `code` (display form with dots re-inserted), `description` (long), `shortDescription`, `billable`, `header`, `chapter`, and (when `includeHierarchy`) `parent` + immediate `children`. The agent can chain straight into `medcode_map_codes` or surface a billability warning without a second call.
- `medcode_check_code` returns a discriminated status (`valid_billable` | `valid_not_billable` | `valid_header` | `terminated` | `unknown`) plus a `whyNot` string for the non-billable/terminated cases — the recovery instruction a coder acts on.
- `medcode_search_codes` discloses truncation: `ctx.enrich.truncated({ shown, cap })` when the result hits the cap, and echoes the parsed query + active filters via `ctx.enrich` so both client surfaces see what was searched. Empty results return an explicit notice (try broader terms / different system), not a bare empty array.
- `medcode_map_codes` always returns `source` provenance (which system/edge answered) so a chained call (e.g. into `openfda` with the resolved NDC) carries the right identifier.
- Multi-code `medcode_get_code` is array-in / partial-success-out: `found[]` + `notFound[]` (with per-code reason), since one bad code in a batch shouldn't fail the others.

### 10. Typed error contracts (per tool, inline)

Domain failure modes declared as `errors: [{ reason, code, when, recovery }]` so `ctx.fail` is type-checked and capable clients preview failures via `tools/list`. Baseline codes (`InternalError`, `ValidationError`, …) bubble without declaration.

| Tool | reason | code | when | recovery (agent's next move) |
|:-----|:-------|:-----|:-----|:-----------------------------|
| `medcode_get_code` | `no_codes_found` | `NotFound` | none of the requested codes exist in any bundled system | Verify code formatting, or call `medcode_search_codes` with a description to find the right code. |
| `medcode_get_code` | `ambiguous_system` | `InvalidParams` | a code matches multiple systems' shapes and no `system` was given | Re-call with an explicit `system` to disambiguate. |
| `medcode_check_code` | `unknown_code` | `NotFound` | the code does not exist in the named/detected system | Check the code, or search by description with `medcode_search_codes`. |
| `medcode_map_codes` | `no_mapping` | `NotFound` | the source resolved but has no edge in the requested `direction` | Confirm the direction is supported for this system, or decode the code with `medcode_get_code` first. |
| `medcode_map_codes` | `direction_unavailable` | `InvalidParams` | a drug-crosswalk direction requested but the build carries no RxNorm tables | Use a hierarchy direction (parents/children), or rebuild the index with RxNorm bundled (the shipped default). |
| `medcode_browse_hierarchy` | `unknown_node` | `NotFound` | the `node` doesn't exist in the system | Omit `node` to list top-level chapters, or verify the node code. |

Validity vs. existence is deliberately split: a *non-billable* or *terminated* code is a successful `medcode_check_code` result (status + `whyNot`), **not** an error — the agent needs the detail, and throwing would hide it. Only a code that doesn't exist at all is `unknown_code`.

`medcode_search_codes` likewise carries no typed error contract: a zero-match query is a successful empty result with a recovery notice (via enrichment), not a `NotFound`. An empty result set is a normal search outcome, and the notice delivers the same recovery guidance without forcing the caller to catch an error.

## Known Limitations

- **US-only.** ICD-10-CM/PCS are US clinical modifications; no ICD-10/ICD-11 base or other national mods. Flagged in the description and `medcode_list_systems`.
- **No CPT / SNOMED CT / LOINC.** Excluded by license (§1) — a crosswalk *into* CPT or SNOMED is out of scope and can't be added without a redistributable source.
- **Release lag.** The bundled DB is as current as its last build. `medcode_list_systems` exposes exactly which release is active so a caller can detect staleness; there is no live-API fallback (by design — the whole server is offline).
- **RxNorm coverage is the prescribable subset, not all of RxNorm.** Historical, obsolete, or non-prescribable concepts in the full release are absent. This is the redistribution tradeoff, surfaced in `medcode_list_systems` (release_id names the subset).
- **ICD-10-PCS hierarchy is axis-based, not prefix-based.** Unlike ICD-10-CM where a shorter code is always the parent of a longer one, PCS codes have no such prefix relationship — each character independently encodes an axis (section, body system, root operation, body part, approach, device, qualifier). `medcode_browse_hierarchy` for PCS walks the axis-value tables, not parent-code prefixes. The `parent` field in the schema has no meaningful value for PCS; hierarchy browsing returns the set of valid next-character values for a given partial code.

## API Reference

No external API. Backend is a bundled SQLite + FTS5 database opened read-only via `bun:sqlite`. Search uses FTS5 `MATCH`; the service translates sanitized user text into an FTS5 query expression. Pagination/caps via `MEDCODE_MAX_RESULTS` with `ctx.enrich.truncated()` disclosure.
