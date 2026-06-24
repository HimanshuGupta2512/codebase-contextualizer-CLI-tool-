const { pipeline } = require('@xenova/transformers');

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

let embedderPromise;

function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', MODEL_ID);
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
  throw new Error('Embedding output could not be converted to Float32Array');
}

module.exports = { MODEL_ID, getEmbedder, toFloat32Array };
