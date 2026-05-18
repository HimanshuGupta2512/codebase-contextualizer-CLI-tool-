const fs = require("fs/promises");
const path = require("path");
const { createAbortError, throwIfAborted } = require("./abort");
const { loadCache, saveCache } = require("./cache");
const { mapLimit } = require("./concurrency");
const { databaseExists, writeEmbeddingResults } = require("./database");
const { hashFile } = require("./file-hash");
const { WorkerPool, getDefaultWorkerCount } = require("./worker-pool");
const { walkSourceFiles } = require("./walker");

async function resolveTargetRoot(target) {
  const root = path.resolve(target);
  const stat = await fs.stat(root);

  if (!stat.isDirectory()) {
    throw new Error(`Target is not a directory: ${root}`);
  }

  return root;
}

function createCounts(changes) {
  return {
    scanned: changes.new.length + changes.modified.length + changes.unchanged.length,
    new: changes.new.length,
    modified: changes.modified.length,
    unchanged: changes.unchanged.length,
    removed: changes.removed.length,
  };
}

async function collectState(target, options = {}) {
  throwIfAborted(options.signal);

  const root = await resolveTargetRoot(target);
  throwIfAborted(options.signal);

  const cacheState = await loadCache(root);
  throwIfAborted(options.signal);

  const walkResult = await walkSourceFiles(root, {
    signal: options.signal,
  });
  throwIfAborted(options.signal);

  const hashConcurrency = options.hashConcurrency || 16;
  const hashResults = await mapLimit(walkResult.files, hashConcurrency, async (file) => {
    throwIfAborted(options.signal);

    try {
      const hash = await hashFile(file.absolutePath);
      throwIfAborted(options.signal);

      return {
        file: {
          ...file,
          hash,
        },
      };
    } catch (error) {
      if (options.signal && options.signal.aborted) {
        throw createAbortError(options.signal);
      }

      return {
        error: {
          path: file.absolutePath,
          message: error.message,
        },
      };
    }
  });
  const hashedFiles = hashResults.filter((result) => result.file).map((result) => result.file);
  const errors = [
    ...walkResult.errors,
    ...hashResults.filter((result) => result.error).map((result) => result.error),
  ];

  const currentFiles = {};
  const filesByRelativePath = {};
  const changes = {
    new: [],
    modified: [],
    unchanged: [],
    removed: [],
  };

  for (const file of hashedFiles) {
    const previous = cacheState.cache.files[file.relativePath];
    const status = !previous
      ? "new"
      : previous.hash === file.hash
        ? "unchanged"
        : "modified";

    currentFiles[file.relativePath] = {
      hash: file.hash,
      size: file.size,
      mtimeMs: file.mtimeMs,
      indexedAt: previous && status === "unchanged" ? previous.indexedAt || null : null,
    };
    filesByRelativePath[file.relativePath] = file;
    changes[status].push(file.relativePath);
  }

  for (const cachedPath of Object.keys(cacheState.cache.files)) {
    if (!currentFiles[cachedPath]) {
      changes.removed.push(cachedPath);
    }
  }

  for (const key of Object.keys(changes)) {
    changes[key].sort();
  }

  return {
    root,
    cachePath: cacheState.cachePath,
    cacheExists: cacheState.exists,
    previousCache: cacheState.cache,
    currentFiles,
    filesByRelativePath,
    changes,
    counts: createCounts(changes),
    errors,
  };
}

function createEmbeddingSummary(results) {
  const succeeded = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const skipped = succeeded.filter((result) => result.skipped);
  const embedded = succeeded.filter((result) => !result.skipped);
  const chunkCount = embedded.reduce((total, result) => total + result.chunks.length, 0);

  return {
    files: results,
    counts: {
      queued: results.length,
      succeeded: succeeded.length,
      failed: failed.length,
      skipped: skipped.length,
      chunks: chunkCount,
    },
  };
}

async function embedFiles(result, pathsToEmbed, options = {}) {
  const relativePaths = [...new Set(pathsToEmbed)].sort();

  if (relativePaths.length === 0) {
    return createEmbeddingSummary([]);
  }

  const workerCount = options.workerCount || getDefaultWorkerCount();
  const pool = new WorkerPool({
    size: workerCount,
  });
  let removeAbortListener = null;

  if (options.signal) {
    const onAbort = () => {
      void pool.close();
    };

    if (options.signal.aborted) {
      await pool.close();
      throw createAbortError(options.signal);
    }

    options.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => options.signal.removeEventListener("abort", onAbort);
  }

  try {
    const embeddingResults = await Promise.all(relativePaths.map(async (relativePath) => {
      throwIfAborted(options.signal);

      const file = result.filesByRelativePath[relativePath];

      if (!file) {
        return null;
      }

      try {
        const workerResult = await pool.run({
          filePath: file.absolutePath,
          relativePath,
        });
        throwIfAborted(options.signal);

        return {
          ok: true,
          ...workerResult,
        };
      } catch (error) {
        if (options.signal && options.signal.aborted) {
          throw createAbortError(options.signal);
        }

        return {
          ok: false,
          filePath: file.absolutePath,
          relativePath,
          error: error.message,
          chunks: [],
        };
      }
    }));

    return createEmbeddingSummary(embeddingResults.filter(Boolean));
  } finally {
    if (removeAbortListener) {
      removeAbortListener();
    }

    await pool.close();
  }
}

async function indexTarget(target, options = {}) {
  const result = await collectState(target, options);
  throwIfAborted(options.signal);

  const shouldBackfillDatabase = !databaseExists(result.root);
  const pathsToEmbed = shouldBackfillDatabase
    ? Object.keys(result.filesByRelativePath)
    : [...result.changes.new, ...result.changes.modified];
  const embeddingSummary = await embedFiles(result, pathsToEmbed, options);
  throwIfAborted(options.signal);

  const databaseSummary = writeEmbeddingResults(
    result.root,
    result.filesByRelativePath,
    embeddingSummary,
    result.changes.removed,
  );
  throwIfAborted(options.signal);

  const indexedAt = new Date().toISOString();
  const failedPaths = new Set(
    embeddingSummary.files
      .filter((fileResult) => !fileResult.ok)
      .map((fileResult) => fileResult.relativePath),
  );

  for (const filePath of [...result.changes.new, ...result.changes.modified]) {
    if (failedPaths.has(filePath)) {
      continue;
    }

    result.currentFiles[filePath].indexedAt = indexedAt;
  }

  for (const filePath of result.changes.unchanged) {
    const previous = result.previousCache.files[filePath];
    result.currentFiles[filePath].indexedAt = previous.indexedAt || indexedAt;
  }

  const filesToSave = {
    ...result.currentFiles,
  };

  for (const filePath of failedPaths) {
    const previous = result.previousCache.files[filePath];

    if (previous) {
      filesToSave[filePath] = previous;
    } else {
      delete filesToSave[filePath];
    }
  }

  await saveCache(result.root, filesToSave);

  result.embeddings = embeddingSummary;
  result.database = databaseSummary;

  return result;
}

async function statusTarget(target, options = {}) {
  return collectState(target, options);
}

module.exports = {
  getDefaultWorkerCount,
  indexTarget,
  statusTarget,
};
