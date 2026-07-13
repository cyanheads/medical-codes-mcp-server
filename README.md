<div align="center">
  <h1>@cyanheads/medical-codes-mcp-server</h1>
  <p><b>Decode, search, validate, and crosswalk US medical codes — ICD-10-CM, ICD-10-PCS, HCPCS Level II, RxNorm — over a bundled offline index via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/medical-codes-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/medical-codes-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/medical-codes-mcp-server/releases/latest/download/medical-codes-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=medical-codes-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvbWVkaWNhbC1jb2Rlcy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22medical-codes-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads/medical-codes-mcp-server%22%5D%7D)

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

## How it works

The code data is **bundled inside the package** — a single SQLite + FTS5 database (`data/medical-codes.db`) built at package-build time from the canonical federal source files and shipped in the npm tarball and Docker image. The server opens it **read-only** at startup and answers every tool call from disk.

That means the server is **offline, keyless, and deterministic**: no runtime network calls, no API key, no rate limit, single-tenant. The same inputs against the same bundled build always return the same output.

### Bundled code systems

Only freely-redistributable, public-domain US federal code sets are bundled:

| System | Source | Covers |
|:---|:---|:---|
| **ICD-10-CM** | [CDC/NCHS](https://www.cdc.gov/nchs/icd/icd-10-cm/index.html) — US federal, public domain | Diagnoses (billable leaf codes + non-billable category headers) |
| **ICD-10-PCS** | [CMS](https://www.cms.gov/medicare/coding-billing/icd-10-codes) — US federal, public domain | Inpatient procedures (axis-based 7-character codes) |
| **HCPCS Level II** | [CMS](https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system) — US federal, public domain | Supplies, drugs, and non-physician services |
| **RxNorm** | [NLM RxNav](https://rxnav.nlm.nih.gov/) — public domain | Drugs: name ↔ RXCUI, NDC ↔ RXCUI crosswalk, ingredients, and brands |

**RxNorm** bundles the current RxNorm **normalized** drug vocabulary — ingredients, brand names, clinical & branded drugs, and packs, with their NDC and ingredient/brand crosswalks. It is sourced at build time from the keyless [RxNav REST API](https://rxnav.nlm.nih.gov/), which serves the public-domain normalized layer — never the UMLS-licensed source vocabularies, so it stays freely redistributable in an offline package. (The full UMLS RxNorm release, which pulls in those licensed sources, is intentionally excluded.) This powers `medcode_map_codes`' drug directions and direct NDC → drug decode in `medcode_get_code`.

CPT (AMA copyright) and SNOMED CT / LOINC (UMLS-license-gated) are intentionally absent — they are not freely redistributable, so they cannot ship in an offline package.

**US scope.** ICD-10-CM and ICD-10-PCS are the US clinical modifications, not the WHO ICD-10/ICD-11 base or another country's national modification.

## Tools

Six tools organized goal-first — one per user action, with a `system` discriminator instead of a per-system tool for each of the bundled code sets. All are read-only.

| Tool | Description |
|:---|:---|
| `medcode_get_code` | Decode 1–50 codes to their official descriptions. Auto-detects the system per code; partial-success `found` / `notFound`. |
| `medcode_search_codes` | Full-text search over official descriptions — go from a clinical description to the code. |
| `medcode_check_code` | Validate a code's existence, currency, and billability, with a `whyNot` for non-billable/terminated cases. |
| `medcode_map_codes` | Crosswalk a code within its hierarchy (`parents`/`children`) or a drug across RxNorm (name ↔ RXCUI, NDC ↔ RXCUI, RXCUI → ingredients/brands). |
| `medcode_browse_hierarchy` | Walk a system's hierarchy for discovery without a search term. |
| `medcode_list_systems` | List bundled systems with release identifiers, effective dates, and code counts (provenance). |

### `medcode_get_code`

Decode one or more codes seen in a claim, EHR field, or another health server's output. The 80% entry point.

- Accepts 1–50 codes; mixed systems are fine — each code's system is detected independently from its shape
- Decodes a **National Drug Code (NDC)** directly to its RxNorm product — hyphenated (`0777-3105-02`) or 10/11-digit — offline via the bundled NDC↔RxNorm map, tagged `source: "NDC"`
- Partial success: resolved codes in `found`, unresolved in `notFound` with a per-code reason, so one bad code never fails the batch
- An explicit `system` overrides auto-detection when a value is genuinely ambiguous (an ambiguous code lists its `candidateSystems`)
- `includeHierarchy` attaches each code's parent and immediate children
- The resolved `system` is echoed on every result for chaining into `medcode_map_codes` or a billability check

---

### `medcode_search_codes`

Find codes whose official descriptions match a described concept — the reverse of `medcode_get_code`.

- Every search term must appear (prefix-matched), so `"diabetic neuropathy"` returns codes mentioning both
- Filter by `system`, `billableOnly` (exclude headers/categories), and `chapter`
- Ranked by full-text relevance; results echo the resolved system per row
- Discloses truncation when the result hits the cap, and returns an explicit notice (with the parsed query) when nothing matched

---

### `medcode_check_code`

Validate whether a code is safe to submit, before a claim goes out.

- Discriminated status: `valid_billable`, `valid_not_billable`, `valid_header`, or `terminated`
- A `whyNot` string explains the non-billable and terminated cases (e.g. "valid ICD-10-CM category but not billable — submit a more specific child code")
- Validity vs. existence is split: a non-billable or terminated code is a **successful** result with a `whyNot`, not an error — only a code absent from every bundled system raises `unknown_code`

---

### `medcode_map_codes`

Crosswalk a code across systems and within a hierarchy.

- Hierarchy directions: `parents` and `children` walk a code's prefix hierarchy one level per call — immediate parent/children only (depth-1); call iteratively for the full path (ICD-10-CM / HCPCS; ICD-10-PCS codes have no prefix parent)
- Drug directions (RxNorm): `name_to_rxcui` (drug name → RXCUI), `ndc_to_rxcui` / `rxcui_to_ndc` (NDC ↔ RXCUI; NDCs accepted hyphenated or 10/11-digit), `rxcui_to_ingredients` / `rxcui_to_brands` (RXCUI → ingredient/brand RXCUIs)
- Every result carries `source` provenance (which system or edge answered) so a chained call uses the right identifier

---

### `medcode_browse_hierarchy`

Orient in an unfamiliar system or enumerate a category's specific codes, without a search term.

- With no `node`: top-level entries (ICD-10-CM categories, HCPCS range buckets, or ICD-10-PCS first-axis values)
- With a `node`: its immediate children
- ICD-10-CM and HCPCS use a prefix hierarchy (a shorter code is the parent of a longer one); ICD-10-PCS is axis-based — only the top-level Section axis is browsable; positions 2–7 are context-dependent on the preceding axis path and aren't enumerable from a flat partial code

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Typed per-tool error contracts — capable clients preview failure modes from `tools/list`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Domain-specific:

- Bundled SQLite + FTS5 index — offline, keyless, deterministic; no runtime network I/O, no rate limit
- Code-shape auto-detection routes a code to its system; an explicit `system` disambiguates collisions
- Real billable/validity signal from the source releases — the order-file billable flag drives `medcode_check_code`, not a heuristic

Agent-friendly output:

- Provenance on every response — the resolved `system` is echoed for chaining, and `medcode_list_systems` reports exactly which release is baked into the running build
- Graceful partial failure — `medcode_get_code` returns per-code `found` / `notFound` rows instead of failing the batch
- Discriminated output contracts — `medcode_check_code`'s typed status and `medcode_map_codes`' `source` let callers branch on data, not string parsing

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

### Self-hosted

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

- [Bun v1.3](https://bun.sh/) or higher (or Node.js v24+ — the server falls back to the `better-sqlite3` optional dependency when not run under Bun).
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
| `MEDCODE_MAX_RESULTS` | Cap on rows returned by `medcode_search_codes` / `medcode_browse_hierarchy`. | `50` (ceiling `200`) |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | Endpoint path where the MCP server is mounted. | `/mcp` |
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

The bundled `data/medical-codes.db` ships in the npm package and Docker image but, at >100 MB, is **not committed to git** — fetch it from the [GitHub Release assets](https://github.com/cyanheads/medical-codes-mcp-server/releases) or rebuild it locally with the build script. You only rebuild when refreshing to a new federal release. The script never downloads: extract the canonical `.gov` source files (ICD-10-CM/PCS order files, HCPCS `ANWEB.txt` — URLs in the script header) into a directory, then point the script at it:

```sh
bun run scripts/build-index.ts --from-dir <dir-with-source-files> --fy 2026
```

It parses the source files and emits the single `.db` file. It runs at build time only — the server never downloads anything.

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

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
