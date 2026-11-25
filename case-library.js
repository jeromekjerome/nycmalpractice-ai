// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The case library's records: the court decisions found on CourtListener, each kept once by its cluster id with the case
// types and topics it was found for and its screen state (unscreened, clear, held or banned). A reply is given decisions
// picked from the clear ones; the nightly screen (case-screen.js) reads the due ones and writes their state here. The SQL
// client (a Neon tagged-template function) is the first parameter of every function, so this file never loads the database.

const SNIPPET_LIMIT = 600;
const CANDIDATE_LIMIT = 300;
// A clear decision is screened again once its last screen is this many days old.
const RESCREEN_AFTER_DAYS = 30;

// Words too common to say what a decision is about.
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'but', 'not', 'you', 'your', 'with', 'from', 'that', 'this', 'these', 'those',
  'has', 'had', 'have', 'who', 'whom', 'what', 'when', 'where', 'which', 'while', 'there', 'their', 'then', 'than', 'into',
  'onto', 'over', 'under', 'after', 'before', 'about', 'been', 'being', 'can', 'could', 'would', 'should', 'will', 'may',
  'might', 'did', 'does', 'its', 'also', 'any', 'all', 'some', 'such', 'other', 'case', 'inc', 'llc', 'corp', 'ltd',
]);

export function plainText(raw) {
  return String(raw ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:x27|39);/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// A filing date as the table takes it (YYYY-MM-DD), or null, so one malformed date cannot stop a topic's save.
const dateOrNull = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : null);

// A raw v4 search result as a library record, or null when it has no cluster id or no case name.
export function recordFromResult(result) {
  if (!result || typeof result !== 'object') return null;
  const clusterId = Number(result.cluster_id);
  const caseName = plainText(result.caseName || result.case_name);
  if (!Number.isFinite(clusterId) || clusterId <= 0 || !caseName) return null;
  const list = Array.isArray(result.citation) ? result.citation : (result.citation ? [result.citation] : []);
  const idOrNull = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
  return {
    cluster_id: clusterId,
    opinion_id: idOrNull(result.opinions?.[0]?.id),
    docket_id: idOrNull(result.docket_id),
    case_name: caseName,
    citations: list.map(plainText).filter(Boolean),
    court: plainText(result.court || result.court_id) || null,
    court_id: plainText(result.court_id) || null,
    date_filed: dateOrNull(result.dateFiled || result.date_filed),
    snippet: plainText(result.opinions?.[0]?.snippet || result.snippet).slice(0, SNIPPET_LIMIT),
    url: result.absolute_url ? `https://www.courtlistener.com${result.absolute_url}` : null,
  };
}

// Keeps the records found for a case type and topic. A decision already in the library gains the type and topic and a new
// last-found time; its screen state is never written here. Returns how many records were sent.
export async function saveFound(sqlClient, records, { caseType, topicId } = {}) {
  let saved = 0;
  for (const r of records || []) {
    await sqlClient`
      INSERT INTO case_library (cluster_id, opinion_id, docket_id, case_name, citations, court, court_id, date_filed, snippet, url, case_types, topics)
      VALUES (${r.cluster_id}, ${r.opinion_id}, ${r.docket_id}, ${r.case_name}, ${JSON.stringify(r.citations || [])}::jsonb, ${r.court}, ${r.court_id},
              ${r.date_filed}, ${r.snippet}, ${r.url}, ${[caseType]}::text[], ${topicId ? [topicId] : []}::text[])
      ON CONFLICT (cluster_id) DO UPDATE SET
        last_found = NOW(),
        case_types = ARRAY(SELECT DISTINCT unnest(case_library.case_types || EXCLUDED.case_types)),
        topics = ARRAY(SELECT DISTINCT unnest(case_library.topics || EXCLUDED.topics)),
        opinion_id = COALESCE(EXCLUDED.opinion_id, case_library.opinion_id),
        docket_id = COALESCE(EXCLUDED.docket_id, case_library.docket_id),
        citations = CASE WHEN jsonb_array_length(EXCLUDED.citations) > 0 THEN EXCLUDED.citations ELSE case_library.citations END,
        snippet = COALESCE(NULLIF(EXCLUDED.snippet, ''), case_library.snippet)
    `;
    saved += 1;
  }
  return saved;
}

// Keeps the pinned records: a decision the site's own pages cite. It is inserted with no case type and no topic and marked
// pinned; one already in the library is marked pinned and gains the ids, citations and excerpt it lacked. The screen state,
// screening time, hold and decision time are never written here. Returns how many records were sent.
export async function savePinned(sqlClient, records) {
  let saved = 0;
  for (const r of records || []) {
    await sqlClient`
      INSERT INTO case_library (cluster_id, opinion_id, docket_id, case_name, citations, court, court_id, date_filed, snippet, url, case_types, topics, pinned)
      VALUES (${r.cluster_id}, ${r.opinion_id}, ${r.docket_id}, ${r.case_name}, ${JSON.stringify(r.citations || [])}::jsonb, ${r.court}, ${r.court_id},
              ${r.date_filed}, ${r.snippet}, ${r.url}, '{}', '{}', TRUE)
      ON CONFLICT (cluster_id) DO UPDATE SET
        pinned = TRUE,
        last_found = NOW(),
        opinion_id = COALESCE(EXCLUDED.opinion_id, case_library.opinion_id),
        docket_id = COALESCE(EXCLUDED.docket_id, case_library.docket_id),
        citations = CASE WHEN jsonb_array_length(EXCLUDED.citations) > 0 THEN EXCLUDED.citations ELSE case_library.citations END,
        snippet = COALESCE(NULLIF(EXCLUDED.snippet, ''), case_library.snippet)
    `;
    saved += 1;
  }
  return saved;
}

// Every citation of every pinned row, in one list.
export async function pinnedCitations(sqlClient) {
  const rows = await sqlClient`SELECT citations FROM case_library WHERE pinned = TRUE`;
  return rows.flatMap(row => (Array.isArray(row.citations) ? row.citations.map(String) : []));
}

// Deletes the rows not found for this many days, except pinned, banned and held ones (a held row waits for the owner).
// Returns how many went.
export async function dropStale(sqlClient, { days = 90 } = {}) {
  const gone = await sqlClient`
    DELETE FROM case_library
    WHERE pinned = FALSE AND screen_state <> 'banned' AND screen_state <> 'held' AND last_found < NOW() - make_interval(days => ${days})
    RETURNING cluster_id
  `;
  return gone.length;
}

const words = text => new Set((String(text ?? '').toLowerCase().match(/\p{L}{3,}/gu) || []).filter(word => !STOP_WORDS.has(word)));
export const wordsOf = words;

function decisionOf(row) {
  const citations = Array.isArray(row.citations) ? row.citations : [];
  return {
    caseName: row.case_name,
    citation: citations[0] || '',
    citations,
    court: row.court || '',
    dateFiled: row.date_filed ? String(row.date_filed).slice(0, 10) : '',
    snippet: row.snippet || '',
    url: row.url || '',
    scope: 'library',
    clusterId: Number(row.cluster_id),
    screen: { state: row.screen_state, on: row.screened_on || null },
  };
}

// The clear decisions of a case type that best match the classifier's terms: most shared words first (case name, excerpt
// and topic ids), the newer decision first on a tie.
export async function pickDecisions(sqlClient, { caseType, terms, limit = 5 } = {}) {
  const rows = await sqlClient`
    SELECT cluster_id, case_name, citations, court, to_char(date_filed, 'YYYY-MM-DD') AS date_filed, snippet, url, topics, screen_state,
           to_char(screened_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS screened_on
    FROM case_library
    WHERE screen_state = 'clear' AND pinned = FALSE AND ${caseType} = ANY(case_types)
    ORDER BY date_filed DESC NULLS LAST
    LIMIT ${CANDIDATE_LIMIT}
  `;
  const wanted = words(terms);
  return rows
    .map(row => {
      const have = words(`${row.case_name} ${row.snippet} ${(row.topics || []).join(' ')}`);
      let overlap = 0;
      for (const word of wanted) if (have.has(word)) overlap += 1;
      return { row, overlap };
    })
    .sort((a, b) => b.overlap - a.overlap
      || String(b.row.date_filed || '').localeCompare(String(a.row.date_filed || ''))
      || Number(a.row.cluster_id) - Number(b.row.cluster_id))
    .slice(0, limit)
    .map(({ row }) => decisionOf(row));
}

export async function clearCount(sqlClient, caseType) {
  const [row] = await sqlClient`SELECT COUNT(*)::int AS n FROM case_library WHERE screen_state = 'clear' AND pinned = FALSE AND ${caseType} = ANY(case_types)`;
  return Number(row?.n) || 0;
}

export async function bannedIds(sqlClient) {
  const rows = await sqlClient`SELECT cluster_id FROM case_library WHERE screen_state = 'banned'`;
  return new Set(rows.map(row => Number(row.cluster_id)));
}

// The screen state of each cluster id the library holds: Map of id to { state, screened_at (ISO or null), on (New York YYYY-MM-DD or null),
// question (the question a hold was found on, or null) }.
export async function screenStates(sqlClient, clusterIds) {
  const ids = [...new Set((clusterIds || []).map(Number).filter(Number.isFinite))];
  const states = new Map();
  if (!ids.length) return states;
  const rows = await sqlClient`
    SELECT cluster_id, screen_state, screened_at, to_char(screened_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS screened_on,
           hold->>'question' AS question
    FROM case_library
    WHERE cluster_id = ANY(${ids.map(String)}::bigint[])
  `;
  for (const row of rows) {
    const at = row.screened_at instanceof Date ? row.screened_at.toISOString() : (row.screened_at || null);
    states.set(Number(row.cluster_id), { state: row.screen_state, screened_at: at, on: row.screened_on || null, question: row.question || null });
  }
  return states;
}

// What a page says of a decision: one `screenStates` entry (or undefined for a decision the library does not hold) becomes
// { state: 'clear', on } for a clear decision, { state: 'held', on: null } for a held or banned one whose hold names a question
// the screen answered, and { state: 'unscreened', on: null } for everything else, an unreadable or missing hold included.
export function shownScreen(entry) {
  if (entry?.state === 'clear') return { state: 'clear', on: entry.on || null };
  if ((entry?.state === 'held' || entry?.state === 'banned') && (entry.question === 'citing' || entry.question === 'higher-court')) return { state: 'held', on: null };
  return { state: 'unscreened', on: null };
}

// The decisions the screen should look at next, at most `limit` of them, each with an opinion id (a row without one stays
// unscreened, so it is never offered to a reply): first every unscreened row, the untried and then the longest-untried
// first, then the first found; then the clear rows last screened a month or more before `now`, longest-untried first. Held
// and banned rows are never due. A row whose screen failed has a new try time, so it waits behind the others next night.
// `last_try_failed` is true when the row was tried after its last finished screen (or tried and never screened): a clear or
// a hold writes both times equal, so a finished screen resets it. `hold` is the row's last hold, or null: the screen skips the
// later decisions it lists as seen.
export async function dueForScreen(sqlClient, { limit, now = new Date() } = {}) {
  return sqlClient`
    SELECT cluster_id, opinion_id, case_name, citations, court, court_id, to_char(date_filed, 'YYYY-MM-DD') AS date_filed, url,
           screen_state, decided_at, hold,
           (screen_tried_at IS NOT NULL AND (screened_at IS NULL OR screen_tried_at > screened_at)) AS last_try_failed
    FROM case_library
    WHERE opinion_id IS NOT NULL
      AND (screen_state = 'unscreened'
           OR (screen_state = 'clear' AND screened_at <= ${new Date(now).toISOString()}::timestamptz - make_interval(days => ${RESCREEN_AFTER_DAYS})))
    ORDER BY screen_state <> 'unscreened', screen_tried_at NULLS FIRST, CASE WHEN screen_state = 'unscreened' THEN first_found END, cluster_id
    LIMIT ${limit}
  `;
}

// A screen attempt on a row: its time only, whether the screen got an answer or not.
export async function recordTried(sqlClient, clusterId, at) {
  await sqlClient`UPDATE case_library SET screen_tried_at = ${at}::timestamptz WHERE cluster_id = ${clusterId}`;
}

// The screen found nothing: the row is clear as of `at`. The hold is left alone, so the owner's record of a hold they cleared
// survives. A row the owner banned or decided while the run went on is not written. Returns whether a row changed.
export async function recordClear(sqlClient, clusterId, at) {
  const rows = await sqlClient`
    UPDATE case_library SET screen_state = 'clear', screened_at = ${at}::timestamptz, screen_tried_at = ${at}::timestamptz
    WHERE cluster_id = ${clusterId} AND screen_state IN ('unscreened', 'clear')
    RETURNING cluster_id
  `;
  return rows.length > 0;
}

// The screen found something: the row is held for the owner with what was found. Written over an unscreened or clear row
// only. Returns whether a row changed.
export async function recordHeld(sqlClient, clusterId, hold, at) {
  const rows = await sqlClient`
    UPDATE case_library SET screen_state = 'held', screened_at = ${at}::timestamptz, screen_tried_at = ${at}::timestamptz, hold = ${JSON.stringify(hold)}::jsonb
    WHERE cluster_id = ${clusterId} AND screen_state IN ('unscreened', 'clear')
    RETURNING cluster_id
  `;
  return rows.length > 0;
}

// The decisions held for the owner, pinned ones included, the newest hold first. `hold` is what the screen found; a decision the
// owner cleared and the screen held again keeps its old decided_at, which is not returned: the hold's own date is hold.found_at.
export async function heldDecisions(sqlClient) {
  const rows = await sqlClient`
    SELECT cluster_id, case_name, citations, court, to_char(date_filed, 'YYYY-MM-DD') AS date_filed, url, hold, case_types, pinned
    FROM case_library
    WHERE screen_state = 'held'
    ORDER BY hold->>'found_at' DESC NULLS LAST, cluster_id
  `;
  return rows.map(row => ({
    cluster_id: Number(row.cluster_id),
    case_name: row.case_name,
    citations: Array.isArray(row.citations) ? row.citations : [],
    court: row.court || null,
    date_filed: row.date_filed || null,
    url: row.url || null,
    hold: row.hold || null,
    case_types: Array.isArray(row.case_types) ? [...row.case_types].sort() : [],
    pinned: row.pinned === true,
  }));
}

// The owner's decision on a held decision: 'clear' (it may be offered to replies again, as of `at`) or 'banned' (never offered,
// never screened again). Written only over a held row, so a decision already made, or a row the screen is still working on,
// is left as it is. The hold stays as the record of what the owner saw. Returns whether a row changed.
// A clear of a hold that answered no question (the screen could not read CourtListener's answer, or the hold names no
// question) sends the decision back to be screened instead: unscreened, with no screening or decision time. Its try time
// stays, so it waits behind the decisions never tried, and a further failure is held once more while the run goes on.
export async function decideHeld(sqlClient, clusterId, decision, at) {
  if (decision !== 'clear' && decision !== 'banned') throw new Error(`decideHeld takes 'clear' or 'banned', not ${String(decision)}`);
  const rows = decision === 'clear'
    ? await sqlClient`
        UPDATE case_library SET
          screen_state = CASE WHEN COALESCE(hold->>'question', 'unreadable') = 'unreadable' THEN 'unscreened' ELSE 'clear' END,
          screened_at = CASE WHEN COALESCE(hold->>'question', 'unreadable') = 'unreadable' THEN NULL ELSE ${at}::timestamptz END,
          decided_at = CASE WHEN COALESCE(hold->>'question', 'unreadable') = 'unreadable' THEN NULL ELSE ${at}::timestamptz END
        WHERE cluster_id = ${clusterId} AND screen_state = 'held'
        RETURNING cluster_id
      `
    : await sqlClient`
        UPDATE case_library SET screen_state = 'banned', decided_at = ${at}::timestamptz
        WHERE cluster_id = ${clusterId} AND screen_state = 'held'
        RETURNING cluster_id
      `;
  return rows.length > 0;
}

// What the library holds. Pinned rows are never offered to a reply, so the per-type clear, unscreened and held counts leave them
// out (they match clearCount). The held, banned and total figures count every row, pinned ones included, since a pinned decision
// that is held or banned needs the owner's attention; `pinned` is the count of pinned rows.
export async function libraryCounts(sqlClient) {
  const perType = await sqlClient`
    SELECT t AS case_type, screen_state, COUNT(*)::int AS n
    FROM case_library, unnest(case_types) AS t
    WHERE pinned = FALSE
    GROUP BY t, screen_state
  `;
  const allStates = await sqlClient`SELECT screen_state, pinned, COUNT(*)::int AS n FROM case_library GROUP BY screen_state, pinned`;
  const pinned = allStates.filter(row => row.pinned).reduce((sum, row) => sum + Number(row.n), 0);
  const byType = {};
  for (const row of perType) {
    const entry = byType[row.case_type] ||= { clear: 0, unscreened: 0, held: 0 };
    if (row.screen_state in entry) entry[row.screen_state] += Number(row.n);
  }
  const count = state => allStates.filter(row => row.screen_state === state).reduce((sum, row) => sum + Number(row.n), 0);
  return { byType, held: count('held'), banned: count('banned'), total: allStates.reduce((sum, row) => sum + Number(row.n), 0), pinned };
}
