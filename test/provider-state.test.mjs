// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Whether each AI provider is answering, as every server instance sees it (provider-state.js). A table kept in memory
// stands in for ai_provider_state: it runs the statements the module sends, reading the test's time as Postgres reads
// now(), and refuses any statement it does not know. Two instances are two states over one table. Nothing here
// reaches a network or a database.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { providerState } from '../provider-state.js';
import { runJob, replyClock, providerPing } from '../providers.js';

const MINUTE = 60_000;
const START = Date.parse('2026-11-21T15:00:00.000Z');

// Runs fn with the console captured, and gives back what fn returned and the lines it printed.
async function quietly(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...parts) => lines.push(parts.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

// The table, and a client that runs on it each statement provider-state.js sends. A statement runs whole, after the
// caller's current turn, as one statement on a row does in Postgres; an UPDATE of a row that is not there changes
// nothing. Each statement sent is kept in `sent`. gone() makes every statement fail, as for a table never made.
function stateTable(time) {
  const rows = new Map();
  const sent = [];
  let missing = false;
  const asDate = value => (value === null ? null : new Date(value));
  const FIVE_MINUTES = 5 * MINUTE;
  const statements = [
    [/^SELECT provider, down_since, reason, retry_at, cardinality\(failed_replies\) AS failed FROM ai_provider_state WHERE down_since IS NOT NULL OR cardinality\(failed_replies\) > 0$/,
      () => [...rows.values()].filter(row => row.down_since !== null || row.failed_replies.length > 0)
        .map(row => ({ provider: row.provider, down_since: asDate(row.down_since), reason: row.reason, retry_at: asDate(row.retry_at), failed: row.failed_replies.length }))],
    [/^INSERT INTO ai_provider_state \(provider, failed_replies\) VALUES \(\?, ARRAY\[now\(\)\]\) ON CONFLICT \(provider\) DO UPDATE SET failed_replies = array_append\(ARRAY\(SELECT failed_at FROM unnest\(ai_provider_state\.failed_replies\) AS failed_at WHERE failed_at > now\(\) - interval '5 minutes'\), now\(\)\), updated_at = now\(\) RETURNING down_since, reason, retry_at, cardinality\(failed_replies\) AS failed$/,
      ([provider]) => {
        const row = rows.get(provider) ?? { provider, down_since: null, reason: null, retry_at: null, failed_replies: [] };
        row.failed_replies = [...row.failed_replies.filter(at => at > time.now() - FIVE_MINUTES), time.now()];
        row.updated_at = time.now();
        rows.set(provider, row);
        return [{ down_since: asDate(row.down_since), reason: row.reason, retry_at: asDate(row.retry_at), failed: row.failed_replies.length }];
      }],
    [/^UPDATE ai_provider_state SET down_since = now\(\), reason = \?, retry_at = now\(\) \+ interval '5 minutes', updated_at = now\(\) WHERE provider = \? AND down_since IS NULL RETURNING down_since, retry_at, cardinality\(failed_replies\) AS failed$/,
      ([reason, provider]) => {
        const row = rows.get(provider);
        if (!row || row.down_since !== null) return [];
        Object.assign(row, { down_since: time.now(), reason, retry_at: time.now() + FIVE_MINUTES, updated_at: time.now() });
        return [{ down_since: asDate(row.down_since), retry_at: asDate(row.retry_at), failed: row.failed_replies.length }];
      }],
    [/^UPDATE ai_provider_state SET retry_at = now\(\) \+ interval '5 minutes', updated_at = now\(\) WHERE provider = \? AND down_since IS NOT NULL AND retry_at <= now\(\) RETURNING retry_at$/,
      ([provider]) => {
        const row = rows.get(provider);
        if (!row || row.down_since === null || row.retry_at === null || row.retry_at > time.now()) return [];
        Object.assign(row, { retry_at: time.now() + FIVE_MINUTES, updated_at: time.now() });
        return [{ retry_at: asDate(row.retry_at) }];
      }],
    [/^WITH was AS \(SELECT provider, down_since, reason FROM ai_provider_state WHERE provider = \? FOR UPDATE\) UPDATE ai_provider_state AS state SET down_since = NULL, reason = NULL, retry_at = NULL, failed_replies = '\{\}', updated_at = now\(\) FROM was WHERE state\.provider = was\.provider AND \(was\.down_since <= now\(\) - interval '5 minutes' OR \(was\.down_since IS NULL AND cardinality\(state\.failed_replies\) > 0\)\) RETURNING was\.down_since, was\.reason$/,
      ([provider]) => {
        const row = rows.get(provider);
        if (!row) return [];
        // A provider marked down is cleared once it has been down five minutes; one that is up, when it has failed
        // replies on record.
        const clears = row.down_since !== null ? row.down_since <= time.now() - FIVE_MINUTES : row.failed_replies.length > 0;
        if (!clears) return [];
        const was = { down_since: asDate(row.down_since), reason: row.reason };
        Object.assign(row, { down_since: null, reason: null, retry_at: null, failed_replies: [], updated_at: time.now() });
        return [was];
      }],
  ];
  const sql = async (strings, ...params) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    sent.push({ query, params });
    await null;
    if (missing) throw new Error('relation "ai_provider_state" does not exist');
    const known = statements.find(([pattern]) => pattern.test(query));
    if (!known) throw new Error(`The fake table does not know this statement: ${query}`);
    return known[1](params);
  };
  return { sql, rows, sent, gone: () => { missing = true; } };
}

// One table and the time it reads, and as many instances over it as a test asks for. answers(provider, n) is what the
// n-th ping says (true: the provider answered it); each ping is kept in `pinged`, and each note the owner is told in
// `told`.
function world({ answers = () => true } = {}) {
  let time = START;
  const clock = { now: () => time, pass: ms => { time += ms; } };
  const table = stateTable(clock);
  const pinged = [];
  const told = [];
  const instance = () => providerState({
    sqlClient: table.sql,
    now: clock.now,
    ping: async provider => { pinged.push(provider); return answers(provider, pinged.length); },
    tell: async note => { told.push(note); },
  });
  return { clock, table, pinged, told, instance };
}

const at = ms => new Date(ms).toISOString();

test('a failed reply sends one ping to its provider at once: a provider that answers it stays up, and one that fails it is marked down, with one email that says since when and why', async () => {
  const { clock, table, pinged, told, instance } = world({ answers: (provider, n) => n === 1 });
  const state = instance();
  const { lines } = await quietly(async () => {
    await state.replyFailed('alpha', { reason: 'timeout', markDownNow: false });
    assert.deepEqual(pinged, ['alpha']);
    assert.equal(await state.isDown('alpha'), false);
    assert.deepEqual(told, []);

    clock.pass(MINUTE);
    await state.replyFailed('alpha', { reason: 'server', markDownNow: false });
  });
  assert.deepEqual(pinged, ['alpha', 'alpha']);
  assert.equal(await state.isDown('alpha'), true);
  assert.deepEqual(told, [{ kind: 'down', provider: 'alpha', reason: 'server', since: at(START + MINUTE) }]);
  // Down since when and why, with the one request let through five minutes ahead, and both failed replies on record.
  const row = table.rows.get('alpha');
  assert.deepEqual([row.down_since, row.reason, row.retry_at, row.failed_replies], [START + MINUTE, 'server', START + 6 * MINUTE, [START, START + MINUTE]]);
  assert.deepEqual(lines, []);
});

test('three failed replies within five minutes mark a provider down whatever the ping says, and a failed reply older than five minutes is not counted', async () => {
  const { clock, pinged, told, instance } = world({ answers: () => true });
  const state = instance();
  const { lines } = await quietly(async () => {
    await state.replyFailed('alpha', { reason: 'timeout' });
    clock.pass(2 * MINUTE);
    await state.replyFailed('alpha', { reason: 'timeout' });
    // The first is now more than five minutes old: two on record, and the ping answers.
    clock.pass(3 * MINUTE + 1_000);
    await state.replyFailed('alpha', { reason: 'timeout' });
    assert.equal(await state.isDown('alpha'), false);
    assert.deepEqual(told, []);
    // A third within five minutes of the other two marks it down, with no ping.
    clock.pass(MINUTE);
    await state.replyFailed('alpha', { reason: 'rate_limit' });
  });
  assert.deepEqual(pinged, ['alpha', 'alpha', 'alpha']);
  assert.equal(await state.isDown('alpha'), true);
  assert.deepEqual(told, [{ kind: 'down', provider: 'alpha', reason: 'rate_limit', since: at(START + 6 * MINUTE + 1_000) }]);
  assert.deepEqual(lines, []);
});

test('a refused key or a spent quota marks a provider down at once, with no ping, even when the table has no row for it yet', async () => {
  const { table, pinged, told, instance } = world();
  const state = instance();
  assert.equal(table.rows.size, 0);
  const { lines } = await quietly(async () => {
    await state.replyFailed('alpha', { reason: 'auth', markDownNow: true });
    await state.replyFailed('beta', { reason: 'quota', markDownNow: true });
  });
  assert.deepEqual(pinged, []);
  assert.deepEqual([await state.isDown('alpha'), await state.isDown('beta')], [true, true]);
  assert.deepEqual(told, [
    { kind: 'down', provider: 'alpha', reason: 'auth', since: at(START) },
    { kind: 'down', provider: 'beta', reason: 'quota', since: at(START) },
  ]);
  assert.deepEqual(lines, []);
});

test('a provider marked down counts as down for five minutes; then one instance claims the one request let through, and every other caller still counts it as down', async () => {
  const { clock, table, told, instance } = world();
  const [first, second] = [instance(), instance()];
  await quietly(() => first.replyFailed('alpha', { reason: 'auth', markDownNow: true }));
  assert.deepEqual([await first.isDown('alpha'), await second.isDown('alpha')], [true, true]);
  clock.pass(5 * MINUTE - 1);
  assert.deepEqual([await first.isDown('alpha'), await second.isDown('alpha')], [true, true]);

  // The five minutes are up, and both instances ask at once: one of them lets its request through.
  clock.pass(1);
  const verdicts = await Promise.all([first.isDown('alpha'), second.isDown('alpha')]);
  assert.deepEqual(verdicts.sort(), [false, true]);
  assert.equal(table.rows.get('alpha').retry_at, START + 10 * MINUTE);
  // That was the one request: from now on both count it as down again, until another five minutes are up.
  assert.deepEqual([await first.isDown('alpha'), await second.isDown('alpha')], [true, true]);
  clock.pass(5 * MINUTE);
  const later = await Promise.all([first.isDown('alpha'), second.isDown('alpha'), first.isDown('alpha')]);
  assert.deepEqual(later.filter(down => !down).length, 1);
  // Letting a request through tells nobody anything: only marking down and clearing do.
  assert.equal(told.length, 1);
});

test('a reply a provider answers clears its row, and the instance whose update clears it sends the one email that says it is back, with since when it was down', async () => {
  const { clock, table, told, instance } = world();
  const [first, second] = [instance(), instance()];
  await quietly(() => first.replyFailed('alpha', { reason: 'timeout', markDownNow: true }));
  assert.equal(await second.isDown('alpha'), true);
  clock.pass(7 * MINUTE);
  const { lines } = await quietly(() => Promise.all([first.replySucceeded('alpha'), second.replySucceeded('alpha')]));
  assert.deepEqual(told, [
    { kind: 'down', provider: 'alpha', reason: 'timeout', since: at(START) },
    { kind: 'up', provider: 'alpha', reason: 'timeout', since: at(START) },
  ]);
  const row = table.rows.get('alpha');
  assert.deepEqual([row.down_since, row.reason, row.retry_at, row.failed_replies], [null, null, null, []]);
  // Each instance knows at once what it wrote itself.
  assert.deepEqual([await first.isDown('alpha'), await second.isDown('alpha')], [false, false]);
  assert.deepEqual(lines, []);
});

test('two instances that mark the same provider down at the same time send one email between them, whether the ping or the provider\'s refusal marks it', async () => {
  for (const markDownNow of [true, false]) {
    const { pinged, told, instance } = world({ answers: () => false });
    const [first, second] = [instance(), instance()];
    const { lines } = await quietly(() => Promise.all([
      first.replyFailed('alpha', { reason: 'server', markDownNow }),
      second.replyFailed('alpha', { reason: 'server', markDownNow }),
    ]));
    assert.equal(told.length, 1, `markDownNow ${markDownNow}`);
    assert.deepEqual(told[0].kind, 'down');
    assert.equal(pinged.length, markDownNow ? 0 : 2);
    assert.deepEqual([await first.isDown('alpha'), await second.isDown('alpha')], [true, true]);
    assert.deepEqual(lines, []);
  }
});

test('a reply a provider answers also clears the failed replies on record for a provider that is up, so that they are counted afresh, and sends no email', async () => {
  const { pinged, told, instance } = world({ answers: () => true });
  const state = instance();
  const { lines } = await quietly(async () => {
    await state.replyFailed('alpha', { reason: 'timeout' });
    await state.replyFailed('alpha', { reason: 'timeout' });
    await state.replySucceeded('alpha');
    await state.replyFailed('alpha', { reason: 'timeout' });
    await state.replyFailed('alpha', { reason: 'timeout' });
    assert.equal(await state.isDown('alpha'), false);
    await state.replyFailed('alpha', { reason: 'timeout' });
  });
  assert.equal(await state.isDown('alpha'), true);
  assert.equal(pinged.length, 4);
  assert.deepEqual(told.map(note => note.kind), ['down']);
  assert.deepEqual(lines, []);
});

test('a provider already marked down is not pinged again for a failed reply, and no second email is sent', async () => {
  const { clock, pinged, told, instance } = world({ answers: () => false });
  const state = instance();
  await quietly(async () => {
    await state.replyFailed('alpha', { reason: 'timeout' });
    clock.pass(MINUTE);
    await state.replyFailed('alpha', { reason: 'timeout' });
    await state.replyFailed('alpha', { reason: 'auth', markDownNow: true });
  });
  assert.deepEqual(pinged, ['alpha']);
  assert.equal(told.length, 1);
});

test('isDown reads the table at most once in fifteen seconds, and what the instance writes itself it knows at once', async () => {
  const { clock, table, instance } = world();
  const [state, other] = [instance(), instance()];
  const reads = () => table.sent.filter(({ query }) => query.startsWith('SELECT')).length;
  assert.deepEqual(await Promise.all([state.isDown('alpha'), state.isDown('beta'), state.isDown('alpha')]), [false, false, false]);
  assert.equal(reads(), 1);
  // Another instance marks alpha down: this one learns it at its next read, not before.
  await quietly(() => other.replyFailed('alpha', { reason: 'auth', markDownNow: true }));
  clock.pass(15_000 - 1);
  assert.equal(await state.isDown('alpha'), false);
  assert.equal(reads(), 1);
  clock.pass(1);
  assert.equal(await state.isDown('alpha'), true);
  assert.equal(reads(), 2);
  // What it writes itself, it knows without reading.
  await quietly(() => state.replyFailed('beta', { reason: 'quota', markDownNow: true }));
  assert.equal(await state.isDown('beta'), true);
  assert.equal(reads(), 2);
  // Five minutes on, its read shows alpha's request may be let through, and it lets it through. That moved the next
  // one five minutes ahead, and a reply alpha answers then clears it: both it knows without reading again.
  clock.pass(5 * MINUTE);
  assert.equal(await state.isDown('alpha'), false);
  assert.equal(reads(), 3);
  assert.equal(await state.isDown('alpha'), true);
  await quietly(() => state.replySucceeded('alpha'));
  assert.equal(await state.isDown('alpha'), false);
  assert.equal(reads(), 3);
});

test('a reply a provider answers costs no write when nothing is on record for it', async () => {
  const { table, told, instance } = world();
  const state = instance();
  assert.equal(await state.isDown('alpha'), false);
  const before = table.sent.length;
  await state.replySucceeded('alpha');
  await state.replySucceeded('beta');
  assert.equal(table.sent.length, before);
  assert.deepEqual(told, []);
});

test('when the table cannot be read or written, every provider counts as up, nothing is pinged or marked down, and each instance logs it once', async () => {
  const { table, pinged, told, instance } = world({ answers: () => false });
  table.gone();
  const [state, other] = [instance(), instance()];
  const { lines } = await quietly(async () => {
    assert.equal(await state.isDown('alpha'), false);
    await state.replyFailed('alpha', { reason: 'timeout' });
    await state.replyFailed('alpha', { reason: 'auth', markDownNow: true });
    await state.replySucceeded('alpha');
    assert.deepEqual(await state.snapshot(), {});
    assert.equal(await state.isDown('alpha'), false);
    assert.equal(await other.isDown('alpha'), false);
  });
  assert.deepEqual([pinged, told], [[], []]);
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.ok(lines.every(line => /provider state could not be read or written, so every provider counts as up: relation "ai_provider_state" does not exist/.test(line)), lines.join('\n'));
  // A read that failed is not sent again on every question: the instance waits its fifteen seconds.
  const sent = table.sent.length;
  await quietly(() => state.isDown('beta'));
  assert.equal(table.sent.length, sent);
});

test('snapshot gives each provider marked down, since when and why, and leaves out a provider that is up', async () => {
  const { clock, instance } = world({ answers: () => true });
  const state = instance();
  await quietly(async () => {
    await state.replyFailed('alpha', { reason: 'quota', markDownNow: true });
    clock.pass(MINUTE);
    await state.replyFailed('beta', { reason: 'timeout' });
  });
  assert.deepEqual(await state.snapshot(), { alpha: { downSince: at(START), reason: 'quota' } });
  assert.deepEqual(await instance().snapshot(), { alpha: { downSince: at(START), reason: 'quota' } });
});

test("through runJob, a provider marked down is not asked while another answers; five minutes on, one reply asks it in its chain's place, and its answer clears it, while a failed answer keeps it down five minutes more", async () => {
  const { clock, table, told, instance } = world({ answers: () => false });
  const state = instance();
  // Two stand-in providers, alpha and beta; a model in `failing` answers 503.
  const asked = [];
  const failing = new Set();
  const adapter = name => ({
    name,
    call: async ({ job, model }) => {
      asked.push(`${job} ${model}`);
      if (failing.has(model)) throw Object.assign(new Error('503 Service Unavailable'), { status: 503 });
      return { text: 'ok', inputTokens: 1, outputTokens: 1 };
    },
  });
  const deps = { adapters: { alpha: adapter('alpha'), beta: adapter('beta') }, budget: ({ execute }) => execute(), providerFor: model => model.split('-')[0], state };
  // One reply's job, and the reply ended, so that the state is told how it went.
  const reply = async () => {
    asked.length = 0;
    const replying = replyClock({ deadlineAt: Date.now() + 45_000 });
    const { result } = await quietly(async () => {
      const answered = await runJob({ job: 'grade', chain: ['alpha-1', 'beta-1'], messages: [{ role: 'user', content: 'x' }], json: true, maxTokens: 100, clock: replying }, deps);
      await replying.end();
      return answered.model;
    });
    return result;
  };

  await quietly(() => state.replyFailed('alpha', { reason: 'auth', markDownNow: true }));
  clock.pass(MINUTE);
  assert.equal(await reply(), 'beta-1');
  assert.deepEqual(asked, ['grade beta-1']);
  clock.pass(4 * MINUTE);
  assert.equal(await reply(), 'alpha-1');
  assert.deepEqual(asked, ['grade alpha-1']);
  assert.deepEqual(told.map(note => note.kind), ['down', 'up']);
  assert.equal(table.rows.get('alpha').down_since, null);

  // Marked down again; this time the request let through fails, so it stays down until five more minutes are up.
  await quietly(() => state.replyFailed('alpha', { reason: 'timeout', markDownNow: true }));
  clock.pass(5 * MINUTE);
  failing.add('alpha-1');
  assert.equal(await reply(), 'beta-1');
  assert.deepEqual(asked, ['grade alpha-1', 'grade beta-1']);
  clock.pass(MINUTE);
  assert.equal(await reply(), 'beta-1');
  assert.deepEqual(asked, ['grade beta-1']);
  assert.deepEqual(told.map(note => note.kind), ['down', 'up', 'down']);
});

test("through runJob, a provider marked down that its chain asks only after one that answers gets its one request let through as a ping, beside the reply, and no job: a ping it answers clears it with one email, a failed one keeps it down five minutes more, and before then it is sent nothing", async () => {
  let answering = true;
  const { clock, table, pinged, told, instance } = world({ answers: () => answering });
  const state = instance();
  // Two stand-in providers as a reply's chain names them: openai first, which answers every job, and anthropic after
  // it, marked down. Each job a provider is asked is kept in `asked`; each ping the state sends, in `pinged`.
  const asked = [];
  const adapter = name => ({
    name,
    call: async ({ job, model }) => { asked.push(`${job} ${model}`); return { text: 'ok', inputTokens: 1, outputTokens: 1 }; },
  });
  const deps = { adapters: { openai: adapter('openai'), anthropic: adapter('anthropic') }, budget: ({ execute }) => execute(), providerFor: model => model.split('-')[0], state };
  const reply = async () => {
    asked.length = 0;
    const replying = replyClock({ deadlineAt: Date.now() + 45_000 });
    return (await quietly(async () => {
      const answered = await runJob({ job: 'grade', chain: ['openai-1', 'anthropic-1'], messages: [{ role: 'user', content: 'x' }], json: true, maxTokens: 100, clock: replying }, deps);
      await replying.end();
      return answered.model;
    })).result;
  };

  await quietly(() => state.replyFailed('anthropic', { reason: 'timeout', markDownNow: true }));
  // Within its five minutes it is sent nothing: no job, and no ping.
  clock.pass(MINUTE);
  assert.equal(await reply(), 'openai-1');
  assert.deepEqual([asked, pinged], [['grade openai-1'], []]);

  // The five minutes are up, and this reply takes the one request let through. openai answers the job, so what goes
  // to anthropic is its ping, beside the reply, with nothing the visitor wrote; no job goes to it.
  clock.pass(4 * MINUTE);
  assert.equal(await reply(), 'openai-1');
  assert.deepEqual([asked, pinged], [['grade openai-1'], ['anthropic']]);
  // It answered the ping: it is up again, as when it answers a job, and the owner is told once.
  assert.deepEqual(told.map(note => [note.kind, note.provider]), [['down', 'anthropic'], ['up', 'anthropic']]);
  assert.deepEqual([table.rows.get('anthropic').down_since, await state.isDown('anthropic')], [null, false]);

  // Marked down again; five minutes on its ping fails: it stays down, and the next request is let through five minutes
  // after this one. Nobody is told anything more.
  await quietly(() => state.replyFailed('anthropic', { reason: 'timeout', markDownNow: true }));
  clock.pass(5 * MINUTE);
  answering = false;
  assert.equal(await reply(), 'openai-1');
  assert.deepEqual([asked, pinged], [['grade openai-1'], ['anthropic', 'anthropic']]);
  assert.equal(table.rows.get('anthropic').retry_at, clock.now() + 5 * MINUTE);
  assert.equal(await state.isDown('anthropic'), true);
  assert.deepEqual(told.map(note => note.kind), ['down', 'up', 'down']);
});

test("through runJob and the app's own ping, a provider that answers a job of the reply has its check cut off, and the reply's end does not wait for it: the check that a failure started, and the ping of a provider let through", async () => {
  const { clock, table, told } = world();
  // The state's ping is the app's (providerPing): a health check of the provider's main model. Here the provider takes
  // the check and never answers it, and does not heed its signal either, and the check's time never runs out: only
  // the cut-off can end it. Each check is kept in `checks`, with its signal.
  const checks = [];
  const failing = new Set();
  const adapter = name => ({
    name,
    call: async ({ model }) => {
      if (failing.has(model)) throw Object.assign(new Error('503 Service Unavailable'), { status: 503 });
      return { text: 'ok', inputTokens: 1, outputTokens: 1 };
    },
    ping: (model, { signal } = {}) => { checks.push({ model, signal }); return new Promise(() => {}); },
  });
  const adapters = { alpha: adapter('alpha'), beta: adapter('beta') };
  const providerFor = model => model.split('-')[0];
  const ping = providerPing([['alpha-1', 'beta-1']], { adapters, budget: ({ execute }) => execute(), providerFor, timer: () => () => {} });
  const state = providerState({ sqlClient: table.sql, now: clock.now, ping, tell: async note => { told.push(note); } });
  const deps = { adapters, budget: ({ execute }) => execute(), providerFor, state };
  const job = (replying, name, chain) => runJob({ job: name, chain, messages: [{ role: 'user', content: 'x' }], json: true, maxTokens: 100, clock: replying }, deps);
  // How long the reply's end takes, or 'waited' if it does not end within a second.
  const ending = replying => Promise.race([replying.end().then(() => 'ended'), new Promise(resolve => setTimeout(resolve, 1_000, 'waited'))]);

  // alpha fails the reply's first job, and its check starts; then it answers the next job. Its check is cut off.
  const first = replyClock({ deadlineAt: Date.now() + 45_000 });
  const { result: outcome } = await quietly(async () => {
    failing.add('alpha-1');
    assert.equal((await job(first, 'classify', ['alpha-1', 'beta-1'])).model, 'beta-1');
    failing.delete('alpha-1');
    assert.equal(checks.length, 1);
    assert.equal((await job(first, 'grade', ['alpha-2'])).model, 'alpha-2');
    return ending(first);
  });
  assert.equal(outcome, 'ended');
  assert.deepEqual(checks.map(({ model, signal }) => [model, signal.aborted]), [['alpha-1', true]]);
  // A check cut off says nothing of the provider: alpha answered a job, so it is up, and nothing is on record.
  assert.deepEqual([table.rows.size, told], [0, []]);

  // beta is marked down; five minutes on, a reply lets its one request through. alpha answers, so beta's ping starts
  // beside the reply. Then beta answers a job of the same reply: its ping is cut off, and the job's answer clears it.
  await quietly(() => state.replyFailed('beta', { reason: 'timeout', markDownNow: true }));
  clock.pass(5 * MINUTE);
  checks.length = 0;
  const second = replyClock({ deadlineAt: Date.now() + 45_000 });
  const { result: later } = await quietly(async () => {
    assert.equal((await job(second, 'classify', ['alpha-1', 'beta-1'])).model, 'alpha-1');
    assert.deepEqual(checks.map(({ model }) => model), ['beta-1']);
    assert.equal((await job(second, 'grade', ['beta-2'])).model, 'beta-2');
    return ending(second);
  });
  assert.equal(later, 'ended');
  assert.deepEqual(checks.map(({ model, signal }) => [model, signal.aborted]), [['beta-1', true]]);
  assert.deepEqual(told.map(note => [note.kind, note.provider]), [['down', 'beta'], ['up', 'beta']]);
  assert.equal(table.rows.get('beta').down_since, null);
});

// OpenAI as runJob asks it, through a fake adapter: a model named in `failing` answers with that HTTP status, and any
// other answers. reply(jobs) runs one reply's jobs ([job, chain] each) in turn with one clock, ends the reply, and
// gives the model that answered each job, or null for a job no model answered.
const ANSWER = ['gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.4-mini'];
const SMALL = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-5.4-mini'];
function openaiReplies(state) {
  const failing = new Map();
  const adapter = {
    name: 'openai',
    call: async ({ model }) => {
      if (failing.has(model)) throw Object.assign(new Error(`HTTP ${failing.get(model)}`), { status: failing.get(model) });
      return { text: 'ok', inputTokens: 1, outputTokens: 1 };
    },
  };
  const deps = { adapters: { openai: adapter }, budget: ({ execute }) => execute(), state };
  const job = (clock, [name, chain]) => runJob({ job: name, chain, messages: [{ role: 'user', content: 'x' }], maxTokens: 100, clock }, deps)
    .then(answer => answer.model, () => null);
  const reply = async jobs => (await quietly(async () => {
    const clock = replyClock({ deadlineAt: Date.now() + 45_000 });
    const models = [];
    for (const each of jobs) models.push(await job(clock, each));
    await clock.end();
    return models;
  })).result;
  return { failing, job, reply };
}

test("through runJob, a reply in which the provider's main model fails and another of its models answers is a success for it: nothing is put on record, it is not marked down and nobody is emailed, even when its ping fails, whichever comes first", async () => {
  const { table, pinged, told, instance } = world({ answers: () => false });
  const state = instance();
  const openai = openaiReplies(state);
  openai.failing.set('gpt-6.1-terra', 503);
  // The reply's own job alone: its main model fails before another answers.
  assert.deepEqual(await openai.reply([['reply', ANSWER]]), ['gpt-6-luna']);
  // The classifier first, as on the site: luna answers it, and then the reply's main model fails.
  assert.deepEqual(await openai.reply([['classify', SMALL], ['reply', ANSWER]]), ['gpt-6-luna', 'gpt-6-luna']);
  assert.deepEqual([told, table.rows.size, await state.isDown('openai')], [[], 0, false]);
  // The ping ran beside the first reply, and its failure changed nothing. In the second the provider had answered
  // before it failed, so it was not pinged at all.
  assert.deepEqual(pinged, ['openai']);
});

test('through runJob, a reply in which the provider answers nothing is a failure for it, put on record when the reply ends, and with a failed ping it is marked down, with one email', async () => {
  const { table, pinged, told, instance } = world({ answers: () => false });
  const state = instance();
  const openai = openaiReplies(state);
  for (const model of ANSWER) openai.failing.set(model, 503);
  const { result: [beforeEnd, afterEnd] } = await quietly(async () => {
    const clock = replyClock({ deadlineAt: Date.now() + 45_000 });
    assert.equal(await openai.job(clock, ['reply', ANSWER]), null);
    // The ping has started beside the reply, but nothing is put on record before it ends.
    const rowsBefore = table.rows.size;
    await clock.end();
    return [rowsBefore, table.rows.size];
  });
  assert.deepEqual([beforeEnd, afterEnd], [0, 1]);
  assert.deepEqual(pinged, ['openai']);
  assert.deepEqual(table.rows.get('openai').failed_replies.length, 1);
  assert.deepEqual(told.map(note => [note.kind, note.provider, note.reason]), [['down', 'openai', 'server']]);
  assert.equal(await state.isDown('openai'), true);
});

test('through runJob, a refused key marks its provider down at once, with no ping, but only when the provider answered nothing in the reply', async () => {
  const { pinged, told, instance } = world({ answers: () => false });
  const state = instance();
  const openai = openaiReplies(state);
  openai.failing.set('gpt-6.1-terra', 401);
  assert.deepEqual(await openai.reply([['reply', ANSWER]]), ['gpt-6-luna']);
  assert.deepEqual([told, await state.isDown('openai')], [[], false]);
  for (const model of ANSWER) openai.failing.set(model, 401);
  assert.deepEqual(await openai.reply([['reply', ANSWER]]), [null]);
  assert.deepEqual(told.map(note => [note.kind, note.reason]), [['down', 'auth']]);
  assert.equal(await state.isDown('openai'), true);
  assert.deepEqual(pinged, []);
});

test('a reply a provider marked down answers leaves the mark as it is until the provider has served its five minutes, and sends no email; the first after them clears it and sends one, even when the request let through moved retry_at on', async () => {
  const { clock, table, told, instance } = world();
  const state = instance();
  await quietly(() => state.replyFailed('alpha', { reason: 'timeout', markDownNow: true }));
  clock.pass(5 * MINUTE - 1);
  await quietly(() => state.replySucceeded('alpha'));
  assert.equal(await state.isDown('alpha'), true);
  assert.deepEqual([table.rows.get('alpha').down_since, told.map(note => note.kind)], [START, ['down']]);
  // Within the five minutes the instance does not even try to clear it.
  assert.equal(table.sent.filter(({ query }) => query.startsWith('WITH was')).length, 0);
  // The five minutes are up. The request let through moves retry_at five minutes on; the reply it answers clears it.
  clock.pass(1);
  assert.equal(await state.isDown('alpha'), false);
  assert.equal(table.rows.get('alpha').retry_at, START + 10 * MINUTE);
  await quietly(() => state.replySucceeded('alpha'));
  assert.deepEqual(told, [
    { kind: 'down', provider: 'alpha', reason: 'timeout', since: at(START) },
    { kind: 'up', provider: 'alpha', reason: 'timeout', since: at(START) },
  ]);
  assert.deepEqual([table.rows.get('alpha').down_since, await state.isDown('alpha')], [null, false]);
});

test('ten replies, one a minute, with the main model failing while luna answers each of them, send no email at all and put nothing on record, whichever job comes first', async () => {
  for (const jobs of [[['classify', SMALL], ['reply', ANSWER]], [['reply', ANSWER]]]) {
    const { clock, table, told, instance } = world({ answers: () => false });
    const state = instance();
    const openai = openaiReplies(state);
    openai.failing.set('gpt-6.1-terra', 503);
    for (let reply = 0; reply < 10; reply += 1) {
      assert.ok((await openai.reply(jobs)).every(model => model === 'gpt-6-luna'));
      clock.pass(MINUTE);
    }
    assert.deepEqual([told, table.rows.size, await state.isDown('openai')], [[], 0, false], jobs.map(([job]) => job).join(', '));
  }
});

test('a ping that cannot be made marks nothing down, and an email that cannot be sent stops nothing', async () => {
  const { clock, table } = world();
  const noPing = providerState({ sqlClient: table.sql, now: clock.now, ping: async () => { throw new Error('no adapter'); }, tell: async () => { throw new Error('mail is down'); } });
  const { lines } = await quietly(async () => {
    await noPing.replyFailed('alpha', { reason: 'timeout' });
    assert.equal(await noPing.isDown('alpha'), false);
    await noPing.replyFailed('beta', { reason: 'auth', markDownNow: true });
  });
  assert.equal(await noPing.isDown('beta'), true);
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /The check of alpha could not be made; it is not marked down for it\./);
  assert.match(lines[1], /Telling the owner that beta is down failed: mail is down/);
});
