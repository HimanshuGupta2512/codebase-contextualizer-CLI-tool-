function createAbortError(signal) {
  const reason = signal && signal.reason;

  if (reason instanceof Error) {
    return reason;
  }

  const error = new Error(reason ? String(reason) : "Operation aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    throw createAbortError(signal);
  }
}

function isAbortError(error) {
  return Boolean(error && (error.name === "AbortError" || /aborted|interrupted/i.test(error.message || "")));
}

module.exports = {
  createAbortError,
  isAbortError,
  throwIfAborted,
};
