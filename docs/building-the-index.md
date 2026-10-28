# Building the bundled index

`data/medical-codes.db` is the single SQLite + FTS5 file the server opens read-only at startup. It ships in the npm package and Docker image but, at over 100 MB, is not committed to git.

## Getting a prebuilt copy

Take it from the npm package (`data/medical-codes.db`), or from the `medical-codes-mcp-server.mcpb` bundle attached to each [GitHub Release](https://github.com/cyanheads/medical-codes-mcp-server/releases), a zip archive holding the index at `data/medical-codes.db`. Rebuild only when refreshing to a new federal release.

## Rebuilding

The build script never downloads source files. Prepare one directory:

1. Extract the canonical `.gov` source files flat into it: the ICD-10-CM and ICD-10-PCS order files, and the HCPCS quarterly `ANWEB` file under its CMS name, which sets the HCPCS release label. The source URLs are in the header of `scripts/build-index.ts`.
2. Cache RxNorm and RxClass into it with the two fetchers. Point each at an empty directory: both resume an existing cache rather than refetch it.
3. Run the build against the directory.

```sh
bun run scripts/ingest/fetch-rxnav.ts --out <dir>/rxnav        # RxNorm, from the keyless RxNav API
bun run scripts/ingest/fetch-rxclass.ts --rxnav <dir>/rxnav --out <dir>/rxclass   # RxClass, after RxNorm
bun run scripts/build-index.ts --from-dir <dir> --fy 2027       # --fy labels the ICD-10-CM/PCS releases
```

The build parses the source files and caches and emits the single `.db` file. RxNorm is dated by the time its RxNav fetch completed and the RxClass sources by theirs, both recorded in the caches, so a rebuild from the same caches reports the same dates.

All of this happens at build time; the server never downloads anything. To run against a custom-built or externally mounted database, set `MEDCODE_DB_PATH` to its absolute path.
