'use strict';

const MAX_PARALLEL_FILES = 3;

// Use concurrency only after the receiving peer explicitly negotiates it.
function parallelFiles(capabilities) {
  const n = capabilities?.parallelFiles;
  return Number.isInteger(n) && n >= 1 && n <= MAX_PARALLEL_FILES ? n : 1;
}

async function runTransfers(items, limit, action, abort) {
  let next = 0, failure;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await action(item); }
      catch (error) {
        if (!failure) { failure = error; abort(); }
      }
    }
  };
  // Wait for all open files/sockets to settle before reporting the first failure.
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  if (failure) throw failure;
}

module.exports = {MAX_PARALLEL_FILES, parallelFiles, runTransfers};
