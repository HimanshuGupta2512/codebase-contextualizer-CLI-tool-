const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const { registerCleanup } = require("./shutdown");

const MAX_WORKER_COUNT = 4;

function normalizeWorkerCount(count) {
  return Math.min(MAX_WORKER_COUNT, Math.max(1, count));
}

function getDefaultWorkerCount() {
  return normalizeWorkerCount(os.cpus().length - 1);
}

class WorkerPool {
  constructor(options = {}) {
    this.workerPath = options.workerPath || path.join(__dirname, "worker.js");
    this.size = normalizeWorkerCount(options.size || getDefaultWorkerCount());
    this.queue = [];
    this.workers = new Set();
    this.closed = false;
    this.closePromise = null;
    this.unregisterCleanup = registerCleanup(() => this.close());

    for (let index = 0; index < this.size; index += 1) {
      this.spawnWorker();
    }
  }

  run(task) {
    if (this.closed) {
      return Promise.reject(new Error("Worker pool is closed"));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({
        task,
        resolve,
        reject,
      });
      this.dispatch();
    });
  }

  async close() {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closed = true;

    this.closePromise = (async () => {
      if (this.unregisterCleanup) {
        this.unregisterCleanup();
        this.unregisterCleanup = null;
      }

      for (const queuedTask of this.queue.splice(0)) {
        queuedTask.reject(new Error("Worker pool closed before task started"));
      }

      await Promise.allSettled(
        Array.from(this.workers, (record) => record.worker.terminate()),
      );

      for (const record of this.workers) {
        if (record.currentTask) {
          record.currentTask.reject(new Error("Worker pool closed before task completed"));
          record.currentTask = null;
        }
      }

      this.workers.clear();
    })();

    return this.closePromise;
  }

  spawnWorker() {
    if (this.closed) {
      return null;
    }

    const worker = new Worker(this.workerPath);
    const record = {
      worker,
      idle: true,
      currentTask: null,
      replaced: false,
    };

    this.workers.add(record);

    worker.on("message", (message) => {
      this.finishTask(record, null, message);
    });

    worker.on("error", (error) => {
      this.failWorker(record, error);
    });

    worker.on("exit", (code) => {
      this.workers.delete(record);

      if (record.currentTask) {
        record.currentTask.reject(new Error(`Worker exited before completing task with code ${code}`));
        record.currentTask = null;
      }

      if (!this.closed && code !== 0 && !record.replaced) {
        this.spawnWorker();
        this.dispatch();
      }
    });

    return record;
  }

  failWorker(record, error) {
    this.workers.delete(record);
    record.idle = false;
    record.replaced = true;

    if (record.currentTask) {
      record.currentTask.reject(error);
      record.currentTask = null;
    }

    if (!this.closed) {
      this.spawnWorker();
      this.dispatch();
    }
  }

  finishTask(record, error, message) {
    if (!record.currentTask) {
      return;
    }

    const completedTask = record.currentTask;
    record.currentTask = null;
    record.idle = true;

    if (error) {
      completedTask.reject(error);
    } else if (message && message.ok === false) {
      completedTask.reject(new Error(message.error || "Worker task failed"));
    } else {
      completedTask.resolve(message.result);
    }

    this.dispatch();
  }

  dispatch() {
    if (this.closed || this.queue.length === 0) {
      return;
    }

    for (const record of this.workers) {
      if (!record.idle || this.queue.length === 0) {
        continue;
      }

      const queuedTask = this.queue.shift();
      record.idle = false;
      record.currentTask = queuedTask;
      record.worker.postMessage(queuedTask.task);
    }
  }
}

module.exports = {
  MAX_WORKER_COUNT,
  WorkerPool,
  getDefaultWorkerCount,
};
