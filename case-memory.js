// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// The decisions CourtListener last returned for each type of case, kept in the database so that a
// reply still has real decisions when a live search fails: the API token is shared and throttled,
// and searches sometimes time out. Only public court decisions are kept, never a visitor's words
// or the search terms drawn from them.
import sql from './db.js';

// Older than this, remembered decisions are not used: the search looks for recent decisions.
export const CASE_MEMORY_MAX_AGE_DAYS = 30;

export async function rememberCases(caseType, cases) {
  if (!Array.isArray(cases) || cases.length === 0) return;
  await sql`
    INSERT INTO search_cache (case_type, cases, updated_at)
    VALUES (${caseType}, ${JSON.stringify(cases)}, NOW())
    ON CONFLICT (case_type) DO UPDATE SET cases = EXCLUDED.cases, updated_at = NOW()`;
}

export async function recallCases(caseType) {
  const [row] = await sql`
    SELECT cases FROM search_cache
    WHERE case_type = ${caseType} AND updated_at > NOW() - make_interval(days => ${CASE_MEMORY_MAX_AGE_DAYS})`;
  return Array.isArray(row?.cases) ? row.cases : [];
}
