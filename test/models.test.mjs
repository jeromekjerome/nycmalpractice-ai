// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The model chains: where the names live, and what the environment may change.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from './runner.mjs';
import { chainsFromEnv, DEFAULTS, ANSWER_MODELS, AUX_MODELS, EMBEDDING_MODELS } from '../models.js';

test('the chains come from one place, and an unset environment gives the defaults', () => {
  assert.deepEqual(DEFAULTS, {
    answer: ['gpt-4o', 'gpt-4.1', 'gpt-5.4-mini'],
    aux: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5.4-mini'],
    embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
  });
  assert.deepEqual(chainsFromEnv({}), DEFAULTS);
  assert.deepEqual({ answer: ANSWER_MODELS, aux: AUX_MODELS, embedding: EMBEDDING_MODELS }, chainsFromEnv());
});

test('the environment can set a chain, and a model named as its own fallback gives a chain of one', () => {
  const chains = chainsFromEnv({ OPENAI_MODEL_ANSWER: 'gpt-6.2-sol', OPENAI_MODEL_ANSWER_FALLBACKS: 'gpt-6.2-sol', OPENAI_MODEL_AUX: 'gpt-6-luna' });
  assert.deepEqual(chains.answer, ['gpt-6.2-sol']);
  assert.deepEqual(chains.aux, ['gpt-6-luna', 'gpt-4.1-mini', 'gpt-5.4-mini']);
  assert.deepEqual(chains.embedding, DEFAULTS.embedding);
});

test('ask.js, auction.js, courtlistener.js and server.js name no model and read models.js', () => {
  for (const file of ['ask.js', 'auction.js', 'courtlistener.js', 'server.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /['"](?:gpt-|text-embedding-)/, `${file} still names a model`);
    assert.match(source, /from '\.\/models\.js'/, `${file} does not import models.js`);
  }
});
