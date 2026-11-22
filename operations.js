// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// Knowing when things fail. Failures used to leave only console output, which the host keeps for an hour: nobody
// was told when the chat, the database or the contact form failed, and the nightly job stopped at its first failing
// step. Now each chat message is recorded with its outcome; a run of failures, a database that cannot be read and a
// contact request that fails email the operator at once; /health/deep answers an uptime monitor; and the nightly job
// runs every step, records the run and emails a summary of the day.

import { neon } from '@neondatabase/serverless';
import { notifyOperator } from './auction.js';
import { APP_URL } from './site.js';
import { withoutKeys, providerOfModel } from './providers.js';
import { chains, unmeasuredOverride } from './model-settings.js';
import { DEFAULTS } from './models.js';

const sql = neon(process.env.DATABASE_URL);
const SITE = 'NYCMalpractice.ai';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeLimit(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} gave no answer in ${ms / 1000} seconds`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The same problem is emailed at most once per window on each server instance, so a failing database sends one
// email, not one per visitor. Never throws.
const lastAlerts = new Map();
export async function alertOperatorOnce(key, windowMs, subject, html) {
  const now = Date.now();
  if (now - (lastAlerts.get(key) || 0) < windowMs) return false;
  lastAlerts.set(key, now);
  await notifyOperator(subject, html).catch(err => console.error('Operator alert failed:', err.message));
  return true;
}

// One row per chat message, whatever happened: 'ok', 'slow' (no reply in time) or 'error'. A row used to be written
// only after a reply that worked, so failures left no trace. Never throws.
export async function recordInteraction({ sessionId, question, mode, caseType, outcome, latencyMs, gateStatus = null }) {
  try {
    await sql`
      INSERT INTO user_interactions (session_id, question, mode, case_type, outcome, latency_ms, gate_status)
      VALUES (${sessionId}, ${question}, ${mode}, ${caseType || 'other'}, ${outcome}, ${Math.round(latencyMs)}, ${gateStatus})`;
  } catch (err) {
    console.warn('DB log failed:', err.message);
    return;
  }
  if (outcome !== 'ok') await checkFailureBurst().catch(err => console.warn('The failure check failed:', err.message));
}

// Three of the last ten messages in 15 minutes failed or ran out of time: the operator is told at once.
async function checkFailureBurst() {
  const [recent] = await sql`
    SELECT count(*) FILTER (WHERE outcome IN ('error', 'slow'))::int AS failed, count(*)::int AS total
    FROM (SELECT outcome FROM user_interactions WHERE created_at > NOW() - INTERVAL '15 minutes' ORDER BY created_at DESC LIMIT 10) AS last_ten`;
  if ((recent?.failed || 0) < 3) return;
  await alertOperatorOnce('chat-failures', 30 * MINUTE, `${SITE}: the chat is failing (${recent.failed} of the last ${recent.total} messages)`,
    `<p>${recent.failed} of the last ${recent.total} chat messages on ${SITE} failed or ran out of time in the past 15 minutes. ` +
    `Each visitor was asked to send the message again.</p><p>Check the host's logs and ${escapeHtml(APP_URL)}/health/deep. ` +
    'You will not be emailed about this again for 30 minutes.</p>');
}

// An AI provider refused a request the app sent it (HTTP 400), which is almost always how the app shapes its
// requests for that provider, and no failure on the provider's side. providers.js gives this the provider's own
// message with any key taken out, and nothing of the request, so nothing a visitor wrote can be in the email. One
// email an hour for each provider.
const BAD_REQUEST_MESSAGE_CHARS = 300;
export async function tellOwnerOfBadRequest({ provider, model, job, status, code, message }) {
  const where = escapeHtml(provider);
  const row = (label, value) => `<tr><td style="color:#666;padding:4px 12px 4px 0">${label}</td><td>${escapeHtml(value)}</td></tr>`;
  return alertOperatorOnce(`ai-bad-request-${provider}`, HOUR, `${SITE}: ${provider} refused a request the app sent it`,
    `<p>${where} refused a request the app sent it, as malformed (HTTP ${escapeHtml(status ?? 400)}). If another model in the chain answered, the visitor was served by it; if every model refused, ` +
    'the visitor\'s message was not answered. The likely cause is how the app shapes its requests for this provider.</p>' +
    `<table>${row('Provider', provider)}${row('Model', model)}${row('Job', job)}${row('Status', status ?? 400)}${code ? row('Error code', code) : ''}` +
    `${row('Provider\'s message', withoutKeys(message).slice(0, BAD_REQUEST_MESSAGE_CHARS))}</table>` +
    `<p>You will not be emailed about ${where} again for an hour.</p>`);
}

// A provider marked down, or back up (provider-state.js). The state sends each once: only the server instance whose
// database update marked it down, or cleared it, tells the owner. The note carries the provider, the reason runJob
// gave the failure that marked it down (never what the provider said) and since when, so nothing a visitor wrote and
// no key can be in the email.
const DOWN_BECAUSE = {
  timeout: 'it did not answer in time',
  connection: 'the app could not connect to it',
  rate_limit: 'it turned requests away as too many (HTTP 408 or 429)',
  server: 'it answered with server errors (HTTP 5xx)',
  auth: "it refused the app's key (HTTP 401 or 403)",
  quota: "the account's quota is spent",
  bad_request: "it refused the app's requests as malformed (HTTP 400)",
};
const because = reason => escapeHtml(DOWN_BECAUSE[reason] ?? `it failed (${reason ?? 'no reason given'})`);

const NEW_YORK_TIME = { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' };
const newYorkTime = value => (Number.isNaN(Date.parse(value)) ? 'an unknown time' : `${new Date(value).toLocaleString('en-US', NEW_YORK_TIME)} New York time`);

function lasting(ms) {
  if (!Number.isFinite(ms)) return 'an unknown time';
  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? '' : 's'}${rest ? ` and ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
}

// What the app does while the provider is marked down: a provider marked down is asked after every other provider
// of a chain (providers.js), so a chain with no other provider keeps asking it. The chains are the ones in use
// (model-settings.js): the reply's, and the small jobs'.
async function meanwhile(provider) {
  const name = escapeHtml(provider);
  const { answer, small } = await chains();
  const inUse = [['reply', answer], ['small-job', small]];
  const alone = inUse.filter(([, chain]) => chain.every(model => providerOfModel(model) === provider)).map(([label]) => label);
  if (!alone.length) return `The app is answering from the next provider in each chain. It asks ${name} only after the others, and lets one request through to ${name} in its usual place five minutes after it was marked down, and every five minutes after that.`;
  if (alone.length === inUse.length) return `No chain has another provider, so the app keeps trying ${name}: replies may be slow, and visitors may be asked to send their message again, until it answers.`;
  return `The ${alone[0]} chain has no other provider, so the app keeps trying ${name} for it; the other chain is answering from its next provider.`;
}

async function tellOwnerProviderIsDown({ provider, reason, since }) {
  await notifyOperator(`${SITE}: ${provider} is marked down`,
    `<p>${escapeHtml(provider)} was marked down at ${newYorkTime(since)}, because ${because(reason)}.</p>` +
    `<p>${await meanwhile(provider)}</p>` +
    '<p>It stays marked down for at least five minutes; you will be emailed once it answers after that.</p>').catch(err => console.error('Operator alert failed:', err.message));
  return true;
}

async function tellOwnerProviderIsUp({ provider, reason, since }) {
  await notifyOperator(`${SITE}: ${provider} is answering again`,
    `<p>${escapeHtml(provider)} answered again, and is no longer marked down. It was marked down for ${lasting(Date.now() - Date.parse(since))}, ` +
    `since ${newYorkTime(since)}, because ${because(reason)}.</p>`).catch(err => console.error('Operator alert failed:', err.message));
  return true;
}

// What providers.js and provider-state.js tell the owner, which server.js sets up once for both: a request a
// provider refused (kind 'bad_request'), a provider marked down ('down') and one back up ('up').
const TELLINGS = { bad_request: tellOwnerOfBadRequest, down: tellOwnerProviderIsDown, up: tellOwnerProviderIsUp };
export async function tellOwnerOfProviders(note) {
  const telling = TELLINGS[note?.kind];
  return telling ? telling(note) : false;
}

// The model chains saved in the settings name a model the registry no longer has, so every job runs on the built-in
// chains (model-settings.js). The settings tell this at each read of the row, once a minute at most; the owner is
// emailed once a day for each server instance.
export async function tellOwnerOfModelChains({ models = [] } = {}) {
  const named = models.map(escapeHtml).join(', ') || 'a model';
  return alertOperatorOnce('model-chains-unknown', DAY, `${SITE}: the saved model chains name a model the app does not know`,
    `<p>The model chains saved in the settings name ${named}, which the app's registry of models does not have. ` +
    `Until they are saved again, every job runs on the built-in chains (models.js): replies ${DEFAULTS.answer.map(escapeHtml).join(', ')}; ` +
    `small jobs ${DEFAULTS.small.map(escapeHtml).join(', ')}.</p>` +
    '<p>Save the chains again from the admin page. You will not be emailed about this again for a day.</p>');
}

// The daily summary's line on the override (model-settings.js): the models it let in that have no measurement on
// record for the place they hold, who saved the chains so and when. Repeated each day until each has one.
const PLACES = { answer: 'a reply model', small: 'a small-job model' };
function overrideLine({ overriddenBy, overriddenOn, models }) {
  const named = models.map(({ model, role }) => `${escapeHtml(model)} as ${PLACES[role]}`);
  const list = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0];
  return `<p>The model chains were saved under the override (by ${escapeHtml(overriddenBy)}, ${newYorkTime(overriddenOn)}) with ${list}, ` +
    `which ${models.length > 1 ? 'have' : 'has'} no measurement on record. This is repeated in each daily summary until ${models.length > 1 ? 'each has' : 'it has'} one.</p>`;
}

// The daily summary's line on the day's replies, by the model that wrote them (ai_usage: each reply job that came back
// through the caps), and a plain word when any was written by a model other than the first of the reply chain in
// force. No email tells of that: a provider is marked down only when it answers nothing in a reply, so while another
// of its jobs answers, its main reply model can fail every time and Claude write every reply. A query of its own, so
// that when it fails the summary goes out without this line alone.
async function repliesByModel() {
  try {
    const [rows, { answer }] = await Promise.all([
      sql`
        SELECT model, count(*)::int AS replies FROM ai_usage
        WHERE created_at > NOW() - INTERVAL '24 hours' AND operation = 'reply' AND status = 'ok'
        GROUP BY model ORDER BY replies DESC, model`,
      chains(),
    ]);
    return { rows: rows.map(row => ({ model: String(row.model), replies: Number(row.replies) || 0 })), first: answer[0] };
  } catch (err) {
    console.error('[digest] The replies by model could not be read, so the summary goes without them:', withoutKeys(err?.message ?? err));
    return null;
  }
}

function repliesLine({ rows, first }) {
  const counted = list => list.map(row => `${escapeHtml(row.model)} ${row.replies}`).join(', ');
  if (!rows.length) return '<p>Replies by the model that wrote them: none.</p>';
  const others = rows.filter(row => row.model !== first);
  const total = rows.reduce((sum, row) => sum + row.replies, 0);
  const byOthers = others.reduce((sum, row) => sum + row.replies, 0);
  return `<p>Replies by the model that wrote them: ${counted(rows)}.</p>` +
    (others.length ? `<p><strong>${byOthers} of the ${total} replies were written by a model other than ${escapeHtml(first)}, the first of the reply chain</strong>: ${counted(others)}.</p>` : '');
}

// ─── /health/deep ─────────────────────────────────────────────────────────────
// The newest columns the code needs: a deploy whose database changes were not made fails the check. The provider state
// (provider-state.js) and the model settings (model-settings.js) work without their tables, on every provider up and
// the built-in chains, so only this check shows that npm run setup-db was not run.
const REQUIRED_COLUMNS = ['firms.card_declined_at', 'leads.decline_reason', 'user_interactions.outcome', 'job_runs.ran_at', 'ai_usage.created_at', 'auctions.reminder_sent_at',
  'ai_provider_state.failed_replies', 'app_settings.value', 'model_measurements.bar_ok', 'provider_model_lists.models'];
let deepHealthCache = { at: 0, value: null };

// For an uptime monitor: is the database reachable, does it have the columns the code uses, and did the nightly job
// run and succeed in the last 26 hours? Computed at most every 30 seconds per instance. Details go to the log.
export async function deepHealth() {
  const cacheMs = Number(process.env.HEALTH_DEEP_CACHE_MS ?? 30_000);
  if (deepHealthCache.value && Date.now() - deepHealthCache.at < cacheMs) return deepHealthCache.value;
  const checks = { database: 'down', schema: 'unknown', nightlyJob: 'unknown' };
  try {
    await timeLimit(sql`SELECT 1`, 3000, 'The database');
    checks.database = 'ok';
    const tables = [...new Set(REQUIRED_COLUMNS.map(column => column.split('.')[0]))];
    const rows = await timeLimit(sql`
      SELECT table_name || '.' || column_name AS col FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY(${tables})`, 3000, 'The schema check');
    const present = new Set(rows.map(row => row.col));
    const missing = REQUIRED_COLUMNS.filter(column => !present.has(column));
    checks.schema = missing.length ? 'missing columns' : 'ok';
    if (missing.length) console.error('[health] the database is missing columns the code uses:', missing.join(', '));
    if (present.has('job_runs.ran_at')) {
      const [job] = await timeLimit(sql`
        SELECT (SELECT ok FROM job_runs WHERE job = 'nightly' ORDER BY ran_at DESC LIMIT 1) AS last_ok,
               (SELECT max(ran_at) FROM job_runs WHERE job = 'nightly') AS last_run`, 3000, 'The job check');
      checks.nightlyJob = !job?.last_run ? 'not run yet'
        : Date.now() - new Date(job.last_run).getTime() > 26 * HOUR ? 'late'
          : job.last_ok ? 'ok' : 'failed';
    }
  } catch (err) {
    console.error('[health] deep check failed:', err.message);
  }
  const ok = checks.database === 'ok' && checks.schema === 'ok' && ['ok', 'not run yet'].includes(checks.nightlyJob);
  deepHealthCache = { at: Date.now(), value: { ok, ...checks } };
  return deepHealthCache.value;
}

// ─── The nightly job ──────────────────────────────────────────────────────────
// Each step runs whatever happened to the ones before it: the first failure used to stop every later step, the
// privacy deletions included. Returns each step's result and the steps that failed.
export async function runSteps(steps) {
  const results = {};
  const failed = [];
  for (const [name, work] of steps) {
    try {
      results[name] = await work();
    } catch (err) {
      console.error(`[nightly] ${name} failed:`, err);
      failed.push({ step: name, error: err?.message || String(err) });
    }
  }
  return { results, failed };
}

// The run is kept for 90 days; /health/deep reads the latest. The failed steps go to the operator.
export async function recordJobRun(job, failed) {
  await sql`INSERT INTO job_runs (job, ok, failed_steps) VALUES (${job}, ${failed.length === 0}, ${failed.length ? JSON.stringify(failed) : null})`;
  await sql`DELETE FROM job_runs WHERE ran_at < NOW() - INTERVAL '90 days'`;
}

export async function reportFailedSteps(job, failed) {
  if (!failed.length) return;
  await notifyOperator(`${SITE}: ${failed.length} step${failed.length === 1 ? '' : 's'} of the ${job} job failed`,
    `<p>These steps failed; the others ran:</p><ul>${failed.map(f => `<li><strong>${escapeHtml(f.step)}</strong>: ${escapeHtml(f.error)}</li>`).join('')}</ul>` +
    '<p>They run again tomorrow. Check the host\'s logs for details.</p>');
}

// A summary of the last day for the operator, sent with the nightly job (DAILY_DIGEST=off stops it). It also shows
// that the job ran. Requests no firm holds are listed so they can be delivered by hand from the admin page.
export async function sendDailyDigest({ failed = [] } = {}) {
  if (process.env.DAILY_DIGEST === 'off') return false;
  const [day] = await sql`
    SELECT
      (SELECT count(*) FROM user_interactions WHERE created_at > NOW() - INTERVAL '24 hours')::int AS messages,
      (SELECT count(*) FROM user_interactions WHERE created_at > NOW() - INTERVAL '24 hours' AND outcome = 'error')::int AS errors,
      (SELECT count(*) FROM user_interactions WHERE created_at > NOW() - INTERVAL '24 hours' AND outcome = 'slow')::int AS slow,
      (SELECT count(*) FROM user_interactions WHERE created_at > NOW() - INTERVAL '24 hours' AND gate_status = 'BLOCKED')::int AS blocked,
      (SELECT count(*) FROM conversations WHERE contact_consent_at > NOW() - INTERVAL '24 hours')::int AS requests,
      (SELECT count(*) FROM leads WHERE created_at > NOW() - INTERVAL '24 hours')::int AS leads,
      (SELECT count(*) FROM ai_usage WHERE created_at > NOW() - INTERVAL '24 hours' AND status = 'ok')::int AS ai_calls,
      (SELECT COALESCE(SUM(input_tokens), 0) FROM ai_usage WHERE created_at > NOW() - INTERVAL '24 hours')::int AS ai_input_tokens,
      (SELECT COALESCE(SUM(output_tokens), 0) FROM ai_usage WHERE created_at > NOW() - INTERVAL '24 hours')::int AS ai_output_tokens,
      (SELECT COALESCE(SUM(actual_cost_usd), 0) FROM ai_usage WHERE created_at > NOW() - INTERVAL '24 hours') AS ai_cost,
      (SELECT count(*) FROM conversations c WHERE c.contact_consent_at > NOW() - INTERVAL '7 days'
         AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.session_id = c.session_id)
         AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.session_id = c.session_id AND a.status IN ('open', 'closing')))::int AS unplaced`;
  // Never fails: a settings table that cannot be read names no override.
  const override = await unmeasuredOverride();
  // Never fails: a query that cannot be read leaves its line out.
  const replies = await repliesByModel();
  const row = (label, value) => `<tr><td style="color:#666;padding:4px 12px 4px 0">${label}</td><td><strong>${escapeHtml(value ?? 0)}</strong></td></tr>`;
  const html = `
    <div style="font-family:sans-serif;max-width:600px">
      <h2 style="margin-bottom:0.5rem">${SITE}: the last 24 hours</h2>
      <table style="border-collapse:collapse">
        ${row('Chat messages', day?.messages)}
        ${row('Failed', day?.errors)}
        ${row('Ran out of time', day?.slow)}
        ${row('Replies the gate blocked', day?.blocked)}
        ${row('Contact requests', day?.requests)}
        ${row('Leads delivered', day?.leads)}
        ${row('AI calls', day?.ai_calls)}
        ${row('AI input tokens', day?.ai_input_tokens)}
        ${row('AI output tokens', day?.ai_output_tokens)}
        ${row('Estimated AI spend (USD)', `$${Number(day?.ai_cost || 0).toFixed(2)}`)}
        ${row('Requests no firm holds (last 7 days)', day?.unplaced)}
      </table>
      ${day?.unplaced ? `<p>Deliver waiting requests by hand from the <a href="${escapeHtml(APP_URL)}/admin.html">admin page</a>.</p>` : ''}
      ${replies ? repliesLine(replies) : ''}
      ${override ? overrideLine(override) : ''}
      <p>${failed.length ? `The nightly job had ${failed.length} failed step${failed.length === 1 ? '' : 's'}: ${failed.map(f => escapeHtml(f.step)).join(', ')}.` : 'The nightly job ran every step.'}</p>
    </div>`;
  await notifyOperator(`${SITE} daily summary: ${day?.messages || 0} messages, ${day?.requests || 0} contact requests, ${day?.leads || 0} leads`, html);
  return true;
}
