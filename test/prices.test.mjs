// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// What a call is counted as costing: the published prices, a price for every model the app can reach, and what
// happens to a model that has none.
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { estimateAiCost, hasPrice } from '../ai-budget.js';
import { DEFAULTS } from '../models.js';

// Dollars per million tokens, input then output: OpenAI's standard rate, read from its pricing page on 2026-11-20.
const PUBLISHED = {
  'gpt-4o': [2.5, 10], 'gpt-4o-mini': [0.15, 0.6], 'gpt-4.1': [2, 8], 'gpt-4.1-mini': [0.4, 1.6],
  'gpt-5.4': [2.5, 15], 'gpt-5.4-mini': [0.75, 4.5], 'gpt-5.4-nano': [0.2, 1.25],
  'gpt-6.2-sol': [2, 10], 'gpt-6.1-terra': [1, 5], 'gpt-6-luna': [0.1, 0.5],
  'text-embedding-3-small': [0.02, 0], 'text-embedding-3-large': [0.13, 0],
};
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual} is not ${expected}`);

// The table is what these tests are about, so a price override set on this machine is put aside while one runs.
function withRatesSetting(value, body) {
  const before = process.env.OPENAI_MODEL_RATES_JSON;
  if (value === undefined) delete process.env.OPENAI_MODEL_RATES_JSON;
  else process.env.OPENAI_MODEL_RATES_JSON = value;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env.OPENAI_MODEL_RATES_JSON;
    else process.env.OPENAI_MODEL_RATES_JSON = before;
  }
}

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

test('the price table holds the published prices per million tokens', () => withRatesSetting(undefined, () => {
  for (const [model, [input, output]] of Object.entries(PUBLISHED)) {
    assert.equal(hasPrice(model), true, model);
    near(estimateAiCost(model, 1_000_000, 0), input, `${model} in`);
    near(estimateAiCost(model, 0, 1_000_000), output, `${model} out`);
  }
}));

test('a dated snapshot is priced as its model, and a longer name is not mistaken for a shorter one', () => withRatesSetting(undefined, () => {
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
}));

test('a model with no price is charged at the cautious default and reported as unpriced', () => withRatesSetting(undefined, () => {
  assert.deepEqual(warnings(() => assert.equal(hasPrice('another-new-model'), false)), [], 'asking whether a model has a price reports nothing');
  const warned = warnings(() => {
    assert.equal(hasPrice('some-new-model'), false);
    near(estimateAiCost('some-new-model', 1_000_000, 0), 20, 'default in');
    near(estimateAiCost('some-new-model', 0, 1_000_000), 100, 'default out');
  });
  // Reported once for the model, however many calls go to it.
  assert.deepEqual(warned.map(line => JSON.parse(line)), [{ event: 'ai_price_missing', model: 'some-new-model' }]);

  // A price given in the environment counts as a price on record, and a setting that is not a table changes nothing.
  withRatesSetting(JSON.stringify({ 'some-new-model': [1, 2] }), () => {
    assert.equal(hasPrice('some-new-model'), true);
    near(estimateAiCost('some-new-model', 1_000_000, 1_000_000), 3, 'configured');
    near(estimateAiCost('gpt-4o', 1_000_000, 0), 2.5, 'the table still prices the rest');
  });
  for (const broken of ['null', 'not json', '[1,2]', '7', '{"gpt-4o":"cheap"}', '{"gpt-4o":[1]}', '{"gpt-4o":[-1,2]}']) {
    withRatesSetting(broken, () => near(estimateAiCost('gpt-4o', 1_000_000, 0), 2.5, `setting ${broken}`));
  }
}));

test('every model this app can reach has a price on record', () => withRatesSetting(undefined, () => {
  for (const model of [...DEFAULTS.answer, ...DEFAULTS.aux, ...DEFAULTS.embedding]) assert.equal(hasPrice(model), true, model);
}));
