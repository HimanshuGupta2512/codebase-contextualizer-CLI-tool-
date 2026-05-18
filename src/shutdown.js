const cleanupTasks = new Set();

let cleanupPromise = null;

function registerCleanup(cleanup) {
  cleanupTasks.add(cleanup);

  return () => {
    cleanupTasks.delete(cleanup);
  };
}

async function runCleanup() {
  if (cleanupPromise) {
    return cleanupPromise;
  }

  cleanupPromise = (async () => {
    const tasks = Array.from(cleanupTasks).reverse();
    cleanupTasks.clear();
    await Promise.allSettled(tasks.map((cleanup) => cleanup()));
  })();

  try {
    return await cleanupPromise;
  } finally {
    cleanupPromise = null;
  }
}

module.exports = {
  registerCleanup,
  runCleanup,
};
