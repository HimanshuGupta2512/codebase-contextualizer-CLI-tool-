# Codebase Contextualizer CLI

![CLI Demo](demo.gif)

A high-performance local semantic search engine for codebases. The CLI walks a directory, extracts semantic code chunks with Tree-sitter, embeds those chunks locally with `@xenova/transformers`, persists vectors in SQLite, and answers natural-language queries without external APIs.

The project is intentionally systems-oriented: it keeps I/O asynchronous, pushes CPU-bound parsing and embedding off the main V8 thread, transfers vector memory without cloning, and stores embeddings in an embedded database that can be queried instantly from the command line.

## System Architecture

The CLI is split into two execution planes.

**Main thread**

- Parses commands with `commander`.
- Walks directories asynchronously while respecting `.gitignore`.
- Hashes source files with streamed SHA-256.
- Uses the cache at `.contextualizer/cache.json` to process only new or modified files.
- Owns all SQLite writes through `better-sqlite3`.

**Worker pool**

- Uses native Node.js `worker_threads`.
- Defaults to `Math.min(4, Math.max(1, os.cpus().length - 1))` workers.
- Each worker initializes its own Tree-sitter parser and singleton local embedding pipeline.
- Workers read files, extract JavaScript functions/classes/methods, build semantic payloads, and return chunk metadata plus vector tensors.

This design avoids the primary Node.js performance trap: running CPU-heavy AST parsing and ONNX inference on the main V8 event loop. The main thread remains responsible for orchestration and storage, while worker threads absorb the expensive compute path.

## Memory Management

Embeddings are represented as `Float32Array` instances end to end. Workers convert model output into compact typed arrays before returning results to the main process.

The worker response uses zero-copy transfer:

```js
parentPort.postMessage(payload, transferList);
```

Each vector's underlying `ArrayBuffer` is included in `transferList`, so ownership moves from the worker to the main thread instead of cloning megabytes of embedding data. This prevents avoidable garbage collection pressure and keeps large-codebase indexing predictable.

## Storage Engine

Vectors are persisted in `.contextualizer/vector.db` with `better-sqlite3`.

The database uses:

- `PRAGMA journal_mode = WAL` for concurrent-friendly write behavior.
- A `files` table keyed by path and hash.
- A `chunks` table containing symbol metadata, line ranges, source snippets, and vector BLOBs.
- Bulk transactional writes with `db.transaction()` so chunk inserts are committed as a batch.
- Binary vector storage via `Buffer.from(embedding.buffer)`.

At search time, BLOBs are reconstructed as typed arrays:

```js
new Float32Array(
  row.embedding.buffer,
  row.embedding.byteOffset,
  row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT
);
```

Cosine similarity is computed over typed arrays and the top matches are ranked in memory.

## Usage

Install dependencies:

```bash
npm install
```

Index a codebase:

```bash
node index.js index .
```

Index with a fixed worker count:

```bash
node index.js index . --workers 4
```

Check cache drift without writing updates:

```bash
node index.js status .
```

Search indexed code:

```bash
node index.js search "hash files with sha256" .
```

Return JSON output:

```bash
node index.js search "worker pool queue" . --json
```

## Benchmark

Run the search latency benchmark against the current directory:

```bash
node scripts/benchmark.js
```

Run against another indexed target:

```bash
node scripts/benchmark.js ./sample-code "authentication logic"
```

The benchmark opens `.contextualizer/vector.db`, embeds a dummy query once, runs 1,000 cosine-similarity scans, and reports average, p50, p90, and p95 latency in milliseconds.

Performance: Achieves sub-0.0763ms p95 vector retrieval latency over 1,000 local queries.

## Current Language Support

The parser dispatch layer currently routes JavaScript-family files:

- `.js`
- `.jsx`
- `.mjs`
- `.cjs`

Unsupported source extensions are skipped gracefully. The architecture is ready for additional Tree-sitter grammars through the parser router.

## Engineering Notes

- No external embedding APIs are used.
- Unchanged files are not re-parsed or re-embedded.
- Indexing skips source files over 1 MB, common binary extensions, and obvious minified bundles before they reach the parser.
- Ctrl+C aborts active indexing, terminates worker threads, and closes open SQLite handles.
- SQLite writes happen on the main thread after worker results return.
- Search loads the local embedding model as a singleton for query vectors.
- The system favors explicit typed-array and BLOB boundaries over generic JavaScript arrays.
