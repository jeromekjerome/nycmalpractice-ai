// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The model measurement's tools (measure/guard-fetch.mjs, run.mjs, probe-shapes.mjs, report.mjs): what a run may
// reach, how a run is recorded, and how a model is judged against today's.
//
// This file is the same in both apps, and so are the four it tests. It brings its own people and its own app
// adapter, so that nothing here depends on which app is running it. What is particular to an app (its adapter,
// its visitors, its known-bad drafts) is tested in measure-app.test.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from './runner.mjs';
import { installGuard, MEASURE_DATABASE_URL, MODEL_HOSTS, withoutKeys } from '../measure/guard-fetch.mjs';
import { tokensOf as openaiTokens, thinkingTokensOf as openaiThinking } from '../provider-openai.js';
import { tokensOf as anthropicTokens, thinkingTokensOf as anthropicThinking } from '../provider-anthropic.js';
import { tokensOf as googleTokens, thinkingTokensOf as googleThinking } from '../provider-google.js';
import { MEASURE_DATABASE_URL as ADDRESS_ON_FILE } from '../measure-address.js';
import { parseArgs, environmentFor, turnRecord, allowanceDecision, courtListenerPace, estimateCost, thinksOf, keysFor, checkChains, measure } from '../measure/run.mjs';
import { probeLine, PROBE_HOSTS } from '../measure/probe-shapes.mjs';
import { replyStats, smallStats, majority, agreement, selfAgreement, replyBar, smallBar, checkRuns, parseReportArgs, renderReport, renderSamples, timeLimits, renderLimits, scoreRuns } from '../measure/report.mjs';
import { rowsFor, measuredOn, siteOrigin, parseUploadArgs, runUpload } from '../measure/upload.mjs';
import { estimateAiCost } from '../ai-budget.js';
import { isReasoningModel } from '../provider-openai.js';
import { capFor } from '../providers.js';

// A stand-in for an app's adapter (measure/app.mjs), and two made-up people: a visitor and a seminar student.
const ADAPTER = {
  APP: 'stand-in',
  SEMINAR_MODES: ['professor'],
  REPLY_JOBS: ['reply', 'rewrite'],
  SMALL_JOBS: ['classify', 'leadScore', 'caseCard', 'studentScore', 'grade'],
  SIDE_JOBS_FROM_TURN: { leadScore: 2, caseCard: 3 },
  recordedFor: ({ type, cases, draft }) => ({ type, cases, ...(draft === undefined ? {} : { draft }) }),
  stateFor: mode => (mode === 'professor' ? { points: 0 } : null),
};
const PEOPLE = [
  { key: 'rear-end-red-light', mode: 'client', caseType: 'auto', messages: ['Message one.', 'Message two.', 'Message three.'] },
  { key: 'seminar-auto', mode: 'professor', caseType: 'auto', messages: ['Message one.'] },
];

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('the measurement refuses every host it was not given, the database included', async () => {
  const before = globalThis.fetch;
  const sent = [];
  const guard = installGuard({ allowHosts: ['api.openai.com'], fetchImpl: async (url) => { sent.push(String(url)); return json({}); } });
  try {
    await assert.rejects(fetch('https://ep-cool-name-123456.us-east-2.aws.neon.tech/sql', { method: 'POST', body: '{}' }), /measure: refused a request to ep-cool-name-123456\.us-east-2\.aws\.neon\.tech/);
    await assert.rejects(fetch('https://www.courtlistener.com/api/rest/v4/search/?q=x'), /refused a request to www\.courtlistener\.com/);
    // A request object is read as a plain address is, and a host that only ends like an allowed one is not allowed.
    await assert.rejects(fetch(new Request('https://measure.invalid/sql', { method: 'POST', body: '{}' })), /refused a request to measure\.invalid/);
    await assert.rejects(fetch('https://api.openai.com.example.net/v1/chat/completions'), /refused a request to api\.openai\.com\.example\.net/);
    await assert.rejects(fetch('not an address'), /measure: refused a request to an address it could not read/);
    assert.deepEqual(sent, []);
    assert.deepEqual(guard.refused, ['ep-cool-name-123456.us-east-2.aws.neon.tech', 'www.courtlistener.com', 'measure.invalid', 'api.openai.com.example.net', '(unreadable)']);
  } finally { guard.restore(); }
  assert.equal(globalThis.fetch, before);
});

test("the measurement's database address is kept in a file that imports nothing, the guard hands on that same address, and no file of the app imports from measure/", () => {
  // The app's model settings check the address too, and they read the database: the guard, which is imported before
  // anything of the app, must never reach it, so the address lives in a file of its own.
  assert.equal(MEASURE_DATABASE_URL, ADDRESS_ON_FILE);
  assert.equal(new URL(MEASURE_DATABASE_URL).hostname, 'measure.invalid');
  const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(source('measure-address.js'), /^\s*import\b|\bimport\(/m, 'measure-address.js imports something');
  assert.match(source('measure/guard-fetch.mjs'), /^import \{ MEASURE_DATABASE_URL \} from '\.\.\/measure-address\.js';$/m);
  const appFiles = readdirSync(new URL('../', import.meta.url)).filter(file => /\.m?js$/.test(file));
  assert.ok(appFiles.includes('server.js') && appFiles.includes('providers.js'), appFiles.join(', '));
  for (const file of appFiles) assert.doesNotMatch(source(file), /from '\.\/measure\/|import\('\.\/measure\//, `${file} imports from measure/`);
});

test('the measurement counts the tokens of each model call and hands the answer on untouched', async () => {
  const body = { model: 'gpt-6.2-sol', choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 120, completion_tokens: 30 } };
  const guard = installGuard({ allowHosts: ['api.openai.com'], fetchImpl: async () => json(body) });
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' });
    assert.deepEqual(await res.json(), body);
    assert.equal(guard.calls.length, 1);
    assert.deepEqual({ ...guard.calls[0], ms: 0 }, { host: 'api.openai.com', model: 'gpt-6.2-sol', inputTokens: 120, outputTokens: 30, ms: 0 });
    assert.ok(guard.calls[0].ms >= 0);
  } finally { guard.restore(); }

  // The call is counted under the name that was asked for, which is the name the price table knows: the answer
  // may name a snapshot of it. An answer with no usage (an error, a list of models) is handed on and not counted.
  const answers = [
    json({ model: 'gpt-6.2-sol-2026-09-30', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    new Response(JSON.stringify({ error: { code: 'model_not_found' } }), { status: 404, headers: { 'content-type': 'application/json' } }),
    new Response('not json', { status: 200 }),
  ];
  const second = installGuard({ allowHosts: ['api.openai.com'], fetchImpl: async () => answers.shift() });
  try {
    await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-6.2-sol', messages: [] }) });
    const missing = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gpt-4o', messages: [] }) });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'model_not_found');
    assert.equal(await (await fetch('https://api.openai.com/v1/models')).text(), 'not json');
    assert.deepEqual(second.calls.map(({ model, inputTokens, outputTokens }) => ({ model, inputTokens, outputTokens })), [{ model: 'gpt-6.2-sol', inputTokens: 7, outputTokens: 3 }]);
  } finally { second.restore(); }
});

test('the measurement keeps, for each model call, its job, whether its JSON parsed, how it ended and what it spent thinking', async () => {
  const completion = (content, finish, usage) => json({ model: 'm', choices: [{ message: { content }, finish_reason: finish }], usage });
  const answers = [
    completion('{"type":"auto"}', 'stop', { prompt_tokens: 50, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 } }),
    completion('Sure! {"type":', 'length', { prompt_tokens: 50, completion_tokens: 120, completion_tokens_details: { reasoning_tokens: 0 } }),
    completion('[1,2]', 'stop', { prompt_tokens: 5, completion_tokens: 2 }),
    completion('A reply.', 'stop', { prompt_tokens: 900, completion_tokens: 300 }),
    new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } }),
  ];
  const jobOf = request => (request.response_format ? 'classify' : 'reply');
  const guard = installGuard({ allowHosts: ['api.openai.com'], jobOf, fetchImpl: async () => { if (!answers.length) throw new TypeError('fetch failed'); return answers.shift(); } });
  const ask = body => fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  try {
    for (let i = 0; i < 3; i++) await ask({ model: 'm', messages: [], response_format: { type: 'json_object' } });
    await ask({ model: 'm', messages: [] });
    assert.equal((await ask({ model: 'm', messages: [] })).status, 429);
    await assert.rejects(ask({ model: 'm', messages: [] }), /fetch failed/);
    // A request that names no model (the list of models, say) is not a model call, whatever it answers.
    answers.push(new Response('{}', { status: 404 }));
    assert.equal((await fetch('https://api.openai.com/v1/models/none')).status, 404);
  } finally { guard.restore(); }
  assert.deepEqual(guard.calls.map(({ ms, host, ...rest }) => rest), [
    { model: 'm', inputTokens: 50, outputTokens: 20, job: 'classify', json: true, finish: 'stop', reasoningTokens: 12 },
    { model: 'm', inputTokens: 50, outputTokens: 120, job: 'classify', json: false, finish: 'length' },
    { model: 'm', inputTokens: 5, outputTokens: 2, job: 'classify', json: false, finish: 'stop' },
    { model: 'm', inputTokens: 900, outputTokens: 300, job: 'reply', finish: 'stop' },
  ]);
  assert.deepEqual(guard.failed.map(({ ms, host, ...rest }) => rest), [
    { model: 'm', job: 'reply', status: 429 },
    { model: 'm', job: 'reply', error: 'fetch failed' },
  ]);
  assert.ok(guard.failed.every(failure => failure.host === 'api.openai.com' && failure.ms >= 0));
});

// ─── The three providers ──────────────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GOOGLE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

test("the guard may be given exactly the three providers' model hosts, the probe's list is the same list, and any other host is refused", async () => {
  assert.deepEqual([...MODEL_HOSTS].sort(), ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com']);
  assert.deepEqual([...PROBE_HOSTS], [...MODEL_HOSTS]);
  const sent = [];
  const guard = installGuard({ allowHosts: [...MODEL_HOSTS], fetchImpl: async (url) => { sent.push(String(url)); return json({}); } });
  try {
    for (const host of ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com']) await fetch(`https://${host}/v1/models`);
    // A host that only ends like an allowed one, one that only begins like one, and another Google service are refused.
    for (const host of ['api.anthropic.com.example.net', 'evil-api.anthropic.com', 'googleapis.com', 'aiplatform.googleapis.com', 'www.courtlistener.com']) {
      await assert.rejects(fetch(`https://${host}/v1/messages`, { method: 'POST', body: '{}' }), new RegExp(`refused a request to ${host.replace(/\./g, '\\.')}`));
    }
    assert.deepEqual(sent, ['https://api.openai.com/v1/models', 'https://api.anthropic.com/v1/models', 'https://generativelanguage.googleapis.com/v1/models']);
  } finally { guard.restore(); }
});

test("a call to Anthropic is recorded with its model, the tokens of its own usage shape, how it ended and what it spent thinking, and one to Google likewise", async () => {
  const message = (text, stop, usage) => json({ type: 'message', model: 'claude-sonnet-5-5-20261001', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text }], stop_reason: stop, usage });
  const completion = (content, finish, usage) => json({ model: 'gemini-3.8-flash', choices: [{ message: { content }, finish_reason: finish }], usage });
  const answers = [
    // Anthropic: input is the input read fresh, the cache written and the cache read; output already includes thinking.
    message('{"type":"auto"}', 'end_turn', { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 108, output_tokens_details: { thinking_tokens: 93 } }),
    message('Sure! {"type":', 'max_tokens', { input_tokens: 40, output_tokens: 3000 }),
    message('', 'refusal', { input_tokens: 40, output_tokens: 2 }),
    message('A reply.', 'end_turn', { input_tokens: 900, output_tokens: 300 }),
    // Google: thinking is reported only inside total_tokens (the live probe of 2026-11-21).
    completion('{"type":"auto"}', 'stop', { prompt_tokens: 56, completion_tokens: 12, total_tokens: 435 }),
    completion('A reply.', 'length', { prompt_tokens: 25, completion_tokens: 44, total_tokens: 369 }),
    new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }), { status: 429, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }), { status: 529, headers: { 'content-type': 'application/json' } }),
  ];
  const jobOf = request => (request.output_config?.format || request.response_format ? 'classify' : 'reply');
  const guard = installGuard({ allowHosts: [...MODEL_HOSTS], jobOf, fetchImpl: async () => { if (!answers.length) throw new TypeError('fetch failed'); return answers.shift(); } });
  const ask = (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body) });
  const asked = { model: 'claude-sonnet-5-5', max_tokens: 3000, messages: [] };
  try {
    await ask(ANTHROPIC_URL, { ...asked, output_config: { effort: 'low', format: { type: 'json_schema', schema: {} } } });
    await ask(ANTHROPIC_URL, { ...asked, output_config: { format: { type: 'json_schema', schema: {} } } });
    await ask(ANTHROPIC_URL, { ...asked, output_config: { format: { type: 'json_schema', schema: {} } } });
    await ask(ANTHROPIC_URL, { ...asked, output_config: { effort: 'medium' } });
    await ask(GOOGLE_URL, { model: 'gemini-3.8-flash', messages: [], response_format: { type: 'json_schema', json_schema: { name: 'classify', strict: true, schema: {} } } });
    await ask(GOOGLE_URL, { model: 'gemini-3.8-flash', messages: [] });
    assert.equal((await ask(GOOGLE_URL, { model: 'gemini-3.8-flash', messages: [] })).status, 429);
    assert.equal((await ask(ANTHROPIC_URL, asked)).status, 529);
    await assert.rejects(ask(ANTHROPIC_URL, asked), /fetch failed/);
    // A request that names no model (a list of models) is not a model call.
    answers.push(json({ data: [] }));
    await fetch('https://api.anthropic.com/v1/models');
  } finally { guard.restore(); }
  assert.deepEqual(guard.calls.map(({ ms, ...rest }) => rest), [
    { host: 'api.anthropic.com', model: 'claude-sonnet-5-5', inputTokens: 150, outputTokens: 108, job: 'classify', json: true, finish: 'stop', reasoningTokens: 93 },
    { host: 'api.anthropic.com', model: 'claude-sonnet-5-5', inputTokens: 40, outputTokens: 3000, job: 'classify', json: false, finish: 'length' },
    { host: 'api.anthropic.com', model: 'claude-sonnet-5-5', inputTokens: 40, outputTokens: 2, job: 'classify', json: false, finish: 'refusal' },
    { host: 'api.anthropic.com', model: 'claude-sonnet-5-5', inputTokens: 900, outputTokens: 300, job: 'reply', finish: 'stop' },
    { host: 'generativelanguage.googleapis.com', model: 'gemini-3.8-flash', inputTokens: 56, outputTokens: 379, job: 'classify', json: true, finish: 'stop', reasoningTokens: 367 },
    { host: 'generativelanguage.googleapis.com', model: 'gemini-3.8-flash', inputTokens: 25, outputTokens: 344, job: 'reply', finish: 'length', reasoningTokens: 300 },
  ]);
  assert.deepEqual(guard.failed.map(({ ms, ...rest }) => rest), [
    { host: 'generativelanguage.googleapis.com', model: 'gemini-3.8-flash', job: 'reply', status: 429 },
    { host: 'api.anthropic.com', model: 'claude-sonnet-5-5', job: 'reply', status: 529 },
    { host: 'api.anthropic.com', model: 'claude-sonnet-5-5', job: 'reply', error: 'fetch failed' },
  ]);
  assert.ok(guard.failed.every(failure => failure.ms >= 0));
});

test("each provider's token rule is written once, in its adapter, and the guard records what the adapter would count", () => {
  // The same usage, read by the adapter's own function: the guard imports these and keeps no copy.
  assert.deepEqual(anthropicTokens({ input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 108 }), { inputTokens: 150, outputTokens: 108 });
  assert.equal(anthropicThinking({ output_tokens: 108, output_tokens_details: { thinking_tokens: 93 } }), 93);
  assert.equal(anthropicThinking({ output_tokens: 108 }), 0);
  assert.deepEqual(googleTokens({ prompt_tokens: 56, completion_tokens: 12, total_tokens: 435 }), { inputTokens: 56, outputTokens: 379 });
  assert.equal(googleThinking({ prompt_tokens: 56, completion_tokens: 12, total_tokens: 435 }), 367);
  // A reported reasoning count that the total already holds is not added twice.
  assert.equal(googleThinking({ prompt_tokens: 20, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 5 }, total_tokens: 35 }), 5);
  assert.equal(googleThinking({ prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 }), 0);
  assert.deepEqual(openaiTokens({ prompt_tokens: 120, completion_tokens: 30 }), { inputTokens: 120, outputTokens: 30 });
  assert.equal(openaiThinking({ prompt_tokens: 50, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 } }), 12);
  assert.equal(openaiThinking({ prompt_tokens: 5 }), 0);
  const source = readFileSync(new URL('../measure/guard-fetch.mjs', import.meta.url), 'utf8');
  for (const adapter of ['provider-openai.js', 'provider-anthropic.js', 'provider-google.js']) assert.match(source, new RegExp(`from '\\.\\./${adapter.replace('.', '\\.')}'`), `the guard does not read ${adapter}`);
  assert.doesNotMatch(source, /cache_read_input_tokens|total_tokens/, 'the guard keeps a copy of a provider token rule');
});

test('nothing shaped like a key is kept or printed, even when a provider quotes one back in an error', async () => {
  assert.equal(withoutKeys('401 Incorrect API key provided: sk-proj-abcDEF123456****************wxyz. You can find your key at the dashboard.'),
    '401 Incorrect API key provided: [key withheld]. You can find your key at the dashboard.');
  assert.equal(withoutKeys('Authorization: Token 0123456789abcdef0123456789abcdef01234567 was refused'), 'Authorization: Token [key withheld] was refused');
  assert.equal(withoutKeys('Bearer sk-test_ABCDEFGH12345678'), 'Bearer [key withheld]');
  assert.equal(withoutKeys('The model `gpt-4o` has been deprecated (request req_0123456789abcdef)'), 'The model `gpt-4o` has been deprecated (request req_0123456789abcdef)');
  assert.equal(withoutKeys(undefined), '');
  // Google's keys ("AIza" and 35 more) and Anthropic's ("sk-ant-" with its hyphens and underscores) are withheld whole.
  assert.equal(withoutKeys('API key not valid: AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q. Pass a valid key.'), 'API key not valid: [key withheld]. Pass a valid key.');
  assert.equal(withoutKeys('invalid x-api-key: sk-ant-api03-AbC_dEf-123456789_XYZ-abcdefghij_0123 (request req_1)'), 'invalid x-api-key: [key withheld] (request req_1)');
  assert.equal(withoutKeys('The model gemini-3.8-flash was not found; see AIza for the docs'), 'The model gemini-3.8-flash was not found; see AIza for the docs');

  // A turn that failed keeps the error without the key, in the run file and in what the guard kept.
  const store = memoryStore({ 'packets.json': { ann: [{ type: 'auto', cases: [] }] } });
  const standIn = standInApp();
  standIn.reply = async () => { throw new Error('401 Incorrect API key provided: sk-proj-abcDEF123456****wxyz.'); };
  const { run } = await measure({ args: runArgs({ label: 'reply-k', mode: 'reply' }), app: standIn, visitors: [{ key: 'ann', mode: 'client', caseType: 'auto', messages: ['first from ann'] }], knownBad: [], store, guard: idleGuard(), pace: {} });
  assert.equal(run.turns[0].error, '401 Incorrect API key provided: [key withheld].');
  assert.doesNotMatch(JSON.stringify([...store.held.values()]), /sk-proj/);

  const guard = installGuard({ allowHosts: ['api.openai.com'], fetchImpl: async () => { throw new Error('connect failed for Bearer sk-live_ABCDEFGH12345678'); } });
  try {
    await assert.rejects(fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) }));
  } finally { guard.restore(); }
  assert.equal(guard.failed[0].error, 'connect failed for Bearer [key withheld]');
});

test('the exact value of each configured secret is withheld whatever its shape, read when called, and an unset or very short one withholds nothing', () => {
  const names = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'COURTLISTENER_TOKEN', 'ADMIN_SECRET', 'ADMIN_SECRET_FOR_UPLOAD', 'CRON_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'TWILIO_AUTH_TOKEN', 'SMTP_PASS', 'BACKUP_SECRET_ACCESS_KEY', 'BACKUP_ENCRYPTION_KEY', 'ETHEREAL_API_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    // Made-up values in shapes no pattern catches: a dotted one like Google's newer keys, one with a slash and plus, a plain word.
    const dotted = 'v1.Qx9mZpL2rT7wKd4NcB8yHs3JfA6eUg';
    process.env.GEMINI_API_KEY = dotted;
    process.env.ADMIN_SECRET = 'plain-made-up-admin-secret';
    process.env.SMTP_PASS = 'pa/ss+word=madeup9';
    assert.equal(withoutKeys(`Gemini said: key ${dotted} is not valid`), 'Gemini said: key [key withheld] is not valid');
    assert.equal(withoutKeys(`${dotted} and ${dotted}`), '[key withheld] and [key withheld]');
    assert.equal(withoutKeys('login failed for plain-made-up-admin-secret / pa/ss+word=madeup9'), 'login failed for [key withheld] / [key withheld]');
    // The patterns still work beside it.
    assert.equal(withoutKeys(`Bearer sk-test_ABCDEFGH12345678 then ${dotted}`), 'Bearer [key withheld] then [key withheld]');
    // Read at the time of the call: a value set later is withheld, and one removed is not.
    process.env.CRON_SECRET = 'cron-made-up-value';
    assert.equal(withoutKeys('x cron-made-up-value x'), 'x [key withheld] x');
    delete process.env.CRON_SECRET;
    assert.equal(withoutKeys('x cron-made-up-value x'), 'x cron-made-up-value x');
    // Unset, empty and very short values withhold nothing (a short one would blank out ordinary words).
    process.env.COURTLISTENER_TOKEN = '';
    process.env.TWILIO_AUTH_TOKEN = 'abc';
    assert.equal(withoutKeys('an abc of things, and  nothing'), 'an abc of things, and  nothing');
    // A value with characters that mean something in a pattern is taken literally.
    process.env.STRIPE_WEBHOOK_SECRET = 'wh.sec(made)up*[1]+?';
    assert.equal(withoutKeys('bad wh.sec(made)up*[1]+? header; whXsec(made)up'), 'bad [key withheld] header; whXsec(made)up');
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

// ─── The runner ───────────────────────────────────────────────────────────────

test('the runner refuses a run it cannot name, a mode it does not know, and a small run with nothing to copy from', () => {
  assert.deepEqual(parseArgs(['--label', 'base-1', '--answer', 'gpt-4o', '--aux', 'gpt-4o-mini', '--mode', 'record']),
    { label: 'base-1', answer: 'gpt-4o', aux: 'gpt-4o-mini', mode: 'record', from: null, yes: false, chains: { answer: ['gpt-4o'], small: ['gpt-4o-mini'] }, blockHosts: [], turns: null });
  assert.equal(parseArgs(['--label', 'a', '--answer', 'x', '--aux', 'y', '--mode', 'small', '--from', 'base-1', '--yes']).yes, true);
  assert.equal(parseArgs(['--label', 'reply-gpt-6.2-sol', '--answer', 'gpt-6.2-sol', '--aux', 'y', '--mode', 'reply']).label, 'reply-gpt-6.2-sol');
  assert.throws(() => parseArgs(['--label', '../x', '--answer', 'x', '--aux', 'y', '--mode', 'reply']), /label/);
  assert.throws(() => parseArgs(['--label', 'a', '--answer', 'x', '--aux', 'y', '--mode', 'small', '--from', '../base-1']), /--from/);
  assert.throws(() => parseArgs(['--label', 'a', '--answer', 'x', '--aux', 'y', '--mode', 'live']), /mode/);
  assert.throws(() => parseArgs(['--label', 'a', '--answer', 'x', '--aux', 'y', '--mode', 'small']), /--from/);
  assert.throws(() => parseArgs(['--label', 'a', '--answer', 'x', '--aux', 'y', '--mode', 'reply', '--fast']), /--fast/);
  assert.throws(() => parseArgs(['--label', 'a', '--answer', 'x', '--mode', 'reply']), /--aux/);
  assert.throws(() => parseArgs(['--label', 'a', '--answer', '--aux', 'y', '--mode', 'reply']), /--answer/);
});

test("a measurement run points the app at no database and holds no other service's keys, and no setting it gives names a model", () => {
  const settings = environmentFor();
  const { NODE_ENV, DATABASE_URL, GATEKEEPER_MODE, GATEKEEPER_COURTLISTENER_LOOKUP, AI_BUDGET_IN_TESTS, DEMO_MODE, DEMO_DATABASE_URL, ...standIns } = settings;
  assert.deepEqual({ NODE_ENV, DATABASE_URL, GATEKEEPER_MODE, GATEKEEPER_COURTLISTENER_LOOKUP }, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://measure:measure@measure.invalid/none',
    GATEKEEPER_MODE: 'llm',
    GATEKEEPER_COURTLISTENER_LOOKUP: 'off',
  });
  assert.equal(DATABASE_URL, MEASURE_DATABASE_URL);
  // The two models a run measures are handed to the app once the guard is installed, as chains of one (the next test).
  assert.deepEqual(Object.keys(settings).filter(name => /MODEL/.test(name)), []);
  // Every other service the app can reach is given a stand-in, so a run cannot charge a card, send a text or
  // send an email even by a path nobody foresaw. The two keys a run needs are left as they are.
  assert.deepEqual(Object.keys(standIns).sort(), ['ADMIN_SECRET', 'ALERT_EMAIL', 'CRON_SECRET', 'DAILY_DIGEST', 'NOTIFICATION_EMAIL', 'SMTP_HOST', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_USER',
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER']);
  assert.match(standIns.STRIPE_SECRET_KEY, /^sk_test_/);
  assert.match(standIns.TWILIO_ACCOUNT_SID, /^AC/);
  assert.match(standIns.SMTP_HOST, /\.invalid$/);
  assert.equal('OPENAI_API_KEY' in settings || 'COURTLISTENER_TOKEN' in settings, false);
  // Settings that would change what a run is (the spending cap switched on in a test environment, a demo copy of the
  // site) are set to nothing. They are not removed: the app loads the local settings file as it starts, and that
  // fills in whatever is not set.
  assert.deepEqual({ AI_BUDGET_IN_TESTS, DEMO_MODE, DEMO_DATABASE_URL }, { AI_BUDGET_IN_TESTS: '', DEMO_MODE: '', DEMO_DATABASE_URL: '' });
});

test('the runner hands the app its two models through the app adapter, only once the guard is installed and the run is going ahead', () => {
  // The adapter makes them the app's chains, one model each (useModels in app.mjs), which loads the app: that must
  // come after the guard, as everything of the app does, and a run that only prints its estimate loads none of it.
  const source = readFileSync(new URL('../measure/run.mjs', import.meta.url), 'utf8');
  const guarded = source.indexOf('const guard = installGuard(');
  const goingAhead = source.indexOf("console.log('Nothing has been run. Add --yes to run it.');");
  const handed = source.indexOf('await app.useModels({ answer: args.chains.answer, aux: args.chains.small });');
  assert.ok(guarded > 0 && goingAhead > guarded, 'the runner installs no guard, or asks for --yes before it');
  assert.ok(handed > goingAhead, 'the runner hands the app its models before the run is going ahead, or not at all');
  assert.equal(source.split('app.useModels(').length, 2, 'the runner hands the app its models more than once');
});

test('the settings a run gives the app are still there after the app has loaded the local settings file', () => {
  // In a folder with a settings file of its own, a second process applies a run's settings, loads the app's
  // database file (which loads the settings file of the folder it is run from), and says what it then holds.
  const folder = mkdtempSync(join(tmpdir(), 'measure-settings-'));
  try {
    writeFileSync(join(folder, '.env'), [
      'DATABASE_URL=postgres://real:real@db.example.test/live', 'AI_BUDGET_IN_TESTS=1', 'DEMO_MODE=1',
      'DEMO_DATABASE_URL=postgres://demo:demo@db.example.test/demo', 'NODE_ENV=production', 'GATEKEEPER_MODE=deterministic',
      'STRIPE_SECRET_KEY=sk_live_from_the_file', 'ONLY_IN_THE_FILE=read',
    ].join('\n'));
    const names = ['DATABASE_URL', 'AI_BUDGET_IN_TESTS', 'DEMO_MODE', 'DEMO_DATABASE_URL', 'NODE_ENV', 'GATEKEEPER_MODE', 'STRIPE_SECRET_KEY', 'ONLY_IN_THE_FILE'];
    const script = [
      `import { environmentFor } from ${JSON.stringify(new URL('../measure/run.mjs', import.meta.url).href)};`,
      'Object.assign(process.env, environmentFor());',
      `await import(${JSON.stringify(new URL('../db.js', import.meta.url).href)});`,
      `console.log('HELD ' + JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name]]))));`,
    ].join('\n');
    const printed = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: folder, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, encoding: 'utf8' });
    const held = JSON.parse(printed.split('\n').find(line => line.startsWith('HELD ')).slice(5));
    assert.deepEqual(held, {
      // The file was read: what only it holds is there.
      ONLY_IN_THE_FILE: 'read',
      // And nothing a run sets was changed by it.
      DATABASE_URL: MEASURE_DATABASE_URL, AI_BUDGET_IN_TESTS: '', DEMO_MODE: '', DEMO_DATABASE_URL: '',
      NODE_ENV: 'test', GATEKEEPER_MODE: 'llm', STRIPE_SECRET_KEY: 'sk_test_measure',
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a turn is recorded with the gate's first verdict, its unanchored citations and what was served", () => {
  const result = {
    answer: 'served text', leadScore: { tier: 'hot', score: 84 }, caseAnalysis: null,
    // After a rewrite the evaluation's own "evaluator" speaks of the last attempt; the first attempt's is the one kept.
    evaluation: { gate_status: 'PASSED', first_pass_compliant: false, final_attempt_number: 2, evaluator: 'carried_forward',
      attempts: [
        { evaluator: 'llm', draft_text: 'first draft', citation_audit: [{ status: 'UNANCHORED' }, { status: 'ANCHORED' }, { status: 'UNANCHORED' }],
          required_checks: [{ id: 'REQ-PI-01', passed: false }, { id: 'REQ-PI-03', passed: true }], prohibited_checks: [{ id: 'PROH-PI-01', violated: true }, { id: 'PROH-PI-02', violated: false }] },
        { evaluator: 'carried_forward', draft_text: 'second' },
      ] },
  };
  assert.deepEqual(turnRecord({ visitor: 'rear-end-red-light', turn: 3, ms: 4200, type: 'auto', result, classifiedType: null }), {
    visitor: 'rear-end-red-light', turn: 3, ms: 4200, type: 'auto', classifiedType: null,
    gateStatus: 'PASSED', firstPassCompliant: false, finalAttempt: 2, evaluator: 'llm',
    firstDraftUnanchored: 2, firstDraftFlagged: ['REQ-PI-01', 'PROH-PI-01'], firstDraft: 'first draft', served: 'served text',
    leadTier: 'hot', leadScore: 84, leadVerdict: true, caseCard: false,
  });
  // A lead the scorer turned down has a verdict and a score but no tier; a case card that came back is kept as "there".
  const turnedDown = turnRecord({ visitor: 'v', turn: 2, ms: 1, type: 'slip', result: { ...result, leadScore: { viable: false, score: 30, confidence: 0.9 }, caseAnalysis: { score: 5 } }, classifiedType: 'slip' });
  assert.deepEqual([turnedDown.leadTier, turnedDown.leadScore, turnedDown.leadVerdict, turnedDown.caseCard, turnedDown.classifiedType], [null, 30, true, true, 'slip']);
  // A turn that could not be made at all, and one the gate could not grade, are recorded as what they are: not passed.
  assert.deepEqual(turnRecord({ visitor: 'v', turn: 1, ms: 9, type: 'slip', result: null, error: 'timed out' }), {
    visitor: 'v', turn: 1, ms: 9, type: 'slip', classifiedType: null,
    gateStatus: null, firstPassCompliant: false, finalAttempt: 0, evaluator: null,
    firstDraftUnanchored: 0, firstDraftFlagged: [], firstDraft: '', served: '',
    leadTier: null, leadScore: null, leadVerdict: false, caseCard: false, error: 'timed out',
  });
  const ungated = turnRecord({ visitor: 'v', turn: 1, ms: 9, type: 'slip', result: { answer: 'text', evaluation: null } });
  assert.deepEqual([ungated.gateStatus, ungated.firstPassCompliant, ungated.served], [null, false, 'text']);
  // A turn that had to be sent twice says so; one sent once says nothing of it.
  assert.equal(turnRecord({ visitor: 'v', turn: 1, ms: 9, type: 'slip', result, attempts: 2 }).attempts, 2);
  assert.equal('attempts' in turnRecord({ visitor: 'v', turn: 1, ms: 9, type: 'slip', result, attempts: 1 }), false);
});

// CourtListener's usage report, with what is left for the day, the hour and the minute.
const usageOf = (day, hour, minute) => ({ current_usage: [
  { scope: 'api_usage', rate: '10/min', remaining: 0, limit: 10, window_seconds: 60, reset_at: '2026-11-20T10:00:30+00:00', blocked: false },
  { scope: 'user', rate: '125/day', remaining: day, limit: 125, window_seconds: 86400, reset_at: '2026-11-21T02:00:00+00:00', blocked: false },
  { scope: 'user', rate: '50/hour', remaining: hour, limit: 50, window_seconds: 3600, reset_at: '2026-11-20T10:40:00+00:00', blocked: false },
  { scope: 'user', rate: '5/min', remaining: minute, limit: 5, window_seconds: 60, reset_at: '2026-11-20T10:00:50+00:00', blocked: false },
] });

test('before a live search the runner goes on, waits or stops by what CourtListener says is left', () => {
  const now = Date.parse('2026-11-20T10:00:00+00:00');
  assert.deepEqual(allowanceDecision(usageOf(120, 50, 5), now), { action: 'go' });
  assert.deepEqual(allowanceDecision(usageOf(10, 4, 4), now), { action: 'go' });
  // Under ten for the day: stop, and carry on another day. A turn can spend four searches, so under four in the
  // hour or the minute: wait for that window.
  const stop = allowanceDecision(usageOf(9, 50, 5), now);
  assert.equal(stop.action, 'stop');
  assert.match(stop.why, /9 of the day's 125/);
  const hour = allowanceDecision(usageOf(60, 3, 5), now);
  assert.deepEqual([hour.action, hour.until], ['wait', Date.parse('2026-11-20T10:40:02+00:00')]);
  const minute = allowanceDecision(usageOf(60, 20, 1), now);
  assert.deepEqual([minute.action, minute.until], ['wait', Date.parse('2026-11-20T10:00:52+00:00')]);
  // A window marked blocked has nothing left whatever it says; a report that does not give the day is no licence to go on.
  const blocked = usageOf(60, 20, 5);
  blocked.current_usage[3].blocked = true;
  assert.equal(allowanceDecision(blocked, now).action, 'wait');
  assert.equal(allowanceDecision({ current_usage: [] }, now).action, 'stop');
  assert.equal(allowanceDecision(null, now).action, 'stop');
  assert.equal(allowanceDecision({ detail: 'Invalid token.' }, now).action, 'stop');
});

test('the runner waits out a usage report it cannot read, and says why when it gives up', async () => {
  // A pace with a scripted usage report and a clock that only moves when the pace sleeps.
  const scripted = (answers) => {
    const slept = [];
    const lines = [];
    let clock = 1_000_000;
    const pace = courtListenerPace({
      log: line => lines.push(line),
      readUsage: async () => answers.shift(),
      sleep: async ms => { if (ms > 0) { slept.push(ms); clock += ms; } },
      now: () => clock,
    });
    return { slept, lines, pace };
  };
  const readable = body => ({ status: 200, body });

  // Unreadable twice (a timeout, then a refusal), then readable: it goes on, having waited a minute each time.
  const patient = scripted([{ status: null, body: null, error: 'The operation was aborted due to timeout' }, { status: 429, body: { detail: 'Request was throttled.' } }, readable(usageOf(120, 50, 5))]);
  assert.equal(await patient.pace.beforeLiveTurn(), 'go');
  assert.deepEqual(patient.slept, [60_000, 60_000]);
  assert.match(patient.lines[0], /could not be read \(The operation was aborted due to timeout\)/);
  assert.match(patient.lines[1], /could not be read \(it answered 429\)/);

  // Unreadable five times running: it stops, and gives the last reason.
  const hopeless = scripted(Array.from({ length: 5 }, () => ({ status: 503, body: null })));
  assert.equal(await hopeless.pace.beforeLiveTurn(), 'stop');
  assert.equal(hopeless.lines.at(-1), "Stopping: CourtListener's usage report could not be read in 5 tries (it answered 503).");
  assert.deepEqual(hopeless.slept, [60_000, 60_000, 60_000, 60_000]);

  // A second live turn is not started within a minute of the first, and a window that is nearly used up is
  // looked at again within five minutes, since the windows roll.
  const paced = scripted([readable(usageOf(120, 50, 5)), readable(usageOf(60, 20, 1)), readable(usageOf(120, 50, 5))]);
  assert.equal(await paced.pace.beforeLiveTurn(), 'go');
  assert.deepEqual(paced.slept, []);
  assert.equal(await paced.pace.beforeLiveTurn(), 'go');
  assert.deepEqual(paced.slept, [60_000, 300_000]);
  assert.equal(paced.lines[0], 'Waiting 300s: 1 of 5 CourtListener requests are left this minute.');

  // The day's allowance running low stops the run.
  const spent = scripted([readable(usageOf(9, 50, 5))]);
  assert.equal(await spent.pace.beforeLiveTurn(), 'stop');
  assert.match(spent.lines[0], /^Stopping: only 9 of the day's 125 CourtListener requests are left\.$/);
});

test("a run's cost is estimated from an earlier run's tokens at the new models' prices, on the high side", () => {
  const base = { answer: 'gpt-4o', aux: 'gpt-4o-mini', calls: [
    { model: 'gpt-4o', job: 'reply', inputTokens: 1_000_000, outputTokens: 100_000 },
    { model: 'gpt-4o', job: 'rewrite', inputTokens: 100_000, outputTokens: 10_000 },
    { model: 'gpt-4o-mini', job: 'grade', inputTokens: 2_000_000, outputTokens: 200_000 },
  ] };
  const pricing = { price: estimateAiCost, thinks: thinksOf, replyJobs: ADAPTER.REPLY_JOBS };
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);
  // Today's models again: (2.50 + 1.00) + (0.25 + 0.10) + (0.30 + 0.12) = 4.27, and a quarter on top.
  near(estimateCost({ mode: 'reply', answer: 'gpt-4o', aux: 'gpt-4o-mini' }, base, pricing), 4.27 * 1.25);
  // A model that thinks is given the allowance every adapter gives it to think in, 2,000 tokens, on each call it makes.
  // gpt-6.2-sol at 2/10: (2.00 + 1.02) + (0.20 + 0.12) = 3.34; the small model unchanged at 0.42.
  near(estimateCost({ mode: 'reply', answer: 'gpt-6.2-sol', aux: 'gpt-4o-mini' }, base, pricing), (3.34 + 0.42) * 1.25);
  // A small run writes no drafts: of the answer model's calls only the rewrites are counted.
  // gpt-6-luna at 0.10/0.50: 0.20 + (200,000 + 2,000) * 0.5 / 1e6 = 0.301; the rewrite at gpt-4o: 0.35.
  near(estimateCost({ mode: 'small', answer: 'gpt-4o', aux: 'gpt-6-luna' }, base, pricing), (0.301 + 0.35) * 1.25);
});

test("the estimate prices each provider's models from the registry and counts their thinking as output", () => {
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);
  const pricing = { price: estimateAiCost, thinks: thinksOf, replyJobs: ADAPTER.REPLY_JOBS };
  // What thinks: every Claude and Gemini model (they all do), the OpenAI models the registry marks, and an unregistered
  // name by the name's own pattern. gpt-4o does not.
  assert.deepEqual(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gpt-6-luna', 'gpt-6.1-terra', 'gpt-9-imaginary'].map(thinksOf), Array(8).fill(true));
  assert.deepEqual(['gpt-4o', 'gpt-4.1-mini'].map(thinksOf), [false, false]);
  // The run that is estimated from is the live pair's: its output already holds the thinking it did (reasoningTokens), so
  // only what was written is kept, and the allowance is added in its place.
  const base = { answer: 'gpt-6.1-terra', aux: 'gpt-6-luna', calls: [
    { model: 'gpt-6.1-terra', job: 'reply', inputTokens: 1_000_000, outputTokens: 400_000, reasoningTokens: 300_000 },
    { model: 'gpt-6.1-terra', job: 'rewrite', inputTokens: 100_000, outputTokens: 10_000 },
    { model: 'gpt-6-luna', job: 'grade', inputTokens: 2_000_000, outputTokens: 200_000, reasoningTokens: 150_000 },
  ] };
  // Claude Sonnet 5.5 (2/10) answers, Gemini 3.5 Flash-Lite (0.30/2.50) does the small jobs:
  // reply 2.00 + (100,000 + 2,000) * 10 / 1e6 = 3.02; rewrite 0.20 + 12,000 * 10 / 1e6 = 0.32; grade 0.60 + (50,000 + 2,000) * 2.5 / 1e6 = 0.73.
  near(estimateCost({ mode: 'reply', answer: 'claude-sonnet-5-5', aux: 'gemini-3.5-flash-lite' }, base, pricing), (3.02 + 0.32 + 0.73) * 1.25);
  // A small run from the same run, Claude Haiku 5.5 (0.10/0.50) on the small jobs, the rewrites at the live reply model (1/5):
  // grade 0.20 + 52,000 * 0.5 / 1e6 = 0.226; the rewrite 0.10 + 12,000 * 5 / 1e6 = 0.16.
  near(estimateCost({ mode: 'small', answer: 'gpt-6.1-terra', aux: 'claude-haiku-5-5' }, base, pricing), (0.226 + 0.16) * 1.25);
  // Gemini 3.8 Flash is priced for the day: today's price now, and the announced one from 2027-01-01.
  assert.ok(estimateAiCost('gemini-3.8-flash', 1_000_000, 1_000_000, '', '2027-01-01') > estimateAiCost('gemini-3.8-flash', 1_000_000, 1_000_000, '', '2026-12-31'));
});

test("a run asks for the key of each provider it reaches, and no other", () => {
  assert.deepEqual(keysFor({ mode: 'reply', answer: 'claude-sonnet-5-5', aux: 'gpt-6-luna' }), ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  assert.deepEqual(keysFor({ mode: 'small', answer: 'gpt-6.1-terra', aux: 'gemini-3.5-flash-lite' }), ['OPENAI_API_KEY', 'GEMINI_API_KEY']);
  assert.deepEqual(keysFor({ mode: 'reply', answer: 'gpt-6.1-terra', aux: 'gpt-6-luna' }), ['OPENAI_API_KEY']);
  assert.deepEqual(keysFor({ mode: 'record', answer: 'gpt-6.1-terra', aux: 'gpt-6-luna' }), ['OPENAI_API_KEY', 'COURTLISTENER_TOKEN']);
  // A name the registry does not hold is asked for no key but OpenAI's, the one the app has always needed.
  assert.deepEqual(keysFor({ mode: 'reply', answer: 'gpt-9-imaginary', aux: 'gpt-6-luna' }), ['OPENAI_API_KEY']);
});

test("the probe puts a model's three results on one line (the requests and the words for each are tested in probe-shapes.test.mjs)", () => {
  assert.equal(probeLine('gpt-6.2-sol', { reply: 'ok', json: 'ok', rewrite: 'ok' }), 'gpt-6.2-sol: reply ok | json ok | rewrite ok');
  assert.equal(probeLine('gpt-9', { reply: 'FAILED 400 unsupported_parameter', json: 'NOT JSON', rewrite: 'EMPTY' }), 'gpt-9: reply FAILED 400 unsupported_parameter | json NOT JSON | rewrite EMPTY');
});

// A stand-in for the app: it finds one decision named after the question, and replies by echo. A draft that says
// it is wrong on purpose is blocked at the first pass.
function standInApp({ failing = () => false } = {}) {
  const seen = { find: [], classify: [], reply: [] };
  return {
    ...ADAPTER,
    seen,
    find: async (history, question) => { seen.find.push({ history: structuredClone(history), question }); return { type: 'auto', cases: [{ caseName: `Found for: ${question}` }] }; },
    classify: async (history, question) => { seen.classify.push({ history: structuredClone(history), question }); return { type: 'slip', terms: 'x' }; },
    reply: async (args) => {
      seen.reply.push(structuredClone(args));
      if (failing(args, seen.reply.length)) throw new Error('the model did not answer');
      const draft = args.recorded.draft ?? `draft for: ${args.question}`;
      return {
        answer: `reply to: ${args.question}`, type: args.recorded.type, cases: args.recorded.cases, leadScore: null, caseAnalysis: null,
        evaluation: { gate_status: 'PASSED', first_pass_compliant: !/wrong on purpose/.test(draft), final_attempt_number: 1,
          attempts: [{ evaluator: 'llm', draft_text: draft, citation_audit: [], required_checks: [{ id: 'REQ-X', passed: !/wrong on purpose/.test(draft) }], prohibited_checks: [] }] },
      };
    },
  };
}

function memoryStore(files = {}) {
  const held = new Map(Object.entries(files).map(([path, value]) => [path, JSON.stringify(value)]));
  return {
    held,
    read: path => (held.has(path) ? JSON.parse(held.get(path)) : null),
    write: (path, value) => { held.set(path, JSON.stringify(value)); },
    remove: path => { held.delete(path); },
  };
}

const TWO_VISITORS = [
  { key: 'ann', mode: 'client', caseType: 'auto', messages: ['first from ann', 'second from ann'] },
  { key: 'ben', mode: 'professor', caseType: 'slip', messages: ['first from ben'] },
];
const idleGuard = () => ({ calls: [], failed: [], refused: [] });
const runArgs = (over) => ({ label: 'base-1', answer: 'gpt-4o', aux: 'gpt-4o-mini', mode: 'record', from: null, yes: true, ...over });

test('a recording run searches once for each turn, replies from what it found, and carries on where it was stopped', async () => {
  const store = memoryStore();
  const first = standInApp();
  // The allowance lets two turns through and stops the third.
  const allowance = ['go', 'go', 'stop'];
  const stopped = await measure({ args: runArgs(), app: first, visitors: TWO_VISITORS, knownBad: [], store, guard: idleGuard(), pace: { beforeLiveTurn: async () => allowance.shift() } });
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(store.read('packets.json'), { ann: [{ type: 'auto', cases: [{ caseName: 'Found for: first from ann' }] }, { type: 'auto', cases: [{ caseName: 'Found for: second from ann' }] }] });
  assert.equal(store.read('results/base-1.json'), null);
  assert.equal(store.read('results/base-1.partial.json').turns.length, 2);
  // The second search is given the conversation so far, this run's own reply included.
  assert.deepEqual(first.seen.find[1], { history: [{ role: 'user', content: 'first from ann' }, { role: 'assistant', content: 'reply to: first from ann' }], question: 'second from ann' });
  // Every reply is made from the packet, never by the visitor's path, with a session of its own and a new game state.
  assert.deepEqual(first.seen.reply[1], {
    question: 'second from ann', mode: 'client', sessionId: 'measure-base-1-ann', gamState: null, allowLeadScoring: true,
    history: [{ role: 'user', content: 'first from ann' }, { role: 'assistant', content: 'reply to: first from ann' }],
    recorded: { type: 'auto', cases: [{ caseName: 'Found for: second from ann' }] },
  });

  // Run again: the two turns already made are neither searched for nor replied to again.
  const second = standInApp();
  const finished = await measure({ args: runArgs(), app: second, visitors: TWO_VISITORS, knownBad: [], store, guard: idleGuard(), pace: { beforeLiveTurn: async () => 'go' } });
  assert.equal(finished.status, 'complete');
  assert.deepEqual(second.seen.find.map(call => call.question), ['first from ben']);
  assert.deepEqual(second.seen.reply.map(call => call.question), ['first from ben']);
  assert.deepEqual(second.seen.reply[0].gamState, { points: 0 });
  const run = store.read('results/base-1.json');
  assert.deepEqual(run.turns.map(turn => `${turn.visitor}:${turn.turn}`), ['ann:1', 'ann:2', 'ben:1']);
  assert.deepEqual([run.app, run.label, run.mode, run.answer, run.aux], ['stand-in', 'base-1', 'record', 'gpt-4o', 'gpt-4o-mini']);
  assert.deepEqual(run.knownBad, []);
  assert.equal(store.read('results/base-1.partial.json'), null);
  assert.equal(Object.keys(store.read('packets.json')).length, 2);

  // A label that already has results is not run again over them.
  await assert.rejects(measure({ args: runArgs(), app: standInApp(), visitors: TWO_VISITORS, knownBad: [], store, guard: idleGuard(), pace: { beforeLiveTurn: async () => 'go' } }), /base-1 already has results/);
});

test('a recording run asks once more when a search finds nothing, and keeps what the model calls cost', async () => {
  const store = memoryStore();
  const found = [[], [{ caseName: 'Second time lucky' }], []];
  const standIn = standInApp();
  standIn.find = async () => ({ type: 'auto', cases: found.shift() ?? [] });
  const guard = idleGuard();
  let asked = 0;
  const pace = { beforeLiveTurn: async () => { asked += 1; guard.calls.push({ model: 'gpt-4o-mini', job: 'classify', inputTokens: 10, outputTokens: 2, ms: 5 }); return 'go'; } };
  const { run } = await measure({ args: runArgs(), app: standIn, visitors: [{ key: 'ann', mode: 'client', caseType: 'auto', messages: ['first from ann', 'second from ann'] }], knownBad: [], store, guard, pace });
  // Turn one: nothing, then something. Turn two: nothing twice, and the empty packet is kept as it is.
  assert.equal(asked, 4);
  assert.deepEqual(store.read('packets.json').ann, [{ type: 'auto', cases: [{ caseName: 'Second time lucky' }] }, { type: 'auto', cases: [] }]);
  assert.equal(run.calls.length, 4);
});

test('a reply run replays the packets and carries its own replies forward, and searches for nothing', async () => {
  const packets = { ann: [{ type: 'auto', cases: [{ caseName: 'A' }] }, { type: 'slip', cases: [] }], ben: [{ type: 'slip', cases: [] }] };
  const store = memoryStore({ 'packets.json': packets });
  const standIn = standInApp();
  const guard = idleGuard();
  guard.refused.push('example.invalid');
  const pace = { beforeLiveTurn: async () => { throw new Error('a reply run never searches'); } };
  const { status, run } = await measure({ args: runArgs({ label: 'reply-x', mode: 'reply', answer: 'x' }), app: standIn, visitors: TWO_VISITORS, knownBad: [{ key: 'bad-one', visitor: 'ann', turn: 1, breaks: 'REQ-X', draft: 'This draft is wrong on purpose.' }], store, guard, pace });
  assert.equal(status, 'complete');
  assert.deepEqual(standIn.seen.find, []);
  assert.deepEqual(standIn.seen.classify, []);
  assert.deepEqual(standIn.seen.reply.map(call => call.recorded), [{ type: 'auto', cases: [{ caseName: 'A' }] }, { type: 'slip', cases: [] }, { type: 'slip', cases: [] }]);
  assert.deepEqual(standIn.seen.reply[1].history, [{ role: 'user', content: 'first from ann' }, { role: 'assistant', content: 'reply to: first from ann' }]);
  assert.deepEqual(run.turns.map(turn => [turn.type, turn.classifiedType, turn.firstDraft]), [['auto', null, 'draft for: first from ann'], ['slip', null, 'draft for: second from ann'], ['slip', null, 'draft for: first from ben']]);
  // The known-bad drafts are for the small-job runs only, and what the guard refused is kept in the run.
  assert.deepEqual(run.knownBad, []);
  assert.deepEqual(run.refused, ['example.invalid']);
  assert.deepEqual(store.read('packets.json'), packets);

  // With a packet missing there is nothing to replay, and the run says so rather than searching.
  await assert.rejects(measure({ args: runArgs({ label: 'reply-y', mode: 'reply' }), app: standInApp(), visitors: TWO_VISITORS, knownBad: [], store: memoryStore({ 'packets.json': { ann: [packets.ann[0]] } }), guard: idleGuard(), pace }), /no recorded packet for ann:2/);
});

test('a turn that fails is tried once more, and one that fails twice is kept as failed while the conversation goes on', async () => {
  const store = memoryStore({ 'packets.json': { ann: [{ type: 'auto', cases: [] }, { type: 'auto', cases: [] }], ben: [{ type: 'slip', cases: [] }] } });
  // The first call fails once; every call for ann's second message fails.
  const standIn = standInApp({ failing: (args, count) => count === 1 || args.question === 'second from ann' });
  const { run } = await measure({ args: runArgs({ label: 'reply-z', mode: 'reply' }), app: standIn, visitors: TWO_VISITORS, knownBad: [], store, guard: idleGuard(), pace: {} });
  assert.deepEqual(standIn.seen.reply.map(call => call.question), ['first from ann', 'first from ann', 'second from ann', 'second from ann', 'first from ben']);
  assert.deepEqual(run.turns.map(turn => [turn.visitor, turn.turn, turn.served, turn.error ?? null]), [
    ['ann', 1, 'reply to: first from ann', null], ['ann', 2, '', 'the model did not answer'], ['ben', 1, 'reply to: first from ben', null],
  ]);
  assert.deepEqual(run.turns.map(turn => turn.attempts ?? 1), [2, 2, 1]);
});

test('a small-job run grades the drafts of the run it copies, classifies each turn, and is shown the drafts that are wrong on purpose', async () => {
  const packets = { ann: [{ type: 'auto', cases: [] }, { type: 'auto', cases: [] }], ben: [{ type: 'slip', cases: [] }] };
  const source = { label: 'base-1', mode: 'record', answer: 'gpt-4o', aux: 'gpt-4o-mini', turns: [
    { visitor: 'ann', turn: 1, firstDraft: 'base draft one', served: 'base reply one' },
    { visitor: 'ann', turn: 2, firstDraft: 'base draft two', served: 'base reply two' },
    { visitor: 'ben', turn: 1, firstDraft: 'base draft for ben', served: 'base reply for ben' },
  ] };
  const store = memoryStore({ 'packets.json': packets, 'results/base-1.json': source });
  const standIn = standInApp();
  const bad = [{ key: 'bad-two', visitor: 'ann', turn: 2, breaks: 'REQ-X', draft: 'This draft is wrong on purpose.' }];
  const { status, run } = await measure({ args: runArgs({ label: 'small-luna', mode: 'small', aux: 'gpt-6-luna', from: 'base-1' }), app: standIn, visitors: TWO_VISITORS, knownBad: bad, store, guard: idleGuard(), pace: {} });
  assert.equal(status, 'complete');
  // Each turn is graded on the copied run's draft, in the copied run's conversation, not this run's own replies.
  assert.deepEqual(standIn.seen.reply.slice(0, 3).map(call => call.recorded.draft), ['base draft one', 'base draft two', 'base draft for ben']);
  assert.deepEqual(standIn.seen.reply[1].history, [{ role: 'user', content: 'first from ann' }, { role: 'assistant', content: 'base reply one' }]);
  assert.deepEqual(standIn.seen.classify.map(call => call.question), ['first from ann', 'second from ann', 'first from ben']);
  assert.deepEqual(standIn.seen.classify[1].history, [{ role: 'user', content: 'first from ann' }, { role: 'assistant', content: 'base reply one' }]);
  assert.deepEqual(run.turns.map(turn => [turn.type, turn.classifiedType]), [['auto', 'slip'], ['auto', 'slip'], ['slip', 'slip']]);
  assert.deepEqual(standIn.seen.find, []);
  // The draft that is wrong on purpose takes the place of the reply at its turn, in the same conversation.
  assert.deepEqual(standIn.seen.reply[3].recorded, { type: 'auto', cases: [], draft: 'This draft is wrong on purpose.' });
  assert.deepEqual(standIn.seen.reply[3].history, [{ role: 'user', content: 'first from ann' }, { role: 'assistant', content: 'base reply one' }]);
  assert.equal(standIn.seen.reply[3].question, 'second from ann');
  assert.deepEqual(run.knownBad, [{ key: 'bad-two', breaks: 'REQ-X', caught: true, flagged: ['REQ-X'], evaluator: 'llm' }]);
  assert.equal(run.from, 'base-1');

  // Without the run to copy from, or with a turn missing from it, there is nothing to grade.
  await assert.rejects(measure({ args: runArgs({ label: 'small-a', mode: 'small', from: 'nowhere' }), app: standInApp(), visitors: TWO_VISITORS, knownBad: [], store: memoryStore({ 'packets.json': packets }), guard: idleGuard(), pace: {} }), /no run named nowhere/);
  const short = memoryStore({ 'packets.json': packets, 'results/base-1.json': { ...source, turns: source.turns.slice(0, 1) } });
  await assert.rejects(measure({ args: runArgs({ label: 'small-b', mode: 'small', from: 'base-1' }), app: standInApp(), visitors: TWO_VISITORS, knownBad: [], store: short, guard: idleGuard(), pace: {} }), /base-1 has no turn ann:2/);

  // The model calls made while grading the drafts that are wrong on purpose are marked off: they are no part of
  // what a conversation costs.
  const guard = idleGuard();
  const counting = standInApp();
  const echo = counting.reply;
  counting.reply = async (args) => { guard.calls.push({ model: 'gpt-6-luna', job: 'grade', inputTokens: 1, outputTokens: 1, ms: 1 }); return echo(args); };
  const counted = await measure({ args: runArgs({ label: 'small-c', mode: 'small', aux: 'gpt-6-luna', from: 'base-1' }), app: counting, visitors: TWO_VISITORS, knownBad: bad, store, guard, pace: {} });
  assert.equal(counted.run.calls.length, 4);
  assert.equal(counted.run.knownBadFromCall, 3);
});

// ─── The report ───────────────────────────────────────────────────────────────

const turn = (over) => ({
  visitor: 'rear-end-red-light', turn: 1, ms: 3000, type: 'auto', classifiedType: null,
  gateStatus: 'PASSED', firstPassCompliant: true, finalAttempt: 1, evaluator: 'llm', firstDraftUnanchored: 0, firstDraftFlagged: [], firstDraft: 'draft', served: 'text',
  leadTier: null, leadScore: null, leadVerdict: false, caseCard: false, ...over,
});
const context = { price: estimateAiCost, visitors: PEOPLE, adapter: ADAPTER };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);

test('a reply that came back empty counts as failed, and the slowest tenth is the 90th percentile', () => {
  const run = { answer: 'gpt-4o', aux: 'gpt-4o-mini', calls: [], turns: [
    ...Array.from({ length: 8 }, (_, i) => turn({ turn: i + 1, ms: 1000 * (i + 1) })),
    turn({ turn: 9, ms: 9000, served: '' }),
    turn({ turn: 10, ms: 20000, gateStatus: 'BLOCKED', firstPassCompliant: false, firstDraftUnanchored: 2 }),
  ] };
  const stats = replyStats(run, context);
  assert.equal(stats.turns, 10);
  assert.equal(stats.finalPassRate, 0.8);
  assert.equal(stats.finalFailures, 2);
  assert.equal(stats.seminarFinalFailures, 0);
  assert.equal(stats.firstPassRate, 0.9);
  // Drafts are counted, not citations: one draft with two citations the citator could not anchor is one.
  assert.equal(stats.unanchoredFirstDrafts, 1);
  assert.equal(stats.turnMedianMs, 5000);
  assert.equal(stats.turnSlowestTenthMs, 9000);
  assert.equal(stats.seminarFinalPassRate, 1);
  assert.equal(stats.costPerConversation, 0);
  assert.deepEqual([stats.replyCallsFailed, stats.replyCallFailures, stats.ungradedFirstDrafts, stats.retriedTurns, stats.turnsOverDeadline], [0, '', 0, 0, 0]);
  // No reply call was kept, so the reply job's own time is not known. That is not the same as no time at all.
  assert.equal(stats.replyMedianMs, null);
  assert.equal(stats.replySlowestTenthMs, null);
});

test('a reply model is timed on its own calls and costed on its own jobs, and its seminar turns are counted apart', () => {
  const run = { answer: 'gpt-6.2-sol', aux: 'gpt-4o-mini',
    turns: [
      turn({ turn: 1, evaluator: 'deterministic_fallback' }),
      turn({ turn: 2, firstDraft: '', firstPassCompliant: false, evaluator: 'deterministic' }),
      turn({ visitor: 'seminar-auto', turn: 1, attempts: 2, ms: 50_000 }),
      turn({ visitor: 'seminar-auto', turn: 2, gateStatus: 'BLOCKED', firstPassCompliant: false }),
      turn({ visitor: 'seminar-auto', turn: 3, gateStatus: null, firstPassCompliant: false, served: '', error: 'timed out' }),
    ],
    calls: [
      { model: 'gpt-6.2-sol', job: 'reply', inputTokens: 1_000_000, outputTokens: 100_000, ms: 2000, finish: 'stop' },
      { model: 'gpt-6.2-sol', job: 'reply', inputTokens: 0, outputTokens: 0, ms: 4000, finish: 'length' },
      { model: 'gpt-6.2-sol', job: 'rewrite', inputTokens: 0, outputTokens: 0, ms: 12000, finish: 'stop' },
      { model: 'gpt-4o-mini', job: 'grade', inputTokens: 1_000_000, outputTokens: 0, ms: 60000 },
    ],
    failed: [
      { model: 'gpt-6.2-sol', job: 'reply', status: 429, ms: 300 },
      { model: 'gpt-6.2-sol', job: 'reply', error: 'Request timed out.', ms: 30_000 },
      { model: 'gpt-4o-mini', job: 'grade', status: 500, ms: 50 },
    ] };
  const stats = replyStats(run, context);
  // The first turn's draft was graded by code alone, so nothing is known of it from the model grader: the pass
  // rates are counted over the other four. The empty draft was rewritten and served (a pass in the end, not at
  // first); the seminar's three turns are a pass, a block and a failure.
  assert.equal(stats.firstPassRate, 1 / 4);
  assert.equal(stats.finalPassRate, 2 / 4);
  assert.equal(stats.finalFailures, 2);
  assert.equal(stats.seminarFinalPassRate, 1 / 3);
  assert.equal(stats.seminarFinalFailures, 2);
  assert.equal(stats.emptyFirstDrafts, 1);
  assert.equal(stats.failedTurns, 1);
  assert.equal(stats.cutOff, 1);
  // The grader's minute is no part of the reply job's time; a reply call that failed is, for as long as it took:
  // 300, 2000, 4000 and 12000. The one that timed out was cut off at the limit it was given, so it took longer than that,
  // and it is counted as over any limit (the runs are made under the clock, which cuts a slow call off).
  assert.equal(stats.replyMedianMs, 4000);
  assert.equal(stats.replySlowestTenthMs, Infinity);
  assert.equal(stats.replyCallsTimedOut, 1);
  // What would otherwise go unseen: reply calls that failed, a first draft the model grader never graded (an empty
  // draft is not sent to it, so that one is not counted), a turn that had to be sent twice, and a turn that took
  // longer than the 45 seconds the site waits.
  assert.equal(stats.replyCallsFailed, 2);
  assert.equal(stats.replyCallFailures, '429 x1, Request timed out. x1');
  assert.equal(stats.ungradedFirstDrafts, 1);
  assert.equal(stats.retriedTurns, 1);
  assert.equal(stats.turnsOverDeadline, 1);
  // gpt-6.2-sol at 2 and 10: 2.00 in and 1.00 out, over two visitors. The small model's 0.15 belongs to the small jobs.
  close(stats.costPerConversation, 1.5);
});

test("agreement is measured against the answer today's model gives most often, and today's model against its own other runs", () => {
  const runs = [{ turns: [turn({ type: 'auto' })] }, { turns: [turn({ type: 'slip' })] }, { turns: [turn({ type: 'auto' })] }];
  const reference = majority(runs, t => t.type);
  assert.equal(reference.get('rear-end-red-light:1'), 'auto');
  const twoTurns = { turns: [turn({ type: 'auto' }), turn({ turn: 2, type: 'slip' })] };
  const both = new Map([['rear-end-red-light:1', 'auto'], ['rear-end-red-light:2', 'auto']]);
  assert.equal(agreement(twoTurns, both, t => t.type), 0.5);
  // A tie goes to the first run's answer. A turn the reference does not hold is not counted, and with nothing to
  // count the agreement is whole. A fourth argument narrows the turns that are compared.
  assert.equal(majority([{ turns: [turn({ type: 'slip' })] }, { turns: [turn({ type: 'auto' })] }], t => t.type).get('rear-end-red-light:1'), 'slip');
  assert.equal(agreement({ turns: [turn({ turn: 7, type: 'slip' })] }, reference, t => t.type), 1);
  assert.equal(agreement(twoTurns, both, t => t.type, t => t.turn === 1), 1);
  // null is an answer like any other ("no tier"), and is compared as one.
  assert.equal(agreement({ turns: [turn({ leadTier: null })] }, new Map([['rear-end-red-light:1', null]]), t => t.leadTier), 1);
  assert.equal(agreement({ turns: [turn({ leadTier: 'hot' })] }, new Map([['rear-end-red-light:1', null]]), t => t.leadTier), 0);

  // Today's model against itself: how often two of its runs give the same answer, for the pair that agrees least.
  const four = types => ({ turns: types.map((type, i) => turn({ turn: i + 1, type })) });
  const [a, b, c] = [four(['x', 'x', 'x', 'x']), four(['x', 'x', 'x', 'y']), four(['x', 'x', 'y', 'y'])];
  // A and B agree on 3 of 4, B and C on 3 of 4, A and C on 2 of 4. The order the runs are named in changes nothing.
  for (const order of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) assert.equal(selfAgreement(order, t => t.type), 0.5);
  assert.equal(selfAgreement([a, b], t => t.type), 0.75);
  assert.equal(selfAgreement([four(['x', 'y']), four(['x', 'y']), four(['x', 'y'])], t => t.type), 1);
  // Only the turns the third argument lets through are compared.
  assert.equal(selfAgreement([a, b, c], t => t.type, t => t.turn <= 2), 1);
  // One run has nothing to be compared with: how well the model agrees with itself is then not known.
  assert.equal(selfAgreement([a], t => t.type), null);
  assert.equal(selfAgreement([], t => t.type), null);
});

test("a small-job model is judged on usable answers, agreement with today's, the lead score, the drafts it catches and each job's own time", () => {
  const reference = {
    type: new Map([['rear-end-red-light:1', 'auto'], ['rear-end-red-light:2', 'auto'], ['rear-end-red-light:3', 'auto'], ['seminar-auto:1', 'auto']]),
    tier: new Map([['rear-end-red-light:2', 'hot'], ['rear-end-red-light:3', null], ['seminar-auto:1', 'hot']]),
    verdict: new Map([['rear-end-red-light:1', true], ['rear-end-red-light:2', true], ['rear-end-red-light:3', false], ['seminar-auto:1', true]]),
  };
  const run = { answer: 'gpt-4o', aux: 'gpt-6-luna', knownBadFromCall: 5,
    turns: [
      turn({ turn: 1, classifiedType: 'auto' }),
      turn({ turn: 2, classifiedType: 'slip', leadTier: 'hot', leadScore: '80', leadVerdict: true }),
      turn({ turn: 3, classifiedType: 'auto', leadTier: 'warm', leadScore: 60, leadVerdict: true, caseCard: false, firstPassCompliant: false }),
      turn({ visitor: 'seminar-auto', turn: 1, classifiedType: 'auto', evaluator: 'deterministic_fallback' }),
    ],
    knownBad: [{ key: 'asks-for-phone', caught: true }, { key: 'no-law-named', caught: false }],
    calls: [
      { model: 'gpt-6-luna', job: 'classify', inputTokens: 1_000_000, outputTokens: 0, ms: 500, json: true },
      { model: 'gpt-6-luna', job: 'classify', inputTokens: 0, outputTokens: 0, ms: 700, json: true },
      { model: 'gpt-6-luna', job: 'grade', inputTokens: 0, outputTokens: 1_000_000, ms: 3000, json: true },
      { model: 'gpt-6-luna', job: 'grade', inputTokens: 0, outputTokens: 0, ms: 5000, json: false },
      { model: 'gpt-4o', job: 'rewrite', inputTokens: 1_000_000, outputTokens: 0, ms: 9000 },
      { model: 'gpt-6-luna', job: 'grade', inputTokens: 1_000_000, outputTokens: 0, ms: 100, json: true },
    ],
    failed: [{ model: 'gpt-6-luna', job: 'leadScore', status: 429, ms: 10 }, { model: 'gpt-4o', job: 'rewrite', status: 500, ms: 10 }],
  };
  const stats = smallStats(run, reference, 65, context);
  // The checks: the grader's answer usable on each of 4 turns (3 were); a lead score there on turns 2 and 3 (both);
  // a case card there on turn 3 (it was not); five answers that had to be JSON (4 were). 9 of 12. The seminar turn is
  // due neither a lead score nor a case card.
  close(stats.jsonValidRate, 9 / 12);
  // A small-job call that failed outright is counted apart, with what it failed on: it may be the account's rate
  // limit and not the model, and the call is made again. The answer model's failed call is no small job.
  assert.equal(stats.failedCalls, 1);
  assert.equal(stats.failedCallSummary, '429 x1');
  assert.equal(stats.typeAgreement, 3 / 4);
  // Both people were written as motor-vehicle cases, and three of the four turns were classified so. A visitor
  // written with no definite type ("other") has no right answer to be held to.
  assert.equal(stats.typeRight, 3 / 4);
  const noneDefinite = PEOPLE.map(person => ({ ...person, caseType: 'other' }));
  assert.equal(smallStats(run, reference, 65, { ...context, visitors: noneDefinite }).typeRight, null);
  assert.equal(smallStats(run, reference, 65, { ...context, visitors: [PEOPLE[0], { ...PEOPLE[1], caseType: 'slip' }] }).typeRight, 2 / 4);
  assert.equal(stats.tierAgreement, 1 / 2);
  assert.equal(stats.verdictAgreement, 1);
  assert.equal(stats.averageLeadScore, 70);
  assert.equal(stats.leadScoreShift, 5);
  assert.deepEqual(stats.knownBadCaught, ['asks-for-phone']);
  // Each job is timed on its own calls, and the rule is applied to the slowest of the jobs.
  assert.deepEqual(stats.jobs.classify, { calls: 2, failed: 0, medianMs: 500, slowestTenthMs: 700, jsonValid: 1 });
  assert.deepEqual(stats.jobs.grade, { calls: 3, failed: 0, medianMs: 3000, slowestTenthMs: 5000, jsonValid: 2 / 3 });
  // A call that failed is timed with its job, for as long as it took.
  assert.deepEqual(stats.jobs.leadScore, { calls: 0, failed: 1, medianMs: 10, slowestTenthMs: 10, jsonValid: 1 });
  assert.deepEqual(Object.keys(stats.jobs), ['classify', 'leadScore', 'grade']);
  assert.equal(stats.slowestTenthMs, 5000);
  assert.equal(stats.slowestJob, 'grade');
  // gpt-6-luna at 0.10 and 0.50, before the known-bad drafts: 0.10 in and 0.50 out, over two visitors.
  close(stats.costPerConversation, 0.3);
});

test("the reply bar is today's worst run, and ten seconds for the slowest tenth of the reply's own calls", () => {
  // "At least as often as today's worst run" is judged on how many turns did not pass, not on a share: a draft or
  // two may be left out of one run's rates and not another's, and one turn not passed is one turn in either.
  const baselines = [{ finalFailures: 2, unanchoredFirstDrafts: 1, seminarFinalFailures: 0 }, { finalFailures: 4, unanchoredFirstDrafts: 3, seminarFinalFailures: 1 }];
  assert.deepEqual(replyBar({ finalFailures: 4, unanchoredFirstDrafts: 3, seminarFinalFailures: 1, replySlowestTenthMs: 10000 }, baselines), { ok: true, reasons: [], failed: [] });
  const failed = replyBar({ finalFailures: 5, unanchoredFirstDrafts: 4, seminarFinalFailures: 2, replySlowestTenthMs: 10001 }, baselines);
  assert.equal(failed.ok, false);
  assert.equal(failed.reasons.length, 4);
  assert.deepEqual(failed.failed, ['finalPass', 'unanchored', 'seminar', 'speed']);
  assert.match(failed.reasons[0], /^5 turns did not pass after the rewrite, more than in today's worst run \(4\)$/);
  assert.match(replyBar({ finalFailures: 5, unanchoredFirstDrafts: 0, seminarFinalFailures: 0, replySlowestTenthMs: 1 }, [{ finalFailures: 0, unanchoredFirstDrafts: 0, seminarFinalFailures: 0 }]).reasons[0], /^5 turns did not pass/);
  assert.match(replyBar({ finalFailures: 1, unanchoredFirstDrafts: 1, seminarFinalFailures: 1, replySlowestTenthMs: 1 }, [{ finalFailures: 0, unanchoredFirstDrafts: 0, seminarFinalFailures: 0 }]).reasons.join('; '),
    /^1 turn did not pass after the rewrite, more than in today's worst run \(0\); 1 first draft cites a case that could not be anchored, more than in today's worst run \(0\); 1 seminar turn did not pass, more than in today's worst run \(0\)$/);
  // A run with no reply call to time has not shown its speed.
  assert.deepEqual(replyBar({ finalFailures: 0, unanchoredFirstDrafts: 0, seminarFinalFailures: 0, replySlowestTenthMs: null }, baselines).failed, ['speed']);
  // Today's grader's answer is now and then cut off, and that draft is then graded by code alone: such drafts are
  // left out of the pass rates. A run in which more than a tenth went that way is not a measurement of its model.
  const mostlyGraded = { finalFailures: 0, unanchoredFirstDrafts: 0, seminarFinalFailures: 0, replySlowestTenthMs: 1000, turns: 45, ungradedFirstDrafts: 2 };
  assert.deepEqual(replyBar(mostlyGraded, baselines).failed, []);
  assert.deepEqual(replyBar({ ...mostlyGraded, ungradedFirstDrafts: 4 }, baselines).failed, []);
  const halfGraded = replyBar({ ...mostlyGraded, ungradedFirstDrafts: 5 }, baselines);
  assert.deepEqual(halfGraded.failed, ['graded']);
  assert.match(halfGraded.reasons[0], /5 of its 45 first drafts were graded by code alone/);
});

test("the small-job bar wants usable answers every time, today's own agreement, a steady lead score, every draft today's model catches, and four seconds", () => {
  const pass = { jsonValidRate: 1, typeAgreement: 0.9, tierAgreement: 0.8, verdictAgreement: 0.85, leadScoreShift: -3, knownBadCaught: ['asks-for-phone', 'no-law-named'], slowestTenthMs: 4000 };
  assert.deepEqual(smallBar(pass, { typeAgreement: 0.9, tierAgreement: 0.8, verdictAgreement: 0.85 }, ['asks-for-phone']), { ok: true, reasons: [], failed: [] });
  const failed = smallBar({ ...pass, jsonValidRate: 0.98, leadScoreShift: 3.5, knownBadCaught: [], slowestTenthMs: 4001 }, { typeAgreement: 0.95, tierAgreement: 0.8, verdictAgreement: 0.9 }, ['asks-for-phone']);
  assert.equal(failed.ok, false);
  assert.equal(failed.reasons.length, 6);
  assert.deepEqual(failed.failed, ['json', 'type', 'verdict', 'leadScore', 'knownBad', 'speed']);
  // With no small-job run of today's model, or only one, there is nothing to hold a candidate to: it does not pass.
  assert.deepEqual(smallBar(pass, null, []).failed, ['baseline']);
  const once = smallBar(pass, { typeAgreement: null, tierAgreement: null, verdictAgreement: null }, []);
  assert.deepEqual(once.failed, ['baseline']);
  assert.match(once.reasons[0], /run once/);
  // With no lead scored at all there is no shift to judge, and that is not a failure of the lead score rule.
  assert.deepEqual(smallBar({ ...pass, leadScoreShift: null }, { typeAgreement: 0.9, tierAgreement: 0.8, verdictAgreement: 0.85 }, []).failed, []);
});

test("each model's limit for a job is twice the slowest tenth of its calls, never over the cap, and the calls that would have run past it are counted", () => {
  const timed = (model, job, times) => times.map(ms => ({ model, job, inputTokens: 0, outputTokens: 0, ms }));
  const runs = [
    {
      calls: [
        ...timed('gpt-6-luna', 'grade', [500, 600, 700, 800, 900, 1000, 1100, 1200, 1349, 5000]),
        ...timed('gpt-6-luna', 'classify', [...Array(10).fill(6000), 9000]),
        ...timed('gpt-6-luna', 'studentScore', [9000, 100, 100, 100]),
        ...timed('gpt-6-luna', 'leadScore', Array(9).fill(400)),
        // A call whose job is not known is left out.
        { model: 'gpt-6-luna', inputTokens: 0, outputTokens: 0, ms: 90_000 },
      ],
      // A call that failed is timed with its job, for as long as it took.
      failed: [{ model: 'gpt-6-luna', job: 'leadScore', status: 429, ms: 50 }],
    },
    { calls: [...timed('gpt-6.1-terra', 'reply', [...Array(9).fill(2000), 4000]), ...timed('gpt-6.1-terra', 'rewrite', [3000, 5000, 1000])], failed: [] },
    { calls: [...timed('gpt-5.4-mini', 'reply', [3000, 3000]), ...timed('gpt-5.4-mini', 'rewrite', [25_000])] },
  ];
  const rows = timeLimits(runs, { adapter: ADAPTER });
  // Each model in the runs, and each job it did, in the order the jobs are named.
  assert.deepEqual(rows.map(row => `${row.model} ${row.job}`), [
    'gpt-6-luna classify', 'gpt-6-luna leadScore', 'gpt-6-luna studentScore', 'gpt-6-luna grade',
    'gpt-6.1-terra reply', 'gpt-6.1-terra rewrite', 'gpt-5.4-mini reply', 'gpt-5.4-mini rewrite',
  ]);
  const row = (model, job) => rows.find(candidate => candidate.model === model && candidate.job === job);
  // Twice a slowest tenth of 1,349 ms is 2,698, rounded up to the next 100 ms; one call took longer.
  assert.deepEqual(row('gpt-6-luna', 'grade'), { model: 'gpt-6-luna', job: 'grade', calls: 10, slowestTenthMs: 1349, limitMs: 2700, setBy: 'times', over: 1 });
  // Twice 6 seconds is over the 8 seconds a small job is given at most.
  assert.deepEqual(row('gpt-6-luna', 'classify'), { model: 'gpt-6-luna', job: 'classify', calls: 11, slowestTenthMs: 6000, limitMs: capFor('classify'), setBy: 'cap', over: 1 });
  assert.equal(capFor('classify'), 8000);
  // The failed call counts among the ten.
  assert.deepEqual(row('gpt-6-luna', 'leadScore'), { model: 'gpt-6-luna', job: 'leadScore', calls: 10, slowestTenthMs: 400, limitMs: 800, setBy: 'times', over: 0 });
  // Fewer than ten calls are too few to set a limit by: a small job is given the cap, and a rewrite the model's
  // limit for the reply, which with too few replies is the cap for a reply.
  assert.deepEqual(row('gpt-6-luna', 'studentScore'), { model: 'gpt-6-luna', job: 'studentScore', calls: 4, slowestTenthMs: 9000, limitMs: 8000, setBy: 'few', over: 1 });
  assert.deepEqual(row('gpt-6.1-terra', 'reply'), { model: 'gpt-6.1-terra', job: 'reply', calls: 10, slowestTenthMs: 2000, limitMs: 4000, setBy: 'times', over: 0 });
  assert.deepEqual(row('gpt-6.1-terra', 'rewrite'), { model: 'gpt-6.1-terra', job: 'rewrite', calls: 3, slowestTenthMs: 5000, limitMs: 4000, setBy: 'reply', over: 1 });
  assert.deepEqual(row('gpt-5.4-mini', 'reply'), { model: 'gpt-5.4-mini', job: 'reply', calls: 2, slowestTenthMs: 3000, limitMs: capFor('reply'), setBy: 'few', over: 0 });
  assert.equal(capFor('reply'), 20_000);
  assert.deepEqual(row('gpt-5.4-mini', 'rewrite'), { model: 'gpt-5.4-mini', job: 'rewrite', calls: 1, slowestTenthMs: 25_000, limitMs: 20_000, setBy: 'reply', over: 1 });

  // The table the report command prints: a row for each, whole, saying how each limit was set.
  const lines = renderLimits(rows).split('\n');
  assert.equal(lines[0], '| Model | Job | Calls | Slowest tenth | Limit | Set by | Calls over the limit |');
  assert.equal(lines.length, rows.length + 2);
  for (const line of lines.slice(2)) assert.equal(line.split('|').length, lines[0].split('|').length, line);
  assert.ok(lines.includes('| gpt-6-luna | grade | 10 | 1.3s | 2.7s | twice the slowest tenth | 1 |'));
  assert.ok(lines.includes('| gpt-6-luna | classify | 11 | 6.0s | 8.0s | the cap | 1 |'));
  assert.ok(lines.includes('| gpt-6-luna | studentScore | 4 | 9.0s | 8.0s | the cap: fewer than 10 calls | 1 |'));
  assert.ok(lines.includes("| gpt-6.1-terra | rewrite | 3 | 5.0s | 4.0s | the reply's: fewer than 10 calls | 1 |"));
  assert.deepEqual(timeLimits([], { adapter: ADAPTER }), []);
});

test('the report command is told which runs are which, and refuses what it cannot read as a run', () => {
  assert.deepEqual(parseReportArgs(['--app', 'nycinjury', '--baseline', 'base-1,base-2,base-3', '--small-baseline', 'small-base-1', '--replies', 'reply-a,reply-b', '--smalls', 'small-a', '--samples', 'reply-a', '--note', 'one', '--note', 'two']),
    { app: 'nycinjury', baseline: ['base-1', 'base-2', 'base-3'], smallBaseline: ['small-base-1'], replies: ['reply-a', 'reply-b'], smalls: ['small-a'], pairs: [], samples: ['reply-a'], notes: ['one', 'two'] });
  assert.deepEqual(parseReportArgs(['--app', 'nycinjury', '--baseline', 'base-1', '--pairs', 'pair-a,pair-b']),
    { app: 'nycinjury', baseline: ['base-1'], smallBaseline: [], replies: [], smalls: [], pairs: ['pair-a', 'pair-b'], samples: [], notes: [] });
  assert.throws(() => parseReportArgs(['--app', 'nycinjury']), /--baseline/);
  assert.throws(() => parseReportArgs(['--baseline', 'base-1']), /--app/);
  assert.throws(() => parseReportArgs(['--app', 'nycinjury', '--baseline', 'base-1,../x']), /label/);
  assert.throws(() => parseReportArgs(['--app', 'nycinjury', '--baseline', 'base-1', '--fast']), /--fast/);
});

test('the report refuses runs that are not what their flags say', () => {
  const made = (label, over = {}) => ({ app: 'nycinjury', label, mode: 'reply', answer: 'gpt-4o', aux: 'gpt-4o-mini', turns: [], finishedAt: '2026-11-20T20:10:00.000Z', ...over });
  const good = {
    app: 'nycinjury',
    baseline: [made('base-1', { mode: 'record' }), made('base-2')],
    smallBaseline: [made('small-base-1', { mode: 'small', from: 'base-1' })],
    replies: [made('reply-sol', { answer: 'gpt-6.2-sol' })],
    smalls: [made('small-luna', { mode: 'small', aux: 'gpt-6-luna', from: 'base-1' })],
  };
  assert.deepEqual(checkRuns(good), []);
  assert.deepEqual(checkRuns({ ...good, smallBaseline: [], replies: [], smalls: [] }), []);
  const first = over => checkRuns({ ...good, ...over })[0];
  // Another app's run; a "today's" run that used another model; a reply run graded by another small model.
  assert.match(first({ replies: [made('reply-sol', { answer: 'gpt-6.2-sol', app: 'nycmalpractice' })] }), /reply-sol was run on nycmalpractice, not nycinjury/);
  assert.match(first({ baseline: [good.baseline[0], made('base-2', { answer: 'gpt-4.1' })] }), /base-2 used gpt-4\.1 with gpt-4o-mini, not today's gpt-4o with gpt-4o-mini/);
  assert.match(first({ replies: [made('reply-sol', { answer: 'gpt-6.2-sol', aux: 'gpt-6-luna' })] }), /reply-sol was graded by gpt-6-luna, not today's gpt-4o-mini/);
  // A small-job run among the reply runs, and the other way about.
  assert.match(first({ replies: [good.smalls[0]] }), /small-luna is a small-job run, given as a reply run/);
  assert.match(first({ smalls: [good.replies[0]] }), /reply-sol is not a small-job run/);
  assert.match(first({ baseline: [good.smallBaseline[0]] }), /small-base-1 is a small-job run, given as a reply run/);
  // A small-job run whose drafts are not today's, or were not written by today's reply model.
  assert.match(first({ smalls: [made('small-luna', { mode: 'small', aux: 'gpt-6-luna', from: 'reply-sol' })] }), /small-luna took its drafts from reply-sol, which is not one of today's runs/);
  assert.match(first({ smalls: [made('small-luna', { mode: 'small', answer: 'gpt-6.2-sol', aux: 'gpt-6-luna', from: 'base-1' })] }), /small-luna had its rewrites written by gpt-6\.2-sol, not today's gpt-4o/);
  assert.match(first({ smallBaseline: [made('small-base-1', { mode: 'small', aux: 'gpt-6-luna', from: 'base-1' })] }), /small-base-1 used gpt-4o with gpt-6-luna, not today's gpt-4o with gpt-4o-mini/);
  // A run with both models changed is given as a pair, and may be any reply run; a small-job run is not one.
  assert.deepEqual(checkRuns({ ...good, pairs: [made('pair-luna-luna', { answer: 'gpt-6-luna', aux: 'gpt-6-luna' })] }), []);
  assert.match(first({ pairs: [good.smalls[0]] }), /small-luna is a small-job run, given as a pair/);
  assert.match(first({ pairs: [made('pair-x', { answer: 'gpt-6-luna', aux: 'gpt-6-luna', app: 'nycmalpractice' })] }), /pair-x was run on nycmalpractice, not nycinjury/);
  // The same run named twice, and a run that was stopped part-way.
  assert.match(first({ replies: [good.replies[0], good.replies[0]] }), /reply-sol is given twice/);
  assert.match(first({ replies: [made('reply-sol', { answer: 'gpt-6.2-sol', finishedAt: undefined })] }), /reply-sol is a run that was stopped part-way/);
});

// Runs small enough to read: one visitor with three turns and one seminar student with one.
function reportRun({ label, mode, answer, aux, from, over = () => ({}), knownBad = [], replyMs = 2000, gradeMs = 3000 }) {
  const turns = [
    turn({ turn: 1, classifiedType: mode === 'small' ? 'auto' : null }),
    turn({ turn: 2, classifiedType: mode === 'small' ? 'auto' : null, leadTier: 'hot', leadScore: 80, leadVerdict: true }),
    turn({ turn: 3, classifiedType: mode === 'small' ? 'auto' : null, leadTier: 'hot', leadScore: 82, leadVerdict: true, caseCard: true }),
    turn({ visitor: 'seminar-auto', turn: 1, classifiedType: mode === 'small' ? 'auto' : null }),
  ].map(made => ({ ...made, served: `${label} says: reply ${made.visitor} ${made.turn}`, ...over(made) }));
  const calls = [];
  for (const made of turns) {
    if (mode !== 'small') calls.push({ model: answer, job: 'reply', inputTokens: 3000, outputTokens: 300, ms: replyMs, finish: 'stop' });
    calls.push({ model: aux, job: 'grade', inputTokens: 3300, outputTokens: 400, ms: gradeMs, json: true, finish: 'stop' });
    if (mode === 'small') calls.push({ model: aux, job: 'classify', inputTokens: 150, outputTokens: 16, ms: 800, json: true, finish: 'stop' });
  }
  return { app: 'nycinjury', label, mode, answer, aux, ...(from ? { from } : {}), startedAt: '2026-11-20T20:00:00.000Z', turns, knownBad, calls, failed: [], refused: [], ...(mode === 'small' ? { knownBadFromCall: calls.length } : {}) };
}

test('the report sets each run beside the bar, names what passes cheapest first, and says where a candidate differs from today', () => {
  // Today's grader catches both drafts, the second under a rule other than the one it breaks.
  const caught = [{ key: 'asks-for-phone', breaks: 'PROH-PI-03', caught: true, flagged: ['PROH-PI-03'] }, { key: 'no-law-named', breaks: 'REQ-PI-02', caught: true, flagged: ['REQ-PI-01'] }];
  const baseline = ['base-1', 'base-2', 'base-3'].map(label => reportRun({ label, mode: label === 'base-1' ? 'record' : 'reply', answer: 'gpt-4o', aux: 'gpt-4o-mini' }));
  const smallBaseline = ['small-base-1', 'small-base-2', 'small-base-3'].map(label => reportRun({ label, mode: 'small', answer: 'gpt-4o', aux: 'gpt-4o-mini', from: 'base-1', knownBad: caught }));
  const replies = [
    reportRun({ label: 'reply-sol', mode: 'reply', answer: 'gpt-6.2-sol', aux: 'gpt-4o-mini' }),
    reportRun({ label: 'reply-luna', mode: 'reply', answer: 'gpt-6-luna', aux: 'gpt-4o-mini' }),
    reportRun({ label: 'reply-terra', mode: 'reply', answer: 'gpt-6.1-terra', aux: 'gpt-4o-mini', over: made => (made.turn === 3 ? { gateStatus: 'BLOCKED', firstPassCompliant: false, firstDraftFlagged: ['REQ-PI-02'] } : {}) }),
  ];
  const smalls = [
    reportRun({ label: 'small-luna', mode: 'small', answer: 'gpt-4o', aux: 'gpt-6-luna', from: 'base-1', knownBad: caught }),
    reportRun({ label: 'small-nano', mode: 'small', answer: 'gpt-4o', aux: 'gpt-5.4-nano', from: 'base-1', knownBad: [caught[0], { ...caught[1], caught: false, flagged: [] }],
      over: made => (made.visitor === 'rear-end-red-light' && made.turn === 2 ? { classifiedType: 'slip', leadTier: 'warm' } : {}) }),
  ];
  const text = renderReport({ app: 'nycinjury', date: '2026-11-20', baseline, smallBaseline, replies, smalls, notes: ['gpt-5.4-nano is retired on 1 April 2027.'], ...context });

  assert.match(text, /^# Model measurement for nycinjury, 2026-11-20\n/);
  for (const heading of ['## Reply models', "### Each reply model's time, cost and trouble", '## Small-job models', "### Each small job's time", '### The drafts that are wrong on purpose', '## What passes', '## What a conversation costs', "## Where a small-job candidate differs from today's usual answer", '## Cheap first, stronger on a block', '## Notes']) {
    assert.ok(text.includes(`\n${heading}\n`), `the report has no "${heading}"`);
  }
  // Every table is whole: each row has as many cells as its heading.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\|[-| :]+\|$/.test(lines[i])) continue;
    const cells = lines[i - 1].split('|').length;
    for (let row = i + 1; row < lines.length && lines[row].startsWith('|'); row++) assert.equal(lines[row].split('|').length, cells, lines[row]);
  }
  const rowOf = label => lines.find(line => line.startsWith(`| ${label} |`));
  assert.match(rowOf('base-1'), /\| gpt-4o \|/);
  assert.match(rowOf('reply-sol'), /\| passes \|$/);
  // The run that left a turn blocked is set beside the rule it missed, and is not among what passes.
  assert.match(rowOf('reply-terra'), /1 turn did not pass after the rewrite, more than in today's worst run \(0\)/);
  assert.match(rowOf('small-luna'), /\| passes \|$/);
  assert.match(rowOf('small-nano'), /did not catch no-law-named/);
  // Draft by draft: caught under the rule it breaks, caught under another rule, or not caught.
  assert.equal(rowOf('asks-for-phone'), '| asks-for-phone | PROH-PI-03 | caught | caught | caught | caught | caught |');
  assert.equal(rowOf('no-law-named'), '| no-law-named | REQ-PI-02 | caught under REQ-PI-01 | caught under REQ-PI-01 | caught under REQ-PI-01 | caught under REQ-PI-01 | NOT caught |');
  const passes = text.slice(text.indexOf('## What passes'), text.indexOf('## What a conversation costs'));
  // Cheapest first: gpt-6-luna before gpt-6.2-sol; gpt-6.1-terra and gpt-5.4-nano did not pass.
  assert.ok(passes.indexOf('gpt-6-luna') < passes.indexOf('gpt-6.2-sol') && passes.indexOf('gpt-6-luna') > 0);
  assert.doesNotMatch(passes.split('did not pass')[0], /gpt-6\.1-terra|gpt-5\.4-nano/);
  // Where the candidate differs, turn by turn, with both answers.
  const differs = text.slice(text.indexOf("## Where a small-job candidate differs"), text.indexOf('## Cheap first'));
  assert.match(differs, /small-nano.*rear-end-red-light, turn 2.*case type slip, where today's says auto/s);
  assert.match(differs, /lead tier warm, where today's says hot/);
  assert.match(text, /gpt-5\.4-nano is retired on 1 April 2027\./);
  assert.match(text, /does not count the classification and the search/);
  assert.match(text, /The pass rates are counted over the first drafts the model grader graded/);
  assert.match(text, /the pair of its runs that agrees least/);
  assert.match(text, /\| Case type right, where the visitor was written with one \|/);
  assert.doesNotMatch(text, /undefined|NaN|\[object/);

  // Runs with both models changed together are set out apart, and not held to the bar.
  assert.doesNotMatch(text, /Both models changed together/);
  const paired = renderReport({ app: 'nycinjury', date: '2026-11-20', baseline, smallBaseline, replies, smalls, pairs: [reportRun({ label: 'pair-luna-luna', mode: 'reply', answer: 'gpt-6-luna', aux: 'gpt-6-luna' })], notes: [], ...context });
  assert.ok(paired.includes('\n## Both models changed together\n'));
  const pairRow = paired.split('\n').find(line => line.startsWith('| pair-luna-luna |'));
  assert.match(pairRow, /^\| pair-luna-luna \| gpt-6-luna \| gpt-6-luna \| 100% \| 100% \|/);
  assert.doesNotMatch(pairRow, /passes \|$/);
  // Four turns over two visitors, each with a reply (3,000 in, 300 out) and a grade (3,300 in, 400 out) at
  // gpt-6-luna's 0.10 and 0.50 a million: 0.00098 a turn, 0.00196 a conversation.
  assert.match(pairRow, /\| \$0\.002 \|$/);
  for (const [i, line] of paired.split('\n').entries()) {
    if (/^\|[-| :]+\|$/.test(line)) assert.equal(paired.split('\n')[i + 1].split('|').length, paired.split('\n')[i - 1].split('|').length, paired.split('\n')[i + 1]);
  }

  // An app with no seminar has no seminar column, and nothing is said of one.
  assert.match(text, /\| Seminar passes \|/);
  const plain = renderReport({ app: 'nycinjury', date: '2026-11-20', baseline, smallBaseline, replies, smalls, notes: [], ...context, adapter: { ...ADAPTER, SEMINAR_MODES: [] } });
  assert.doesNotMatch(plain, /[Ss]eminar/);
  for (const [i, line] of plain.split('\n').entries()) {
    if (/^\|[-| :]+\|$/.test(line)) assert.equal(plain.split('\n')[i + 1].split('|').length, plain.split('\n')[i - 1].split('|').length, plain.split('\n')[i + 1]);
  }

  // Small-job candidates with no run of today's small model beside them: none passes, and nothing is said to differ or not.
  const unheld = renderReport({ app: 'nycinjury', date: '2026-11-20', baseline, smallBaseline: [], replies: [], smalls, notes: [], ...context });
  assert.doesNotMatch(unheld.split('\n').find(line => line.startsWith('| small-luna |')), /\| passes \|$/);
  assert.match(unheld, /No small-job candidate passes every rule\./);
  assert.doesNotMatch(unheld, /nothing differs/);
  assert.doesNotMatch(unheld, /undefined|NaN|\[object/);

  // With nothing but today's runs the report still stands.
  const alone = renderReport({ app: 'nycinjury', date: '2026-11-20', baseline, smallBaseline: [], replies: [], smalls: [], notes: [], ...context });
  assert.match(alone, /## Reply models/);
  assert.doesNotMatch(alone, /undefined|NaN|\[object/);
});

test("the samples set each chosen run's replies beside today's, turn by turn, for the owner to read", () => {
  const baseline = reportRun({ label: 'base-1', mode: 'record', answer: 'gpt-4o', aux: 'gpt-4o-mini' });
  const candidate = reportRun({ label: 'reply-sol', mode: 'reply', answer: 'gpt-6.2-sol', aux: 'gpt-4o-mini' });
  const text = renderSamples({ app: 'nycinjury', date: '2026-11-20', runs: [baseline, candidate], visitorKeys: ['rear-end-red-light'], visitors: PEOPLE });
  assert.match(text, /^# Sample conversations for nycinjury, 2026-11-20\n/);
  const order = ['Message one.', 'base-1 says: reply rear-end-red-light 1', 'reply-sol says: reply rear-end-red-light 1', 'Message two.', 'base-1 says: reply rear-end-red-light 2', 'Message three.', 'reply-sol says: reply rear-end-red-light 3'];
  let at = -1;
  for (const piece of order) {
    const found = text.indexOf(piece, at + 1);
    assert.ok(found > at, `"${piece}" is missing or out of order`);
    at = found;
  }
  assert.match(text, /gpt-4o \(base-1\)/);
  assert.match(text, /gpt-6\.2-sol \(reply-sol\)/);
  assert.doesNotMatch(text, /seminar-auto/);
});

test("a call cut off at its time limit counts as over any limit, in the reply's speed, in a small job's and in each model's limits", () => {
  const cutOff = (model, job, ms = 8000) => ({ model, job, error: 'This operation was aborted', ms });
  // The same words as the SDKs' own timeouts, which the guard records as they come.
  const calls = [...Array(8)].map(() => ({ model: 'gpt-6.1-terra', job: 'reply', inputTokens: 0, outputTokens: 0, ms: 2000, finish: 'stop' }));
  const slow = replyStats({ answer: 'gpt-6.1-terra', aux: 'gpt-6-luna', turns: [], calls, failed: [cutOff('gpt-6.1-terra', 'reply', 8000), cutOff('gpt-6.1-terra', 'reply', 8000)] }, context);
  // Ten calls, two cut off at eight seconds: each one's own time is under the ten the bar allows, but they ran out of time.
  assert.equal(slow.replySlowestTenthMs, Infinity);
  assert.equal(slow.replyMedianMs, 2000);
  assert.equal(slow.replyCallsTimedOut, 2);
  const none = { finalFailures: 0, unanchoredFirstDrafts: 0, seminarFinalFailures: 0 };
  assert.match(replyBar({ ...slow, ...none }, [none]).reasons[0], /cut off at the time limit they were given/);
  // A refusal with a status, or an error of another kind, is no time limit.
  const refused = replyStats({ answer: 'gpt-6.1-terra', aux: 'gpt-6-luna', turns: [], calls, failed: [{ model: 'gpt-6.1-terra', job: 'reply', status: 429, ms: 100 }, { model: 'gpt-6.1-terra', job: 'reply', error: 'fetch failed', ms: 100 }] }, context);
  assert.equal(refused.replyCallsTimedOut, 0);
  assert.equal(refused.replySlowestTenthMs, 2000);
  for (const words of ['Request timed out.', 'Request was aborted.', 'The operation timed out', 'request timeout']) {
    assert.equal(replyStats({ answer: 'gpt-6.1-terra', aux: 'gpt-6-luna', turns: [], calls, failed: [{ model: 'gpt-6.1-terra', job: 'reply', error: words, ms: 5 }] }, context).replyCallsTimedOut, 1, words);
  }
  // Small jobs: the same, for the job's own slowest tenth.
  const smallCalls = [...Array(8)].map(() => ({ model: 'gpt-6-luna', job: 'grade', inputTokens: 0, outputTokens: 0, ms: 1000, json: true }));
  const small = smallStats({ answer: 'gpt-6.1-terra', aux: 'gpt-6-luna', turns: [], calls: smallCalls, failed: [cutOff('gpt-6-luna', 'grade'), cutOff('gpt-6-luna', 'grade')], knownBad: [] }, { type: new Map(), tier: new Map(), verdict: new Map() }, null, context);
  assert.equal(small.jobs.grade.slowestTenthMs, Infinity);
  assert.equal(small.callsTimedOut, 2);
  assert.equal(small.slowestTenthMs, Infinity);
  const passing = { jsonValidRate: 1, typeAgreement: 1, tierAgreement: 1, verdictAgreement: 1, leadScoreShift: null, knownBadCaught: [] };
  assert.match(smallBar({ ...small, ...passing }, { typeAgreement: 1, tierAgreement: 1, verdictAgreement: 1 }, []).reasons[0], /cut off at the time limit they were given/);
  // The limits: calls cut off count as over the limit, and when more than a tenth of a job's calls were cut off no time
  // can be said to be enough, so the job is given the cap.
  const timed = (job, ms) => ({ model: 'm', job, inputTokens: 0, outputTokens: 0, ms });
  const rows = timeLimits([{
    calls: [...Array(8)].map(() => timed('grade', 1000)), failed: [cutOff('m', 'grade', 2000), cutOff('m', 'grade', 2000)],
  }, {
    calls: [...Array(19)].map(() => timed('classify', 1000)), failed: [cutOff('m', 'classify', 2000)],
  }], { adapter: ADAPTER });
  assert.deepEqual(rows.find(row => row.job === 'grade'), { model: 'm', job: 'grade', calls: 10, slowestTenthMs: Infinity, limitMs: 8000, setBy: 'cap', over: 2 });
  // One in twenty cut off is not a tenth: the limit is set by the other calls, and the cut-off one is still counted over it.
  assert.deepEqual(rows.find(row => row.job === 'classify'), { model: 'm', job: 'classify', calls: 20, slowestTenthMs: 1000, limitMs: 2000, setBy: 'times', over: 1 });
  assert.ok(renderLimits(rows).split('\n').includes('| m | grade | 10 | past its time limit | 8.0s | the cap | 2 |'));
});

// ─── A report across three providers ──────────────────────────────────────────

// The runs the owner will set side by side: today's live pair as the baseline (graded by gpt-6-luna), candidates from
// the other two providers, and small-job candidates that took their drafts from the baseline's first run.
function threeProviderRuns({ scale = 1 } = {}) {
  const scaled = run => ({ ...run, finishedAt: '2026-11-22T10:00:00.000Z', calls: run.calls.map(call => ({ ...call, inputTokens: call.inputTokens * scale, outputTokens: call.outputTokens * scale })) });
  const caught = [{ key: 'asks-for-phone', breaks: 'PROH-PI-03', caught: true, flagged: ['PROH-PI-03'] }];
  const live = { answer: 'gpt-6.1-terra', aux: 'gpt-6-luna' };
  const baseline = ['providers-module', 'providers-clock', 'providers-settings'].map((label, i) => scaled(reportRun({ label, mode: i === 0 ? 'record' : 'reply', ...live })));
  const smallBaseline = ['small-luna-1', 'small-luna-2', 'small-luna-3'].map(label => scaled(reportRun({ label, mode: 'small', ...live, from: 'providers-module', knownBad: caught })));
  const replies = [
    scaled(reportRun({ label: 'reply-claude-sonnet', mode: 'reply', answer: 'claude-sonnet-5-5', aux: 'gpt-6-luna' })),
    scaled(reportRun({ label: 'reply-gemini-flash', mode: 'reply', answer: 'gemini-3.8-flash', aux: 'gpt-6-luna' })),
  ];
  const smalls = [
    scaled(reportRun({ label: 'small-claude-haiku', mode: 'small', answer: 'gpt-6.1-terra', aux: 'claude-haiku-5-5', from: 'providers-module', knownBad: caught })),
    scaled(reportRun({ label: 'small-gemini-lite', mode: 'small', answer: 'gpt-6.1-terra', aux: 'gemini-3.5-flash-lite', from: 'providers-module', knownBad: caught })),
  ];
  return { baseline, smallBaseline, replies, smalls };
}

test("the report takes runs from three providers, names each model's provider, and says who grades and that the comparison is with the models now live", () => {
  const runs = threeProviderRuns();
  assert.deepEqual(checkRuns({ app: 'nycinjury', ...runs }), []);
  const text = renderReport({ app: 'nycinjury', date: '2026-11-22', ...runs, notes: [], ...context });

  // The first paragraph: how many, which models are today's, who grades, and what the comparison is.
  const first = text.split('\n\n')[1];
  assert.match(first, /^2 synthetic visitors and 4 turns, played through the app's own reply pipeline\./);
  assert.ok(first.includes("Today's models, the ones now live, are `gpt-6.1-terra` for the reply and `gpt-6-luna` for the small jobs"), first);
  assert.ok(first.includes('Every reply run was graded by `gpt-6-luna`, held fixed whichever model wrote the reply'), first);
  assert.ok(first.includes('Runs of models that are no longer live are history and are no part of the comparison.'), first);

  // Each model's provider, from the registry, with its price.
  const lines = text.split('\n');
  assert.ok(text.includes('\n## The models and their providers\n'));
  const table = lines.slice(lines.indexOf('## The models and their providers') + 2);
  const rowOf = model => table.slice(0, 12).find(line => line.startsWith(`| ${model} |`));
  assert.equal(rowOf('gpt-6.1-terra'), '| gpt-6.1-terra | openai | the reply | $1.00 / $5.00 |');
  assert.equal(rowOf('gpt-6-luna'), '| gpt-6-luna | openai | the small jobs, grading every reply | $0.10 / $0.50 |');
  assert.equal(rowOf('claude-sonnet-5-5'), '| claude-sonnet-5-5 | anthropic | the reply | $2.00 / $10.00 |');
  assert.equal(rowOf('claude-haiku-5-5'), '| claude-haiku-5-5 | anthropic | the small jobs | $0.10 / $0.50 |');
  assert.equal(rowOf('gemini-3.8-flash'), '| gemini-3.8-flash | google | the reply | $0.75 / $3.75, then $1.50 / $7.50 from 2027-01-01 |');
  assert.equal(rowOf('gemini-3.5-flash-lite'), '| gemini-3.5-flash-lite | google | the small jobs | $0.30 / $2.50 |');
  // A model the registry does not hold is said not to be in it, and no table is broken.
  const odd = renderReport({ app: 'nycinjury', date: '2026-11-22', ...runs, replies: [{ ...runs.replies[0], label: 'reply-odd', answer: 'mystery-1' }], notes: [], ...context });
  assert.ok(odd.includes('| mystery-1 | not in the registry | the reply | no price on record |'));
  for (const [i, line] of lines.entries()) {
    if (/^\|[-| :]+\|$/.test(line)) assert.equal(lines[i + 1].split('|').length, lines[i - 1].split('|').length, lines[i + 1]);
  }
  assert.ok(text.includes("At each provider's published standard prices"));
  assert.doesNotMatch(text, /undefined|NaN|\[object|Infinity/);
});

test('the report says which models were cut off at their allowance and how many calls ran out of time, and gives a later price beside the price today', () => {
  const runs = threeProviderRuns({ scale: 1000 });
  // The Claude reply run had two replies cut off at their allowance and one reply call cut off at its time limit; the
  // Gemini small-job run had one answer cut off at its allowance and two small calls cut off at their limit.
  runs.replies[0].calls[0].finish = 'length';
  runs.replies[0].calls[2].finish = 'length';
  runs.replies[0].failed.push({ model: 'claude-sonnet-5-5', job: 'reply', error: 'This operation was aborted', ms: 9000 });
  runs.smalls[1].calls.find(call => call.job === 'grade').finish = 'length';
  runs.smalls[1].failed.push({ model: 'gemini-3.5-flash-lite', job: 'grade', error: 'Request timed out.', ms: 8000 }, { model: 'gemini-3.5-flash-lite', job: 'classify', error: 'This operation was aborted', ms: 8000 });
  const text = renderReport({ app: 'nycinjury', date: '2026-11-22', ...runs, notes: [], ...context });

  assert.ok(text.includes('\n### Answers cut off at their allowance\n'));
  assert.ok(text.includes('- `claude-sonnet-5-5` (reply-claude-sonnet): 2 replies cut off at its allowance: raise the headroom and measure again before judging.'));
  assert.ok(text.includes('- `gemini-3.5-flash-lite` (small-gemini-lite): 1 answer cut off at its allowance: raise the headroom and measure again before judging.'));
  // Nothing else is flagged: the other runs had none cut off.
  assert.equal(text.split('cut off at its allowance:').length - 1, 2);
  assert.ok(text.includes('\n### Calls cut off at their time limit\n'));
  const timedOut = ' It is counted as over any limit, so its slowest tenth is longer than what the table shows.';
  assert.ok(text.includes(`- \`claude-sonnet-5-5\` (reply-claude-sonnet): 1 reply call.${timedOut}`));
  assert.ok(text.includes(`- \`gemini-3.5-flash-lite\` (small-gemini-lite): 2 small-job calls.${timedOut}`));

  // The cost at a later price: Gemini 3.8 Flash (0.75 and 3.75, then 1.50 and 7.50) as the reply model. Six million tokens
  // in and 0.6 million out over a conversation: $6.750 today, $13.500 from 2027-01-01.
  const section = text.slice(text.indexOf('## At a later price'));
  assert.ok(text.includes('\n## At a later price\n'));
  assert.ok(section.includes('| reply-gemini-flash | gemini-3.8-flash | $6.750 | $13.500 | 2027-01-01 |'), section.slice(0, 700));
  // No model with a later price, no section; and a price already in force is no later price.
  assert.doesNotMatch(renderReport({ app: 'nycinjury', date: '2026-11-22', ...runs, replies: [runs.replies[0]], smalls: [runs.smalls[0]], notes: [], ...context }), /## At a later price/);
  assert.doesNotMatch(renderReport({ app: 'nycinjury', date: '2027-01-02', ...runs, notes: [], ...context }), /## At a later price/);
});

// ─── The upload to the site ───────────────────────────────────────────────────

// The runs of the report test above, under the name of this app, to be read by label as the command reads them.
function uploadRuns() {
  const caught = [{ key: 'asks-for-phone', breaks: 'PROH-PI-03', caught: true, flagged: ['PROH-PI-03'] }, { key: 'no-law-named', breaks: 'REQ-PI-02', caught: true, flagged: ['REQ-PI-01'] }];
  const runs = [
    ...['base-1', 'base-2', 'base-3'].map(label => reportRun({ label, mode: label === 'base-1' ? 'record' : 'reply', answer: 'gpt-4o', aux: 'gpt-4o-mini' })),
    ...['small-base-1', 'small-base-2', 'small-base-3'].map(label => reportRun({ label, mode: 'small', answer: 'gpt-4o', aux: 'gpt-4o-mini', from: 'base-1', knownBad: caught })),
    reportRun({ label: 'reply-sol', mode: 'reply', answer: 'gpt-6.2-sol', aux: 'gpt-4o-mini' }),
    reportRun({ label: 'reply-terra', mode: 'reply', answer: 'gpt-6.1-terra', aux: 'gpt-4o-mini', over: made => (made.turn === 3 ? { gateStatus: 'BLOCKED', firstPassCompliant: false, firstDraftFlagged: ['REQ-PI-02'] } : {}) }),
    // Slow only: it misses the speed rule and nothing else.
    reportRun({ label: 'reply-slow', mode: 'reply', answer: 'gpt-5.4', aux: 'gpt-4o-mini', replyMs: 12000 }),
    reportRun({ label: 'small-luna', mode: 'small', answer: 'gpt-4o', aux: 'gpt-6-luna', from: 'base-1', knownBad: caught }),
    reportRun({ label: 'small-nano', mode: 'small', answer: 'gpt-4o', aux: 'gpt-5.4-nano', from: 'base-1', knownBad: [caught[0], { ...caught[1], caught: false, flagged: [] }] }),
  ];
  return Object.fromEntries(runs.map(run => [run.label, { ...run, finishedAt: '2026-11-20T21:00:00.000Z' }]));
}
const UPLOAD_ADAPTER = { ...ADAPTER, APP: 'nycinjury' };
const UPLOAD_ARGV = ['--app', 'nycinjury', '--baseline', 'base-1,base-2,base-3', '--small-baseline', 'small-base-1,small-base-2,small-base-3',
  '--replies', 'reply-sol,reply-terra,reply-slow', '--smalls', 'small-luna,small-nano', '--site', 'https://nycinjury.ai'];
const SECRET = 'the-owners-admin-secret';

test("the upload makes a row for each candidate run only, judged as the report judges it, with the rules it missed, and dated by New York's calendar", () => {
  const runs = uploadRuns();
  const given = { baseline: ['base-1', 'base-2', 'base-3'].map(label => runs[label]), smallBaseline: ['small-base-1', 'small-base-2', 'small-base-3'].map(label => runs[label]),
    replies: ['reply-sol', 'reply-terra', 'reply-slow'].map(label => runs[label]), smalls: ['small-luna', 'small-nano'].map(label => runs[label]) };
  const rows = rowsFor(given, { price: estimateAiCost, visitors: PEOPLE, adapter: UPLOAD_ADAPTER });
  assert.deepEqual(rows.map(row => [row.role, row.model, row.runLabel]), [
    ['answer', 'gpt-6.2-sol', 'reply-sol'], ['answer', 'gpt-6.1-terra', 'reply-terra'], ['answer', 'gpt-5.4', 'reply-slow'],
    ['small', 'gpt-6-luna', 'small-luna'], ['small', 'gpt-5.4-nano', 'small-nano'],
  ], "today's own runs are not candidates, and a small-job run is a row for its small model");
  const byLabel = label => rows.find(row => row.runLabel === label);
  assert.deepEqual([byLabel('reply-sol').barOk, byLabel('reply-sol').qualityOk, byLabel('reply-sol').failed], [true, true, []]);
  // A turn left blocked misses the quality part; being slow alone misses the whole bar and not the quality part.
  assert.deepEqual([byLabel('reply-terra').barOk, byLabel('reply-terra').qualityOk, byLabel('reply-terra').failed], [false, false, ['finalPass']]);
  assert.deepEqual([byLabel('reply-slow').barOk, byLabel('reply-slow').qualityOk, byLabel('reply-slow').failed], [false, true, ['speed']]);
  assert.deepEqual([byLabel('small-nano').barOk, byLabel('small-nano').qualityOk, byLabel('small-nano').failed], [false, false, ['knownBad']]);
  // The same judging as the report: the bar of each row is the report's own.
  const scored = scoreRuns(given, { price: estimateAiCost, visitors: PEOPLE, adapter: UPLOAD_ADAPTER });
  assert.deepEqual(rows.map(row => row.barOk), [...scored.candidateReply, ...scored.candidateSmall].map(row => row.bar.ok));
  assert.equal(byLabel('reply-sol').measuredOn, '2026-11-20');
  assert.equal(byLabel('reply-sol').stats.turns, 4);
  // New York's date, not the machine's and not UTC's: five minutes past midnight UTC is still the evening before, and
  // so is three in the morning UTC in winter.
  assert.equal(measuredOn('2026-11-22T00:04:09.018Z'), '2026-11-21');
  assert.equal(measuredOn('2026-11-21T03:00:00.000Z'), '2026-11-20');
  assert.equal(measuredOn('2026-11-21T05:00:00.000Z'), '2026-11-21');
  assert.equal(measuredOn('2026-07-04T03:59:00.000Z'), '2026-07-03');
  assert.throws(() => measuredOn('not a date'));
});

test("the upload goes only to an https address, or this machine for a test, by its origin alone, and takes the report's run lists with --site and --yes", () => {
  assert.equal(siteOrigin('https://nycinjury.ai'), 'https://nycinjury.ai');
  assert.equal(siteOrigin('https://nycinjury.ai/some/path?token=1'), 'https://nycinjury.ai');
  assert.equal(siteOrigin('http://127.0.0.1:4180'), 'http://127.0.0.1:4180');
  assert.equal(siteOrigin('http://localhost:3000/x'), 'http://localhost:3000');
  for (const bad of ['http://nycinjury.ai', 'ftp://nycinjury.ai', 'https://user:pass@nycinjury.ai', 'nycinjury.ai', 'http://127.0.0.1.evil.test']) assert.throws(() => siteOrigin(bad), bad);
  const args = parseUploadArgs([...UPLOAD_ARGV, '--yes']);
  assert.deepEqual([args.site, args.yes, args.replies, args.smalls], ['https://nycinjury.ai', true, ['reply-sol', 'reply-terra', 'reply-slow'], ['small-luna', 'small-nano']]);
  assert.equal(parseUploadArgs(UPLOAD_ARGV).yes, false);
  assert.throws(() => parseUploadArgs(UPLOAD_ARGV.slice(0, -2)), /--site/);
  assert.throws(() => parseUploadArgs([...UPLOAD_ARGV, '--pairs', 'pair-a']), /--pairs/);
  assert.throws(() => parseUploadArgs([...UPLOAD_ARGV, '--note', 'x']), /--note/);
  assert.throws(() => parseUploadArgs([...UPLOAD_ARGV, '--secret', 'x']), /--secret/);
});

// Runs the command over the runs above with a stand-in fetch; gives its exit code, what it printed and said, and each request.
async function uploading(argv, { env = { ADMIN_SECRET_FOR_UPLOAD: SECRET }, answer = { saved: 5 }, status = 200, runs = uploadRuns() } = {}) {
  const printed = [];
  const failed = [];
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  };
  const code = await runUpload({
    argv, env, fetch, print: line => printed.push(line), fail: line => failed.push(line), adapter: UPLOAD_ADAPTER, price: estimateAiCost, visitors: PEOPLE,
    readRun: label => { if (!runs[label]) throw new Error(`there is no finished run named ${label} in measure/results`); return runs[label]; },
  });
  return { code, printed, failed, requests };
}

test('the upload prints what it will send and where, and sends nothing without --yes', async () => {
  const { code, printed, failed, requests } = await uploading(UPLOAD_ARGV);
  assert.equal(code, 0);
  assert.deepEqual(requests, []);
  assert.deepEqual(printed, [
    'Upload of the model measurements of nycinjury',
    '  to: https://nycinjury.ai/api/admin/models/measurements',
    '  rows: 5',
    '  answer  gpt-6.2-sol  reply-sol  2026-11-20  meets the bar  quality: met',
    '  answer  gpt-6.1-terra  reply-terra  2026-11-20  misses finalPass  quality: missed',
    '  answer  gpt-5.4  reply-slow  2026-11-20  misses speed  quality: met',
    '  small  gpt-6-luna  small-luna  2026-11-20  meets the bar  quality: met',
    '  small  gpt-5.4-nano  small-nano  2026-11-20  misses knownBad  quality: missed',
    'Nothing was sent. Run again with --yes to send these rows.',
  ]);
  assert.deepEqual(failed, []);
});

test('with --yes the upload sends the rows once, to the one address, with the secret in one header and nowhere else, and does not follow a redirect', async () => {
  const { code, printed, failed, requests } = await uploading([...UPLOAD_ARGV, '--yes']);
  assert.equal(code, 0);
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests;
  assert.equal(url, 'https://nycinjury.ai/api/admin/models/measurements');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['x-admin-secret'], SECRET);
  const body = JSON.parse(init.body);
  assert.equal(body.app, 'nycinjury');
  assert.equal(body.rows.length, 5);
  assert.deepEqual(Object.keys(body.rows[0]).sort(), ['barOk', 'failed', 'measuredOn', 'model', 'qualityOk', 'role', 'runLabel', 'stats']);
  assert.equal(JSON.stringify(body).includes(SECRET), false);
  assert.equal(printed.at(-1), 'The site stored 5 of 5 rows (a row it already held, unchanged, is not stored again).');
  assert.equal([...printed, ...failed, url].some(line => line.includes(SECRET)), false, 'the secret was printed');
});

test('the upload says what is wrong and sends nothing: no secret, a refused answer, runs that do not fit, another app, a run it cannot read', async () => {
  const noSecret = await uploading([...UPLOAD_ARGV, '--yes'], { env: {} });
  assert.equal(noSecret.code, 1);
  assert.match(noSecret.failed[0], /ADMIN_SECRET_FOR_UPLOAD is not set/);
  assert.deepEqual(noSecret.requests, []);

  // The site refuses; its words are shown and the secret is not among them, even if the site echoed it.
  const refused = await uploading([...UPLOAD_ARGV, '--yes'], { status: 401, answer: { error: `Unauthorized ${SECRET}` } });
  assert.equal(refused.code, 1);
  assert.match(refused.failed[0], /the site answered 401: Unauthorized \[secret withheld\]/);
  assert.equal(refused.failed.some(line => line.includes(SECRET)), false);
  const odd = await uploading([...UPLOAD_ARGV, '--yes'], { answer: { ok: true } });
  assert.equal(odd.code, 1);
  assert.match(odd.failed[0], /without saying how many rows/);

  // Runs that are not what their flags say: the report's own refusal.
  const runs = uploadRuns();
  runs['reply-sol'] = { ...runs['reply-sol'], finishedAt: undefined };
  const stopped = await uploading([...UPLOAD_ARGV, '--yes'], { runs });
  assert.equal(stopped.code, 1);
  assert.ok(stopped.failed.some(line => /reply-sol is a run that was stopped part-way/.test(line)), stopped.failed.join('|'));
  assert.deepEqual(stopped.requests, []);

  const other = await uploading(['--app', 'nycmalpractice', ...UPLOAD_ARGV.slice(2), '--yes']);
  assert.match(other.failed[0], /this is nycinjury, not nycmalpractice/);
  const missing = await uploading(UPLOAD_ARGV.map(word => (word === 'small-luna,small-nano' ? 'small-luna,small-gone' : word)));
  assert.match(missing.failed[0], /there is no finished run named small-gone/);
  const none = await uploading(['--app', 'nycinjury', '--baseline', 'base-1,base-2,base-3', '--site', 'https://nycinjury.ai', '--yes']);
  assert.equal(none.code, 1);
  assert.match(none.failed[0], /no candidate run was given/);
  const http = await uploading(UPLOAD_ARGV.map(word => (word === 'https://nycinjury.ai' ? 'http://nycinjury.ai' : word)));
  assert.match(http.failed[0], /must be an https address/);
  for (const result of [noSecret, refused, odd, stopped, other, missing, none, http]) assert.deepEqual(result.printed.filter(line => line.startsWith('The site stored')), []);
});

// ─── Chains, blocked hosts and a turn limit (the live failover runs) ──────────

const CHOSEN_ANSWER = 'gpt-6.1-terra,claude-haiku-5-5,gemini-3.5-flash-lite';
const CHOSEN_SMALL = 'gpt-6-luna,claude-haiku-5-5,gemini-3.5-flash-lite';
const parsing = (...rest) => parseArgs(['--label', 'three-providers-chosen', '--mode', 'reply', ...rest]);

test('--answer and --aux take a comma-separated chain, the first model of each stays as answer and aux, and a single model is a chain of one', () => {
  const chosen = parsing('--answer', CHOSEN_ANSWER, '--aux', CHOSEN_SMALL);
  assert.deepEqual(chosen.chains, { answer: ['gpt-6.1-terra', 'claude-haiku-5-5', 'gemini-3.5-flash-lite'], small: ['gpt-6-luna', 'claude-haiku-5-5', 'gemini-3.5-flash-lite'] });
  assert.equal(chosen.answer, 'gpt-6.1-terra');
  assert.equal(chosen.aux, 'gpt-6-luna');
  const single = parsing('--answer', 'gpt-6.1-terra', '--aux', 'gpt-6-luna');
  assert.deepEqual([single.answer, single.aux, single.chains], ['gpt-6.1-terra', 'gpt-6-luna', { answer: ['gpt-6.1-terra'], small: ['gpt-6-luna'] }]);
  // Spaces are not part of a name, and an empty or repeated entry is a mistake, not a shorter chain.
  assert.deepEqual(parsing('--answer', 'a, b', '--aux', 'c').chains.answer, ['a', 'b']);
  for (const bad of ['a,,b', 'a,', ',a', 'a,b,a']) {
    assert.throws(() => parsing('--answer', bad, '--aux', 'c'), /--answer/, bad);
    assert.throws(() => parsing('--answer', 'c', '--aux', bad), /--aux/, bad);
  }
});

test('every model of the chains must be in the registry before anything is sent, and the runner checks them before the keys, the settings, the guard or the app', () => {
  assert.doesNotThrow(() => checkChains(parsing('--answer', CHOSEN_ANSWER, '--aux', CHOSEN_SMALL)));
  assert.throws(() => checkChains(parsing('--answer', 'gpt-6.1-terra,gpt-9-imaginary', '--aux', 'gpt-6-luna')), /gpt-9-imaginary.*registry/);
  assert.throws(() => checkChains(parsing('--answer', 'gpt-6.1-terra', '--aux', 'gpt-6-luna,claude-nonesuch-1')), /claude-nonesuch-1.*registry/);
  const source = readFileSync(new URL('../measure/run.mjs', import.meta.url), 'utf8');
  const checked = source.indexOf('checkChains(args)');
  assert.ok(checked > 0, 'the runner never checks the chains');
  assert.ok(checked < source.indexOf('for (const name of keysFor(args))'), 'the chains are checked after the keys are asked for');
  assert.ok(checked < source.indexOf('Object.assign(process.env, environmentFor())'), 'the chains are checked after the run has begun');
});

test('--block-host may be given more than once, and takes only the three model hosts', () => {
  assert.deepEqual(parsing('--answer', 'x', '--aux', 'y').blockHosts, []);
  assert.deepEqual(parsing('--answer', 'x', '--aux', 'y', '--block-host', 'api.openai.com').blockHosts, ['api.openai.com']);
  assert.deepEqual(parsing('--answer', 'x', '--aux', 'y', '--block-host', 'api.openai.com', '--block-host', 'api.anthropic.com', '--block-host', 'api.openai.com').blockHosts, ['api.openai.com', 'api.anthropic.com']);
  for (const other of ['www.courtlistener.com', 'example.com', 'generativelanguage.googleapis.com/v1']) {
    assert.throws(() => parsing('--answer', 'x', '--aux', 'y', '--block-host', other), /--block-host/, other);
  }
  assert.throws(() => parsing('--answer', 'x', '--aux', 'y', '--block-host'), /--block-host needs a value/);
});

test('--turns is a whole number of turns above none, and is for runs that replay, not for a small-job run with drafts to grade', () => {
  assert.equal(parsing('--answer', 'x', '--aux', 'y').turns, null);
  assert.equal(parsing('--answer', 'x', '--aux', 'y', '--turns', '10').turns, 10);
  for (const bad of ['0', '-3', '1.5', 'ten', '10x']) assert.throws(() => parsing('--answer', 'x', '--aux', 'y', '--turns', bad), /--turns/, bad);
  assert.throws(() => parseArgs(['--label', 'a', '--mode', 'small', '--from', 'base-1', '--answer', 'x', '--aux', 'y', '--turns', '10']), /--turns/);
});

test('the guard refuses a blocked host as it refuses an unknown one, and keeps each blocked model call as a failure', async () => {
  const sent = [];
  const jobOf = request => (request.messages.length ? 'reply' : 'classify');
  const guard = installGuard({ allowHosts: [...MODEL_HOSTS], blockHosts: ['api.openai.com'], jobOf, fetchImpl: async (url) => { sent.push(String(url)); return json({ model: 'm', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }); } });
  const ask = (url, body) => fetch(url, { method: 'POST', body: JSON.stringify(body) });
  try {
    await assert.rejects(ask('https://api.openai.com/v1/chat/completions', { model: 'gpt-6.1-terra', messages: [{ role: 'user', content: 'x' }] }), /refused a request to api\.openai\.com/);
    await assert.rejects(ask('https://api.openai.com/v1/chat/completions', { model: 'gpt-6-luna', messages: [] }), /refused/);
    // A request that names no model is refused too, and is no model call.
    await assert.rejects(fetch('https://api.openai.com/v1/models'), /refused/);
    // The other model hosts still answer.
    assert.equal((await ask(GOOGLE_URL, { model: 'gemini-3.5-flash-lite', messages: [] })).status, 200);
  } finally { guard.restore(); }
  assert.deepEqual(sent, [GOOGLE_URL]);
  assert.deepEqual(guard.refused, ['api.openai.com', 'api.openai.com', 'api.openai.com']);
  assert.deepEqual(guard.failed.map(({ ms, ...rest }) => rest), [
    { host: 'api.openai.com', model: 'gpt-6.1-terra', job: 'reply', error: 'measure: refused a request to api.openai.com, which this run blocks' },
    { host: 'api.openai.com', model: 'gpt-6-luna', job: 'classify', error: 'measure: refused a request to api.openai.com, which this run blocks' },
  ]);
  assert.equal(guard.calls.length, 1);
});

test('with the first provider blocked, a chain goes on to the second, whose answer is the one recorded', async () => {
  const answered = { content: [{ type: 'text', text: 'From the second provider.' }], stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 9 } };
  const guard = installGuard({ allowHosts: [...MODEL_HOSTS], blockHosts: ['api.openai.com'], fetchImpl: async () => json(answered) });
  // The app's failover, in miniature: each model of the chain is tried in its turn, and a connection failure is a reason to go on.
  const chain = [['gpt-6.1-terra', 'https://api.openai.com/v1/chat/completions'], ['claude-haiku-5-5', ANTHROPIC_URL]];
  let served = null;
  try {
    for (const [model, url] of chain) {
      try {
        served = await (await fetch(url, { method: 'POST', body: JSON.stringify({ model, messages: [] }) })).json();
        break;
      } catch { /* the next provider */ }
    }
  } finally { guard.restore(); }
  assert.equal(served.content[0].text, 'From the second provider.');
  assert.deepEqual(guard.calls.map(call => [call.host, call.model]), [['api.anthropic.com', 'claude-haiku-5-5']]);
  assert.deepEqual(guard.failed.map(failure => [failure.host, failure.model]), [['api.openai.com', 'gpt-6.1-terra']]);
});

test("a run's estimate prices every model of each chain at its allowance, and a run of fewer turns costs its share", () => {
  const base = { answer: 'gpt-4o', aux: 'gpt-4o-mini', turns: [{}, {}, {}, {}], calls: [
    { model: 'gpt-4o', job: 'reply', inputTokens: 1_000_000, outputTokens: 100_000 },
    { model: 'gpt-4o', job: 'rewrite', inputTokens: 100_000, outputTokens: 10_000 },
    { model: 'gpt-4o-mini', job: 'grade', inputTokens: 2_000_000, outputTokens: 200_000 },
  ] };
  const pricing = { price: estimateAiCost, thinks: thinksOf, replyJobs: ADAPTER.REPLY_JOBS };
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);
  // One model each, as before: 4.27 and a quarter on top.
  near(estimateCost({ mode: 'reply', answer: 'gpt-4o', aux: 'gpt-4o-mini', chains: { answer: ['gpt-4o'], small: ['gpt-4o-mini'] } }, base, pricing), 4.27 * 1.25);
  // gpt-4o-mini behind gpt-4o for the reply: its price for the reply (0.15 + 0.06) and the rewrite (0.015 + 0.006) is added.
  const chained = { mode: 'reply', answer: 'gpt-4o', aux: 'gpt-4o-mini', chains: { answer: ['gpt-4o', 'gpt-4o-mini'], small: ['gpt-4o-mini'] } };
  near(estimateCost(chained, base, pricing), (4.27 + 0.231) * 1.25);
  // A second small-job model that thinks is priced for every small call, at its allowance.
  const thinking = estimateCost({ mode: 'reply', answer: 'gpt-4o', aux: 'gpt-4o-mini', chains: { answer: ['gpt-4o'], small: ['gpt-4o-mini', 'gemini-3.5-flash-lite'] } }, base, pricing);
  assert.ok(thinking > 4.27 * 1.25);
  // One turn of four: a quarter of it. More turns than the earlier run had cost no more than the whole.
  near(estimateCost({ ...chained, turns: 1 }, base, pricing), (4.27 + 0.231) * 1.25 / 4);
  near(estimateCost({ ...chained, turns: 9 }, base, pricing), (4.27 + 0.231) * 1.25);
});

test('a run asks for the key of every provider in its chains', () => {
  const chains = { answer: CHOSEN_ANSWER.split(','), small: CHOSEN_SMALL.split(',') };
  assert.deepEqual(keysFor({ mode: 'reply', answer: 'gpt-6.1-terra', aux: 'gpt-6-luna', chains }), ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']);
  assert.deepEqual(keysFor({ mode: 'record', answer: 'gpt-6.1-terra', aux: 'gpt-6-luna', chains: { answer: ['gpt-6.1-terra'], small: ['gpt-6-luna'] } }), ['OPENAI_API_KEY', 'COURTLISTENER_TOKEN']);
});

const FIVE_EACH = ['ann', 'ben', 'cat'].map(key => ({ key, mode: 'client', caseType: 'auto', messages: [1, 2, 3, 4, 5].map(n => `message ${n} from ${key}`) }));
const PACKETS_FOR_FIVE_EACH = Object.fromEntries(FIVE_EACH.map(visitor => [visitor.key, visitor.messages.map(() => ({ type: 'auto', cases: [] }))]));
const replying = (over, visitors = FIVE_EACH, packets = PACKETS_FOR_FIVE_EACH) =>
  measure({ args: runArgs({ mode: 'reply', ...over }), app: standInApp(), visitors, knownBad: [], store: memoryStore({ 'packets.json': packets }), guard: idleGuard(), pace: {} });

test('--turns runs only the first turns of the visitor list in its order, and the run says so', async () => {
  const standIn = standInApp();
  const store = memoryStore({ 'packets.json': PACKETS_FOR_FIVE_EACH });
  const { status, run } = await measure({ args: runArgs({ label: 'failover-1', mode: 'reply', turns: 10 }), app: standIn, visitors: FIVE_EACH, knownBad: [], store, guard: idleGuard(), pace: {} });
  assert.equal(status, 'complete');
  assert.equal(run.turns.length, 10);
  assert.deepEqual(run.turns.map(turn => `${turn.visitor}:${turn.turn}`), [...[1, 2, 3, 4, 5].map(n => `ann:${n}`), ...[1, 2, 3, 4, 5].map(n => `ben:${n}`)]);
  assert.equal(standIn.seen.reply.length, 10);
  assert.equal(run.turnLimit, 10);
  // Part-way through a visitor, and with more turns than there are.
  const partway = await replying({ label: 'failover-2', turns: 7 });
  assert.deepEqual(partway.run.turns.map(turn => `${turn.visitor}:${turn.turn}`).slice(-3), ['ann:5', 'ben:1', 'ben:2']);
  assert.equal((await replying({ label: 'failover-3', turns: 99 })).run.turns.length, 15);
  // Without the flag, every turn, and no limit is written into the run.
  const whole = await replying({ label: 'whole' });
  assert.equal(whole.run.turns.length, 15);
  assert.equal('turnLimit' in whole.run, false);
});

test("the run file records the chains and the blocked hosts, with answer and aux still the first model of each, and the guard's refusals as failures", async () => {
  const chains = { answer: CHOSEN_ANSWER.split(','), small: CHOSEN_SMALL.split(',') };
  const guard = { calls: [], failed: [{ host: 'api.openai.com', model: 'gpt-6.1-terra', job: 'reply', error: 'refused', ms: 0 }], refused: ['api.openai.com'] };
  const args = runArgs({ label: 'failover-1', mode: 'reply', answer: 'gpt-6.1-terra', aux: 'gpt-6-luna', chains, blockHosts: ['api.openai.com'], turns: 2 });
  const { run } = await measure({ args, app: standInApp(), visitors: FIVE_EACH, knownBad: [], store: memoryStore({ 'packets.json': PACKETS_FOR_FIVE_EACH }), guard, pace: {} });
  assert.deepEqual([run.answer, run.aux], ['gpt-6.1-terra', 'gpt-6-luna']);
  assert.deepEqual(run.chains, chains);
  assert.deepEqual(run.blockedHosts, ['api.openai.com']);
  assert.deepEqual(run.refused, ['api.openai.com']);
  assert.equal(run.failed[0].model, 'gpt-6.1-terra');
  // A run of one model each records them as chains of one, and no blocked hosts.
  const single = await replying({ label: 'plain' }, TWO_VISITORS, { ann: [{ type: 'auto', cases: [] }, { type: 'auto', cases: [] }], ben: [{ type: 'slip', cases: [] }] });
  assert.deepEqual(single.run.chains, { answer: ['gpt-4o'], small: ['gpt-4o-mini'] });
  assert.equal('blockedHosts' in single.run, false);
});

test('a run file without chains still reads: a stopped run of one model is carried on, and a run of other chains is begun again', async () => {
  const packets = { ann: [{ type: 'auto', cases: [] }, { type: 'auto', cases: [] }], ben: [{ type: 'slip', cases: [] }] };
  // A partial file as the runner wrote it before chains: no chains, no blocked hosts.
  const older = { app: 'stand-in', label: 'reply-old', mode: 'reply', answer: 'gpt-4o', aux: 'gpt-4o-mini', startedAt: '2026-11-20T00:00:00.000Z', turns: [
    { visitor: 'ann', turn: 1, served: 'reply to: first from ann', error: null, gateStatus: 'PASSED' },
  ], knownBad: [], calls: [], failed: [], refused: [] };
  const standIn = standInApp();
  const { run } = await measure({ args: runArgs({ label: 'reply-old', mode: 'reply' }), app: standIn, visitors: TWO_VISITORS, knownBad: [], store: memoryStore({ 'packets.json': packets, 'results/reply-old.partial.json': older }), guard: idleGuard(), pace: {} });
  assert.deepEqual(standIn.seen.reply.map(call => call.question), ['second from ann', 'first from ben']);
  assert.equal(run.turns.length, 3);
  assert.deepEqual(run.chains, { answer: ['gpt-4o'], small: ['gpt-4o-mini'] });
  // The same label with other chains is another run: nothing of the old one is kept.
  const other = standInApp();
  const again = await measure({ args: runArgs({ label: 'reply-old', mode: 'reply', chains: { answer: ['gpt-4o', 'gpt-4o-mini'], small: ['gpt-4o-mini'] } }), app: other, visitors: TWO_VISITORS, knownBad: [], store: memoryStore({ 'packets.json': packets, 'results/reply-old.partial.json': older }), guard: idleGuard(), pace: {} });
  assert.equal(other.seen.reply.length, 3);
  assert.equal(again.run.turns.length, 3);
});
