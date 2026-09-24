/**
 * @fileoverview What `.mcpbignore` keeps out of the `.mcpb` bundle. `mcpb pack`
 * archives the whole project directory minus these patterns (it does not read
 * `.gitignore`), so a build-input or test directory the file does not name ships
 * to every Claude Desktop install. Evaluated with the `ignore` package, the same
 * gitignore-semantics matcher `lint:packaging` uses for its bundle-content guard.
 * @module tests/scripts/mcpbignore.test
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Matcher = { add(patterns: string[]): Matcher; ignores(path: string): boolean };

async function bundleMatcher(): Promise<Matcher> {
  const mod: unknown = await import('ignore');
  const createIgnore = ((mod as { default?: unknown }).default ?? mod) as () => Matcher;
  const lines = readFileSync(join(ROOT, '.mcpbignore'), 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return createIgnore().add(lines);
}

describe('.mcpbignore', () => {
  it.each([
    'tests/fixtures/medical-codes.fixture.db',
    'tests/ingest/parsers.test.ts',
    '.sources/rxnav/products.jsonl',
    '.sources/rxclass/byrxcui.jsonl',
    'coverage/coverage-final.json',
    // Source, build scripts, docs, and repo metadata: the bundle runs dist/ alone.
    'src/index.ts',
    'scripts/build-index.ts',
    'docs/design.md',
    '.github/workflows/codeql.yml',
    '.vscode/settings.json',
    '.dockerignore',
    '.gitattributes',
    '.npmignore',
    'devcheck.config.json',
    'CITATION.cff',
  ])('keeps %s out of the bundle', async (path) => {
    expect((await bundleMatcher()).ignores(path)).toBe(true);
  });

  it.each([
    'data/medical-codes.db',
    'dist/index.js',
    'manifest.json',
    // Read at runtime: the framework takes the server's identity from package.json.
    'package.json',
    'server.json',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'node_modules/@cyanheads/mcp-ts-core/dist/index.js',
    'node_modules/some-pkg/tests/index.js',
    // Root-anchored: a dependency's own src/, scripts/, and docs/ still ship.
    'node_modules/some-pkg/src/index.js',
    'node_modules/some-pkg/scripts/postinstall.js',
    'node_modules/some-pkg/docs/index.js',
  ])('still ships %s', async (path) => {
    expect((await bundleMatcher()).ignores(path)).toBe(false);
  });
});
