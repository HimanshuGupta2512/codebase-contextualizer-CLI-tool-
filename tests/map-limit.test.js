const { mapLimit } = require('../src/concurrency');

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
  console.log('mapLimit tests:');

  const result = await mapLimit([1, 2, 3, 4], 2, async (x) => x * 2);
  assert('maps all items correctly',
    JSON.stringify(result) === JSON.stringify([2, 4, 6, 8]));

  let concurrent = 0;
  let maxConcurrent = 0;
  await mapLimit([1, 2, 3, 4, 5], 3, async (x) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(r => setTimeout(r, 10));
    concurrent--;
    return x;
  });
  assert('never exceeds concurrency limit of 3', maxConcurrent <= 3);

  const empty = await mapLimit([], 4, async (x) => x);
  assert('empty array returns empty array', empty.length === 0);

  const order = [];
  await mapLimit([1, 2, 3], 1, async (x) => {
    order.push(x);
    return x;
  });
  assert('limit of 1 processes items in order',
    JSON.stringify(order) === JSON.stringify([1, 2, 3]));

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
