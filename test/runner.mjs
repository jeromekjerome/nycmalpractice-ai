// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The unit-test runner: test(name, fn) registers a test, and run() runs them in order. Each test has a time limit, 30 seconds
// unless TEST_TIMEOUT_MS sets another; a test that has not settled by then fails. Every run ends with its summary line, and a
// run with a failure sets the exit code to 1 and rejects (test/runner.test.mjs).
const tests = [];

const DEFAULT_LIMIT_MS = 30_000;
// After a test that did not settle, how long the process may take to end on its own before it is ended: a test still running
// can hold a timer or a socket that would keep it alive.
const EXIT_GRACE_MS = 1_000;

class TimedOut extends Error {}

export function test(name, fn) {
  tests.push({ name, fn });
}

// TEST_TIMEOUT_MS when it is a positive number, else the default.
function limitMs() {
  const set = Number(process.env.TEST_TIMEOUT_MS);
  return Number.isFinite(set) && set > 0 ? set : DEFAULT_LIMIT_MS;
}

// Settles as the test does, or rejects with TimedOut when it has not settled within `ms`. The timer is cleared either way, so
// it never keeps the process alive after the test.
async function withinLimit(fn, ms) {
  let timer;
  const timeUp = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new TimedOut(`it did not settle within ${ms} ms`)), ms);
  });
  try {
    await Promise.race([(async () => fn())(), timeUp]);
  } finally {
    clearTimeout(timer);
  }
}

export async function run() {
  const ms = limitMs();
  let failures = 0;
  let timedOut = false;

  for (const { name, fn } of tests) {
    try {
      await withinLimit(fn, ms);
      console.log(`PASS ${name}`);
    } catch (error) {
      failures += 1;
      if (error instanceof TimedOut) {
        timedOut = true;
        console.error(`FAIL ${name}: ${error.message}`);
      } else {
        console.error(`FAIL ${name}`);
        console.error(error?.stack || error);
      }
    }
  }

  if (failures) {
    console.error(`Failed ${failures} of ${tests.length} test(s)`);
    process.exitCode = 1;
    // Unref'd, so it ends only a process something else keeps alive.
    if (timedOut) setTimeout(() => process.exit(), EXIT_GRACE_MS).unref();
    throw new Error(`${failures} test(s) failed`);
  }

  console.log(`Passed ${tests.length} test(s)`);
}
