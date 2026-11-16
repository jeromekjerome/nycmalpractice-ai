import sql from './db.js';

const RATES = [
  [/^gpt-4o-mini/, 0.30, 1.20],
  [/^gpt-4o/, 5.00, 20.00],
  [/^gpt-4\.1-mini/, 0.80, 3.20],
  [/^gpt-4\.1/, 4.00, 16.00],
  [/^text-embedding-3-small/, 0.04, 0],
  [/^text-embedding-3-large/, 0.26, 0],
];
const DEFAULT_RATE = [20, 100];

function ratesFor(model) {
  let configured = {};
  if (process.env.OPENAI_MODEL_RATES_JSON) {
    try { configured = JSON.parse(process.env.OPENAI_MODEL_RATES_JSON); }
    catch { configured = {}; }
  }
  const custom = configured[model];
  if (Array.isArray(custom) && custom.length === 2 && custom.every(value => Number.isFinite(value) && value >= 0)) return custom;
  return RATES.find(([pattern]) => pattern.test(model))?.slice(1) || DEFAULT_RATE;
}

function money(value) {
  return Math.ceil(value * 100_000_000) / 100_000_000;
}

export function estimateAiCost(model, inputTokens, outputTokens, operation = '') {
  const [inputRate, outputRate] = ratesFor(model);
  return money((Math.max(0, inputTokens) * inputRate + Math.max(0, outputTokens) * outputRate) / 1_000_000);
}

function inputTokensFor(request) {
  return Math.ceil(JSON.stringify(request.messages ?? request.input ?? '').length / 4);
}

function outputTokensFor(request, operation) {
  if (operation.includes('embedding')) return 0;
  return request.max_completion_tokens ?? request.max_tokens ?? 1000;
}

function capFromEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function budgetError(code, message) {
  return Object.assign(new Error(message), { code, status: 503 });
}

async function recordUsage(sqlClient, id, status, usage, model, operation) {
  const inputTokens = Math.max(0, Number(usage?.prompt_tokens) || 0);
  const outputTokens = Math.max(0, Number(usage?.completion_tokens) || 0);
  const actualCost = status === 'ok' ? estimateAiCost(model, inputTokens, outputTokens, operation) : 0;
  try {
    await sqlClient`
      UPDATE ai_usage
      SET status = ${status}, input_tokens = ${inputTokens}, output_tokens = ${outputTokens},
          actual_cost_usd = ${actualCost}, error_code = ${status === 'ok' ? null : 'provider_error'}
      WHERE id = ${id}
    `;
  } catch (error) {
    console.error(JSON.stringify({ event: 'ai_usage_record_failed', operation, model, message: error.message }));
  }
}

export async function runWithAiBudget({ operation, model, request, execute }, {
  sqlClient = sql,
  enabled = process.env.NODE_ENV !== 'test' || process.env.AI_BUDGET_IN_TESTS === '1',
  dailyCapUsd = capFromEnv('AI_DAILY_CAP_USD', 25),
  monthlyCapUsd = capFromEnv('AI_MONTHLY_CAP_USD', 200),
} = {}) {
  if (!enabled) return execute();
  const inputTokens = inputTokensFor(request);
  const reservedCost = estimateAiCost(model, inputTokens, outputTokensFor(request, operation), operation);
  let id;
  try {
    const [, rows] = await sqlClient.transaction(tx => [
      tx`SELECT pg_advisory_xact_lock(741852963)`,
      tx`
        INSERT INTO ai_usage (operation, model, status, reserved_cost_usd)
        SELECT ${operation}, ${model}, 'reserved', ${reservedCost}
        WHERE
          (SELECT COALESCE(SUM(COALESCE(actual_cost_usd, reserved_cost_usd)), 0) FROM ai_usage
             WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + ${reservedCost} <= ${dailyCapUsd}
          AND
          (SELECT COALESCE(SUM(COALESCE(actual_cost_usd, reserved_cost_usd)), 0) FROM ai_usage
             WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + ${reservedCost} <= ${monthlyCapUsd}
        RETURNING id
      `,
    ]);
    id = rows[0]?.id;
  } catch (error) {
    throw budgetError('ai_budget_unavailable', 'The AI spending limit could not be checked.');
  }
  if (id == null) throw budgetError('ai_budget_exceeded', 'The site AI spending limit has been reached.');

  try {
    const response = await execute();
    await recordUsage(sqlClient, id, 'ok', response?.usage, model, operation);
    return response;
  } catch (error) {
    await recordUsage(sqlClient, id, 'error', null, model, operation);
    throw error;
  }
}
