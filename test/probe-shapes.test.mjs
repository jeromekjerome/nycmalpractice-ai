// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The probe's widening (measure/probe-shapes.mjs): for each model named, the provider the registry gives it, whether
// that provider lists it, and the three kinds of request sent through that provider's adapter. Fake adapters stand in
// for the three providers: nothing here reaches a network or a database.
//
// This file is the same in both apps.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { PROBE_HOSTS, SHAPES, parseProbeArgs, probeCost, probeModel, runProbe, watchUsage } from '../measure/probe-shapes.mjs';
import { SCHEMAS } from '../job-schemas.js';

// A fake adapter that keeps every call, answers with `answer(call)`, and lists `names`.
function fakeAdapter(name, { names = [], answer = () => ({ text: 'fine', inputTokens: 10, outputTokens: 20 }), ping = async () => ({ inputTokens: 4, outputTokens: 1 }) } = {}) {
  const calls = [];
  const pings = [];
  return {
    name, calls, pings,
    async ping(model, options) { pings.push({ model, options }); return ping(model, options); },
    async call(request) {
      calls.push(request);
      const given = answer(request);
      if (given instanceof Error) throw given;
      return given;
    },
    async listModels() { return names; },
  };
}

const jsonAnswer = request => (request.json ? { text: '{"type":"auto","terms":"x"}', inputTokens: 10, outputTokens: 20 } : { text: 'fine', inputTokens: 10, outputTokens: 20 });

test('the probe may reach exactly the three providers\' hosts', () => {
  assert.deepEqual([...PROBE_HOSTS].sort(), ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com']);
});

test('the three shapes are a reply, a JSON job with its schema and a rewrite at a low temperature that ends with a late system instruction, all synthetic', () => {
  assert.deepEqual(Object.keys(SHAPES), ['reply', 'json', 'rewrite']);
  assert.equal(SHAPES.reply.job, 'reply');
  assert.equal(SHAPES.reply.messages.at(-1).role, 'user');
  assert.equal(SHAPES.json.job, 'classify');
  assert.equal(SHAPES.json.json, true);
  assert.equal(SHAPES.rewrite.job, 'rewrite');
  assert.equal(SHAPES.rewrite.temperature, 0.2);
  assert.deepEqual(SHAPES.rewrite.messages.map(message => message.role), ['system', 'user', 'assistant', 'system']);
  for (const shape of Object.values(SHAPES)) assert.ok(shape.maxTokens > 0);
});

test('the arguments are the models and --yes, and a model the registry does not have is refused', () => {
  assert.deepEqual(parseProbeArgs(['--yes', 'gemini-3.8-flash', 'claude-haiku-5-5']), { yes: true, models: ['gemini-3.8-flash', 'claude-haiku-5-5'], problem: null });
  assert.equal(parseProbeArgs(['gpt-5.4']).yes, false);
  assert.match(parseProbeArgs(['--yes', 'gemini-9-imaginary']).problem, /gemini-9-imaginary is not in the registry/);
  assert.match(parseProbeArgs(['--yes']).problem, /usage/);
  assert.match(parseProbeArgs(['--yes', '../x']).problem, /usage/);
});

test('a run counts the ping in its estimate, and prices a model at the day asked for', () => {
  assert.ok(probeCost(['gpt-5.4']) > 0);
  const flash = ['gemini-3.8-flash'];
  assert.ok(probeCost(flash, '2027-01-01') > probeCost(flash, '2026-12-31'), 'the dated price is the one used');
});

test('the estimated cost adds each model\'s worst case at its registry price, and rounds up to the cent', () => {
  const one = probeCost(['claude-opus-5-5']);
  const both = probeCost(['claude-opus-5-5', 'gemini-3.5-flash-lite']);
  assert.ok(one > 0 && both > one);
  assert.equal(Math.round(one * 100), one * 100, 'a whole number of cents');
  assert.ok(probeCost(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']) < 1);
});

test('a model is sent the three shapes through its provider\'s adapter and passes when each answers, the JSON one with its schema', async () => {
  const google = fakeAdapter('google', { names: ['gemini-3.8-flash'], answer: jsonAnswer });
  const found = await probeModel('gemini-3.8-flash', { adapters: { google } });
  assert.deepEqual(found.results, { reply: 'ok', json: 'ok', rewrite: 'ok', ping: 'ok' });
  assert.equal(found.line, 'gemini-3.8-flash: reply ok | json ok | rewrite ok | ping ok');
  assert.deepEqual(google.pings.map(({ model }) => model), ['gemini-3.8-flash']);
  assert.match(found.details, /ping .*s, 4 in, 1 out/);
  assert.deepEqual(google.calls.map(call => call.job), ['reply', 'classify', 'rewrite']);
  for (const call of google.calls) {
    assert.equal(call.model, 'gemini-3.8-flash');
    assert.equal(call.entry.provider, 'google');
  }
  assert.equal(google.calls[1].schema, SCHEMAS.classify);
  assert.equal(google.calls[1].json, true);
  assert.equal(google.calls[2].temperature, 0.2);
  assert.match(found.details, /reply .*s, 10 in, 20 out; json .*; rewrite /);
});

test('each failure is told in a word: no text, not JSON, cut off at the limit, or the provider\'s own refusal with its status and code', async () => {
  const answers = {
    reply: { text: '  ', inputTokens: 1, outputTokens: 1 },
    json: { text: 'Sure! {"a":1}', inputTokens: 1, outputTokens: 1 },
    rewrite: { text: 'half a sentence', inputTokens: 1, outputTokens: 1, cutOff: true },
  };
  const odd = fakeAdapter('anthropic', { names: ['claude-haiku-5-5'], answer: request => answers[request.job === 'classify' ? 'json' : request.job] });
  assert.deepEqual((await probeModel('claude-haiku-5-5', { adapters: { anthropic: odd } })).results, { reply: 'EMPTY', json: 'NOT JSON', rewrite: 'CUT OFF', ping: 'ok' });
  const refused = fakeAdapter('openai', { names: ['gpt-5.4'], answer: request => Object.assign(new Error('Bad'), request.job === 'reply' ? { status: 400, code: 'unsupported_parameter' } : { status: 402, error: { type: 'billing' } }) });
  assert.deepEqual((await probeModel('gpt-5.4', { adapters: { openai: refused } })).results, { reply: 'FAILED 400 unsupported_parameter', json: 'FAILED 402 billing', rewrite: 'FAILED 402 billing', ping: 'ok' });
  const dropped = fakeAdapter('openai', { names: ['gpt-5.4'], answer: () => new Error('socket hang up') });
  assert.equal((await probeModel('gpt-5.4', { adapters: { openai: dropped } })).results.reply, 'FAILED Error unknown');
});

test('the ping is sent through the adapter after the three shapes, and a refused ping is told by its status and code, without stopping the line', async () => {
  const refusedPing = fakeAdapter('anthropic', { names: ['claude-haiku-5-5'], answer: jsonAnswer, ping: async () => { throw Object.assign(new Error('max_tokens too small'), { status: 400, error: { type: 'invalid_request_error' } }); } });
  const found = await probeModel('claude-haiku-5-5', { adapters: { anthropic: refusedPing } });
  assert.equal(found.results.ping, 'FAILED 400 invalid_request_error');
  assert.equal(found.line, 'claude-haiku-5-5: reply ok | json ok | rewrite ok | ping FAILED 400 invalid_request_error');
  assert.equal(refusedPing.calls.length, 3);
  assert.equal(refusedPing.pings.length, 1);
});

test('the raw usage numbers of each answer are printed beside its tokens, as the provider response carried them', async () => {
  const google = fakeAdapter('google', { names: ['gemini-3.8-flash'], answer: jsonAnswer });
  let read = 0;
  const watch = { take: () => (read++ % 2 === 1 ? 'usage prompt_tokens=7 completion_tokens=5 total_tokens=52' : null) };
  const found = await probeModel('gemini-3.8-flash', { adapters: { google }, watch });
  assert.equal(found.details.split('; ').length, 4);
  for (const part of found.details.split('; ')) assert.match(part, /usage prompt_tokens=7 completion_tokens=5 total_tokens=52$/);
});

const asResponse = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-secret-header': 'header-value-123', authorization: 'Bearer nope' } });

for (const [host, body, expected] of [
  ['api.openai.com', { choices: [{ message: { content: 'secret words' } }], usage: { prompt_tokens: 9, completion_tokens: 30, total_tokens: 39, completion_tokens_details: { reasoning_tokens: 21, accepted_prediction_tokens: 0 } } },
    'prompt_tokens=9 completion_tokens=30 total_tokens=39 completion_tokens_details.reasoning_tokens=21 completion_tokens_details.accepted_prediction_tokens=0'],
  ['api.anthropic.com', { content: [{ type: 'text', text: 'secret words' }], usage: { input_tokens: 12, output_tokens: 44, cache_read_input_tokens: 0, service_tier: 'standard', server_tool_use: { web_search_requests: 0 } } },
    'input_tokens=12 output_tokens=44 cache_read_input_tokens=0 server_tool_use.web_search_requests=0'],
  ['generativelanguage.googleapis.com', { choices: [{ message: { content: 'secret words' } }], usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 49, completion_tokens_details: { reasoning_tokens: 40 } } },
    'prompt_tokens=6 completion_tokens=3 total_tokens=49 completion_tokens_details.reasoning_tokens=40'],
]) {
  test(`the usage watcher reads ${host}'s numbers from a copy of the response, and prints numbers only, never text or headers`, async () => {
    const watcher = watchUsage({ fetchImpl: async () => asResponse(body) });
    assert.equal(watcher.take(), null);
    const response = await watcher.fetch(`https://${host}/v1/anything`, { method: 'POST' });
    assert.deepEqual(await response.json(), body, 'the caller still gets the whole response');
    const taken = watcher.take();
    assert.equal(taken, `usage ${expected}`);
    assert.doesNotMatch(taken, /secret|header-value|Bearer|content/);
    assert.equal(watcher.take(), null, 'taken once');
  });
}

test('the usage watcher keeps nothing of a response with no usage, a body that is not JSON, or a host the probe does not use', async () => {
  const bodies = [asResponse({ data: [] }), new Response('not json at all', { status: 500 }), asResponse({ usage: { prompt_tokens: 1 } })];
  const watcher = watchUsage({ fetchImpl: async () => bodies.shift() });
  await watcher.fetch('https://api.openai.com/v1/models');
  assert.equal(watcher.take(), null);
  await watcher.fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(watcher.take(), null);
  await watcher.fetch('https://example.test/x');
  assert.equal(watcher.take(), null);
});

test('a model the registry lacks, one whose provider has no adapter, and one the provider does not list are each said so and sent nothing', async () => {
  const google = fakeAdapter('google', { names: ['gemini-3.5-flash-lite'] });
  assert.match((await probeModel('gemini-9-imaginary', { adapters: { google } })).line, /gemini-9-imaginary: not in the registry/);
  assert.match((await probeModel('claude-haiku-5-5', { adapters: { google } })).line, /claude-haiku-5-5: no anthropic adapter/);
  assert.match((await probeModel('gemini-3.8-flash', { adapters: { google } })).line, /gemini-3.8-flash: not in google's list/);
  assert.equal(google.calls.length, 0);
  const broken = { name: 'google', async listModels() { throw new Error('a key sk-proj-abcDEF1234567890wxyz was refused'); }, async call() { throw new Error('never'); } };
  const said = (await probeModel('gemini-3.8-flash', { adapters: { google: broken } })).line;
  assert.match(said, /gemini-3.8-flash: google's list could not be read/);
  assert.doesNotMatch(said, /sk-proj-abcDEF/);
});

test('a run prints its estimated cost first and sends nothing without --yes', async () => {
  const google = fakeAdapter('google', { names: ['gemini-3.8-flash'], answer: jsonAnswer });
  const printed = [];
  const code = await runProbe({ argv: ['gemini-3.8-flash'], adapters: { google }, log: line => printed.push(line) });
  assert.equal(code, 2);
  assert.match(printed[0], /^Estimated cost of this run: under \$\d+\.\d\d$/);
  assert.match(printed.at(-1), /Add --yes to run it/);
  assert.equal(google.calls.length, 0);
});

test('with --yes a run prints one line a model, each with its detail line, across the providers', async () => {
  const adapters = {
    openai: fakeAdapter('openai', { names: ['gpt-5.4'], answer: jsonAnswer }),
    anthropic: fakeAdapter('anthropic', { names: ['claude-haiku-5-5'], answer: jsonAnswer }),
    google: fakeAdapter('google', { names: ['gemini-3.5-flash-lite'], answer: jsonAnswer }),
  };
  const printed = [];
  const code = await runProbe({ argv: ['--yes', 'gpt-5.4', 'claude-haiku-5-5', 'gemini-3.5-flash-lite'], adapters, log: line => printed.push(line) });
  assert.equal(code, 0);
  for (const model of ['gpt-5.4', 'claude-haiku-5-5', 'gemini-3.5-flash-lite']) assert.ok(printed.includes(`${model}: reply ok | json ok | rewrite ok | ping ok`), model);
  assert.equal(printed.filter(line => line.startsWith('  ')).length, 3);
  assert.ok(Object.values(adapters).every(adapter => adapter.calls.length === 3 && adapter.pings.length === 1));
});

test('a run with a model the registry lacks stops before anything is sent', async () => {
  const google = fakeAdapter('google', { names: ['gemini-3.8-flash'] });
  const printed = [];
  const code = await runProbe({ argv: ['--yes', 'gemini-3.8-flash', 'gemini-9-imaginary'], adapters: { google }, log: line => printed.push(line) });
  assert.equal(code, 1);
  assert.equal(google.calls.length, 0);
});
