import sql from './db.js';
import { priceOn } from './model-registry.js';

// What each model costs is in model-registry.js, the one place that knows the models.

// A model with no price is counted at this rate, far above any real one, so that it uses the cap up quickly
// instead of spending unseen. hasPrice() and the ai_price_missing warning are how the gap gets noticed.
const DEFAULT_RATE = [20, 100];

// The price on record for a model, or null when there is none.
function priceOnRecord(model, day) {
  return priceOn(model, day);
}

export function hasPrice(model) {
  return priceOnRecord(model) !== null;
}

const reportedUnpriced = new Set();

function ratesFor(model, day) {
  const price = priceOnRecord(model, day);
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

// `day` ('YYYY-MM-DD') is for tests and for pricing a day other than today: a price a provider has announced for a later
// day is counted from that day (model-registry.js).
export function estimateAiCost(model, inputTokens, outputTokens, operation = '', day = undefined) {
  const [inputRate, outputRate] = ratesFor(model, day);
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
  // Accepts the one shape a provider layer will hand it (inputTokens, outputTokens), and OpenAI's own names
  // (prompt_tokens, completion_tokens), which is what arrives today.
  const inputTokens = Math.max(0, Number(usage?.inputTokens ?? usage?.prompt_tokens) || 0);
  const outputTokens = Math.max(0, Number(usage?.outputTokens ?? usage?.completion_tokens) || 0);
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
