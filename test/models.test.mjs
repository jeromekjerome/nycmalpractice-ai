// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The model chains: where the names live, and what the environment may change.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from './runner.mjs';
import { hasPrice } from '../ai-budget.js';
import { chainsFromEnv, DEFAULTS, ANSWER_MODELS, AUX_MODELS, EMBEDDING_MODELS } from '../models.js';

test('the chains come from one place, and an unset environment gives the defaults', () => {
  assert.deepEqual(DEFAULTS, {
    answer: ['gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.4-mini'],
    aux: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-5.4-mini'],
    embedding: ['text-embedding-3-small', 'text-embedding-3-large'],
  });
  assert.deepEqual(chainsFromEnv({}), DEFAULTS);
  assert.deepEqual({ answer: ANSWER_MODELS, aux: AUX_MODELS, embedding: EMBEDDING_MODELS }, chainsFromEnv());
});

test('the environment can set a chain, and a model named as its own fallback gives a chain of one', () => {
  // The small jobs' main model is set to one that is not the default, so the list shows the environment's model
  // in front and the default fallbacks behind it.
  const chains = chainsFromEnv({ OPENAI_MODEL_ANSWER: 'gpt-6.2-sol', OPENAI_MODEL_ANSWER_FALLBACKS: 'gpt-6.2-sol', OPENAI_MODEL_AUX: 'gpt-5.4-nano' });
  assert.deepEqual(chains.answer, ['gpt-6.2-sol']);
  assert.deepEqual(chains.aux, ['gpt-5.4-nano', 'gpt-6.1-terra', 'gpt-5.4-mini']);
  assert.deepEqual(chains.embedding, DEFAULTS.embedding);
});

test('every model in the chains was chosen by the owner, measured, priced, and is not one OpenAI retires on 14 January 2027', () => {
  const chosen = JSON.parse(readFileSync(new URL('../measure/chosen.json', import.meta.url), 'utf8'));
  assert.equal(chosen.by, 'owner');
  assert.deepEqual(DEFAULTS.answer, chosen.answer);
  assert.deepEqual(DEFAULTS.aux, chosen.aux);
  assert.ok(existsSync(new URL(`../${chosen.report}`, import.meta.url)), 'the report the choice was made from is in the repository');
  // The record says why. The report holds each model to a bar, and no small-job model passed every rule of it,
  // so a reader has to be told on what grounds one was chosen all the same.
  for (const chain of ['answer', 'aux']) {
    assert.ok(typeof chosen.why?.[chain] === 'string' && chosen.why[chain].trim().length >= 80, `measure/chosen.json does not say why the ${chain} chain was chosen`);
  }
  // Only finished runs count. A run that was stopped part-way is kept beside them as <label>.partial.json, on this
  // machine only, and would otherwise vouch here for a model that the repository cannot show was measured.
  const finished = readdirSync(new URL('../measure/results/', import.meta.url)).filter(file => file.endsWith('.json') && !file.endsWith('.partial.json'));
  const runs = finished.map(file => JSON.parse(readFileSync(new URL(`../measure/results/${file}`, import.meta.url), 'utf8')));
  for (const model of chosen.answer) assert.ok(runs.some(run => run.mode !== 'small' && run.answer === model), `${model} was never measured as a reply model`);
  for (const model of chosen.aux) assert.ok(runs.some(run => run.mode === 'small' && run.aux === model), `${model} was never measured as a small-job model`);
  for (const model of [...chosen.answer, ...chosen.aux]) {
    assert.equal(hasPrice(model), true, `${model} has no price`);
    assert.doesNotMatch(model, /^gpt-4(?:o|\.1)/, `${model} is retired on 14 January 2027`);
  }
});

test('the example settings and the readme name no model OpenAI retires, and a model the example sets is the default', () => {
  // A copy of the example becomes somebody's settings, and a model set there replaces the default from then on.
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const defaults = {
    OPENAI_MODEL_ANSWER: DEFAULTS.answer[0],
    OPENAI_MODEL_ANSWER_FALLBACKS: DEFAULTS.answer.slice(1).join(','),
    OPENAI_MODEL_AUX: DEFAULTS.aux[0],
    OPENAI_MODEL_AUX_FALLBACKS: DEFAULTS.aux.slice(1).join(','),
  };
  for (const [name, value] of Object.entries(defaults)) {
    const set = example.match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (set) assert.equal(set[1].trim(), value, `${name} in .env.example`);
  }
  for (const file of ['.env.example', 'README.md']) {
    assert.doesNotMatch(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), /gpt-4(?:o|\.1)/, `${file} still names a model OpenAI retires on 14 January 2027`);
  }
});

test('ask.js, auction.js, courtlistener.js and server.js name no model and read models.js', () => {
  for (const file of ['ask.js', 'auction.js', 'courtlistener.js', 'server.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /['"](?:gpt-|text-embedding-)/, `${file} still names a model`);
    assert.match(source, /from '\.\/models\.js'/, `${file} does not import models.js`);
  }
});
