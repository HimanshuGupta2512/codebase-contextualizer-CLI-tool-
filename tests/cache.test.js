const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { loadCache, saveCache } = require('../src/cache');

let passed = 0;
let failed = 0;

function assert(description, condition) {
  if (condition) {
    console.log(`  PASS: ${description}`);
    passed++;
  } else {
    console.error(`  FAIL: ${description}`);
    failed++;
  }
}

async function run() {
  console.log('cache tests:');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cachetest-'));

  const result1 = await loadCache(tmpDir);
  assert('loadCache returns exists: false for new dir',
    result1.exists === false);
  assert('loadCache returns empty files object',
    Object.keys(result1.cache.files).length === 0);
  assert('loadCache returns version 1',
    result1.cache.version === 1);

  const files = {
    'src/index.js': { hash: 'abc123', size: 500, mtimeMs: 1000, indexedAt: null },
    'src/utils.js': { hash: 'def456', size: 200, mtimeMs: 2000, indexedAt: null },
  };
  await saveCache(tmpDir, files);
  const result2 = await loadCache(tmpDir);
  assert('loadCache returns exists: true after save',
    result2.exists === true);
  assert('round-trip preserves file count',
    Object.keys(result2.cache.files).length === 2);
  assert('round-trip preserves hash',
    result2.cache.files['src/index.js'].hash === 'abc123');

  const sortedKeys = Object.keys(result2.cache.files);
  assert('keys are sorted alphabetically',
    sortedKeys[0] === 'src/index.js');

  await fs.rm(tmpDir, { recursive: true });

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
