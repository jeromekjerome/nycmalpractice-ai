// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The CourtListener allowance (courtlistener-usage.js): what the usage report says is left, the count of requests each job
// sent, and how much a job may still spend. The report and the table are fakes; nothing here reaches a network or a database.
import './test-settings.mjs';
process.env.COURTLISTENER_TOKEN ||= 'cl-test-token';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from './runner.mjs';
import { readAllowance, countRequests, usageToday, allowanceLeft } from '../courtlistener-usage.js';

const REPORT = JSON.parse(readFileSync(new URL('./fixtures/cl-api-usage.json', import.meta.url), 'utf8'));
const answer = (body, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('the allowance is the remaining count of the token owner\'s day, hour and minute', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify(REPORT), { status: 200 }); };
  assert.deepEqual(await readAllowance({ token: 'cl-test-token', fetchImpl }), { day: 125, hour: 50, minute: 5 });
  assert.equal(seen.url, 'https://www.courtlistener.com/api/rest/v4/api-usage/');
  assert.equal(seen.init.headers.Authorization, 'Token cl-test-token');
});

test('the allowance is null when the report is refused, is not JSON, or does not answer in time', async () => {
  assert.equal(await readAllowance({ token: 't', fetchImpl: answer({ detail: 'no' }, 401) }), null);
  assert.equal(await readAllowance({ token: 't', fetchImpl: answer('<html>nope</html>') }), null);
  assert.equal(await readAllowance({ token: 't', fetchImpl: answer({ current_usage: [] }) }), null);
  const slow = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const gaveUp = new AbortController();
  setTimeout(() => gaveUp.abort(new DOMException('timed out', 'TimeoutError')), 20);
  assert.equal(await readAllowance({ token: 't', fetchImpl: slow, signal: gaveUp.signal }), null);
  assert.equal(await readAllowance({ token: 't', fetchImpl: async () => { throw new Error('down'); } }), null);
});

test('a job may spend what is left of the day, less its reserve, and nothing when the hour is nearly spent', () => {
  assert.equal(allowanceLeft({ day: 40, hour: 50, minute: 5 }), 10);
  assert.equal(allowanceLeft({ day: 125, hour: 4, minute: 5 }), 0);
  assert.equal(allowanceLeft({ day: 125, hour: 5, minute: 5 }), 0);
  assert.equal(allowanceLeft({ day: 20, hour: 50, minute: 5 }), 0);
  assert.equal(allowanceLeft({ day: 125, hour: 20, minute: 5 }), 15);
  assert.equal(allowanceLeft({ day: 125, hour: 50, minute: 5 }), 45);
  assert.equal(allowanceLeft({ day: 125, hour: 50, minute: 5 }, { reserve: 100, hourReserve: 0 }), 25);
  assert.equal(allowanceLeft(null), 0);
});

test('counting requests sends one upsert holding the job name and New York\'s day', async () => {
  const calls = [];
  const sql = async (strings, ...values) => { calls.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values }); return []; };
  await countRequests(sql, 'library-refresh', 3);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /^INSERT INTO courtlistener_usage \(day, job, requests\) VALUES \(\?, \?, \?\) ON CONFLICT \(day, job\) DO UPDATE SET requests = courtlistener_usage\.requests \+ EXCLUDED\.requests$/);
  assert.match(calls[0].values[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(calls[0].values.slice(1), ['library-refresh', 3]);
  await countRequests(sql, 'chat-search');
  assert.equal(calls[1].values[2], 1);
});

test('counting requests never throws, and counts nothing for a count that is not a positive whole number', async () => {
  await countRequests(async () => { throw new Error('database down'); }, 'chat-search', 1);
  const calls = [];
  const sql = async (strings, ...values) => { calls.push(values); return []; };
  await countRequests(sql, 'chat-search', 0);
  await countRequests(sql, 'chat-search', -2);
  await countRequests(sql, 'chat-search', 1.5);
  assert.equal(calls.length, 0);
});

test('the day counted is the New York day, not the UTC day', async () => {
  const rows = [];
  const sql = async (strings, ...values) => { rows.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values }); return [{ job: 'chat-search', requests: 4 }]; };
  // 02:30 UTC on 25 November is still the evening of the 24th in New York.
  const found = await usageToday(sql, new Date('2026-11-25T02:30:00Z'));
  assert.deepEqual(found, [{ job: 'chat-search', requests: 4 }]);
  assert.match(rows[0].text, /^SELECT job, requests FROM courtlistener_usage WHERE day = \?/);
  assert.deepEqual(rows[0].values, ['2026-11-24']);
  assert.deepEqual(await usageToday(async () => { throw new Error('down'); }, new Date()), []);
});
