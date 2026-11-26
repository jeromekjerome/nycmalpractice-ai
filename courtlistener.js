// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import { runJob } from './providers.js';
import { chains } from './model-settings.js';
import sql from './db.js';
import { countRequests } from './courtlistener-usage.js';

const CL_BASE = 'https://www.courtlistener.com/api/rest/v4';

// New York Court of Appeals, Supreme Court, and Appellate Division.
const DEFAULT_NY_COURTS = 'ny nysupct nyappdiv';

// CourtListener throttles API tokens per minute and the budget is shared between search and
// citation-lookup, so identical searches are served from an in-memory cache. Case law for a
// given query does not change hour to hour, and the type-level fallback queries repeat constantly.
const SEARCH_TIMEOUT_MS = 5000;            // per request (a healthy search answers in about a second)
const SEARCH_BUDGET_MS = 8000;             // for the whole ladder of requests in one lookup
const SEARCH_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 200;
const MAX_SPECIFIC_TERMS = 8;
const searchCache = new Map();

// The counts of requests sent that have not finished saving. A reply waits for them before it ends, so a function
// that freezes after replying has not lost them.
const countsInFlight = new Set();

export function pendingCounts() {
  return Promise.allSettled([...countsInFlight]);
}

export function clearSearchCache() {
  searchCache.clear();
}

function getHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.COURTLISTENER_TOKEN) {
    headers['Authorization'] = `Token ${process.env.COURTLISTENER_TOKEN}`;
  }
  return headers;
}

// The words every result must contain, per case type. Kept short on purpose: each word is required,
// and every set below finds New York precedential decisions filed since 2015 (checked November 2026).
const CASE_TYPE_TERMS = {
  surgical_error:      'medical malpractice surgery',
  misdiagnosis:        'medical malpractice failure to diagnose',
  medication_error:    'medical malpractice medication',
  birth_injury:        'medical malpractice birth injury',
  anesthesia_error:    'medical malpractice anesthesia',
  hospital_negligence: 'medical malpractice hospital negligence',
  nursing_home:        'nursing home negligence',
  dental:              'dental malpractice',
  other:               'medical malpractice',
};

// Words that carry no search signal, plus the query-syntax operators.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'was', 'were', 'that', 'this', 'from', 'have', 'has', 'had', 'are',
  'you', 'your', 'his', 'her', 'their', 'not', 'but', 'who', 'what', 'when', 'where', 'how', 'why',
  'been', 'being', 'into', 'about', 'after', 'before', 'they', 'them', 'she', 'him', 'our', 'out',
  'off', 'over', 'under', 'then', 'than', 'too', 'very', 'can', 'could', 'would', 'should', 'will',
  'just', 'also', 'any', 'all', 'some', 'more', 'most', 'other', 'such', 'only', 'own', 'same',
  'both', 'each', 'few', 'did', 'does', 'doing', 'got', 'get', 'like', 'last', 'week', 'weeks',
  'month', 'months', 'year', 'years', 'ago', 'day', 'days', 'time', 'one', 'two', 'three', 'its',
  'while', 'there', 'here', 'which', 'because', 'really', 'still', 'may', 'might', 'near',
  'or', 'to', 'of', 'in', 'on', 'at', 'by', 'an', 'as', 'is', 'it', 'me', 'my', 'we', 'he', 'so', 'no', 'if', 'do', 'am', 'be', 'up',
]);

// Search results carry <mark> highlight tags (in the case name and citations too, not only the
// snippet) and raw opinion whitespace. Everything downstream — prompts and the page — needs plain text.
function plainText(raw) {
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

function mapResult(r, scope) {
  const citations = (Array.isArray(r.citation) ? r.citation : (r.citation ? [r.citation] : []))
    .map(plainText)
    .filter(Boolean);
  const url = r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : '';

  return {
    caseName:    plainText(r.caseName || r.case_name),
    citation:    citations[0] || '',
    citations,                       // every parallel citation CourtListener returned
    court:       plainText(r.court || r.court_id),
    dateFiled:   r.dateFiled || r.date_filed || '',
    // v4 nests the snippet under opinions[]; the top-level field only existed in v3.
    snippet:     plainText(r.snippet || r.opinions?.[0]?.snippet).slice(0, 600),
    url,                             // the address the page links the decision from
    scope,                           // 'ny' (court-filtered) | 'national' (fallback)
  };
}

// The fact-specific words of a query: plain tokens only (nothing that could act as query syntax),
// without stopwords or words the type's base terms already require.
function specificTerms(query, baseTerms) {
  const required = new Set(baseTerms.toLowerCase().split(/\s+/));
  const seen = new Set();
  const terms = [];
  // Letters in any alphabet count as part of a word, so an accented word is not cut in two.
  for (const raw of String(query ?? '').split(/[^\p{L}\p{N}-]+/u)) {
    const term = raw.replace(/^-+|-+$/g, '');
    const key = term.toLowerCase();
    if (term.length < 3 || /^\d+$/.test(term)) continue;
    if (STOPWORDS.has(key) || required.has(key) || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === MAX_SPECIFIC_TERMS) break;
  }
  return terms;
}

// One CourtListener search request. Never throws: { cases, stop }.
// `stop` means no further request should be sent: the API is throttling us, refusing the token,
// down, or out of time — another request would fail the same way and only add latency. With
// `cacheOnly`, nothing is sent at all and only a cached answer is returned.
async function runSearch(paramsObject, limit, scope, deadline, { cacheOnly = false } = {}) {
  const url = `${CL_BASE}/search/?${new URLSearchParams(paramsObject)}`;

  const cached = searchCache.get(url);
  if (cached && (Date.now() - cached.at) < SEARCH_CACHE_TTL_MS) {
    return { cases: cached.cases.slice(0, limit), stop: false };
  }
  if (cacheOnly) return { cases: [], stop: true };

  const timeout = Math.min(SEARCH_TIMEOUT_MS, deadline - Date.now());
  if (timeout <= 0) return { cases: [], stop: true };

  try {
    // A request is counted before it is sent, so a failed or timed-out one counts, as CourtListener counts it.
    // The count never throws; the reply waits for it through pendingCounts().
    const counting = countRequests(sql, 'chat-search', 1);
    countsInFlight.add(counting);
    counting.finally(() => countsInFlight.delete(counting));
    const res = await fetch(url, {
      headers: getHeaders(),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      console.error(`CourtListener search failed (${scope}):`, res.status, res.statusText);
      // 429 = rate limited, 401/403 = the token is refused, 5xx = service trouble. Any other 4xx
      // (e.g. an unknown court id) is specific to this request, so the next rung is worth trying.
      return { cases: [], stop: [401, 403, 429].includes(res.status) || res.status >= 500 };
    }

    const data = await res.json();
    if (!Array.isArray(data?.results)) {
      // Not a search answer at all: nothing to use, and nothing worth remembering for six hours.
      console.error(`CourtListener search returned an unexpected body (${scope})`);
      return { cases: [], stop: false };
    }
    // CourtListener sometimes lists one decision under two clusters; keep the first. Two results
    // are the same decision when they share a name and either a citation, a filing date or a URL.
    const sameDecision = (a, b) =>
      a.caseName.toLowerCase() === b.caseName.toLowerCase() && (
        a.citations.some(citation => b.citations.includes(citation)) ||
        (a.dateFiled && a.dateFiled === b.dateFiled) ||
        (a.url && a.url === b.url)
      );
    const cases = [];
    for (const r of data.results) {
      const mapped = mapResult(r, scope);
      // A result with no case name cannot be cited.
      if (!mapped.caseName) continue;
      if (cases.some(kept => sameDecision(kept, mapped))) continue;
      cases.push(mapped);
    }

    if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
      searchCache.delete(searchCache.keys().next().value);
    }
    searchCache.set(url, { at: Date.now(), cases });

    return { cases: cases.slice(0, limit), stop: false };
  } catch (err) {
    console.error(`CourtListener error (${scope}):`, err.message);
    // A request that ran out of time may just have been a slow query: the simpler one on the next
    // rung can still fit in what is left of the budget. A connection failure will not.
    return { cases: [], stop: err?.name !== 'TimeoutError' };
  }
}

// ─── The case library's requests ──────────────────────────────────────────────
// Each is one request with no ladder, no second try and no cache. The refresh's two are counted here under the job `library`
// before they are sent (the count is awaited, so a function that stops after the job has lost nothing); the screen's search
// is counted by the screen. None throws: status 0 is a network error or a timeout.
const LIBRARY_TIMEOUT_MS = 20_000;

// One topic search: precedential New York decisions since 2015, best match first. Returns { results, status }.
export async function searchTopic({ q, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({
    q: String(q ?? ''), type: 'o', order_by: 'score desc', filed_after: '2015-01-01', stat_Precedential: 'on',
    court: process.env.COURTLISTENER_COURTS || DEFAULT_NY_COURTS,
  });
  await countRequests(sql, 'library', 1);
  try {
    const res = await fetchImpl(`${CL_BASE}/search/?${params}`, { headers: getHeaders(), signal: AbortSignal.timeout(LIBRARY_TIMEOUT_MS) });
    if (!res.ok) {
      console.error('CourtListener topic search failed:', res.status, res.statusText);
      return { results: [], status: res.status };
    }
    const data = await res.json();
    return { results: Array.isArray(data?.results) ? data.results : [], status: res.status };
  } catch (err) {
    console.error('CourtListener topic search error:', err.message);
    return { results: [], status: 0 };
  }
}

// One citation lookup of the text given (citations separated by line breaks). Returns { status, body }, the body being the
// list of citations the lookup found, each with its clusters.
export async function lookupCitations({ text, fetchImpl = fetch } = {}) {
  await countRequests(sql, 'library', 1);
  try {
    const res = await fetchImpl(`${CL_BASE}/citation-lookup/`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text: String(text ?? '') }).toString(),
      signal: AbortSignal.timeout(LIBRARY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('CourtListener citation lookup failed:', res.status, res.statusText);
      return { status: res.status, body: null };
    }
    return { status: res.status, body: await res.json() };
  } catch (err) {
    console.error('CourtListener citation lookup error:', err.message);
    return { status: 0, body: null };
  }
}

// One search for the nightly screen (case-screen.js), with the parameters it gives. The screen counts the request under the
// job `screen` before it calls this, so it is not counted here. Returns { status, body }; never throws. Its timeout goes with
// the screen's time budget (case-screen.js): the last request starts by 235 s and so ends by 280 s, inside the 300 s of the
// jobs function (api/jobs.js). A heavily cited decision's question took 25 s when the words were tuned.
const SCREEN_TIMEOUT_MS = 45_000;
export async function searchForScreen({ params, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${CL_BASE}/search/?${new URLSearchParams(params || {})}`, { headers: getHeaders(), signal: AbortSignal.timeout(SCREEN_TIMEOUT_MS) });
    if (!res.ok) {
      console.error('CourtListener screen search failed:', res.status, res.statusText);
      return { status: res.status, body: null };
    }
    return { status: res.status, body: await res.json() };
  } catch (err) {
    console.error('CourtListener screen search error:', err.message);
    return { status: 0, body: null };
  }
}

/**
 * Retrieve case law for a malpractice situation. New York courts are searched first; a national
 * precedential search is the fallback, so the case packet is never unnecessarily empty.
 *
 * Within each scope the tailored query is tried before the type-level one. The tailored query
 * requires the type's base terms and at least one of the fact-specific terms; requiring all of
 * them (the previous behaviour) matched nothing for ordinary conversations, in any court.
 * When the tailored query is slow, the type-level one is sent alongside it (see searchScope).
 */
export async function searchMalpracticeCases({ query = '', caseType = 'other', limit = 5 } = {}) {
  const baseTerms = Object.hasOwn(CASE_TYPE_TERMS, caseType) ? CASE_TYPE_TERMS[caseType] : CASE_TYPE_TERMS.other;
  const extras = specificTerms(query, baseTerms);
  const queries = extras.length
    ? [`${baseTerms} (${extras.join(' OR ')})`, baseTerms]
    : [baseTerms];

  const commonParams = {
    type: 'o',
    order_by: 'score desc',
    filed_after: '2015-01-01',
    stat_Precedential: 'on',
    highlight: 'on',               // snippet = matched passages instead of the opinion's first 500 chars
  };
  const nyCourts = process.env.COURTLISTENER_COURTS || DEFAULT_NY_COURTS;
  const deadline = Date.now() + SEARCH_BUDGET_MS;

  // 1) New York courts by default; 2) national precedential search if New York has nothing.
  // Once a request says to stop, no more are sent — but a later rung that is already cached costs
  // nothing and is still better than an empty packet.
  const state = { cacheOnly: false };
  for (const scope of ['ny', 'national']) {
    const paramsFor = q => (scope === 'ny' ? { q, ...commonParams, court: nyCourts } : { q, ...commonParams });
    const cases = await searchScope(queries, paramsFor, limit, scope, deadline, state);
    if (cases.length > 0) return cases;
  }
  return [];
}

// When the tailored query has not answered after this long, the type-level query is sent alongside
// it and whichever finds cases first is used. A tailored query can take longer than the per-request
// timeout (seen live in November 2026), and a slow answer used to leave the reply with no case law at
// all. The extra request is only sent when the tailored query is slow.
const DEFAULT_HEDGE_AFTER_MS = 2500;

// The first of the runs to come back with cases, or an empty result once none of them has.
function firstWithCases(runs) {
  return new Promise(resolve => {
    let pending = runs.length;
    let stop = false;
    for (const run of runs) {
      run.then(result => {
        stop = stop || result.stop;
        if (result.cases.length > 0) resolve({ cases: result.cases, stop });
        else if (--pending === 0) resolve({ cases: [], stop });
      });
    }
  });
}

// One scope (New York courts, or national): the tailored query, then the type-level one.
async function searchScope(queries, paramsFor, limit, scope, deadline, state) {
  const run = q => runSearch(paramsFor(q), limit, scope, deadline, { cacheOnly: state.cacheOnly });
  const [tailored, typeLevel] = queries;
  const tailoredRun = run(tailored);
  if (!typeLevel) {
    const result = await tailoredRun;
    if (result.stop) state.cacheOnly = true;
    return result.cases;
  }

  const hedgeAfter = Number(process.env.COURTLISTENER_HEDGE_AFTER_MS) || DEFAULT_HEDGE_AFTER_MS;
  let timer;
  const early = await Promise.race([
    tailoredRun,
    new Promise(resolve => { timer = setTimeout(resolve, hedgeAfter, null); }),
  ]);
  clearTimeout(timer);

  if (early) {
    // The tailored query answered in time: use it, or try the type-level one as before.
    if (early.stop) state.cacheOnly = true;
    if (early.cases.length > 0) return early.cases;
    const result = await run(typeLevel);
    if (result.stop) state.cacheOnly = true;
    return result.cases;
  }

  // The tailored query is slow: send the type-level one alongside and take whichever finds cases first.
  const result = await firstWithCases([tailoredRun, run(typeLevel)]);
  if (result.stop) state.cacheOnly = true;
  return result.cases;
}

const CLASSIFIER_FALLBACK = { type: 'other', terms: 'medical malpractice standard of care' };
// About a thousand tokens for the small model: a few cents per thousand conversations. It was 600 characters, which
// a visitor's second message could already pass, and what was cut was the middle of the account.
const CLASSIFIER_TEXT_LIMIT = 4000;

// `deps` is handed on to runJob (providers.js): tests pass fake adapters. `clock` is the reply's, when the
// classification is part of one.
export async function extractCaseType(text, deps = {}, clock = null) {
  // The visitor's messages are passed oldest first, and read whole. Only an account longer than the limit is cut,
  // and then it keeps both ends: the opening says what happened, the latest message what is being asked now.
  const whole = String(text ?? '');
  const half = CLASSIFIER_TEXT_LIMIT / 2;
  const excerpt = whole.length > CLASSIFIER_TEXT_LIMIT ? `${whole.slice(0, half)} … ${whole.slice(-half)}` : whole;

  try {
    const { small } = await chains();
    const res = await runJob({
      job: 'classify',
      chain: small,
      messages: [{
        role: 'user',
        content: `Classify this NYC malpractice inquiry into one category.

Categories:
- surgical_error: surgical errors, wrong-site surgery, operating room negligence, and any object left in the body during surgery or a procedure (sponge, instrument, needle, guidewire, catheter piece), even when it was found later on a scan
- misdiagnosis: failure to diagnose, delayed diagnosis, missed diagnosis, misread imaging of an illness or condition (not an object left in the body)
- medication_error: wrong drug, wrong dose, prescription errors, pharmacy errors
- birth_injury: birth injuries, cerebral palsy, Erb's palsy, obstetric malpractice
- anesthesia_error: anesthesia complications, awareness under anesthesia
- hospital_negligence: hospital falls, infections, staffing, vicarious liability for staff
- nursing_home: nursing home neglect, elder abuse, pressure sores, malnutrition
- dental: dental malpractice, extraction errors, nerve damage, failed procedures
- other: general medical malpractice, standard of care questions

Also provide 3-5 targeted search terms for finding similar court cases.

Respond ONLY with JSON: {"type": "misdiagnosis", "terms": "delayed cancer diagnosis radiology"}

Text: ${excerpt}`,
      }],
      json: true,
      maxTokens: 120,
      clock,
    }, deps);

    const parsed = JSON.parse(res.text);
    // The caller reads .type and .terms, so anything that is not an object is no answer.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { ...CLASSIFIER_FALLBACK };
  } catch {
    return { ...CLASSIFIER_FALLBACK };
  }
}
