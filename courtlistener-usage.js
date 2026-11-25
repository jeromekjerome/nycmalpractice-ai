// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// What the CourtListener token has left, and what each job has spent. The token's allowance is shared by every caller of
// it, so a job reads the usage report (which costs nothing) before it sends a search, and each request sent is counted
// against the job that sent it. The SQL client is a parameter, so this file never loads the database.

const USAGE_URL = 'https://www.courtlistener.com/api/rest/v4/api-usage/';
const TIME_ZONE = 'America/New_York';
const READ_TIMEOUT_MS = 5000;

// New York's calendar day of a moment, as YYYY-MM-DD.
function newYorkDay(moment) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(moment);
}

// The requests left in the token's day, hour and minute, or null when the report cannot be read. Never throws.
export async function readAllowance({ token, fetchImpl = fetch, signal } = {}) {
  try {
    const res = await fetchImpl(USAGE_URL, {
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
      signal: signal ?? AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const rows = Array.isArray(body?.current_usage) ? body.current_usage.filter(row => row?.scope === 'user') : [];
    const left = seconds => {
      const row = rows.find(candidate => candidate.window_seconds === seconds);
      return Number.isFinite(row?.remaining) ? row.remaining : null;
    };
    const allowance = { day: left(86400), hour: left(3600), minute: left(60) };
    return Object.values(allowance).includes(null) ? null : allowance;
  } catch {
    return null;
  }
}

// Adds n requests to a job's count for New York's day. Never throws: a count that cannot be saved is not worth a failure.
export async function countRequests(sqlClient, job, n = 1) {
  if (!Number.isInteger(n) || n < 1) return;
  try {
    await sqlClient`
      INSERT INTO courtlistener_usage (day, job, requests)
      VALUES (${newYorkDay(new Date())}, ${job}, ${n})
      ON CONFLICT (day, job) DO UPDATE SET requests = courtlistener_usage.requests + EXCLUDED.requests
    `;
  } catch (err) {
    console.error('Could not count the CourtListener requests:', err.message);
  }
}

// Each job's count for the New York day of `now`.
export async function usageToday(sqlClient, now = new Date()) {
  try {
    const rows = await sqlClient`SELECT job, requests FROM courtlistener_usage WHERE day = ${newYorkDay(now)} ORDER BY job`;
    return rows.map(row => ({ job: row.job, requests: Number(row.requests) }));
  } catch (err) {
    console.error('Could not read the CourtListener counts:', err.message);
    return [];
  }
}

// The requests a job may still spend: what is left of the day less its reserve, and of the hour less its reserve.
export function allowanceLeft(allowance, { reserve = 30, hourReserve = 5 } = {}) {
  if (!allowance) return 0;
  return Math.max(0, Math.min(allowance.day - reserve, allowance.hour - hourReserve));
}
