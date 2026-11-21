// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// How a request is shaped for the model it goes to: the older models take it as written, the reasoning models
// (gpt-5 and every later name, and the o-series) take a different token limit and no temperature.
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { requestFor, isReasoningModel, chatCompletionsWithFallback } from '../openaiModelFailover.js';
import { estimateAiCost, hasPrice, runWithAiBudget } from '../ai-budget.js';

const REQUEST = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 1000, temperature: 0.7 };

test('a request is shaped for every reasoning model, the gpt-6 names included', () => {
  for (const model of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-10', 'o3']) {
    assert.equal(isReasoningModel(model), true, model);
    assert.deepEqual(requestFor(model, REQUEST), { model, messages: REQUEST.messages, max_completion_tokens: 3000, reasoning_effort: 'low' }, model);
  }
  for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'text-embedding-3-small']) {
    assert.equal(isReasoningModel(model), false, model);
    assert.deepEqual(requestFor(model, REQUEST), { model, ...REQUEST }, model);
  }
});

test('when the first model of a chain is gone, the next answers with a request shaped for it', async () => {
  const sent = [];
  const openai = { chat: { completions: { create: async (request) => {
    sent.push(request);
    if (request.model === 'gpt-4o') throw Object.assign(new Error('The model `gpt-4o` has been deprecated'), { status: 404, code: 'model_not_found' });
    return { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  } } } };
  const res = await chatCompletionsWithFallback(openai, { models: ['gpt-4o', 'gpt-6.2-sol'], ...REQUEST }, { budget: ({ execute }) => execute() });
  assert.equal(res.choices[0].message.content, 'ok');
  assert.deepEqual(sent.map(r => r.model), ['gpt-4o', 'gpt-6.2-sol']);
  assert.equal(sent[1].max_completion_tokens, 3000);
  assert.equal('max_tokens' in sent[1], false);
  assert.equal('temperature' in sent[1], false);
});

test('after the retirement the third model of the old chain answers, shaped for it and charged at its own price', async () => {
  // The reply chain as it stood before the models were changed. From 14 January 2027 the first two are gone.
  const chain = ['gpt-4o', 'gpt-4.1', 'gpt-5.4-mini'];
  const sent = [];
  const openai = { chat: { completions: { create: async (request) => {
    sent.push(request);
    if (request.model !== 'gpt-5.4-mini') throw Object.assign(new Error(`The model ${request.model} has been deprecated`), { status: 404, code: 'model_not_found' });
    return { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1000, completion_tokens: 500 } };
  } } } };
  // The spending cap as it runs in production, over a database that keeps what it is asked.
  const rows = [];
  const sql = async (strings, ...params) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    rows.push({ query, params });
    return /^INSERT INTO ai_usage/.test(query) ? [{ id: rows.length }] : [];
  };
  sql.transaction = async work => { const results = []; for (const query of work(sql)) results.push(await query); return results; };
  const budget = job => runWithAiBudget(job, { sqlClient: sql, enabled: true, dailyCapUsd: 25, monthlyCapUsd: 200 });

  const res = await chatCompletionsWithFallback(openai, { models: chain, ...REQUEST }, { budget });
  assert.equal(res.choices[0].message.content, 'ok');
  assert.deepEqual(sent.map(request => request.model), chain);
  // The first two were sent the request as written; the third, a reasoning model, the request shaped for it.
  assert.deepEqual(sent[1], { model: 'gpt-4.1', ...REQUEST });
  assert.deepEqual(sent[2], { model: 'gpt-5.4-mini', messages: REQUEST.messages, max_completion_tokens: 3000, reasoning_effort: 'low' });

  // Each attempt was reserved against the cap under its own model's name, and the two that failed cost nothing.
  const reserved = rows.filter(row => /^INSERT INTO ai_usage/.test(row.query));
  const settled = rows.filter(row => /^UPDATE ai_usage/.test(row.query));
  assert.deepEqual(reserved.map(row => row.params[1]), chain);
  assert.deepEqual(settled.map(row => [row.params[0], row.params[3]]), [['error', 0], ['error', 0], ['ok', estimateAiCost('gpt-5.4-mini', 1000, 500)]]);
  // The one that answered is charged at gpt-5.4-mini's published price (0.75 in, 4.50 out a million tokens), which
  // is on record; at the price kept for a model with none, the same call would count as seven cents.
  assert.equal(hasPrice('gpt-5.4-mini'), true);
  assert.ok(Math.abs(estimateAiCost('gpt-5.4-mini', 1000, 500) - 0.003) < 1e-6);
  assert.ok(Math.abs(estimateAiCost('a-model-with-no-price', 1000, 500) - 0.07) < 1e-6);
});
