# Codebase Contextualizer

A command-line tool for semantic search over local codebases. It parses source files into AST-level chunks, generates vector embeddings using a locally-run ONNX model, stores them in SQLite, and retrieves the most semantically relevant chunks for a given natural language query — entirely offline, with no external API dependencies.

---

## Performance

Benchmarked against the [Express.js](https://github.com/expressjs/express) repository (141 files, 229 chunks), running 1,000 search iterations:

| Metric | Result |
|--------|--------|
| Average latency | 0.21 ms |
| p50 | 0.20 ms |
| p90 | 0.27 ms |
| p95 | 0.27 ms |

---

## Project Structure

```text
.
├── index.js                  # CLI entry point (commander)
├── scripts/
│   └── benchmark.js          # Search latency benchmark (p50/p90/p95)
├── tests/
│   ├── cosine-similarity.test.js
│   ├── map-limit.test.js
│   └── cache.test.js
└── src/
    ├── indexer.js            # Pipeline orchestration
    ├── walker.js             # Directory traversal with .gitignore support
    ├── file-hash.js          # SHA-256 change detection
    ├── parser.js             # AST chunker (Tree-sitter for JS/JSX, regex for Python)
    ├── embeddings.js         # Shared ONNX embedding utilities
    ├── worker.js             # Worker thread: parse → embed → transfer
    ├── worker-pool.js        # Custom worker_threads pool with crash recovery
    ├── database.js           # SQLite vector storage
    ├── search.js             # Query embedding + cosine similarity ranking
    ├── cache.js              # Incremental index state (skip unchanged files)
    ├── concurrency.js        # Custom async mapLimit
    ├── file-filter.js        # Binary/minified file exclusion
    ├── paths.js              # Cross-platform path normalization
    ├── abort.js              # AbortError utilities
    └── shutdown.js           # Global cleanup registry
```

---

## Design Notes

**Worker thread pool**
The embedding pipeline runs entirely off the main thread. A custom `worker_threads` pool (not a library) manages worker lifecycle: tasks queue when all workers are busy, crashed workers auto-respawn, and the pool drains cleanly on SIGINT/SIGTERM.

**Zero-copy tensor transfer**
Each worker passes its embedding result back to the main thread via `postMessage(payload, transferList)`, transferring ownership of the underlying `ArrayBuffer` rather than cloning it. This avoids redundant memory allocation across the thread boundary for 384-dimensional float vectors.

**Incremental indexing**
Files are SHA-256 hashed on each run. Only new or modified files enter the parse-embed-store pipeline; unchanged files are skipped. The hash state is persisted to `.contextualizer/cache.json` via atomic tmp-file rename to prevent corruption on interrupted runs.

**End-to-end abort propagation**
`AbortController` is threaded through the walker, the hash concurrency layer, the worker pool, and the SQLite write path. A SIGINT at any point in the pipeline triggers a coordinated teardown — no leaked file handles or orphaned threads.

**Multi-language parsing**
JavaScript and JSX files are parsed via Tree-sitter AST grammars. Python files use an indentation-aware regex chunker that extracts function and class definition blocks without native binary dependencies, keeping the tool portable across environments.

**Local inference**
Embeddings are produced by Xenova/all-MiniLM-L6-v2 via @xenova/transformers (ONNX Runtime). The model runs fully on-device — no network calls are made after the initial model download.

---

## Installation

```bash
git clone https://github.com/HimanshuGupta2512/codebase-contextualizer-CLI-tool-
cd codebase-contextualizer-CLI-tool-
npm install
```

---

## Usage

```bash
# Index a codebase
node index.js index <path>

# Search with a natural language query
node index.js search <path> "<query>" [--top <n>]

# Check index status
node index.js status <path>

# Run search latency benchmark
node scripts/benchmark.js <path> "<query>"

# Run unit tests
npm test
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js, worker_threads |
| Parsing | Tree-sitter (JS/JSX), regex chunker (Python) |
| Embeddings | @xenova/transformers, Xenova/all-MiniLM-L6-v2 |
| Storage | SQLite (better-sqlite3) |
| Search | Cosine similarity over Float32Array vectors |
| CLI | Commander.js |
