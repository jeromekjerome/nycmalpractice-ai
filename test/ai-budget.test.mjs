import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { chatCompletionsWithFallback } from '../openaiModelFailover.js';
import { estimateAiCost, runWithAiBudget } from '../ai-budget.js';

function budgetWorld({ inserted = true, fail = false } = {}) {
  const calls = [];
  const sql = async (strings, ...params) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ query, params });
    if (/^INSERT INTO ai_usage/.test(query)) return inserted ? [{ id: 42 }] : [];
    return [];
  };
  sql.transaction = async work => {
    if (fail) throw new Error('database unavailable');
    const results = [];
    for (const query of work(sql)) results.push(await query);
    return results;
  };
  return { sql, calls };
}

test('AI budget reservations are atomic and actual token usage replaces the estimate', async () => {
  const { sql, calls } = budgetWorld();
  const response = { usage: { prompt_tokens: 40, completion_tokens: 20 } };
  const result = await runWithAiBudget({
    operation: 'answer-draft', model: 'gpt-4o',
    request: { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100 },
    execute: async () => response,
  }, { sqlClient: sql, enabled: true, dailyCapUsd: 25, monthlyCapUsd: 200 });

  assert.equal(result, response);
  assert.match(calls[0].query, /pg_advisory_xact_lock/);
  const insert = calls.find(call => /^INSERT INTO ai_usage/.test(call.query));
  assert.match(insert.query, /date_trunc\('day'/);
  assert.match(insert.query, /date_trunc\('month'/);
  assert.deepEqual(insert.params.slice(0, 2), ['answer-draft', 'gpt-4o']);
  assert.ok(insert.params[2] > 0);
  assert.deepEqual(insert.params.slice(2), [insert.params[2], insert.params[2], 25, insert.params[2], 200]);
  const update = calls.find(call => /^UPDATE ai_usage/.test(call.query));
  assert.deepEqual(update.params, ['ok', 40, 20, estimateAiCost('gpt-4o', 40, 20), null, 42]);
});

test('AI budget exhaustion and database failures prevent provider calls without model fallback', async () => {
  const exhausted = budgetWorld({ inserted: false });
  let providerCalls = 0;
  await assert.rejects(runWithAiBudget({
    operation: 'answer-draft', model: 'gpt-4o', request: { messages: [] },
    execute: async () => { providerCalls += 1; },
  }, { sqlClient: exhausted.sql, enabled: true }), error => error.code === 'ai_budget_exceeded');
  assert.equal(providerCalls, 0);

  const unavailable = budgetWorld({ fail: true });
  await assert.rejects(runWithAiBudget({
    operation: 'answer-draft', model: 'gpt-4o', request: { messages: [] },
    execute: async () => { providerCalls += 1; },
  }, { sqlClient: unavailable.sql, enabled: true }), error => error.code === 'ai_budget_unavailable');
  assert.equal(providerCalls, 0);

  const budget = async () => { throw Object.assign(new Error('cap reached'), { code: 'ai_budget_exceeded' }); };
  await assert.rejects(chatCompletionsWithFallback({ chat: { completions: { create: async () => { providerCalls += 1; } } } }, {
    models: ['gpt-4o', 'gpt-4.1'], messages: [],
  }, { budget }), /cap reached/);
  assert.equal(providerCalls, 0);
});

test('AI usage recording preserves the original provider error and never stores prompts', async () => {
  const { sql, calls } = budgetWorld();
  await assert.rejects(runWithAiBudget({
    operation: 'case-classification', model: 'gpt-4o-mini', request: { messages: [{ content: 'private facts' }] },
    execute: async () => { throw Object.assign(new Error('provider down'), { status: 503 }); },
  }, { sqlClient: sql, enabled: true }), /provider down/);
  const update = calls.find(call => /^UPDATE ai_usage/.test(call.query));
  assert.equal(update.params[0], 'error');
  assert.equal(update.params[3], 0);
  assert.equal(update.params[4], 'provider_error');
  assert.ok(calls.every(call => !call.params.some(value => String(value).includes('private facts'))));
});
