// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// A fixture for test/runner.test.mjs, which runs it as a child process; the suite never imports it. It registers one test
// with the runner for each kind named on the command line, in order, and runs them as test/index.test.mjs does. The kinds:
// - pass: settles at once;
// - hang: never settles, and holds nothing open;
// - hang-holding: never settles, and holds a timer open that would keep the process alive;
// - throw: throws as it is called;
// - reject: rejects.
import './test-settings.mjs';
import { test, run } from './runner.mjs';

const KINDS = {
  pass: () => {},
  hang: () => new Promise(() => {}),
  'hang-holding': () => new Promise(() => { setInterval(() => {}, 1000); }),
  throw: () => { throw new Error('thrown as it was called'); },
  reject: async () => { throw new Error('rejected'); },
};

for (const [i, kind] of process.argv.slice(2).entries()) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error(`runner-cases: no kind named ${kind}`);
  test(`${kind} ${i + 1}`, KINDS[kind]);
}
run().catch(() => {});
