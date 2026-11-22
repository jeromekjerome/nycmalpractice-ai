// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Anthropic's adapter (provider-anthropic.js): the request each job becomes for a Claude model, the answer read back
// into the shape every adapter gives, and what failureOf makes of the SDK's own errors. A fake client, and a fake
// fetch under the SDK's own client, stand in for Anthropic: nothing here reaches a network or a database.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import {
  APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, AuthenticationError, BadRequestError,
  ConflictError, ContentTooLargeError, InternalServerError, NotFoundError, OverloadedError, PaymentRequiredError,
  PermissionDeniedError, RateLimitError, UnprocessableEntityError, AnthropicError,
} from '@anthropic-ai/sdk';
import { test } from './runner.mjs';
import { runJob, failureOf, adaptersFor, ProvidersFailed } from '../providers.js';
import { anthropicAdapter } from '../provider-anthropic.js';
import { SCHEMAS } from '../job-schemas.js';
import { MODELS, entryFor, providerOf } from '../model-registry.js';
import { estimateAiCost, hasPrice } from '../ai-budget.js';

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

const noBudget = ({ execute }) => execute();

// A message as the Messages API answers it.
function message(blocks, { stop = 'end_turn', input = 3, output = 2, cacheWrite, cacheRead } = {}) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
    content: typeof blocks === 'string' ? [{ type: 'text', text: blocks }] : blocks,
    stop_reason: stop, stop_sequence: null,
    usage: {
      input_tokens: input, output_tokens: output,
      ...(cacheWrite !== undefined ? { cache_creation_input_tokens: cacheWrite } : {}),
      ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    },
  };
}

// A fake client. Each request is kept in `sent`, with the options (the signal) it was given.
function fakeClient(respond = () => message('ok')) {
  const sent = [];
  return {
    sent,
    messages: { async create(body, options) { sent.push({ body, options }); return respond(body); } },
    models: {
      // Two pages, as the SDK's own list gives them.
      async *list() { for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) yield { id }; },
    },
  };
}

const QUESTION = [{ role: 'user', content: 'What is a statute of limitations?' }];
const headers = new Headers();
const body = (type, text = 'a message') => ({ type: 'error', error: { type, message: text } });

// ─── The request ──────────────────────────────────────────────────────────────

test('a reply to Claude is the system prompt apart, the conversation, adaptive thinking and the entry\'s effort, with no temperature, forced tool, prefill or fallback', async () => {
  const client = fakeClient();
  const adapter = anthropicAdapter(client);
  const answer = await adapter.call({
    model: 'claude-sonnet-5-5', entry: entryFor('claude-sonnet-5-5'), job: 'reply',
    system: 'You answer plainly.', messages: QUESTION, maxTokens: 1000, temperature: 0.7, signal: undefined,
  });
  assert.equal(answer.text, 'ok');
  assert.deepEqual(client.sent.map(({ body: sent }) => sent), [{
    model: 'claude-sonnet-5-5',
    max_tokens: 3000,
    system: 'You answer plainly.',
    messages: [{ role: 'user', content: 'What is a statute of limitations?' }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
  }]);
  const sent = client.sent[0].body;
  for (const key of ['temperature', 'top_p', 'top_k', 'tool_choice', 'tools', 'fallbacks', 'budget_tokens']) assert.ok(!(key in sent), key);
  assert.notEqual(sent.messages.at(-1).role, 'assistant');
});

test('a JSON job to Claude carries that job\'s schema as its structured output, the small jobs\' effort, and no tool', async () => {
  const before = JSON.stringify(SCHEMAS);
  const client = fakeClient(() => message('{"type":"auto","terms":"car"}'));
  const answer = await anthropicAdapter(client).call({
    model: 'claude-haiku-5-5', entry: entryFor('claude-haiku-5-5'), job: 'classify', schema: SCHEMAS.classify,
    messages: QUESTION, json: true, maxTokens: 120,
  });
  assert.equal(answer.text, '{"type":"auto","terms":"car"}');
  const { body: sent } = client.sent[0];
  assert.deepEqual(sent, {
    model: 'claude-haiku-5-5',
    max_tokens: 2120,
    messages: QUESTION,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMAS.classify } },
  });
  // It is a copy: the schemas are shared by every job, and nothing the adapter does to its request may reach them.
  assert.notEqual(sent.output_config.format.schema, SCHEMAS.classify);
  assert.notEqual(sent.output_config.format.schema.properties, SCHEMAS.classify.properties);
  sent.output_config.format.schema.properties.type.enum.push('changed');
  assert.equal(JSON.stringify(SCHEMAS), before);
  assert.ok(!('tools' in sent) && !('tool_choice' in sent));
  // The schemas use only what structured outputs take: plain types, enum, anyOf with null (alone in its object),
  // required, and additionalProperties false; no numeric or string limits.
  const walk = schema => {
    if (schema === null || typeof schema !== 'object') return;
    for (const key of ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'oneOf', 'not', 'allOf', '$ref']) assert.ok(!(key in schema), key);
    if ('anyOf' in schema) assert.ok(!('type' in schema) && !('properties' in schema), 'anyOf beside type');
    if (schema.type === 'object') assert.equal(schema.additionalProperties, false);
    for (const value of Object.values(schema)) walk(value);
  };
  for (const schema of Object.values(SCHEMAS)) walk(schema);
});

test('a JSON job whose app has no schema for it is sent with no format, and every small job is asked at the small effort', async () => {
  const client = fakeClient();
  await anthropicAdapter(client).call({ model: 'claude-opus-5-5', entry: entryFor('claude-opus-5-5'), job: 'newJob', schema: null, messages: QUESTION, json: true, maxTokens: 50 });
  assert.deepEqual(client.sent[0].body.output_config, { effort: 'low' });
});

test('a rewrite to Claude ends with a user turn: the instruction the gate puts last becomes the user\'s, and the draft stays the assistant\'s', async () => {
  const client = fakeClient();
  const messages = [
    { role: 'system', content: 'You rewrite replies.' },
    { role: 'user', content: 'The question' },
    { role: 'assistant', content: 'The blocked draft' },
    { role: 'system', content: 'Rewrite the draft above without the problems listed.' },
  ];
  await anthropicAdapter(client).call({ model: 'claude-sonnet-5-5', entry: entryFor('claude-sonnet-5-5'), job: 'rewrite', messages, maxTokens: 1000, temperature: 0.2 });
  assert.deepEqual(client.sent[0].body, {
    model: 'claude-sonnet-5-5',
    max_tokens: 3000,
    system: 'You rewrite replies.',
    messages: [
      { role: 'user', content: 'The question' },
      { role: 'assistant', content: 'The blocked draft' },
      { role: 'user', content: 'Rewrite the draft above without the problems listed.' },
    ],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
  });
});

test('the leading system messages become one system text, and consecutive messages of one role are joined into one turn', async () => {
  const client = fakeClient();
  await anthropicAdapter(client).call({
    model: 'claude-sonnet-5-5', entry: entryFor('claude-sonnet-5-5'), job: 'reply',
    system: 'First.',
    messages: [
      { role: 'system', content: 'Second.' },
      { role: 'user', content: 'One' },
      { role: 'system', content: 'Aside.' },
      { role: 'assistant', content: 'Two' },
      { role: 'user', content: 'Three' },
    ],
    maxTokens: 10,
  });
  const sent = client.sent[0].body;
  assert.equal(sent.system, 'First.\n\nSecond.');
  assert.deepEqual(sent.messages, [
    { role: 'user', content: 'One\n\nAside.' },
    { role: 'assistant', content: 'Two' },
    { role: 'user', content: 'Three' },
  ]);
  // No system text at all: no system field.
  await anthropicAdapter(client).call({ model: 'claude-sonnet-5-5', entry: entryFor('claude-sonnet-5-5'), job: 'reply', messages: QUESTION, maxTokens: 10 });
  assert.ok(!('system' in client.sent[1].body));
});

test("a conversation that begins with the assistant's turn is sent to Claude beginning with the user's, as the Messages API needs: the assistant's turns before the user's first are left out, and an ordinary conversation is sent as it is", async () => {
  // The history the page sends, used when the stored conversation cannot be read, can begin with the assistant's turn:
  // cut to its last forty messages, or sent wrong.
  const client = fakeClient();
  const call = messages => anthropicAdapter(client).call({ model: 'claude-haiku-5-5', entry: entryFor('claude-haiku-5-5'), job: 'reply', system: 'You answer plainly.', messages, maxTokens: 10 });
  await call([
    { role: 'system', content: 'Instructions.' },
    { role: 'assistant', content: 'An earlier reply, whose question the history no longer holds.' },
    { role: 'assistant', content: 'And another.' },
    { role: 'user', content: 'My question' },
    { role: 'assistant', content: 'My answer' },
    { role: 'user', content: 'My next question' },
  ]);
  assert.equal(client.sent[0].body.system, 'You answer plainly.\n\nInstructions.');
  assert.deepEqual(client.sent[0].body.messages, [
    { role: 'user', content: 'My question' },
    { role: 'assistant', content: 'My answer' },
    { role: 'user', content: 'My next question' },
  ]);
  // A conversation that begins with the user's turn is sent as it is.
  const ordinary = [{ role: 'user', content: 'One' }, { role: 'assistant', content: 'Two' }, { role: 'user', content: 'Three' }];
  await call(ordinary);
  assert.deepEqual(client.sent[1].body.messages, ordinary);
});

test('the signal is handed to the SDK, and with a model the registry does not know no effort is asked', async () => {
  const client = fakeClient();
  const signal = new AbortController().signal;
  await anthropicAdapter(client).call({ model: 'claude-sonnet-9', entry: null, job: 'reply', messages: QUESTION, maxTokens: 10, signal });
  assert.equal(client.sent[0].options.signal, signal);
  assert.deepEqual(client.sent[0].body.output_config, undefined);
});

test('the allowance the caps reserve is exactly the output the request asks for, thinking\'s room included, and a health check\'s is the ping\'s', async () => {
  const client = fakeClient();
  const adapter = anthropicAdapter(client);
  const entry = entryFor('claude-opus-5-5');
  for (const [job, maxTokens] of [['reply', 1000], ['classify', 120], ['grade', 2500]]) {
    client.sent.length = 0;
    await adapter.call({ model: 'claude-opus-5-5', entry, job, messages: QUESTION, maxTokens });
    assert.equal(adapter.allowance({ model: 'claude-opus-5-5', entry, job, maxTokens }), client.sent[0].body.max_tokens, job);
  }
  client.sent.length = 0;
  await adapter.ping('claude-opus-5-5');
  assert.equal(adapter.allowance({ model: 'claude-opus-5-5', entry, job: 'health', maxTokens: undefined }), client.sent[0].body.max_tokens);
});

// ─── The answer ───────────────────────────────────────────────────────────────

test('the answer is the text blocks, with the tokens the response reports, cache tokens added to the input and thinking counted in the output', async () => {
  const answer = await anthropicAdapter(fakeClient(() => message(
    [{ type: 'thinking', thinking: 'hm', signature: 'sig' }, { type: 'text', text: 'Hello ' }, { type: 'text', text: 'there.' }],
    { input: 10, output: 40, cacheWrite: 5, cacheRead: 100 },
  ))).call({ model: 'claude-sonnet-5-5', entry: entryFor('claude-sonnet-5-5'), job: 'reply', messages: QUESTION, maxTokens: 100 });
  assert.deepEqual(answer, { text: 'Hello there.', inputTokens: 115, outputTokens: 40 });
});

test('a refusal comes back as refused, a stop at the allowance as cutOff, and an answer with no text blocks as empty text', async () => {
  const call = respond => anthropicAdapter(fakeClient(respond)).call({ model: 'claude-sonnet-5-5', entry: entryFor('claude-sonnet-5-5'), job: 'reply', messages: QUESTION, maxTokens: 100 });
  assert.deepEqual(await call(() => message([], { stop: 'refusal', input: 7, output: 0 })), { text: '', inputTokens: 7, outputTokens: 0, refused: true });
  assert.deepEqual(await call(() => message('Half a rep', { stop: 'max_tokens', output: 100 })), { text: 'Half a rep', inputTokens: 3, outputTokens: 100, cutOff: true });
  assert.equal((await call(() => message([{ type: 'thinking', thinking: 'all of it', signature: 's' }], { stop: 'max_tokens' }))).text, '');
});

test('a refusal makes runJob move on to the next model, and the refused attempt is still reserved and billed', async () => {
  const adapters = {
    anthropic: anthropicAdapter(fakeClient(() => message([], { stop: 'refusal', input: 7, output: 0 }))),
    openai: { name: 'openai', async call() { return { text: 'from openai', inputTokens: 1, outputTokens: 1 }; } },
  };
  const reserved = [];
  const budget = async ({ operation, model, request, execute }) => { reserved.push([operation, model, request.max_tokens]); return execute(); };
  const { result, lines } = await quietly(() => runJob({ job: 'reply', chain: ['claude-sonnet-5-5', 'gpt-6-luna'], messages: QUESTION, maxTokens: 1000 }, { adapters, budget }));
  assert.deepEqual([result.text, result.provider, result.model], ['from openai', 'openai', 'gpt-6-luna']);
  assert.deepEqual(result.attempts.map(attempt => [attempt.model, attempt.failure?.reason ?? null]), [['claude-sonnet-5-5', 'refusal'], ['gpt-6-luna', null]]);
  assert.deepEqual(reserved[0], ['reply', 'claude-sonnet-5-5', 3000]);
  assert.match(lines.join('\n'), /Trying the next model/);
});

test('a ping sends the smallest request, one short user message and the least output, and resolves with its tokens', async () => {
  const client = fakeClient(() => message([], { stop: 'max_tokens', input: 8, output: 1 }));
  const tokens = await anthropicAdapter(client).ping('claude-haiku-5-5', { signal: undefined });
  assert.deepEqual(tokens, { inputTokens: 8, outputTokens: 1 });
  assert.deepEqual(client.sent[0].body, {
    model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'health check' }], output_config: { effort: 'low' },
  });
});

test('the list of models is every id the SDK lists', async () => {
  assert.deepEqual(await anthropicAdapter(fakeClient()).listModels(), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
});

// ─── The SDK's own client ─────────────────────────────────────────────────────

function apiResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

async function withOwnClient(fn) {
  const saved = { fetch: globalThis.fetch, key: process.env.ANTHROPIC_API_KEY };
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
  }
}

const CLASSIFY = { model: 'claude-haiku-5-5', entry: entryFor('claude-haiku-5-5'), job: 'classify', schema: SCHEMAS.classify, messages: QUESTION, json: true, maxTokens: 120 };

test('the adapter\'s own client sends to Anthropic through the fetch in force at each call, with its key as a bearer credential, and the body written out', async () => {
  await withOwnClient(async () => {
    const first = [];
    globalThis.fetch = async (url, init) => { first.push([String(url), init]); return apiResponse(200, message('{"type":"auto","terms":"x"}')); };
    const adapter = anthropicAdapter();
    assert.equal((await adapter.call(CLASSIFY)).text, '{"type":"auto","terms":"x"}');
    const second = [];
    globalThis.fetch = async (url, init) => { second.push(String(url)); return apiResponse(200, message('{}')); };
    await adapter.call(CLASSIFY);
    // The client was made at the first call; the fetch put there later is the one the second call used.
    assert.equal(first.length, 1);
    assert.deepEqual(second, ['https://api.anthropic.com/v1/messages']);
    assert.equal(first[0][0], 'https://api.anthropic.com/v1/messages');
    assert.equal(new Headers(first[0][1].headers).get('authorization'), 'Bearer test-anthropic-key');
    assert.deepEqual(JSON.parse(first[0][1].body), {
      model: 'claude-haiku-5-5',
      max_tokens: 2120,
      messages: [{ role: 'user', content: 'What is a statute of limitations?' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMAS.classify } },
    });
  });
});

test('the adapter\'s own client sends a call once, and each failure is the SDK\'s own error, which failureOf names', async () => {
  await withOwnClient(async () => {
    const adapter = anthropicAdapter();
    const failures = [
      [() => apiResponse(529, body('overloaded_error', 'Overloaded')), 'server'],
      [() => apiResponse(500, body('api_error')), 'server'],
      [() => apiResponse(429, body('rate_limit_error')), 'rate_limit'],
      [() => apiResponse(402, body('billing_error', 'Your credit balance is too low')), 'quota'],
      [() => apiResponse(401, body('authentication_error')), 'auth'],
      [() => apiResponse(403, body('permission_error')), 'auth'],
      [() => apiResponse(404, body('not_found_error', 'model: claude-x')), 'gone'],
      [() => apiResponse(413, body('request_too_large')), 'bad_request'],
      [() => apiResponse(400, body('invalid_request_error')), 'bad_request'],
      [() => { throw new TypeError('fetch failed'); }, 'connection'],
      [() => { throw new DOMException('This operation was aborted', 'AbortError'); }, 'timeout'],
    ];
    for (const [respond, reason] of failures) {
      let sent = 0;
      globalThis.fetch = async () => { sent += 1; return respond(); };
      const error = await adapter.call(CLASSIFY).then(() => null, caught => caught);
      assert.ok(error instanceof APIError, `${reason}: ${error}`);
      assert.equal(failureOf(error)?.reason, reason, `${reason}: ${error.constructor.name}`);
      // Sent once: the SDK's own retry is off, because the chain of models is the retry.
      assert.equal(sent, 1, `${reason} was sent ${sent} times`);
    }
    let sent = 0;
    globalThis.fetch = async () => { sent += 1; return apiResponse(200, message('{}')); };
    const aborted = await adapter.call({ ...CLASSIFY, signal: AbortSignal.abort() }).then(() => null, caught => caught);
    assert.ok(aborted instanceof APIUserAbortError);
    assert.deepEqual([failureOf(aborted)?.reason, sent], ['timeout', 0]);
  });
});

test('a response that cannot be read is a failed connection, so the next model is asked, and a fault in the adapter\'s own code is still rethrown', async () => {
  await withOwnClient(async () => {
    globalThis.fetch = async () => new Response('<html>bad gateway', { status: 200, headers: { 'content-type': 'application/json' } });
    const error = await anthropicAdapter().call(CLASSIFY).then(() => null, caught => caught);
    assert.equal(failureOf(error)?.reason, 'connection', String(error));
  });
  const broken = anthropicAdapter({ messages: { create: async () => ({ content: null, usage: null, stop_reason: 'end_turn' }) } });
  const answer = await broken.call(CLASSIFY);
  assert.equal(answer.text, '');
  const thrown = anthropicAdapter({ messages: { create: async () => ({ get content() { throw new TypeError('own fault'); } }) } });
  await assert.rejects(thrown.call(CLASSIFY), TypeError);
});

// ─── failureOf, with the Anthropic SDK's errors ───────────────────────────────

test('failureOf names each error the Anthropic SDK raises, a 529 as a server fault and an exhausted balance as quota, and leaves alone what is no failure of a provider', () => {
  const verdict = reason => ({ reason, next: true, markDownNow: reason === 'auth' || reason === 'quota', tellOwner: reason === 'bad_request' });
  const named = [
    [new APIConnectionTimeoutError(), 'timeout'],
    [new APIUserAbortError(), 'timeout'],
    [new APIConnectionError({ message: 'Connection error.', cause: new TypeError('fetch failed') }), 'connection'],
    [new BadRequestError(400, body('invalid_request_error', 'temperature is not supported'), undefined, headers), 'bad_request'],
    [new AuthenticationError(401, body('authentication_error', 'invalid x-api-key'), undefined, headers), 'auth'],
    // How an exhausted balance arrives: HTTP 402, error type billing_error (the reference's error-codes.md).
    [new PaymentRequiredError(402, body('billing_error', 'Your credit balance is too low'), undefined, headers), 'quota'],
    [new PermissionDeniedError(403, body('permission_error'), undefined, headers), 'auth'],
    [new NotFoundError(404, body('not_found_error', 'model: claude-x'), undefined, headers), 'gone'],
    [new ContentTooLargeError(413, body('request_too_large'), undefined, headers), 'bad_request'],
    [new RateLimitError(429, body('rate_limit_error'), undefined, headers), 'rate_limit'],
    [new InternalServerError(500, body('api_error'), undefined, headers), 'server'],
    [new OverloadedError(529, body('overloaded_error', 'Overloaded'), undefined, headers), 'server'],
  ];
  for (const [error, reason] of named) assert.deepEqual(failureOf(error), verdict(reason), `${error.constructor.name} ${error.status ?? ''}`.trim());
  // As the SDK makes them from a response.
  for (const [status, type, reason] of [[402, 'billing_error', 'quota'], [413, 'request_too_large', 'bad_request'], [529, 'overloaded_error', 'server']]) {
    assert.deepEqual(failureOf(APIError.generate(status, body(type), undefined, headers)), verdict(reason), String(status));
  }
  // The billing type alone, whatever the status that carries it.
  assert.equal(failureOf(new APIError(400, body('billing_error'), undefined, headers))?.reason, 'quota');
  for (const error of [
    new TypeError('own fault'),
    new ConflictError(409, body('conflict'), undefined, headers),
    new UnprocessableEntityError(422, body('unprocessable'), undefined, headers),
    new AnthropicError('Could not resolve authentication method.'),
  ]) assert.equal(failureOf(error), null, `${error.constructor.name}: ${error.message}`);
});

test('the SDK\'s timeout, connection and abort errors have the class names failureOf reads, and the abort is not a connection error', () => {
  assert.equal(new APIConnectionTimeoutError().constructor.name, 'APIConnectionTimeoutError');
  assert.equal(new APIConnectionError({ message: 'x' }).constructor.name, 'APIConnectionError');
  assert.equal(new APIUserAbortError().constructor.name, 'APIUserAbortError');
  assert.ok(new APIConnectionTimeoutError() instanceof APIConnectionError);
  assert.ok(!(new APIUserAbortError() instanceof APIConnectionError));
});

// ─── Registry, registration and a model with no adapter ───────────────────────

test('the registry holds the three Claude models, each priced from Anthropic\'s page with its source and date written beside it, and asked at an effort', () => {
  const prices = { 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.10, 0.50], 'claude-opus-5-5': [4, 20] };
  for (const [name, price] of Object.entries(prices)) {
    assert.equal(providerOf(name), 'anthropic', name);
    assert.deepEqual(MODELS[name].price, price, name);
    assert.ok(hasPrice(name), name);
    // The efforts measured in Task 10: Haiku's reply at medium (at low it missed the quality part of the bar), the others at low.
    assert.deepEqual(MODELS[name].effort, { reply: name === 'claude-haiku-5-5' ? 'medium' : 'low', small: 'low' }, name);
    assert.ok(!MODELS[name].reasoning && !MODELS[name].embedding && !MODELS[name].retiresOn, name);
  }
  assert.equal(estimateAiCost('claude-sonnet-5-5', 1_000_000, 1_000_000), 12);
  assert.equal(entryFor('claude-opus-5-5-2026-11-01'), entryFor('claude-opus-5-5'));
});

test('the Anthropic adapter is among the default adapters only when ANTHROPIC_API_KEY is set', () => {
  assert.deepEqual(Object.keys(adaptersFor({})), ['openai']);
  assert.deepEqual(Object.keys(adaptersFor({ ANTHROPIC_API_KEY: '' })), ['openai']);
  const withKey = adaptersFor({ ANTHROPIC_API_KEY: 'test-anthropic-key' });
  assert.deepEqual(Object.keys(withKey), ['openai', 'anthropic']);
  assert.equal(withKey.anthropic.name, 'anthropic');
  assert.equal(withKey.anthropic.host, 'api.anthropic.com');
});

test('a Claude model with no adapter is a failed attempt as auth that reserves and sends nothing, and the chain\'s other models still answer', async () => {
  const reserved = [];
  const budget = ({ model, execute }) => { reserved.push(model); return execute(); };
  const openai = { name: 'openai', async call() { return { text: 'from openai', inputTokens: 1, outputTokens: 1 }; } };
  const { result, lines } = await quietly(() => runJob({ job: 'reply', chain: ['claude-sonnet-5-5', 'gpt-6-luna'], messages: QUESTION, maxTokens: 1000 }, { adapters: { openai }, budget }));
  assert.deepEqual([result.text, result.provider], ['from openai', 'openai']);
  assert.deepEqual(result.attempts.map(attempt => [attempt.provider, attempt.model, attempt.failure?.reason ?? null]), [['anthropic', 'claude-sonnet-5-5', 'auth'], ['openai', 'gpt-6-luna', null]]);
  assert.deepEqual(reserved, ['gpt-6-luna']);
  assert.match(lines.join('\n'), /no anthropic adapter/i);
  assert.ok(!lines.join('\n').includes('test-'));

  // Nothing in the chain can answer: ProvidersFailed, not a throw from the setup.
  const failed = await quietly(() => runJob({ job: 'reply', chain: ['claude-sonnet-5-5'], messages: QUESTION, maxTokens: 1000 }, { adapters: { openai }, budget })).then(() => null, error => error);
  assert.ok(failed instanceof ProvidersFailed);
  assert.match(failed.message, /claude-sonnet-5-5 \(auth\)/);
});

test('a model with no adapter does not count against its provider in the provider state, and does not send the provider to the back', async () => {
  const told = [];
  const state = {
    isDown: async () => false, replySucceeded: async provider => told.push(['ok', provider]), replyFailed: async provider => told.push(['failed', provider]),
    ping: async () => true, snapshot: async () => ({}),
  };
  const { replyClock } = await import('../providers.js');
  const clock = replyClock({ deadlineAt: Date.now() + 30_000 });
  const openai = { name: 'openai', async call() { return { text: 'ok', inputTokens: 1, outputTokens: 1 }; } };
  const result = await quietly(() => runJob({ job: 'reply', chain: ['claude-sonnet-5-5', 'gpt-6-luna'], messages: QUESTION, maxTokens: 10, clock }, { adapters: { openai }, budget: noBudget, state }));
  assert.equal(result.result.provider, 'openai');
  assert.equal(clock.demoted('anthropic'), false);
  await clock.end();
  assert.deepEqual(told, [['ok', 'openai']]);
});
