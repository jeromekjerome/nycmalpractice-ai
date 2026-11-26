// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The unit-test runner (test/runner.mjs): each test's time limit, the summary line of every run, and the exit code. Each case
// runs the runner in a child process on the fixture test/runner-cases.child.mjs, which the suite itself never runs.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from './runner.mjs';

const CHILD = fileURLToPath(new URL('./runner-cases.child.mjs', import.meta.url));
// How long a child may take before it is killed, which would mean the process hung.
const KILLED_AFTER_MS = 15_000;

// Runs the fixture with the kinds of test named, and TEST_TIMEOUT_MS set to `limit` or, without one, unset.
function runCases(kinds, limit) {
  const env = { ...process.env };
  delete env.TEST_TIMEOUT_MS;
  if (limit !== undefined) env.TEST_TIMEOUT_MS = String(limit);
  const started = Date.now();
  const child = spawnSync(process.execPath, [CHILD, ...kinds], { env, encoding: 'utf8', timeout: KILLED_AFTER_MS });
  return { status: child.status, signal: child.signal, out: child.stdout, err: child.stderr, ms: Date.now() - started };
}

test('a test that never settles fails at its time limit, naming the test and the limit, and the run goes on, prints its summary and exits non-zero', () => {
  const child = runCases(['pass', 'hang', 'pass'], 200);
  assert.deepEqual([child.status, child.signal], [1, null], child.err);
  assert.ok(child.ms < 5000, `the run took ${child.ms} ms`);
  assert.equal(child.out, 'PASS pass 1\nPASS pass 3\n');
  assert.match(child.err, /^FAIL hang 2: it did not settle within 200 ms$/m);
  assert.match(child.err, /^Failed 1 of 3 test\(s\)$/m);
});

test('a test that never settles and holds a timer open still ends the run, non-zero, within a few seconds', () => {
  const child = runCases(['hang-holding', 'pass'], 200);
  assert.deepEqual([child.status, child.signal], [1, null], `the process was killed or exited ${child.status}: ${child.err}`);
  assert.ok(child.ms < 5000, `the run took ${child.ms} ms`);
  assert.match(child.err, /^FAIL hang-holding 1: it did not settle within 200 ms$/m);
  assert.equal(child.out, 'PASS pass 2\n');
  assert.match(child.err, /^Failed 1 of 2 test\(s\)$/m);
});

test('a test that throws or rejects fails the run, which prints its summary and exits non-zero', () => {
  const child = runCases(['throw', 'reject', 'pass'], 200);
  assert.deepEqual([child.status, child.signal], [1, null], child.err);
  assert.equal(child.out, 'PASS pass 3\n');
  assert.match(child.err, /^FAIL throw 1$\n^Error: thrown as it was called$/m);
  assert.match(child.err, /^FAIL reject 2$\n^Error: rejected$/m);
  assert.match(child.err, /^Failed 2 of 3 test\(s\)$/m);
});

test('a run whose tests all pass prints what it always printed and exits 0, under the default limit', () => {
  const child = runCases(['pass', 'pass']);
  assert.deepEqual([child.status, child.signal], [0, null], child.err);
  assert.equal(child.out, 'PASS pass 1\nPASS pass 2\nPassed 2 test(s)\n');
  assert.equal(child.err, '');
  // A limit that is not a positive number leaves the default: a test of 100 ms passes, where a limit read from the value
  // itself would have run out first. With a limit of 50 ms, the same test fails.
  for (const limit of ['abc', '0', '-5']) assert.equal(runCases(['slow'], limit).status, 0, limit);
  const short = runCases(['slow'], 50);
  assert.equal(short.status, 1);
  assert.match(short.err, /^FAIL slow 1: it did not settle within 50 ms$/m);
});
