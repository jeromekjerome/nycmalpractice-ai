// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Google's adapter (provider-google.js): the request each job becomes on Google's OpenAI-compatible endpoint, the answer
// read back into the shape every adapter gives, and what failureOf makes of the openai SDK's errors from it. A fake
// client, and a fake fetch under the SDK's own client, stand in for Google: nothing here reaches a network or a database.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { runJob, failureOf, adaptersFor } from '../providers.js';
import { googleAdapter } from '../provider-google.js';
import { SCHEMAS } from '../job-schemas.js';
import { MODELS, entryFor, providerOf, priceOn } from '../model-registry.js';
import { estimateAiCost, hasPrice } from '../ai-budget.js';
import { installGuard } from '../measure/guard-fetch.mjs';

const noBudget = ({ execute }) => execute();

// A chat completion as the compatible endpoint answers it.
function completion(content, { finish = 'stop', prompt = 3, completionTokens = 2, thinking, total } = {}) {
  return {
    id: 'cmpl_test', object: 'chat.completion', model: 'gemini-3.8-flash',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
    usage: {
      prompt_tokens: prompt, completion_tokens: completionTokens, total_tokens: total === null ? undefined : (total ?? prompt + completionTokens),
      ...(thinking !== undefined ? { completion_tokens_details: { reasoning_tokens: thinking } } : {}),
    },
  };
}

// A fake client. Each request is kept in `sent`, with the options (the signal) it was given.
function fakeClient(respond = () => completion('ok')) {
  const sent = [];
  return {
    sent,
    chat: { completions: { async create(body, options) { sent.push({ body, options }); return respond(body); } } },
    models: {
      async *list() { for (const id of ['models/gemini-3.8-flash', 'models/gemini-3.5-flash-lite', 'gemini-2.5-pro']) yield { id }; },
    },
  };
}

const QUESTION = [{ role: 'user', content: 'What is a statute of limitations?' }];
const FLASH = { model: 'gemini-3.8-flash', entry: entryFor('gemini-3.8-flash') };
const LITE = { model: 'gemini-3.5-flash-lite', entry: entryFor('gemini-3.5-flash-lite') };

// ─── The request ──────────────────────────────────────────────────────────────

test('a reply to Gemini is one leading system message, the conversation, the entry\'s reasoning effort and the length with thinking room, with no temperature and no store', async () => {
  const client = fakeClient();
  const answer = await googleAdapter(client).call({ ...FLASH, job: 'reply', system: 'You answer plainly.', messages: QUESTION, maxTokens: 1000, temperature: 0.7 });
  assert.equal(answer.text, 'ok');
  assert.deepEqual(client.sent.map(({ body }) => body), [{
    model: 'gemini-3.8-flash',
    messages: [{ role: 'system', content: 'You answer plainly.' }, { role: 'user', content: 'What is a statute of limitations?' }],
    max_tokens: 3000,
    reasoning_effort: 'low',
  }]);
});

test('a JSON job is asked for with the job\'s schema as a json_schema response format, a copy that nothing done to the request can reach', async () => {
  const client = fakeClient(() => completion('{"type":"auto","terms":"x"}'));
  const answer = await googleAdapter(client).call({ ...LITE, job: 'classify', schema: SCHEMAS.classify, messages: QUESTION, json: true, maxTokens: 120 });
  assert.equal(answer.text, '{"type":"auto","terms":"x"}');
  const [{ body }] = client.sent;
  assert.deepEqual(body, {
    model: 'gemini-3.5-flash-lite',
    messages: QUESTION,
    max_tokens: 2120,
    reasoning_effort: 'low',
    response_format: { type: 'json_schema', json_schema: { name: 'classify', strict: true, schema: SCHEMAS.classify } },
  });
  assert.notEqual(body.response_format.json_schema.schema, SCHEMAS.classify);
  body.response_format.json_schema.schema.required.push('mutated');
  assert.deepEqual(SCHEMAS.classify.required, ['type', 'terms']);
});

test('a JSON job with no schema is asked for as a json_object, as the OpenAI adapter asks', async () => {
  const client = fakeClient(() => completion('{}'));
  await googleAdapter(client).call({ ...LITE, job: 'someJob', messages: QUESTION, json: true, maxTokens: 120 });
  assert.deepEqual(client.sent[0].body.response_format, { type: 'json_object' });
});

test('the rewrite keeps its words: its late system instruction is sent as a user turn, so that the request ends with the user, and no temperature goes', async () => {
  const client = fakeClient();
  await googleAdapter(client).call({
    ...FLASH, job: 'rewrite', temperature: 0.2, maxTokens: 1000,
    messages: [
      { role: 'system', content: 'You rewrite replies.' },
      { role: 'user', content: 'The question' },
      { role: 'assistant', content: 'The draft' },
      { role: 'system', content: 'Rewrite it without the blocked phrases.' },
    ],
  });
  assert.deepEqual(client.sent[0].body, {
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'system', content: 'You rewrite replies.' },
      { role: 'user', content: 'The question' },
      { role: 'assistant', content: 'The draft' },
      { role: 'user', content: 'Rewrite it without the blocked phrases.' },
    ],
    max_tokens: 3000,
    reasoning_effort: 'low',
  });
  assert.equal('temperature' in client.sent[0].body, false);
});

test('the system argument and a leading system message are joined into the one system message', async () => {
  const client = fakeClient();
  await googleAdapter(client).call({ ...FLASH, job: 'reply', system: 'First.', messages: [{ role: 'system', content: 'Second.' }, ...QUESTION], maxTokens: 10 });
  assert.deepEqual(client.sent[0].body.messages, [{ role: 'system', content: 'First.\n\nSecond.' }, QUESTION[0]]);
});

test('the other jobs of the entry are asked at its small effort, and a model with no entry is sent no effort', async () => {
  const client = fakeClient();
  const adapter = googleAdapter(client);
  await adapter.call({ ...FLASH, job: 'leadScore', messages: QUESTION, maxTokens: 100 });
  await adapter.call({ model: 'gemini-9-unknown', entry: null, job: 'reply', messages: QUESTION, maxTokens: 100 });
  assert.equal(client.sent[0].body.reasoning_effort, 'low');
  assert.equal('reasoning_effort' in client.sent[1].body, false);
});

test('the signal is handed to the client, and the request never carries a store field or a tool', async () => {
  const client = fakeClient();
  const controller = new AbortController();
  await googleAdapter(client).call({ ...FLASH, job: 'reply', messages: QUESTION, maxTokens: 10, signal: controller.signal });
  assert.equal(client.sent[0].options.signal, controller.signal);
  for (const key of ['store', 'tools', 'tool_choice', 'temperature', 'top_p', 'stream']) assert.equal(key in client.sent[0].body, false);
});

test('the health check is the smallest valid request: one user message, one token, the small effort', async () => {
  const client = fakeClient(() => completion('', { finish: 'length', prompt: 4, completionTokens: 1, thinking: 0 }));
  const cost = await googleAdapter(client).ping('gemini-3.5-flash-lite');
  assert.deepEqual(client.sent[0].body, { model: 'gemini-3.5-flash-lite', messages: [{ role: 'user', content: 'health check' }], max_tokens: 1, reasoning_effort: 'low' });
  assert.deepEqual(cost, { inputTokens: 4, outputTokens: 1 });
});

test('allowance is exactly the length each request asks for: the job\'s own and the room to think, and one for the ping', async () => {
  const client = fakeClient();
  const adapter = googleAdapter(client);
  for (const [job, maxTokens] of [['reply', 1000], ['classify', 120], ['rewrite', 1000]]) {
    await adapter.call({ ...FLASH, job, messages: QUESTION, maxTokens });
    assert.equal(adapter.allowance({ ...FLASH, job, maxTokens }), client.sent.at(-1).body.max_tokens);
  }
  await adapter.ping('gemini-3.8-flash');
  assert.equal(adapter.allowance({ ...FLASH, job: 'health' }), client.sent.at(-1).body.max_tokens);
  assert.equal(adapter.allowance({ ...FLASH, job: 'reply', maxTokens: 1000 }), 3000);
});

// ─── The answer ───────────────────────────────────────────────────────────────

test('usage: input is the prompt tokens, output is the total less the prompt, which is where Google reports thinking (recorded shapes of 2026-11-21)', async () => {
  const ask = usage => googleAdapter(fakeClient(() => completion('hello', usage))).call({ ...FLASH, job: 'reply', messages: QUESTION, maxTokens: 10 });
  // Google's compatible endpoint, as the live probe recorded it: no reasoning_tokens, the thinking only in total_tokens.
  assert.deepEqual(await ask({ prompt: 56, completionTokens: 12, total: 435 }), { text: 'hello', inputTokens: 56, outputTokens: 379 }, 'gemini-3.8-flash rewrite');
  assert.deepEqual(await ask({ prompt: 25, completionTokens: 44, total: 369 }), { text: 'hello', inputTokens: 25, outputTokens: 344 }, 'gemini-3.5-flash-lite reply');
  assert.equal((await ask({ prompt: 37, completionTokens: 16, total: 53 })).outputTokens, 16, 'json');
  assert.equal((await ask({ prompt: 3, completionTokens: 0, total: 3 })).outputTokens, 0, 'ping');
  // A reported reasoning count with a consistent total is not added twice.
  assert.equal((await ask({ prompt: 20, completionTokens: 10, thinking: 5, total: 35 })).outputTokens, 15);
  // A reasoning count the total does not account for is not lost, and with no total the completion and reasoning tokens are summed.
  assert.equal((await ask({ prompt: 20, completionTokens: 10, thinking: 5, total: 30 })).outputTokens, 15);
  assert.equal((await ask({ prompt: 7, completionTokens: 5, thinking: 40, total: null })).outputTokens, 45);
  assert.equal((await ask({ prompt: 7, completionTokens: 5, total: null })).outputTokens, 5);
});

test('an answer stopped at the length limit is cutOff, and one with no text at all is empty to failureOf', async () => {
  const adapter = googleAdapter(fakeClient(() => completion('', { finish: 'length', thinking: 50 })));
  const answer = await adapter.call({ ...FLASH, job: 'reply', messages: QUESTION, maxTokens: 10 });
  assert.equal(answer.cutOff, true);
  assert.equal(failureOf(answer).reason, 'empty');
  const partial = await googleAdapter(fakeClient(() => completion('half an ans', { finish: 'length' }))).call({ ...FLASH, job: 'reply', messages: QUESTION, maxTokens: 10 });
  assert.equal(partial.cutOff, true);
  assert.equal(failureOf(partial), null);
});

test('a blocked answer with no text is an empty failure, whether its content is null, missing or a filter stop', async () => {
  for (const reply of [
    { choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }], usage: { prompt_tokens: 3, completion_tokens: 0 } },
    { choices: [], usage: { prompt_tokens: 3 } },
    {},
  ]) {
    const answer = await googleAdapter(fakeClient(() => reply)).call({ ...FLASH, job: 'reply', messages: QUESTION, maxTokens: 10 });
    assert.equal(answer.text, '');
    assert.equal(failureOf(answer).reason, 'empty');
  }
});

test('listModels gives the names without Google\'s models/ prefix, so that they match the registry', async () => {
  assert.deepEqual(await googleAdapter(fakeClient()).listModels(), ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-pro']);
});

test('the adapter is named google, answers at generativelanguage.googleapis.com, and a model with the response read as a TypeError is a connection failure, not the app\'s fault', async () => {
  const adapter = googleAdapter(fakeClient());
  assert.equal(adapter.name, 'google');
  assert.equal(adapter.host, 'generativelanguage.googleapis.com');
  const broken = googleAdapter({ chat: { completions: { async create() { throw new TypeError('terminated'); } } } });
  await assert.rejects(broken.call({ ...FLASH, job: 'reply', messages: QUESTION, maxTokens: 10 }), error => failureOf(error)?.reason === 'connection');
});

// ─── The registry and its price ───────────────────────────────────────────────

test('both Gemini models are in the registry as Google\'s, at the prices read from Google\'s pricing page, with a low effort', () => {
  assert.equal(providerOf('gemini-3.8-flash'), 'google');
  assert.equal(providerOf('gemini-3.5-flash-lite'), 'google');
  assert.deepEqual(MODELS['gemini-3.8-flash'].price, [0.75, 3.75]);
  assert.deepEqual(MODELS['gemini-3.5-flash-lite'].price, [0.30, 2.50]);
  for (const name of ['gemini-3.8-flash', 'gemini-3.5-flash-lite']) {
    assert.deepEqual(MODELS[name].effort, { reply: 'low', small: 'low' });
    assert.equal(hasPrice(name), true);
  }
  assert.equal(estimateAiCost('gemini-3.8-flash', 1_000_000, 1_000_000, '', '2026-12-31'), 4.5);
});

test('gemini-3.8-flash is priced at 0.75 and 3.75 through 2026-12-31 and at 1.50 and 7.50 from 2027-01-01, and every price is read for a day through one function', () => {
  assert.deepEqual(priceOn('gemini-3.8-flash', '2026-12-31'), [0.75, 3.75]);
  assert.deepEqual(priceOn('gemini-3.8-flash', '2027-01-01'), [1.50, 7.50]);
  assert.deepEqual(priceOn('gemini-3.8-flash', '2030-06-01'), [1.50, 7.50]);
  assert.deepEqual(priceOn('gemini-3.8-flash-2026-10-01', '2027-02-01'), [1.50, 7.50], 'a dated snapshot of the name');
  assert.deepEqual(priceOn('gemini-3.5-flash-lite', '2027-01-01'), [0.30, 2.50]);
  assert.deepEqual(priceOn('gpt-5.4', '2027-01-01'), [2.50, 15.00]);
  assert.equal(priceOn('no-such-model', '2027-01-01'), null);
  // The caps' estimate is the same price: a million tokens each way on each side of the day.
  assert.equal(estimateAiCost('gemini-3.8-flash', 1_000_000, 1_000_000, '', '2026-12-31'), 4.5);
  assert.equal(estimateAiCost('gemini-3.8-flash', 1_000_000, 1_000_000, '', '2027-01-01'), 9);
  // With no day given it is today's: whichever side of the change today is, it is one of the two.
  assert.ok([4.5, 9].includes(estimateAiCost('gemini-3.8-flash', 1_000_000, 1_000_000)));
});

// ─── The five schemas, against what Google's structured output takes ──────────

test('the five schemas use only what Google\'s structured output documents: no keyword it ignores or lacks', () => {
  // Documented as supported: type, enum, required, additionalProperties, items, anyOf with null. Ignored by Google (so
  // a schema leaning on them would silently lose its meaning): length, size and uniqueness limits. Not documented: oneOf, not, nullable.
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf']);
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((item, at) => walk(item, `${path}[${at}]`));
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties') Object.entries(value).forEach(([name, sub]) => walk(sub, `${path}.${name}`));
      else {
        assert.ok(allowed.has(key), `${path} uses "${key}", which Google's structured output does not document`);
        walk(value, `${path}.${key}`);
      }
    }
  };
  for (const [name, schema] of Object.entries(SCHEMAS)) walk(schema, name);
});

// ─── Registration ─────────────────────────────────────────────────────────────

test('the Google adapter is among the default adapters only when GEMINI_API_KEY is set', () => {
  assert.deepEqual(Object.keys(adaptersFor({ GEMINI_API_KEY: '' })), ['openai']);
  assert.deepEqual(Object.keys(adaptersFor({})), ['openai']);
  assert.deepEqual(Object.keys(adaptersFor({ ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' })), ['openai', 'anthropic', 'google']);
  assert.equal(adaptersFor({ GEMINI_API_KEY: 'test-gemini-key' }).google.name, 'google');
  assert.equal(process.env.GEMINI_API_KEY, '');
});

// ─── The SDK's own client, over a fake fetch ──────────────────────────────────

function reply(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

async function withOwnClient(fetchImpl, fn) {
  const saved = { fetch: globalThis.fetch, key: process.env.GEMINI_API_KEY };
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.key;
  }
}

test('the adapter\'s own client posts to Google\'s compatible endpoint through the fetch in force at each call, with its key as a bearer credential and the body written out', async () => {
  const seen = [];
  const fetchImpl = async (input, init) => {
    seen.push({ url: String(input?.url ?? input), method: init?.method, auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(init.body) });
    return reply(200, completion('ok'));
  };
  await withOwnClient(fetchImpl, async () => {
    const adapter = googleAdapter();
    assert.equal(seen.length, 0, 'making the adapter sends nothing');
    await adapter.call({ ...FLASH, job: 'reply', system: 'S', messages: QUESTION, maxTokens: 1000 });
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].auth, 'Bearer test-gemini-key');
  assert.deepEqual(seen[0].body, {
    model: 'gemini-3.8-flash',
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'What is a statute of limitations?' }],
    max_tokens: 3000,
    reasoning_effort: 'low',
  });
});

test('the guard that allows Google\'s host lets the adapter\'s request through to its fetch, and refuses every other host', async () => {
  const reached = [];
  const guard = (() => {
    const before = globalThis.fetch;
    globalThis.fetch = async input => { reached.push(String(input?.url ?? input)); return reply(200, completion('ok')); };
    const installed = installGuard({ allowHosts: ['generativelanguage.googleapis.com'] });
    return { installed, before };
  })();
  try {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    await googleAdapter().call({ ...FLASH, job: 'reply', messages: QUESTION, maxTokens: 10 });
    assert.equal(reached.length, 1);
    await assert.rejects(globalThis.fetch('https://api.anthropic.com/v1/messages', { method: 'POST' }), /refused a request to api\.anthropic\.com/);
    assert.deepEqual(guard.installed.refused, ['api.anthropic.com']);
  } finally {
    process.env.GEMINI_API_KEY = '';
    guard.installed.restore();
    globalThis.fetch = guard.before;
  }
});

// What each status Google documents becomes, through the SDK's own error classes, and at runJob.
const STATUSES = [
  [400, 'invalid_request', 'bad_request'],
  [400, 'failed_precondition', 'bad_request'],
  [401, 'authentication', 'auth'],
  [403, 'permission_denied', 'auth'],
  [404, 'model_not_found', 'gone'],
  [429, 'rate_limit_exceeded', 'rate_limit'],
  [429, 'too_many_requests', 'rate_limit'],
  [429, 'quota_exceeded', 'quota'],
  [500, 'api_error', 'server'],
  [503, 'service_unavailable', 'server'],
  [504, 'deadline_exceeded', 'server'],
];

for (const [status, code, reason] of STATUSES) {
  test(`Google's ${status} ${code}, as the SDK's own error carries it, is ${reason}`, async () => {
    const error = await withOwnClient(async () => reply(status, { error: { code, message: 'a message from Google' } }), async () => {
      try {
        await googleAdapter().call({ ...FLASH, job: 'reply', messages: QUESTION, maxTokens: 10 });
      } catch (caught) {
        return caught;
      }
      return null;
    });
    assert.equal(error?.status, status);
    assert.equal(failureOf(error)?.reason, reason);
  });
}

test('an exhausted prepaid balance, Google\'s 402 payment_required, is a quota failure that marks the provider down at once', async () => {
  const error = await withOwnClient(async () => reply(402, { error: { code: 'payment_required', message: 'Your Prepay credit balance is depleted.' } }), async () => {
    try {
      await googleAdapter().call({ ...FLASH, job: 'reply', messages: QUESTION, maxTokens: 10 });
    } catch (caught) {
      return caught;
    }
    return null;
  });
  assert.equal(error?.status, 402);
  assert.equal(failureOf(error).reason, 'quota');
  assert.equal(failureOf(error).markDownNow, true);
  // And a 402 with no body code at all.
  const bare = await withOwnClient(async () => reply(402, {}), async () => googleAdapter().call({ ...FLASH, job: 'reply', messages: QUESTION, maxTokens: 10 }).catch(caught => caught));
  assert.equal(failureOf(bare).reason, 'quota');
});

test('a Google 403 for an outstanding balance is an auth failure that marks the provider down at once', async () => {
  const error = await withOwnClient(async () => reply(403, { error: { code: 'permission_denied', message: 'Your project has an outstanding balance.' } }), async () => googleAdapter().call({ ...FLASH, job: 'reply', messages: QUESTION, maxTokens: 10 }).catch(caught => caught));
  assert.equal(failureOf(error).reason, 'auth');
  assert.equal(failureOf(error).markDownNow, true);
});

test('runJob asks a Google model through the adapter, records its tokens and names the provider', async () => {
  const google = googleAdapter(fakeClient(() => completion('from gemini', { prompt: 9, completionTokens: 4 })));
  const chain = ['gemini-3.8-flash'];
  const got = await runJob({ job: 'reply', chain, messages: QUESTION, maxTokens: 100 }, { adapters: { google }, budget: noBudget });
  assert.deepEqual([got.text, got.provider, got.model, got.inputTokens, got.outputTokens], ['from gemini', 'google', 'gemini-3.8-flash', 9, 4]);
});
