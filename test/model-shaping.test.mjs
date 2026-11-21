// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// How a request is shaped for the model it goes to: the older models take it as written, the reasoning models
// (gpt-5 and every later name, and the o-series) take a different token limit and no temperature.
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { requestFor, isReasoningModel, chatCompletionsWithFallback } from '../openaiModelFailover.js';

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
