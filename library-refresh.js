// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The nightly refresh of the case library: it runs the topic searches searched longest ago, keeps the best results of each in
// the library (case-library.js), looks up the pinned decisions it does not yet hold, and drops the rows nobody has found for
// a long time. The searches, the citation lookup and the usage report are parameters, so this file never reaches a network or
// a database; the CourtListener allowance (courtlistener-usage.js) is shared by every caller of the token, so the run reads it
// once first and sends no more requests than it leaves.

import { saveFound, savePinned, pinnedCitations, dropStale, recordFromResult, wordsOf } from './case-library.js';
import { allowanceLeft } from './courtlistener-usage.js';

const COURT_OF_APPEALS_REPORTERS = new Set(['n.y.', 'n.y.2d', 'n.y.3d']);

const normalized = citation => String(citation ?? '').toLowerCase().replace(/\s+/g, '');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// A citation-lookup cluster as a library record (the shape recordFromResult gives), or null without an id or a case name.
export function recordFromCluster(cluster) {
  const clusterId = Number(cluster?.id);
  const caseName = String(cluster?.case_name ?? '').replace(/\s+/g, ' ').trim();
  if (!Number.isFinite(clusterId) || clusterId <= 0 || !caseName) return null;
  const idOrNull = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);
  const citations = (Array.isArray(cluster.citations) ? cluster.citations : [])
    .map(citation => `${citation?.volume ?? ''} ${citation?.reporter ?? ''} ${citation?.page ?? ''}`.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const fromCourtOfAppeals = (Array.isArray(cluster.citations) ? cluster.citations : [])
    .some(citation => COURT_OF_APPEALS_REPORTERS.has(String(citation?.reporter ?? '').toLowerCase()));
  const firstOpinion = String((Array.isArray(cluster.sub_opinions) ? cluster.sub_opinions : [])[0] ?? '').match(/\/(\d+)\/?$/);
  return {
    cluster_id: clusterId,
    opinion_id: idOrNull(firstOpinion?.[1]),
    docket_id: idOrNull(cluster.docket_id),
    case_name: caseName,
    citations,
    court: fromCourtOfAppeals ? 'New York Court of Appeals' : null,
    court_id: fromCourtOfAppeals ? 'ny' : null,
    date_filed: /^\d{4}-\d{2}-\d{2}$/.test(String(cluster.date_filed ?? '')) ? String(cluster.date_filed) : null,
    snippet: '',
    url: cluster.absolute_url ? `https://www.courtlistener.com${cluster.absolute_url}` : null,
  };
}

// Of the clusters a citation answered, the one whose case name shares the most words with the pin's name; the first on a tie.
function bestCluster(clusters, name) {
  const wanted = wordsOf(name);
  let best = null;
  let bestOverlap = -1;
  for (const cluster of clusters) {
    const have = wordsOf(cluster?.case_name);
    let overlap = 0;
    for (const word of wanted) if (have.has(word)) overlap += 1;
    if (overlap > bestOverlap) { best = cluster; bestOverlap = overlap; }
  }
  return best;
}

// The topics in the order to run them: never-searched first, then the one searched longest ago; the order given on a tie.
function inRunOrder(topics, lastRuns) {
  const all = Object.entries(topics || {}).flatMap(([caseType, list]) => (list || []).map(topic => ({ caseType, id: topic.id, q: topic.q })));
  const at = topic => (lastRuns.has(topic.id) ? lastRuns.get(topic.id) : -Infinity);
  return all.map((topic, index) => ({ topic, index })).sort((a, b) => at(a.topic) - at(b.topic) || a.index - b.index).map(({ topic }) => topic);
}

async function lastRunsOf(sqlClient) {
  const rows = await sqlClient`SELECT topic_id, last_run_at FROM library_topics`;
  const runs = new Map();
  for (const row of rows) {
    const at = row.last_run_at ? Date.parse(row.last_run_at instanceof Date ? row.last_run_at.toISOString() : row.last_run_at) : NaN;
    runs.set(row.topic_id, Number.isFinite(at) ? at : -Infinity);
  }
  return runs;
}

// The pins no pinned row yet holds. A pin is held when a pinned row's citations include its citation.
export async function unresolvedPins(sqlClient, pins) {
  const held = new Set((await pinnedCitations(sqlClient)).map(normalized));
  return (pins || []).filter(pin => !held.has(normalized(pin.citation)));
}

// Looks the unresolved pins up in one request and keeps what is found, pinned. A pin not found waits for the next night.
async function resolvePins({ sqlClient, unresolved, lookupPins }) {
  const { status, body } = await lookupPins({ text: unresolved.map(pin => pin.citation).join('\n') });
  if (status !== 200) {
    console.warn(`CourtListener answered ${status} to the citation lookup of the pinned decisions; they are looked up again tomorrow.`);
    return 0;
  }
  const entries = Array.isArray(body) ? body : [];
  const records = [];
  for (const pin of unresolved) {
    const wanted = normalized(pin.citation);
    const entry = entries.find(candidate => normalized(candidate?.citation) === wanted
      || (Array.isArray(candidate?.normalized_citations) && candidate.normalized_citations.some(citation => normalized(citation) === wanted)));
    const clusters = entry?.status === 200 && Array.isArray(entry.clusters) ? entry.clusters : [];
    const record = clusters.length ? recordFromCluster(bestCluster(clusters, pin.name)) : null;
    if (record) records.push(record);
    else console.warn(`The pinned decision ${pin.citation} (${pin.name}) was not found by the citation lookup; it is looked up again tomorrow.`);
  }
  return savePinned(sqlClient, records);
}

// One night's refresh. Returns what it did; throws when CourtListener answers a topic search with anything but a result,
// leaving the rows already written and that topic's last-run time untouched.
export async function refreshLibrary({
  sqlClient, topics, search, lookupPins, pins = [], allowance, now = Date.now, sleep = wait,
  maxSearches = 10, perTopic = 8, spacingMs = 13000, budgetMs = 240000, reserve = 30, hourReserve = 5,
} = {}) {
  const start = now();
  const result = { searched: [], added: 0, dropped: 0, pinsResolved: 0, stoppedBecause: null };

  const answer = await allowance();
  const left = answer ? allowanceLeft(answer, { reserve, hourReserve }) : 0;
  if (left <= 0) {
    result.stoppedBecause = 'allowance';
    return result;
  }

  let sent = 0;
  // Every request after the first waits the spacing; none is sent when the spacing would carry the run past its time.
  const mayRequest = async () => {
    if (now() - start + spacingMs > budgetMs) { result.stoppedBecause = 'time'; return false; }
    if (sent > 0) await sleep(spacingMs);
    sent += 1;
    return true;
  };

  // The pins come first, so that the searches, which can fill the whole night, never leave them waiting. The lookup is one
  // request, not one of the searches; a lookup that fails leaves the pins for tomorrow and the night goes on.
  const unresolved = await unresolvedPins(sqlClient, pins);
  if (unresolved.length && await mayRequest()) {
    result.pinsResolved = await resolvePins({ sqlClient, unresolved, lookupPins });
  }

  const cap = Math.min(maxSearches, left - sent);
  const queue = result.stoppedBecause === 'time' ? [] : inRunOrder(topics, await lastRunsOf(sqlClient));
  for (const topic of queue) {
    if (result.searched.length >= maxSearches) break;
    if (result.searched.length >= cap) { if (cap < maxSearches) result.stoppedBecause = 'allowance'; break; }
    if (!(await mayRequest())) break;
    const { results, status } = await search({ q: topic.q });
    if (status !== 200) throw new Error(`CourtListener answered ${status} to the topic search ${topic.id}; the run stopped`);
    const records = (Array.isArray(results) ? results : []).slice(0, perTopic).map(recordFromResult).filter(Boolean);
    await saveFound(sqlClient, records, { caseType: topic.caseType, topicId: topic.id });
    await sqlClient`
      INSERT INTO library_topics (topic_id, last_run_at, last_found)
      VALUES (${topic.id}, NOW(), ${records.length})
      ON CONFLICT (topic_id) DO UPDATE SET last_run_at = NOW(), last_found = EXCLUDED.last_found
    `;
    result.searched.push(topic.id);
    result.added += records.length;
  }

  result.dropped = await dropStale(sqlClient);
  return result;
}
