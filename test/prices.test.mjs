// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// What a call is counted as costing: the published prices, a price for every model the app can reach, and what
// happens to a model that has none.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { estimateAiCost, hasPrice } from '../ai-budget.js';
import { DEFAULTS } from '../models.js';
import { MODELS, entryFor, providerOf } from '../model-registry.js';

// Dollars per million tokens, input then output: OpenAI's standard rate, read from its pricing page on 2026-11-20.
const PUBLISHED = {
  'gpt-4o': [2.5, 10], 'gpt-4o-mini': [0.15, 0.6], 'gpt-4.1': [2, 8], 'gpt-4.1-mini': [0.4, 1.6],
  'gpt-5.4': [2.5, 15], 'gpt-5.4-mini': [0.75, 4.5], 'gpt-5.4-nano': [0.2, 1.25],
  'gpt-6.2-sol': [2, 10], 'gpt-6.1-terra': [1, 5], 'gpt-6-luna': [0.1, 0.5],
  'text-embedding-3-small': [0.02, 0], 'text-embedding-3-large': [0.13, 0],
};
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual} is not ${expected}`);

// Runs the body with console.warn captured, and returns the lines it was given.
function warnings(body) {
  const lines = [];
  const realWarn = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    body();
  } finally {
    console.warn = realWarn;
  }
  return lines;
}

test('the registry holds the published prices per million tokens', () => {
  for (const [model, [input, output]] of Object.entries(PUBLISHED)) {
    assert.equal(hasPrice(model), true, model);
    near(estimateAiCost(model, 1_000_000, 0), input, `${model} in`);
    near(estimateAiCost(model, 0, 1_000_000), output, `${model} out`);
  }
});

test('a dated snapshot is priced as its model, and a longer name is not mistaken for a shorter one', () => {
  near(estimateAiCost('gpt-4o-2024-08-06', 1_000_000, 0), 2.5, 'snapshot');
  near(estimateAiCost('gpt-5.4-nano-2026-03-17', 0, 1_000_000), 1.25, 'snapshot of nano');
  near(estimateAiCost('gpt-5.4-mini', 0, 1_000_000), 4.5, 'mini is not gpt-5.4');
  near(estimateAiCost('gpt-5.4-nano', 0, 1_000_000), 1.25, 'nano is not gpt-5.4');
  warnings(() => {
    // A dearer variant sold under a longer name must not be counted at the price of the name it begins with.
    for (const variant of ['gpt-4o-realtime-preview', 'gpt-5.4-pro', 'gpt-6.2-sol-preview', 'gpt-4o-2024-08-06-preview']) {
      assert.equal(hasPrice(variant), false, variant);
      near(estimateAiCost(variant, 1_000_000, 0), 20, `${variant} in`);
    }
    // Nor does a name every object answers to, or no name at all, find a price.
    for (const odd of ['constructor', 'toString', '__proto__', '', undefined, null]) {
      assert.equal(hasPrice(odd), false, String(odd));
      near(estimateAiCost(odd, 1_000_000, 0), 20, `${String(odd)} in`);
    }
  });
});

test('a model with no price is charged at the cautious default and reported as unpriced', () => {
  assert.deepEqual(warnings(() => assert.equal(hasPrice('another-new-model'), false)), [], 'asking whether a model has a price reports nothing');
  const warned = warnings(() => {
    assert.equal(hasPrice('some-new-model'), false);
    near(estimateAiCost('some-new-model', 1_000_000, 0), 20, 'default in');
    near(estimateAiCost('some-new-model', 0, 1_000_000), 100, 'default out');
  });
  // Reported once for the model, however many calls go to it.
  assert.deepEqual(warned.map(line => JSON.parse(line)), [{ event: 'ai_price_missing', model: 'some-new-model' }]);
});

test('every model this app can reach has a price on record', () => {
  for (const model of [...DEFAULTS.answer, ...DEFAULTS.small, ...DEFAULTS.embedding]) assert.equal(hasPrice(model), true, model);
});

test('every model in the default chains has a registry entry with a provider and a price', () => {
  for (const model of [...DEFAULTS.answer, ...DEFAULTS.small, ...DEFAULTS.embedding]) {
    const entry = entryFor(model);
    assert.ok(entry, `${model} has an entry`);
    assert.ok(['openai', 'anthropic', 'google'].includes(providerOf(model)), `${model} has a provider`);
    assert.ok(Array.isArray(entry.price) && entry.price.length === 2 && entry.price.every(part => Number.isFinite(part) && part >= 0), `${model} has a price`);
  }
});

test('the registry prices gpt-6.1-terra at 1 dollar in and 5 out per million tokens', () => {
  near(estimateAiCost('gpt-6.1-terra', 1_000_000, 1_000_000), 6, 'terra in and out');
});

test('a dated snapshot takes the registry entry of its model, and a longer name takes none', () => {
  assert.equal(entryFor('gpt-6-luna-2026-10-01'), entryFor('gpt-6-luna'));
  assert.equal(providerOf('gpt-6-luna-2026-10-01'), 'openai');
  assert.equal(entryFor('gpt-6-luna-pro'), null);
  assert.equal(providerOf('gpt-6-luna-pro'), null);
  for (const odd of ['constructor', '__proto__', '', undefined, null]) assert.equal(entryFor(odd), null, String(odd));
});

test('the two embedding models are marked as embeddings and no chat model is', () => {
  assert.deepEqual(Object.keys(MODELS).filter(name => MODELS[name].embedding).sort(), ['text-embedding-3-large', 'text-embedding-3-small']);
});
