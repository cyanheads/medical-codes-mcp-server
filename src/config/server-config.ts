/**
 * @fileoverview Server-specific configuration for medical-codes-mcp-server.
 * Lazy-parsed from environment variables. Framework config (transport, logging,
 * auth, storage) is owned by @cyanheads/mcp-ts-core and parsed separately.
 *
 * The server is offline and keyless — it reads a bundled SQLite + FTS5 database
 * built at package-build time. The only runtime knobs are the DB path override
 * and the result cap.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Treats an unset env var (`undefined`), a set-but-empty env var (`""`), and an
 * unsubstituted MCPB placeholder (`${user_config.X}`) identically as absent —
 * so an empty `MEDCODE_DB_PATH=` falls back to the bundled default rather than
 * resolving to an empty path.
 */
const PLACEHOLDER_PATTERN = /^\$\{[^}]+\}$/;
const emptyAsUndefined = (v: unknown) => {
  if (v === '') return;
  if (typeof v === 'string' && PLACEHOLDER_PATTERN.test(v)) return;
  return v;
};

const ServerConfigSchema = z.object({
  dbPath: z
    .preprocess(emptyAsUndefined, z.string().optional())
    .describe(
      'Absolute path override for the bundled SQLite database. Defaults to the packaged data/medical-codes.db resolved relative to the build output.',
    ),
  maxResults: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Cap on rows returned by search and browse tools (default 50, hard ceiling 200).'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Lazily parse and cache the server config. Maps schema paths to env var names
 * so a validation error names the variable (`MEDCODE_MAX_RESULTS`) not the path.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    dbPath: 'MEDCODE_DB_PATH',
    maxResults: 'MEDCODE_MAX_RESULTS',
  });
  return _config;
}
