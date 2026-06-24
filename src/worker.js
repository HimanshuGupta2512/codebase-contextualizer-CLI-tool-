const fs = require("fs/promises");
const { parentPort } = require("worker_threads");
const { getEmbedder, toFloat32Array } = require("./embeddings");
const { getContentSkipReason } = require("./file-filter");
const { getParser, parseSourceFile } = require("./parser");

async function embedChunk(embedder, chunk) {
  const output = await embedder(chunk.semanticText, {
    pooling: "mean",
    normalize: true,
  });

  return {
    ...chunk,
    embedding: toFloat32Array(output.data),
  };
}

async function processFile(task) {
  if (!getParser(task.filePath)) {
    return {
      filePath: task.filePath,
      relativePath: task.relativePath,
      skipped: true,
      reason: "Unsupported source extension",
      chunks: [],
    };
  }

  const code = await fs.readFile(task.filePath, "utf8");
  const contentSkipReason = getContentSkipReason(code);

  if (contentSkipReason) {
    return {
      filePath: task.filePath,
      relativePath: task.relativePath,
      skipped: true,
      reason: contentSkipReason,
      chunks: [],
    };
  }

  const parseResult = parseSourceFile({
    filePath: task.filePath,
    relativePath: task.relativePath,
    code,
  });
  const chunks = parseResult.chunks;

  if (chunks.length === 0) {
    return {
      filePath: task.filePath,
      relativePath: task.relativePath,
      skipped: false,
      chunks: [],
    };
  }

  const embedder = await getEmbedder();
  const embeddedChunks = [];

  for (const chunk of chunks) {
    embeddedChunks.push(await embedChunk(embedder, chunk));
  }

  return {
    filePath: task.filePath,
    relativePath: task.relativePath,
    skipped: false,
    chunks: embeddedChunks,
  };
}

parentPort.on("message", async (task) => {
  try {
    const result = await processFile(task);
    const transferList = [];

    for (const chunk of result.chunks) {
      transferList.push(chunk.embedding.buffer);
    }

    parentPort.postMessage(
      {
        ok: true,
        result,
      },
      transferList,
    );
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error.stack || error.message,
    });
  }
});
