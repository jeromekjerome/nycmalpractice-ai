// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// Knowing when things fail. Failures used to leave only console output, which the host keeps for an hour: nobody
// was told when the chat, the database or the contact form failed, and the nightly job stopped at its first failing
// step. Now each chat message is recorded with its outcome; a run of failures, a database that cannot be read and a
// contact request that fails email the operator at once; /health/deep answers an uptime monitor; and the nightly job
// runs every step, records the run and emails a summary of the day.

import { neon } from '@neondatabase/serverless';
import { notifyOperator } from './auction.js';
import { APP_URL } from './site.js';

const sql = neon(process.env.DATABASE_URL);
const SITE = 'NYCMalpractice.ai';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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

// ─── /health/deep ─────────────────────────────────────────────────────────────
// The newest columns the code needs: a deploy whose database changes were not made fails the check.
const REQUIRED_COLUMNS = ['firms.card_declined_at', 'leads.decline_reason', 'user_interactions.outcome', 'job_runs.ran_at', 'ai_usage.created_at', 'auctions.reminder_sent_at'];
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
      <p>${failed.length ? `The nightly job had ${failed.length} failed step${failed.length === 1 ? '' : 's'}: ${failed.map(f => escapeHtml(f.step)).join(', ')}.` : 'The nightly job ran every step.'}</p>
    </div>`;
  await notifyOperator(`${SITE} daily summary: ${day?.messages || 0} messages, ${day?.requests || 0} contact requests, ${day?.leads || 0} leads`, html);
  return true;
}
