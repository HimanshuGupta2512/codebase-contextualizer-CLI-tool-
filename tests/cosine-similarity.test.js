const { cosineSimilarity } = require('../src/search');

function makeVec(values) {
  return new Float32Array(values);
}

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

function assertNear(description, actual, expected, tolerance = 0.0001) {
  const ok = Math.abs(actual - expected) < tolerance;
  if (ok) {
    console.log(`  PASS: ${description} (got ${actual.toFixed(6)})`);
    passed++;
  } else {
    console.error(`  FAIL: ${description} (expected ~${expected}, got ${actual})`);
    failed++;
  }
}

console.log('cosineSimilarity tests:');

assertNear(
  'identical vectors return 1.0',
  cosineSimilarity(makeVec([1, 0, 0]), makeVec([1, 0, 0])),
  1.0
);

assertNear(
  'opposite vectors return -1.0',
  cosineSimilarity(makeVec([1, 0, 0]), makeVec([-1, 0, 0])),
  -1.0
);

assertNear(
  'orthogonal vectors return 0.0',
  cosineSimilarity(makeVec([1, 0, 0]), makeVec([0, 1, 0])),
  0.0
);

assertNear(
  'zero vector returns 0',
  cosineSimilarity(makeVec([0, 0, 0]), makeVec([1, 0, 0])),
  0.0
);

assert(
  'mismatched lengths return -Infinity',
  cosineSimilarity(makeVec([1, 0]), makeVec([1, 0, 0])) === Number.NEGATIVE_INFINITY
);

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
