<div align="center">
  <h1>@cyanheads/medical-codes-mcp-server</h1>
  <p><b>Decode, search, validate, and crosswalk US medical codes — ICD-10-CM, ICD-10-PCS, HCPCS Level II, RxNorm — over a bundled offline index via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/medical-codes-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/medical-codes-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/medical-codes-mcp-server/releases/latest/download/medical-codes-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=medical-codes-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbWVkaWNhbC1jb2Rlcy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22medical-codes-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fmedical-codes-mcp-server%22%5D%7D)

</div>

<div align="center">

**Public Hosted Server:** [https://medical-codes.caseyjhand.com/mcp](https://medical-codes.caseyjhand.com/mcp)

</div>

<div align="center">

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

> [!NOTE]
> **Informational, not clinical or coding advice.** This server returns official code descriptions and billable/validity flags from public-domain federal releases to help you decode and look up codes. It is **not** medical advice, and a `valid_billable` result is **not** a coding or reimbursement decision. Always verify codes against the official source releases (CMS, CDC/NCHS, NLM) and your payer's rules before submitting a claim. The bundled data is only as current as the release baked into the build — call `medcode_list_systems` to see exactly which releases are active.

## Overview

US medical codes — ICD-10-CM, ICD-10-PCS, HCPCS Level II, and RxNorm — from a bundled offline SQLite index built from public-domain CDC/NCHS, CMS, and NLM federal releases, plus the RxClass drug classes of the RxNorm drugs. Decode, search, validate billability, and crosswalk codes, drugs (including NDC lookups), and drug classes from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `medcode_get_code` | Decode 1–50 codes to their official descriptions. Auto-detects the system per code; partial-success `found` / `notFound`. |
| `medcode_search_codes` | Full-text search over official descriptions — go from a clinical description to the code. |
| `medcode_check_code` | Validate a code's existence, currency, and billability, with a `whyNot` for non-billable/terminated cases. |
| `medcode_map_codes` | Crosswalk a code within its hierarchy (`parents`/`children`), a drug across RxNorm (name ↔ RXCUI, NDC ↔ RXCUI, RXCUI → ingredients/brands), or a drug to its RxClass classes and a class to its member drugs. |
| `medcode_browse_hierarchy` | Walk a system's hierarchy for discovery without a search term. |
| `medcode_list_systems` | List bundled systems with release identifiers, effective dates, and code counts, and the RxClass layer with each source's version (provenance). |

## How it works

Only freely-redistributable, public-domain US federal code sets are bundled, baked into a single SQLite + FTS5 database at package-build time and opened read-only at startup.

### Bundled code systems

| System | Source | Covers |
|:---|:---|:---|
| **ICD-10-CM** | [CDC/NCHS](https://www.cdc.gov/nchs/icd/icd-10-cm/index.html) — US federal, public domain | Diagnoses (billable leaf codes + non-billable category headers) |
| **ICD-10-PCS** | [CMS](https://www.cms.gov/medicare/coding-billing/icd-10-codes) — US federal, public domain | Inpatient procedures (axis-based 7-character codes) |
| **HCPCS Level II** | [CMS](https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system) — US federal, public domain | Supplies, drugs, and non-physician services |
| **RxNorm** | [NLM RxNav](https://rxnav.nlm.nih.gov/) — public domain | Drugs: name ↔ RXCUI, NDC ↔ RXCUI crosswalk, ingredients, and brands |
| **RxClass drug classes** | [NLM RxClass](https://lhncbc.nlm.nih.gov/RxNav/applications/RxClassIntro.html) — US government sources only | Classes of the RxNorm drugs: pharmacologic class, mechanism of action, physiologic effect, pharmacokinetics, therapeutic category, chemical structure, diseases treated/prevented and contraindications, VA class, DEA schedule, CVX vaccine code |

**RxNorm** bundles the current normalized drug vocabulary — ingredients, brand names, clinical & branded drugs, and packs, with their NDC and ingredient/brand crosswalks — sourced at build time from the keyless [RxNav REST API](https://rxnav.nlm.nih.gov/), which serves the public-domain normalized layer only. The full UMLS-licensed RxNorm release is intentionally excluded, so the package stays freely redistributable.

**RxClass** is a class layer over those drugs, not a code system: 20,707 classes and 86,837 drug–class edges, fetched at build time from the keyless [RxClass API](https://rxnav.nlm.nih.gov/REST/rxclass/). Six sources are bundled, all US government works: `MEDRT` (VA MED-RT — mechanism, physiologic effect, pharmacokinetics, chemical structure, and disease relations), `FDASPL` (FDA established pharmacologic classes and related classes from structured product labels), `FMTSME` (therapeutic categories), `VA` (VA National Formulary classes), `RXNORM` (DEA controlled-substance schedules), and `CDC` (CVX vaccine codes). Four are excluded: `ATC` and `ATCPROD`, whose WHO terms bar copying and distribution for commercial purposes; `SNOMEDCT`, which is under the SNOMED CT Affiliate license; and `DAILYMED`, which repeats FDASPL's edges almost exactly (8,694 of its 8,710) and publishes no version.

> This product uses publicly available data courtesy of the U.S. National Library of Medicine (NLM), National Institutes of Health, Department of Health and Human Services; NLM is not responsible for the product and does not endorse or recommend this or any other product.

CPT (AMA copyright) and SNOMED CT / LOINC (UMLS-license-gated) are intentionally absent — not freely redistributable, so they cannot ship in an offline package.

**US scope.** ICD-10-CM and ICD-10-PCS are the US clinical modifications, not the WHO ICD-10/ICD-11 base or another country's national modification.

## Capability reference

### `medcode_get_code` <sub>tool</sub>

- Accepts 1–50 codes; mixed systems are fine — each code's system is detected independently from its shape
- Decodes a National Drug Code (NDC) directly to its RxNorm product — hyphenated FDA segment configurations (4-4-2, 5-3-2, 5-4-1, or the 11-digit 5-4-2) or bare 10/11 digits — offline via the bundled NDC↔RxNorm map, tagged `source: "NDC"`
- Partial success: resolved codes in `found`, unresolved in `notFound` with a per-code reason — a bare integer that resolves nowhere is named as a possible CPT / HCPCS Level I code, which is out of scope, except a bare 10/11-digit one, which is named as an NDC no bundled drug maps to
- An explicit `system` overrides auto-detection when a value is genuinely ambiguous (an ambiguous code lists its `candidateSystems`) and skips the NDC decode; `includeHierarchy` attaches each code's parent and immediate children
- `alsoInSystems` names other bundled systems holding the same code string — it is a different code in each
- RxNorm rows carry `billable: null` (RxNorm has no billing concept) and `shortDescription: null` (RxNorm publishes a single name); `chapter` holds the RxNorm term type (`IN`, `SCD`, `SBD`, …)
- Errors: `no_codes_found` when none of the requested codes resolve in any bundled system — or, under an explicit `system`, in that system, with any other bundled system that holds a code named

---

### `medcode_search_codes` <sub>tool</sub>

- Every search term must appear — matched first as a token prefix, then as a substring, so inflected and compound forms are also found; an RxNorm concept matches on its drug name alone, never its term type
- Filter by `system`, `billableOnly` (exclude headers/categories, and every RxNorm concept — RxNorm has no billing concept), and `chapter` (for RxNorm, the term type)
- Ranked by full-text relevance; results echo the resolved `system` per row
- Paginates via `cursor`/`limit` (default `MEDCODE_MAX_RESULTS`, ceiling 200); discloses `truncated`/`nextCursor`, and returns a notice with the parsed query when nothing matches

---

### `medcode_check_code` <sub>tool</sub>

- Discriminated `status`: `valid_billable`, `valid_not_billable`, `valid_header`, `valid`, or `terminated` — `valid` is a current RxNorm concept, returned with `billable: null` because RxNorm has no billing concept
- `whyNot` explains non-billable/terminated cases — a non-billable or terminated code is a successful result, not an error
- `alsoInSystems` names other bundled systems holding the same code string, since the verdict applies only to the resolved system
- Errors: `unknown_code` (absent from the named or detected system — under an explicit `system`, a code another bundled system holds is named as that system's code; an NDC lands here too, including a well-formed bare 10/11-digit one no bundled drug maps to, with a recovery pointing at `medcode_get_code` and `medcode_map_codes` `ndc_to_rxcui`) and `ambiguous_system` (present in multiple systems, no `system` given)

---

### `medcode_map_codes` <sub>tool</sub>

- Hierarchy directions `parents`/`children` walk one level per call (depth-1); ICD-10-PCS codes have no prefix parent, and RxNorm concepts no code hierarchy
- Drug directions (RxNorm): `name_to_rxcui` (matches the drug name, never the term type), `ndc_to_rxcui`/`rxcui_to_ndc` (NDC accepted hyphenated in an FDA segment configuration — 4-4-2, 5-3-2, 5-4-1, or the 11-digit 5-4-2 — or as bare 10/11 digits), `rxcui_to_ingredients`/`rxcui_to_brands` (each hit carries `conceptType`: `IN`/`PIN`/`MIN`/`BN`)
- Drug-class directions (RxClass): `rxcui_to_classes` returns an RXCUI's classes, and `class_to_rxcuis` a class ID's direct member RXCUIs, each with its RxNorm name and `conceptType`. Each hit carries `classType`, `source` (the RxClass source asserting it), and `relation` (`has_epc`, `may_treat`, …) — one hit per class × source × relation. A relation starting `ci_` (`ci_with`, `ci_moa`, `ci_pe`, `ci_chemclass`) is a contraindication, not an indication
- RxClass attaches most classes to ingredients, so a drug product also returns its ingredients' classes, naming the ingredient in `via` (an `IN` over its `PIN`); inheritance runs upward only. DEA schedules are recorded only on drug products, and VA classes almost only there: map a product for those — an ingredient's empty `SCHEDULE` or `VA` result says so rather than reading as unscheduled or unclassified. Membership is direct: a class whose drugs all attach to its subclasses (`N0000193873` "Diuretic") returns no members, and the class hierarchy is not walked
- Class IDs match case-insensitively, and a one-digit CVX vaccine code reads as its zero-padded ID (`3` is CVX `03`)
- `classType` (`EPC`, `MOA`, `PE`, `PK`, `TC`, `CHEM`, `DISEASE`, `VA`, `SCHEDULE`, `CVX`) narrows the two class directions and is rejected on every other
- `children`, `name_to_rxcui`, `rxcui_to_ndc`, `rxcui_to_classes`, and `class_to_rxcuis` paginate via `cursor`/`limit` — one RXCUI can carry thousands of package NDCs and one class thousands of members; `limit` and `cursor` are rejected on every other direction, and `system` steers only `parents`/`children` (the drug and class directions accept only `RXNORM`)
- Every hit carries `source` provenance so a chained call uses the right identifier; a resolvable source with no edge in the requested direction is a successful empty result with a notice, not an error — a brand name has no classes, for instance
- Errors: `no_mapping` (source doesn't resolve — a code-system name passed as `from`, an NDC where a code or RXCUI belongs (a well-formed one no bundled drug maps to in the words `ndc_to_rxcui` uses), a class ID where an RXCUI belongs, or a bare integer that may be an out-of-scope CPT / HCPCS Level I code, is named as such, and a code-system name is recovered to the one input the direction takes; a `parents`/`children` code an explicit `system` missed is named as the code of the bundled system that holds it; an `ndc_to_rxcui` miss says whether the spelling is malformed or a well-formed NDC no bundled drug maps to; a `class_to_rxcuis` miss is worded for a class ID, naming an RXCUI or class type sent in its place), `field_not_applicable` (a `system`, `classType`, `limit`, or `cursor` the direction does not use), `direction_unavailable` (RxNorm, or for the class directions the RxClass layer, not bundled in this build), `ambiguous_system`

---

### `medcode_browse_hierarchy` <sub>tool</sub>

- With no `node`: top-level entries (ICD-10-CM categories, HCPCS range buckets, ICD-10-PCS first-axis values); with a `node`: its immediate children
- ICD-10-CM/HCPCS use a prefix hierarchy; ICD-10-PCS is axis-based and only the top-level Section axis is browsable — positions 2–7 are context-dependent and not enumerable from a flat partial code
- Paginates via `cursor`/`limit` (default `MEDCODE_MAX_RESULTS`, ceiling 200)
- Errors: `unknown_node` when the node doesn't exist (or, for ICD-10-PCS, uses an out-of-alphabet character or begins no bundled code)

---

### `medcode_list_systems` <sub>tool</sub>

- No input; returns one entry per bundled system with `releaseId`, `effectiveStart`/`effectiveEnd`, `codeCount`, `sourceUrl`, and `builtAt`
- `builtAt` dates the system's data: for ICD-10-CM, ICD-10-PCS, and HCPCS, the time the index was built from the named release; for RxNorm, which publishes no release label, the date the RxNav snapshot was fetched, so a rebuild from the same snapshot reports the same date
- `classLayer` reports the RxClass layer apart from the code systems: its class and edge counts, and per source the RxClass version (null where RxClass publishes none — CDC), the classes and edges it contributes, and the date the RxClass snapshot was fetched; null on a build without the layer
- Confirms exactly which ICD-10-CM/PCS fiscal year, HCPCS release, RxNorm snapshot, and RxClass sources are baked into the running build

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

ICD-10 / HCPCS / RxNorm-specific:

- Bundled SQLite + FTS5 index — offline, keyless, deterministic; no runtime network I/O, no rate limit
- Code-shape auto-detection routes a code to its system automatically; an explicit `system` disambiguates collisions
- Real billable/validity signal from the source releases — the order-file billable flag drives `medcode_check_code`, not a heuristic; RxNorm, which has no billing concept, reports `billable: null` rather than a verdict

Agent-friendly output:

- Provenance on every response — the resolved `system` is echoed for chaining, `alsoInSystems` flags a code string that means something different in another bundled system, and `medcode_list_systems` reports exactly which release is baked into the build
- Graceful partial failure — `medcode_get_code` returns per-code `found`/`notFound` rows instead of failing the batch
- Discriminated output contracts — `medcode_check_code`'s typed `status` and `medcode_map_codes`' `source` let callers branch on data, not string parsing

## Getting started

This server ships with the code database bundled — there is no API key to obtain and nothing to download at runtime.

### Public Hosted Instance

A public instance is available at `https://medical-codes.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP, with this client config:

```json
{
  "mcpServers": {
    "medical-codes-mcp-server": {
      "type": "streamable-http",
      "url": "https://medical-codes.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "medical-codes-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/medical-codes-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "medical-codes-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/medical-codes-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "medical-codes-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/medical-codes-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

Refer to "your MCP client configuration file" generically — different clients use different config paths, and the server isn't client-specific.

### Prerequisites

- [Bun v1.4](https://bun.sh/) or higher (or Node.js v24+ — the server falls back to the `better-sqlite3` optional dependency when not run under Bun).
- No API key, account, or network access required.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/medical-codes-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd medical-codes-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# all runtime vars are optional — the server runs as-is
```

## Configuration

The server is offline and keyless — there are no required variables. Two server-specific knobs and the standard framework vars apply:

| Variable | Description | Default |
|:---|:---|:---|
| `MEDCODE_DB_PATH` | Absolute path override for the bundled SQLite index. Set only to point at a custom-built or externally-mounted database. | packaged `data/medical-codes.db` |
| `MEDCODE_MAX_RESULTS` | Default page size when a call sends no `limit` — `medcode_search_codes`, `medcode_browse_hierarchy`, and the paginated `medcode_map_codes` directions — and the number of children `medcode_get_code` attaches with `includeHierarchy`. | `50` (ceiling `200`) |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | Endpoint path where the MCP server is mounted. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateless`, `stateful`, or `auto` (which resolves to `stateful`). `src/index.ts` declares `stateless` — no tool asks the caller for input mid-call — and this variable overrides that declaration. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Building the bundled index

The bundled `data/medical-codes.db` ships in the npm package and Docker image but, at >100 MB, is **not committed to git**. To get a prebuilt copy without rebuilding, take it from the npm package (`data/medical-codes.db`) or from the `medical-codes-mcp-server.mcpb` bundle attached to each [GitHub Release](https://github.com/cyanheads/medical-codes-mcp-server/releases) — a zip archive holding the index at `data/medical-codes.db`. You only rebuild when refreshing to a new federal release. The build script never downloads: extract the canonical `.gov` source files (ICD-10-CM/PCS order files, HCPCS `ANWEB.txt` — URLs in the script header) into a directory, cache RxNorm and RxClass into it with the two fetchers, then point the script at it:

```sh
bun run scripts/ingest/fetch-rxnav.ts --out <dir>/rxnav        # RxNorm, from the keyless RxNav API
bun run scripts/ingest/fetch-rxclass.ts --rxnav <dir>/rxnav --out <dir>/rxclass   # RxClass, after RxNorm
bun run scripts/build-index.ts --from-dir <dir> --fy 2026
```

It parses the source files and caches and emits the single `.db` file. RxNorm is dated by the time its RxNav fetch completed and the RxClass sources by theirs, both recorded in the caches, so a rebuild from the same caches reports the same dates. The build runs at build time only — the server never downloads anything.

### Docker

```sh
docker build -t medical-codes-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=stdio medical-codes-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/medical-codes-mcp-server`. It copies the bundled `data/medical-codes.db` into the image so the server is fully self-contained. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers the six tools and opens the bundled index in `setup()`. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/services/code-index` | The code-index service — read-only SQLite handle, code-shape detection, FTS5 query translation. |
| `scripts/build-index.ts` | Build-time ingest pipeline that bakes the federal source files into `data/medical-codes.db`. |
| `data/medical-codes.db` | The bundled SQLite + FTS5 code index, opened read-only at runtime. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging; the code index is a read-only global, not tenant state
- Register new tools via the `createApp()` array in `src/index.ts`
- The bundled DB is the source of truth — surface real billable/validity flags from the source releases; never fabricate a code or a billability decision

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
