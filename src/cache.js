const fs = require("fs/promises");
const path = require("path");

const CACHE_DIR = ".contextualizer";
const CACHE_FILE = "cache.json";
const CACHE_VERSION = 1;

function getCachePath(root) {
  return path.join(root, CACHE_DIR, CACHE_FILE);
}

function createEmptyCache(root) {
  return {
    version: CACHE_VERSION,
    root,
    updatedAt: null,
    files: {},
  };
}

function normalizeCache(cache, root) {
  if (!cache || typeof cache !== "object") {
    return createEmptyCache(root);
  }

  return {
    version: cache.version || CACHE_VERSION,
    root: cache.root || root,
    updatedAt: cache.updatedAt || null,
    files: cache.files && typeof cache.files === "object" ? cache.files : {},
  };
}

function sortObjectByKey(value) {
  return Object.keys(value)
    .sort()
    .reduce((sorted, key) => {
      sorted[key] = value[key];
      return sorted;
    }, {});
}

async function loadCache(root) {
  const cachePath = getCachePath(root);

  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);

    return {
      cache: normalizeCache(parsed, root),
      exists: true,
      cachePath,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        cache: createEmptyCache(root),
        exists: false,
        cachePath,
      };
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Cache file is not valid JSON: ${cachePath}`);
    }

    throw error;
  }
}

async function saveCache(root, files) {
  const cachePath = getCachePath(root);
  const cacheDir = path.dirname(cachePath);
  const cache = {
    version: CACHE_VERSION,
    root,
    updatedAt: new Date().toISOString(),
    files: sortObjectByKey(files),
  };
  const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(tmpPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, cachePath);

  return {
    cache,
    cachePath,
  };
}

module.exports = {
  CACHE_DIR,
  CACHE_FILE,
  CACHE_VERSION,
  getCachePath,
  loadCache,
  saveCache,
};
