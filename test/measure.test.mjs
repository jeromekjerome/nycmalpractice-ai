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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from './runner.mjs';
import { installGuard, MEASURE_DATABASE_URL, withoutKeys } from '../measure/guard-fetch.mjs';
import { parseArgs, environmentFor, turnRecord, allowanceDecision, courtListenerPace, estimateCost, measure } from '../measure/run.mjs';
import { outcome, probeLine, probeRequests } from '../measure/probe-shapes.mjs';
import { replyStats, smallStats, majority, agreement, selfAgreement, replyBar, smallBar, checkRuns, parseReportArgs, renderReport, renderSamples } from '../measure/report.mjs';
import { estimateAiCost } from '../ai-budget.js';
import { isReasoningModel } from '../openaiModelFailover.js';

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

test('nothing shaped like a key is kept or printed, even when a provider quotes one back in an error', async () => {
  assert.equal(withoutKeys('401 Incorrect API key provided: sk-proj-abcDEF123456****************wxyz. You can find your key at the dashboard.'),
    '401 Incorrect API key provided: [key withheld]. You can find your key at the dashboard.');
  assert.equal(withoutKeys('Authorization: Token 0123456789abcdef0123456789abcdef01234567 was refused'), 'Authorization: Token [key withheld] was refused');
  assert.equal(withoutKeys('Bearer sk-test_ABCDEFGH12345678'), 'Bearer [key withheld]');
  assert.equal(withoutKeys('The model `gpt-4o` has been deprecated (request req_0123456789abcdef)'), 'The model `gpt-4o` has been deprecated (request req_0123456789abcdef)');
  assert.equal(withoutKeys(undefined), '');

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

// ─── The runner ───────────────────────────────────────────────────────────────

test('the runner refuses a run it cannot name, a mode it does not know, and a small run with nothing to copy from', () => {
  assert.deepEqual(parseArgs(['--label', 'base-1', '--answer', 'gpt-4o', '--aux', 'gpt-4o-mini', '--mode', 'record']),
    { label: 'base-1', answer: 'gpt-4o', aux: 'gpt-4o-mini', mode: 'record', from: null, yes: false });
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

test('a measurement run points the app at no database, one answer model and one small model, and holds no other service\'s keys', () => {
  const settings = environmentFor({ answer: 'gpt-6.2-sol', aux: 'gpt-6-luna' });
  const { NODE_ENV, DATABASE_URL, GATEKEEPER_MODE, GATEKEEPER_COURTLISTENER_LOOKUP, OPENAI_MODEL_ANSWER, OPENAI_MODEL_ANSWER_FALLBACKS, OPENAI_MODEL_AUX, OPENAI_MODEL_AUX_FALLBACKS,
    AI_BUDGET_IN_TESTS, OPENAI_MODEL_RATES_JSON, DEMO_MODE, DEMO_DATABASE_URL, ...standIns } = settings;
  assert.deepEqual({ NODE_ENV, DATABASE_URL, GATEKEEPER_MODE, GATEKEEPER_COURTLISTENER_LOOKUP, OPENAI_MODEL_ANSWER, OPENAI_MODEL_ANSWER_FALLBACKS, OPENAI_MODEL_AUX, OPENAI_MODEL_AUX_FALLBACKS }, {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://measure:measure@measure.invalid/none',
    GATEKEEPER_MODE: 'llm',
    GATEKEEPER_COURTLISTENER_LOOKUP: 'off',
    OPENAI_MODEL_ANSWER: 'gpt-6.2-sol', OPENAI_MODEL_ANSWER_FALLBACKS: 'gpt-6.2-sol',
    OPENAI_MODEL_AUX: 'gpt-6-luna', OPENAI_MODEL_AUX_FALLBACKS: 'gpt-6-luna',
  });
  assert.equal(DATABASE_URL, MEASURE_DATABASE_URL);
  // Every other service the app can reach is given a stand-in, so a run cannot charge a card, send a text or
  // send an email even by a path nobody foresaw. The two keys a run needs are left as they are.
  assert.deepEqual(Object.keys(standIns).sort(), ['ADMIN_SECRET', 'ALERT_EMAIL', 'CRON_SECRET', 'DAILY_DIGEST', 'NOTIFICATION_EMAIL', 'SMTP_HOST', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_USER',
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER']);
  assert.match(standIns.STRIPE_SECRET_KEY, /^sk_test_/);
  assert.match(standIns.TWILIO_ACCOUNT_SID, /^AC/);
  assert.match(standIns.SMTP_HOST, /\.invalid$/);
  assert.equal('OPENAI_API_KEY' in settings || 'COURTLISTENER_TOKEN' in settings, false);
  // Settings that would change what a run is (the spending cap switched on in a test environment, another price
  // table, a demo copy of the site) are set to nothing. They are not removed: the app loads the local settings
  // file as it starts, and that fills in whatever is not set.
  assert.deepEqual({ AI_BUDGET_IN_TESTS, OPENAI_MODEL_RATES_JSON, DEMO_MODE, DEMO_DATABASE_URL }, { AI_BUDGET_IN_TESTS: '', OPENAI_MODEL_RATES_JSON: '', DEMO_MODE: '', DEMO_DATABASE_URL: '' });
});

test('the settings a run gives the app are still there after the app has loaded the local settings file', () => {
  // In a folder with a settings file of its own, a second process applies a run's settings, loads the app's
  // database file (which loads the settings file of the folder it is run from), and says what it then holds.
  const folder = mkdtempSync(join(tmpdir(), 'measure-settings-'));
  try {
    writeFileSync(join(folder, '.env'), [
      'DATABASE_URL=postgres://real:real@db.example.test/live', 'AI_BUDGET_IN_TESTS=1', 'OPENAI_MODEL_RATES_JSON={"gpt-4o":[0,0]}', 'DEMO_MODE=1',
      'DEMO_DATABASE_URL=postgres://demo:demo@db.example.test/demo', 'NODE_ENV=production', 'GATEKEEPER_MODE=deterministic', 'OPENAI_MODEL_ANSWER=gpt-4o',
      'STRIPE_SECRET_KEY=sk_live_from_the_file', 'ONLY_IN_THE_FILE=read',
    ].join('\n'));
    const names = ['DATABASE_URL', 'AI_BUDGET_IN_TESTS', 'OPENAI_MODEL_RATES_JSON', 'DEMO_MODE', 'DEMO_DATABASE_URL', 'NODE_ENV', 'GATEKEEPER_MODE', 'OPENAI_MODEL_ANSWER', 'STRIPE_SECRET_KEY', 'ONLY_IN_THE_FILE'];
    const script = [
      `import { environmentFor } from ${JSON.stringify(new URL('../measure/run.mjs', import.meta.url).href)};`,
      "Object.assign(process.env, environmentFor({ answer: 'gpt-6.2-sol', aux: 'gpt-6-luna' }));",
      `await import(${JSON.stringify(new URL('../db.js', import.meta.url).href)});`,
      `console.log('HELD ' + JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name]]))));`,
    ].join('\n');
    const printed = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: folder, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, encoding: 'utf8' });
    const held = JSON.parse(printed.split('\n').find(line => line.startsWith('HELD ')).slice(5));
    assert.deepEqual(held, {
      // The file was read: what only it holds is there.
      ONLY_IN_THE_FILE: 'read',
      // And nothing a run sets was changed by it.
      DATABASE_URL: MEASURE_DATABASE_URL, AI_BUDGET_IN_TESTS: '', OPENAI_MODEL_RATES_JSON: '', DEMO_MODE: '', DEMO_DATABASE_URL: '',
      NODE_ENV: 'test', GATEKEEPER_MODE: 'llm', OPENAI_MODEL_ANSWER: 'gpt-6.2-sol', STRIPE_SECRET_KEY: 'sk_test_measure',
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
  const pricing = { price: estimateAiCost, reasoning: isReasoningModel, replyJobs: ADAPTER.REPLY_JOBS };
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`);
  // Today's models again: (2.50 + 1.00) + (0.25 + 0.10) + (0.30 + 0.12) = 4.27, and a quarter on top.
  near(estimateCost({ mode: 'reply', answer: 'gpt-4o', aux: 'gpt-4o-mini' }, base, pricing), 4.27 * 1.25);
  // A reasoning model is given a thousand tokens of thinking on each call it makes.
  // gpt-6.2-sol at 2/10: (2.00 + 1.01) + (0.20 + 0.11) = 3.32; the small model unchanged at 0.42.
  near(estimateCost({ mode: 'reply', answer: 'gpt-6.2-sol', aux: 'gpt-4o-mini' }, base, pricing), (3.32 + 0.42) * 1.25);
  // A small run writes no drafts: of the answer model's calls only the rewrites are counted.
  // gpt-6-luna at 0.10/0.50: 0.20 + (200,000 + 1,000) * 0.5 / 1e6 = 0.3005; the rewrite at gpt-4o: 0.35.
  near(estimateCost({ mode: 'small', answer: 'gpt-4o', aux: 'gpt-6-luna' }, base, pricing), (0.3005 + 0.35) * 1.25);
});

test('the probe says in a word what a model made of each of the three kinds of request', () => {
  const answered = text => ({ status: 200, body: { choices: [{ message: { content: text } }] } });
  assert.equal(outcome(answered('A statute of limitations is a time limit.')), 'ok');
  assert.equal(outcome(answered('{"ok": true}'), { wantsJson: true }), 'ok');
  assert.equal(outcome(answered('Here you go: {"ok": true}'), { wantsJson: true }), 'NOT JSON');
  assert.equal(outcome(answered('[true]'), { wantsJson: true }), 'NOT JSON');
  // A reasoning model that spends its whole allowance thinking answers with nothing.
  assert.equal(outcome(answered('')), 'EMPTY');
  assert.equal(outcome(answered('   ')), 'EMPTY');
  assert.equal(outcome({ status: 200, body: { choices: [{ message: { content: null } }] } }, { wantsJson: true }), 'EMPTY');
  assert.equal(outcome({ status: 400, body: { error: { code: 'unsupported_parameter', message: "Unsupported parameter: 'temperature'" } } }), 'FAILED 400 unsupported_parameter');
  assert.equal(outcome({ status: 429, body: { error: { type: 'rate_limit_error' } } }), 'FAILED 429 rate_limit_error');
  assert.equal(outcome({ status: 500, body: null }), 'FAILED 500 unknown');
  assert.equal(probeLine('gpt-6.2-sol', { reply: 'ok', json: 'ok', rewrite: 'ok' }), 'gpt-6.2-sol: reply ok | json ok | rewrite ok');
  assert.equal(probeLine('gpt-9', { reply: 'FAILED 400 unsupported_parameter', json: 'NOT JSON', rewrite: 'EMPTY' }), 'gpt-9: reply FAILED 400 unsupported_parameter | json NOT JSON | rewrite EMPTY');
  // The three requests are shaped for the model as the app shapes them: a reasoning model is sent no temperature.
  const shapes = probeRequests('gpt-6.2-sol', isReasoningModel('gpt-6.2-sol') ? (model, request) => { const { temperature, max_tokens, ...rest } = request; return { model, ...rest, max_completion_tokens: max_tokens + 2000 }; } : null);
  assert.deepEqual(Object.keys(shapes), ['reply', 'json', 'rewrite']);
  assert.deepEqual(shapes.json.response_format, { type: 'json_object' });
  assert.equal(shapes.json.max_completion_tokens, 2120);
  assert.equal('temperature' in shapes.rewrite, false);
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
  assert.equal(stats.seminarFinalPassRate, 1 / 3);
  assert.equal(stats.emptyFirstDrafts, 1);
  assert.equal(stats.failedTurns, 1);
  assert.equal(stats.cutOff, 1);
  // The grader's minute is no part of the reply job's time; a reply call that failed is, for as long as it took:
  // 300, 2000, 4000, 12000 and the 30 seconds of the one that timed out.
  assert.equal(stats.replyMedianMs, 4000);
  assert.equal(stats.replySlowestTenthMs, 30_000);
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
  const baselines = [{ finalPassRate: 0.95, unanchoredFirstDrafts: 1, seminarFinalPassRate: 1 }, { finalPassRate: 0.9, unanchoredFirstDrafts: 3, seminarFinalPassRate: 0.875 }];
  assert.deepEqual(replyBar({ finalPassRate: 0.9, unanchoredFirstDrafts: 3, seminarFinalPassRate: 0.875, replySlowestTenthMs: 10000 }, baselines), { ok: true, reasons: [], failed: [] });
  const failed = replyBar({ finalPassRate: 0.89, unanchoredFirstDrafts: 4, seminarFinalPassRate: 0.8, replySlowestTenthMs: 10001 }, baselines);
  assert.equal(failed.ok, false);
  assert.equal(failed.reasons.length, 4);
  assert.deepEqual(failed.failed, ['finalPass', 'unanchored', 'seminar', 'speed']);
  // A run with no reply call to time has not shown its speed.
  assert.deepEqual(replyBar({ finalPassRate: 1, unanchoredFirstDrafts: 0, seminarFinalPassRate: 1, replySlowestTenthMs: null }, baselines).failed, ['speed']);
  // Today's grader's answer is now and then cut off, and that draft is then graded by code alone: such drafts are
  // left out of the pass rates. A run in which more than a tenth went that way is not a measurement of its model.
  const mostlyGraded = { finalPassRate: 1, unanchoredFirstDrafts: 0, seminarFinalPassRate: 1, replySlowestTenthMs: 1000, turns: 45, ungradedFirstDrafts: 2 };
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

test('the report command is told which runs are which, and refuses what it cannot read as a run', () => {
  assert.deepEqual(parseReportArgs(['--app', 'nycinjury', '--baseline', 'base-1,base-2,base-3', '--small-baseline', 'small-base-1', '--replies', 'reply-a,reply-b', '--smalls', 'small-a', '--samples', 'reply-a', '--note', 'one', '--note', 'two']),
    { app: 'nycinjury', baseline: ['base-1', 'base-2', 'base-3'], smallBaseline: ['small-base-1'], replies: ['reply-a', 'reply-b'], smalls: ['small-a'], samples: ['reply-a'], notes: ['one', 'two'] });
  assert.deepEqual(parseReportArgs(['--app', 'nycinjury', '--baseline', 'base-1']),
    { app: 'nycinjury', baseline: ['base-1'], smallBaseline: [], replies: [], smalls: [], samples: [], notes: [] });
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
  assert.match(rowOf('reply-terra'), /passes after the rewrite on 75%, under today's worst run \(100%\)/);
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
  assert.doesNotMatch(text, /undefined|NaN|\[object/);

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
