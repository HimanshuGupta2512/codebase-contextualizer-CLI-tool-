#!/usr/bin/env node

const { Command, InvalidArgumentError } = require("commander");
const { isAbortError } = require("./src/abort");
const { getDefaultWorkerCount, indexTarget, statusTarget } = require("./src/indexer");
const { searchTarget } = require("./src/search");
const { runCleanup } = require("./src/shutdown");

const DEFAULT_HASH_CONCURRENCY = 16;
const shutdownController = new AbortController();
let shutdownStarted = false;

async function shutdown(signalName) {
  if (shutdownStarted) {
    process.exit(signalName === "SIGTERM" ? 143 : 130);
  }

  shutdownStarted = true;
  const error = new Error(`Interrupted by ${signalName}`);
  error.name = "AbortError";
  shutdownController.abort(error);

  console.error("");
  console.error("Interrupted. Cleaning up workers and database handles...");
  await runCleanup();
  process.exit(signalName === "SIGTERM" ? 143 : 130);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("must be a positive integer");
  }

  return parsed;
}

function summarize(result, saved) {
  return {
    root: result.root,
    cachePath: result.cachePath,
    cacheExists: result.cacheExists,
    saved,
    counts: result.counts,
    changes: result.changes,
    database: result.database,
    embeddings: result.embeddings
      ? {
          counts: result.embeddings.counts,
          files: result.embeddings.files.map((file) => ({
            relativePath: file.relativePath,
            ok: file.ok,
            skipped: Boolean(file.skipped),
            reason: file.reason,
            error: file.error,
            chunkCount: file.chunks.length,
          })),
        }
      : undefined,
    errors: result.errors,
  };
}

function printChangedFiles(label, files) {
  if (files.length === 0) {
    return;
  }

  console.log(`${label}:`);
  for (const file of files.slice(0, 20)) {
    console.log(`  ${file}`);
  }

  if (files.length > 20) {
    console.log(`  ...and ${files.length - 20} more`);
  }
}

function printResult(result, mode, json) {
  const saved = mode === "index";

  if (json) {
    console.log(JSON.stringify(summarize(result, saved), null, 2));
    return;
  }

  console.log(`${mode === "index" ? "Index complete" : "Status"}: ${result.root}`);
  console.log(`Cache: ${result.cachePath}${result.cacheExists ? "" : " (new)"}`);
  console.log(`Scanned files: ${result.counts.scanned}`);
  console.log(`New: ${result.counts.new}`);
  console.log(`Modified: ${result.counts.modified}`);
  console.log(`Unchanged: ${result.counts.unchanged}`);
  console.log(`Removed: ${result.counts.removed}`);

  printChangedFiles("New files", result.changes.new);
  printChangedFiles("Modified files", result.changes.modified);
  printChangedFiles("Removed files", result.changes.removed);

  if (result.embeddings) {
    console.log(`Embedded chunks: ${result.embeddings.counts.chunks}`);
    console.log(`Vector database: ${result.database.databasePath}`);
    console.log(`Persisted chunks: ${result.database.chunksWritten}`);

    for (const file of result.embeddings.files) {
      if (!file.ok) {
        console.log(`Failed to embed ${file.relativePath}: ${file.error}`);
      } else if (file.skipped) {
        console.log(`Skipped ${file.relativePath}: ${file.reason}`);
      } else {
        console.log(`Successfully embedded ${file.chunks.length} chunks from ${file.relativePath}`);
      }
    }
  }

  if (result.errors.length > 0) {
    console.log("Traversal warnings:");
    for (const error of result.errors.slice(0, 10)) {
      console.log(`  ${error.path}: ${error.message}`);
    }

    if (result.errors.length > 10) {
      console.log(`  ...and ${result.errors.length - 10} more`);
    }
  }
}

function trimSnippet(code, maxLines = 16) {
  const lines = code.trim().split(/\r?\n/);
  const clipped = lines.slice(0, maxLines);

  if (lines.length > maxLines) {
    clipped.push("...");
  }

  return clipped.join("\n");
}

function printSearchResults(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Search: ${result.query}`);
  console.log(`Target: ${result.root}`);
  console.log(`Database: ${result.databasePath}`);

  if (result.results.length === 0) {
    console.log("No indexed chunks found.");
    return;
  }

  for (const [index, match] of result.results.entries()) {
    const lineRange = match.startLine === match.endLine
      ? `${match.startLine}`
      : `${match.startLine}-${match.endLine}`;

    console.log("");
    console.log(`${index + 1}. ${match.name} (${match.type})`);
    console.log(`Score: ${match.score.toFixed(4)}`);
    console.log(`File: ${match.file}`);
    console.log(`Line: ${lineRange}`);
    console.log("Code:");
    console.log(trimSnippet(match.code));
  }
}

async function runIndex(target, options) {
  const result = await indexTarget(target, {
    hashConcurrency: options.concurrency,
    signal: shutdownController.signal,
    workerCount: options.workers,
  });

  printResult(result, "index", options.json);
}

async function runStatus(target, options) {
  const result = await statusTarget(target, {
    hashConcurrency: options.concurrency,
    signal: shutdownController.signal,
  });

  printResult(result, "status", options.json);
}

async function runSearch(query, target, options) {
  const result = await searchTarget(target || ".", query, {
    limit: options.limit,
    signal: shutdownController.signal,
  });

  printSearchResults(result, options.json);
}

const program = new Command();

program
  .name("codebase-contextualizer")
  .description("Index local codebases for offline semantic search.")
  .version("0.1.0");

program
  .command("index")
  .description("Walk a target directory, hash source files, and update the local cache.")
  .argument("<target>", "directory to index")
  .option("-c, --concurrency <number>", "concurrent file hash operations", parsePositiveInteger, DEFAULT_HASH_CONCURRENCY)
  .option("-w, --workers <number>", "worker thread count for parsing and embedding, capped at 4", parsePositiveInteger, getDefaultWorkerCount())
  .option("--json", "print machine-readable output")
  .action(runIndex);

program
  .command("status")
  .description("Show cache drift without writing cache updates.")
  .argument("<target>", "directory to inspect")
  .option("-c, --concurrency <number>", "concurrent file hash operations", parsePositiveInteger, DEFAULT_HASH_CONCURRENCY)
  .option("--json", "print machine-readable output")
  .action(runStatus);

program
  .command("search")
  .description("Search indexed chunks with a local semantic query.")
  .argument("<query>", "natural language query")
  .argument("[target]", "indexed target directory", ".")
  .option("-n, --limit <number>", "maximum ranked results", parsePositiveInteger, 5)
  .option("--json", "print machine-readable output")
  .action(runSearch);

program.parseAsync(process.argv).catch(async (error) => {
  await runCleanup();

  if (isAbortError(error)) {
    process.exitCode = 130;
    return;
  }

  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
