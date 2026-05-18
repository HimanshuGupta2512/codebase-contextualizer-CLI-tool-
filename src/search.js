const path = require("path");
const { pipeline } = require("@xenova/transformers");
const { throwIfAborted } = require("./abort");
const { getDatabasePath, openDatabase } = require("./database");

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let embedderPromise;

function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", MODEL_ID);
  }

  return embedderPromise;
}

function toFloat32Array(value) {
  if (value instanceof Float32Array) {
    return new Float32Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return Float32Array.from(value);
  }

  if (Array.isArray(value)) {
    return Float32Array.from(value);
  }

  throw new Error("Embedding output could not be converted to Float32Array");
}

async function embedQuery(query) {
  const embedder = await getEmbedder();
  const output = await embedder(query, {
    pooling: "mean",
    normalize: true,
  });

  return toFloat32Array(output.data);
}

function blobToFloat32Array(blob) {
  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

function cosineSimilarity(left, right) {
  if (left.length !== right.length) {
    return Number.NEGATIVE_INFINITY;
  }

  let dot = 0;
  let magnitudeLeft = 0;
  let magnitudeRight = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    magnitudeLeft += left[index] * left[index];
    magnitudeRight += right[index] * right[index];
  }

  if (magnitudeLeft === 0 || magnitudeRight === 0) {
    return 0;
  }

  return dot / (Math.sqrt(magnitudeLeft) * Math.sqrt(magnitudeRight));
}

function loadChunks(db) {
  return db.prepare(`
    SELECT
      chunks.id,
      files.path AS file,
      chunks.name,
      chunks.type,
      chunks.startLine,
      chunks.endLine,
      chunks.code,
      chunks.embedding
    FROM chunks
    INNER JOIN files ON files.id = chunks.file_id
  `).all();
}

async function searchTarget(target, query, options = {}) {
  const root = path.resolve(target || ".");
  const limit = options.limit || 5;
  throwIfAborted(options.signal);

  const queryEmbedding = await embedQuery(query);
  throwIfAborted(options.signal);

  const db = openDatabase(root);

  try {
    const rows = loadChunks(db);
    throwIfAborted(options.signal);

    const results = rows
      .map((row) => ({
        id: row.id,
        file: row.file,
        name: row.name,
        type: row.type,
        startLine: row.startLine,
        endLine: row.endLine,
        code: row.code,
        score: cosineSimilarity(queryEmbedding, blobToFloat32Array(row.embedding)),
      }))
      .filter((result) => Number.isFinite(result.score))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    return {
      root,
      databasePath: getDatabasePath(root),
      query,
      results,
    };
  } finally {
    db.close();
  }
}

module.exports = {
  blobToFloat32Array,
  cosineSimilarity,
  searchTarget,
};
