#!/usr/bin/env node

const path = require("path");
const { performance } = require("perf_hooks");
const Database = require("better-sqlite3");
const { pipeline } = require("@xenova/transformers");

const ITERATIONS = 1000;
const DEFAULT_QUERY = "authentication logic";
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

function loadChunks(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });

  try {
    return db.prepare(`
      SELECT
        chunks.id,
        files.path AS file,
        chunks.name,
        chunks.startLine,
        chunks.endLine,
        chunks.embedding
      FROM chunks
      INNER JOIN files ON files.id = chunks.file_id
    `).all().map((row) => ({
      ...row,
      embedding: blobToFloat32Array(row.embedding),
    }));
  } finally {
    db.close();
  }
}

function searchChunks(queryEmbedding, chunks) {
  let best = null;

  for (const chunk of chunks) {
    const score = cosineSimilarity(queryEmbedding, chunk.embedding);

    if (!best || score > best.score) {
      best = {
        chunk,
        score,
      };
    }
  }

  return best;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))];
}

function summarizeLatencies(latencies) {
  const sorted = [...latencies].sort((left, right) => left - right);
  const total = latencies.reduce((sum, value) => sum + value, 0);

  return {
    average: total / latencies.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
  };
}

async function main() {
  const target = path.resolve(process.argv[2] || ".");
  const query = process.argv[3] || DEFAULT_QUERY;
  const databasePath = path.join(target, ".contextualizer", "vector.db");
  const chunks = loadChunks(databasePath);

  if (chunks.length === 0) {
    throw new Error(`No chunks found in ${databasePath}. Run "node index.js index ${target}" first.`);
  }

  console.log(`Database: ${databasePath}`);
  console.log(`Chunks: ${chunks.length}`);
  console.log(`Query: ${query}`);
  console.log(`Loading model: ${MODEL_ID}`);

  const queryEmbedding = await embedQuery(query);
  const latencies = [];

  // Warm the tight loop once so the reported run is less sensitive to first-call overhead.
  searchChunks(queryEmbedding, chunks);

  for (let index = 0; index < ITERATIONS; index += 1) {
    const start = performance.now();
    searchChunks(queryEmbedding, chunks);
    latencies.push(performance.now() - start);
  }

  const summary = summarizeLatencies(latencies);
  const best = searchChunks(queryEmbedding, chunks);

  console.log("");
  console.log(`Iterations: ${ITERATIONS}`);
  console.log(`Average: ${summary.average.toFixed(4)} ms`);
  console.log(`p50: ${summary.p50.toFixed(4)} ms`);
  console.log(`p90: ${summary.p90.toFixed(4)} ms`);
  console.log(`p95: ${summary.p95.toFixed(4)} ms`);

  if (best) {
    console.log("");
    console.log("Best match:");
    console.log(`  File: ${best.chunk.file}`);
    console.log(`  Line: ${best.chunk.startLine}-${best.chunk.endLine}`);
    console.log(`  Symbol: ${best.chunk.name}`);
    console.log(`  Score: ${best.score.toFixed(4)}`);
  }
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
