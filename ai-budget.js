import sql from './db.js';

// OpenAI's published prices in dollars per million tokens, input then output: the standard rate, read from
// developers.openai.com/api/docs/pricing on 2026-11-20. Until that day the rows here were twice the published
// prices, so every recorded cost, the daily summary's estimate and both caps were out by a factor of two. They
// are the published prices now: a cap of 25 dollars means 25 dollars.
const PRICES = {
  'gpt-4o': [2.50, 10.00],
  'gpt-4o-mini': [0.15, 0.60],
  'gpt-4.1': [2.00, 8.00],
  'gpt-4.1-mini': [0.40, 1.60],
  'gpt-5.4': [2.50, 15.00],
  'gpt-5.4-mini': [0.75, 4.50],
  'gpt-5.4-nano': [0.20, 1.25],
  'gpt-6.2-sol': [2.00, 10.00],
  'gpt-6.1-terra': [1.00, 5.00],
  'gpt-6-luna': [0.10, 0.50],
  'text-embedding-3-small': [0.02, 0],
  'text-embedding-3-large': [0.13, 0],
};
// A model with no price is counted at this rate, far above any real one, so that it uses the cap up quickly
// instead of spending unseen. hasPrice() and the ai_price_missing warning are how the gap gets noticed.
const DEFAULT_RATE = [20, 100];

// A row prices its own name and that name's dated snapshots (gpt-4o-2024-08-06), and nothing else. A name that
// merely begins with a priced one (gpt-4o-realtime-preview, gpt-5.4-pro) is a different model at a different
// price, usually a higher one: counting it at the shorter name's price would under-count against the cap.
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

function isRate(value) {
  return Array.isArray(value) && value.length === 2 && value.every(part => Number.isFinite(part) && part >= 0);
}

function configuredPrices() {
  if (!process.env.OPENAI_MODEL_RATES_JSON) return {};
  try { return JSON.parse(process.env.OPENAI_MODEL_RATES_JSON) || {}; }
  catch { return {}; }
}

function tablePrice(name) {
  return Object.hasOwn(PRICES, name) ? PRICES[name] : null;
}

// The price on record for a model, or null when there is none: OPENAI_MODEL_RATES_JSON first, then the table.
function priceOnRecord(model) {
  const name = String(model || '');
  const custom = configuredPrices()[name];
  if (isRate(custom)) return custom;
  return tablePrice(name) || tablePrice(name.replace(DATED_SNAPSHOT, ''));
}

export function hasPrice(model) {
  return priceOnRecord(model) !== null;
}

const reportedUnpriced = new Set();

function ratesFor(model) {
  const price = priceOnRecord(model);
  if (price) return price;
  if (!reportedUnpriced.has(model)) {
    reportedUnpriced.add(model);
    console.warn(JSON.stringify({ event: 'ai_price_missing', model }));
  }
  return DEFAULT_RATE;
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
