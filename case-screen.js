// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The nightly screen of the case library. Each decision due (dueForScreen in case-library.js) is put to CourtListener in one
// or two questions:
// - the citing question: does a later decision that cites it have one of a few words, such as "overruled", near its
//   party's name?
// - the higher court question, for a decision below the Court of Appeals: has a higher court since filed a decision under
//   the same party names?
// Nothing found and the decision is clear. Anything found and it is held for the owner, who is emailed what was found and
// decides on the admin page. This is a filter that errs toward holding, not a citator. The search, the usage report, the
// clock and the email are parameters, so this file never reaches a network or loads the database.

import { dueForScreen, recordTried, recordClear, recordHeld, plainText } from './case-library.js';
import { allowanceLeft, countRequests } from './courtlistener-usage.js';

const PASSAGE_LIMIT = 600;
const PHRASE_LIMIT = 60;
// A hold lists the clusters of the hits it found, at most this many from one answer; a decision held again keeps the
// union of its holds' lists, at most the second number, the newest kept.
const SEEN_PER_HOLD = 20;
const SEEN_LIMIT = 200;
// The words looked for near the party's name, each quoted so that it is searched as written, and how many words apart they
// may be. Tuned on recorded answers (plan 4 Task 4): every form of the three verbs, at 15 apart.
const TREATMENT_WORDS = [
  'overrule', 'overrules', 'overruled', 'overruling', 'abrogate', 'abrogates', 'abrogated', 'abrogating',
  'supersede', 'supersedes', 'superseded', 'superseding', 'good law',
];
const DISTANCE = 15;
// The citing question of a decision whose name gives no party word: any of these words anywhere in a decision that cites it.
const ANY_TREATMENT = '"overruled" OR "abrogated" OR "superseded" OR "no longer good law"';
// Words of a caption that name no party in particular.
const CAPTION_STOP_WORDS = new Set([
  'people', 'state', 'city', 'county', 'town', 'village', 'new', 'york', 'matter', 'estate', 'the', 'and', 'inc', 'corp', 'llc',
  'authority', 'board', 'department', 'dept', 'company', 'co',
]);
// What the owner is told the screen found, for each kind of hold.
const FINDINGS = {
  citing: () => 'A later decision that cites it has one of the words the screen looks for (such as "overruled" or "abrogated") near its party\'s name.',
  'higher-court': () => 'A higher court has since filed a decision under a case name with the same party names.',
  unreadable: hold => `The screen could not read CourtListener's answer for it (status ${hold.status}).`,
};
const TIME_UP = Symbol('time');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dayOrNull = value => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').slice(0, 10)) ? String(value).slice(0, 10) : null);

// A side's party word: its first word of three or more letters outside the caption stop words, failing that its first word
// of three or more letters, failing that null. Words are letters only, so no character of the search syntax gets in.
function wordOf(side) {
  const words = (String(side ?? '').match(/\p{L}+/gu) || []).filter(word => [...word].length >= 3);
  return words.find(word => !CAPTION_STOP_WORDS.has(word.toLowerCase())) ?? words[0] ?? null;
}

// The two sides' party words of a case name, split on its first " v. " or " v " after a leading "Matter of" or "In re".
export function partyWords(caseName) {
  const name = String(caseName ?? '').trim().replace(/^(?:matter\s+of|in\s+re)\s+/i, '');
  const sides = name.match(/^(.*?)\s+v\.?\s+(.*)$/is);
  return sides ? [wordOf(sides[1]), wordOf(sides[2])] : [wordOf(name), null];
}

// The questions for one decision: { citing, higherCourt }, each the search's parameters; higherCourt is null for a decision
// of the Court of Appeals. Neither carries a date from the owner's decision: a re-screen skips the clusters the decision's
// hold lists as seen instead (screenOne).
export function screenQuestions(row) {
  const [one, two] = partyWords(row.case_name);
  const party = one ?? two;
  const near = party ? TREATMENT_WORDS.map(word => `"${party} ${word}"~${DISTANCE}`).join(' OR ') : ANY_TREATMENT;
  const citing = { type: 'o', q: `cites:(${row.opinion_id}) AND (${near})`, highlight: 'on', order_by: 'dateFiled desc' };
  if (row.court_id === 'ny') return { citing, higherCourt: null };

  const words = [one, two].filter(Boolean);
  const phrase = String(row.case_name ?? '').replace(/[^\p{L}\s]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, PHRASE_LIMIT).trim();
  const higherCourt = {
    type: 'o', q: `caseName:${words.length ? `(${words.join(' AND ')})` : `("${phrase}")`}`,
    court: row.court_id === 'nyappdiv' ? 'ny' : 'nyappdiv ny', order_by: 'dateFiled desc',
  };
  const filed = dayOrNull(row.date_filed);
  if (filed) higherCourt.filed_after = filed;
  return { citing, higherCourt };
}

// The clusters a row's last hold lists as seen, or none.
const seenOf = hold => (Array.isArray(hold?.seen) ? hold.seen.map(Number).filter(id => Number.isFinite(id) && id > 0) : []);

// What a new hold lists as seen: the earlier holds' clusters and then the new hits', each once, the newest kept.
const seenWith = (earlier, found) => [...new Set([...earlier, ...found])].slice(-SEEN_LIMIT);

// A result's cluster id, from its cluster_id or else its address.
function clusterOf(result) {
  const id = Number(result?.cluster_id);
  if (Number.isFinite(id) && id > 0) return id;
  const match = String(result?.absolute_url ?? '').match(/^\/opinion\/(\d+)\//);
  return match ? Number(match[1]) : null;
}

function laterOf(hit) {
  const address = String(hit?.absolute_url ?? '');
  return {
    case_name: plainText(hit?.caseName || hit?.case_name) || null,
    url: address.startsWith('/') ? `https://www.courtlistener.com${address}` : null,
    court: plainText(hit?.court || hit?.court_id) || null,
    date_filed: dayOrNull(hit?.dateFiled ?? hit?.date_filed),
  };
}

const snippetOf = hit => String(hit?.opinions?.[0]?.snippet ?? hit?.snippet ?? '');
// The hit's highlighted passage as plain text: the marks removed, and a tag cut off at the end of the snippet too.
const passageOf = hit => plainText(snippetOf(hit).replace(/<[^>]*$/, '')).slice(0, PASSAGE_LIMIT);
const hasMark = hit => /<mark>/i.test(snippetOf(hit));

// What an answer is:
// - refused: 401, 403 or 429, CourtListener refusing the token or the rate, never the decision's doing;
// - failed: no answer at all (status 0) or a 5xx;
// - results: a 200 with a list of results;
// - unreadable: anything else, a question this decision's screen could not get answered.
function readAnswer(answer) {
  const status = Number.isFinite(Number(answer?.status)) ? Number(answer.status) : 0;
  if ([401, 403, 429].includes(status)) return { refused: status };
  if (status === 0 || (status >= 500 && status <= 599)) return { failed: status };
  if (status === 200 && Array.isArray(answer?.body?.results)) return { results: answer.body.results };
  return { unreadable: status };
}

// Asks a decision's questions in turn. Returns TIME_UP when the time ran out before a question, { refused }, { failed } or
// { unreadable } with the status, { hold } for the first question that found something, or {} for nothing found. A hit is a
// result that is neither the decision itself nor a cluster the row's last hold lists as seen. The owner is shown, for the
// citing question, the first hit with a marked passage, else its first hit; for the higher court question, its first hit.
// The hold counts the hits and adds the clusters of the first SEEN_PER_HOLD to what the last hold saw.
async function screenOne(row, questions, ask) {
  const seen = seenOf(row.hold);
  const skipped = new Set([Number(row.cluster_id), ...seen]);
  for (const [question, params] of [['citing', questions.citing], ['higher-court', questions.higherCourt]]) {
    if (!params) continue;
    const answer = await ask(params);
    if (answer === TIME_UP) return TIME_UP;
    const read = readAnswer(answer);
    if (read.refused !== undefined) return { refused: read.refused };
    if (read.failed !== undefined) return { failed: read.failed };
    if (!read.results) return { unreadable: read.unreadable };
    const hits = read.results.filter(result => !skipped.has(clusterOf(result)));
    if (!hits.length) continue;
    const shown = question === 'citing' ? (hits.find(hasMark) ?? hits[0]) : hits[0];
    const found = hits.slice(0, SEEN_PER_HOLD).map(clusterOf).filter(id => id !== null);
    return { hold: { question, later: laterOf(shown), passage: passageOf(shown), hits: hits.length, seen: seenWith(seen, found) } };
  }
  return {};
}

const unreadableHold = (status, row) => ({ question: 'unreadable', status, later: null, passage: null, seen: seenOf(row.hold) });
const stopped = (status, row) => new Error(`CourtListener answered ${status} to the screen of ${row.cluster_id}; the run stopped`);

const linkOf = url => {
  const shown = escapeHtml(url);
  return String(url ?? '').startsWith('https://') ? `<a href="${shown}">${shown}</a>` : shown;
};

// How many later decisions a hold found, and that the one shown comes first.
const foundCount = hits => (hits === 1 ? '1 later decision was found. It is shown below.' : `${hits} later decisions were found. The first is shown below.`);

// The owner's email about one held decision: the decision, the count of later decisions found, the one shown and its passage,
// every value escaped.
function holdEmail(row, hold, site) {
  const citations = Array.isArray(row.citations) ? row.citations : [];
  const lines = values => values.filter(Boolean).join('<br>');
  const parts = [
    `<p>The nightly screen held a court decision in the case library. ${escapeHtml(FINDINGS[hold.question](hold))}`
      + ' While it is held it is not offered to replies. It waits for you on the admin page, where you can clear it or ban it.</p>',
    `<h3>The decision</h3><p>${lines([escapeHtml(row.case_name), escapeHtml(citations[0]), escapeHtml([row.court, row.date_filed].filter(Boolean).join(', ')), linkOf(row.url)])}</p>`,
  ];
  if (hold.later) {
    if (Number.isInteger(hold.hits) && hold.hits > 0) parts.push(`<p>${foundCount(hold.hits)}</p>`);
    parts.push(`<h3>The later decision</h3><p>${lines([escapeHtml(hold.later.case_name), escapeHtml([hold.later.court, hold.later.date_filed].filter(Boolean).join(', ')), linkOf(hold.later.url)])}</p>`);
  }
  if (hold.passage) parts.push(`<h3>The passage</h3><blockquote>${escapeHtml(hold.passage)}</blockquote>`);
  return { subject: `${site ? `${site}: ` : ''}A decision is held for your review: ${row.case_name}`, html: parts.join('') };
}

// Emails the owner about a decision newly held. Returns whether the email went; one that did not is logged, never retried.
async function tellOwner(notify, row, hold, site) {
  const { subject, html } = holdEmail(row, hold, site);
  let outcome;
  try {
    outcome = await notify(subject, html);
  } catch (err) {
    outcome = { sent: false, reason: err?.message };
  }
  if (outcome?.sent === true) return true;
  console.error(`The screen held decision ${row.cluster_id} (${row.case_name}) but could not email the owner: ${outcome?.reason ?? 'no reason given'}. It waits on the admin page.`);
  return false;
}

/**
 * One night's screen. Returns what it did. It throws, keeping every row written before, when CourtListener:
 * - refuses the token or the rate (401, 403, 429): that decision is left exactly as it was;
 * - gives no answer or a 5xx: that decision gets its try time. But a decision whose last try failed too is held as
 *   unreadable instead and the run goes on, so a decision that never answers leaves the queue;
 * - gives any other answer the screen cannot read (another 4xx, or a 200 with no results): the decision is held as unreadable
 *   and the run goes on.
 * At most one decision a run is held as unreadable, whatever the answer was: the next one gets its try time and the run
 * stops, so a run that meets an outage, or a change at CourtListener that every question meets, still stops.
 *
 * @param {Function} options.search     search({ params }) => { status, body } (searchForScreen in courtlistener.js); never throws
 * @param {Function} options.allowance  () => { day, hour, minute } | null, read once (readAllowance)
 * @param {Function} options.notify     notify(subject, html) => { sent: true } | { sent: false, reason } (sendOperatorNotice)
 * @param {Function} options.now        the time in milliseconds
 * @returns {Promise<{ screened: number, cleared: number, held: number, requests: number, notifyFailed: number, stoppedBecause: null | 'allowance' | 'time' }>}
 */
export async function screenDecisions({
  sqlClient, search, allowance, notify, site = '', now = Date.now, sleep = wait,
  // The budget goes with searchForScreen's 45 s timeout (courtlistener.js): the last request starts by 235 s and so ends by
  // 280 s, inside the 300 s of the jobs function (api/jobs.js). Change the two together.
  maxRequests = 20, spacingMs = 13000, budgetMs = 235000, reserve = 30, hourReserve = 5,
} = {}) {
  if (typeof notify !== 'function') throw new Error('the screen was given no way to email the owner');
  const start = now();
  const result = { screened: 0, cleared: 0, held: 0, requests: 0, notifyFailed: 0, stoppedBecause: null };

  const answer = await allowance();
  const left = answer ? allowanceLeft(answer, { reserve, hourReserve }) : 0;
  if (left <= 0) {
    result.stoppedBecause = 'allowance';
    return result;
  }
  // The run's own limit is a normal end; a smaller allowance is named as the reason the run stopped.
  const cap = Math.min(maxRequests, left);
  const capReason = cap < maxRequests ? 'allowance' : null;
  if (cap <= 0) return result;
  // Every decision needs at least one request, so no more than `cap` can be screened.
  const rows = await dueForScreen(sqlClient, { limit: cap, now: new Date(start) });

  // Every request after the first waits the spacing; none is sent when the spacing would carry the run past its time. Each is
  // counted before it is sent, as CourtListener counts it.
  const ask = async params => {
    if (now() - start + spacingMs > budgetMs) return TIME_UP;
    if (result.requests > 0) await sleep(spacingMs);
    await countRequests(sqlClient, 'screen', 1);
    result.requests += 1;
    return search({ params });
  };

  // Whether a decision has been held as unreadable in this run: one may be, whatever the answer was.
  let unreadableHeld = false;
  for (const row of rows) {
    const questions = screenQuestions(row);
    // A decision is started only when all its questions fit under the cap.
    if (result.requests + (questions.higherCourt ? 2 : 1) > cap) {
      result.stoppedBecause = capReason;
      break;
    }
    const found = await screenOne(row, questions, ask);
    if (found === TIME_UP) {
      result.stoppedBecause = 'time';
      break;
    }
    const at = new Date(now()).toISOString();
    if (found.refused !== undefined) throw stopped(found.refused, row);
    // No answer or a 5xx on a decision whose last try did not fail, or a second unreadable answer in the run: the decision
    // gets its try time and the run stops. The first unreadable answer of the run holds its decision and the run goes on.
    const unreadable = found.failed ?? found.unreadable;
    if (unreadable !== undefined) {
      if ((found.failed !== undefined && !row.last_try_failed) || unreadableHeld) {
        await recordTried(sqlClient, row.cluster_id, at);
        throw stopped(unreadable, row);
      }
      unreadableHeld = true;
      found.hold = unreadableHold(unreadable, row);
    }
    result.screened += 1;
    if (!found.hold) {
      if (await recordClear(sqlClient, row.cluster_id, at)) result.cleared += 1;
      continue;
    }
    // The hold is written first; the owner is emailed only about a row it changed.
    const hold = { found_at: at, ...found.hold };
    if (!(await recordHeld(sqlClient, row.cluster_id, hold, at))) continue;
    result.held += 1;
    if (!(await tellOwner(notify, row, hold, site))) result.notifyFailed += 1;
  }
  if (!result.stoppedBecause && rows.length >= cap) result.stoppedBecause = capReason;
  return result;
}
