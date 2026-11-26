// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The nightly screen of the case library (case-screen.js): the questions it asks CourtListener about each decision, what it
// does with the answers, and when it stops. The answers come from recorded CourtListener answers (test/fixtures/cl-screen-*.json,
// each with the parameters it was asked with) or from fakes; the database is a fake that keeps rows in an array and orders the
// due decisions the way case-library.js's dueForScreen does; the clock is a counter and nothing sleeps. Nothing here reaches a
// network or a database.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { test } from './runner.mjs';
import { screenDecisions, screenQuestions, partyWords } from '../case-screen.js';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/cl-screen-${name}.json`, import.meta.url), 'utf8'));
const PLENTY = { day: 125, hour: 50, minute: 5 };
const DAY_MS = 86_400_000;
const NIGHT = Date.parse('2026-11-25T23:00:00Z');
const APPELLATE = 'Appellate Division of the Supreme Court of the State of New York';

// A database that keeps the library's rows: dueForScreen's order (never-screened first, by last try with the untried first,
// then first found; then clear ones screened a month or more ago, by last try) and its last_try_failed (tried after the last
// screen, or tried and never screened), the three screen writes, and the counts.
function fakeLibrary(rows = []) {
  const db = {
    rows: rows.map((row, i) => ({
      screen_state: 'unscreened', screened_at: null, screen_tried_at: null, hold: null, decided_at: null,
      first_found: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), ...row,
    })),
    events: [], queries: [],
  };
  const find = id => db.rows.find(row => Number(row.cluster_id) === Number(id));
  const writable = row => row && ['unscreened', 'clear'].includes(row.screen_state);
  db.sql = async (strings, ...values) => {
    const text = strings.join('?');
    db.queries.push({ text, values });
    if (/INSERT INTO courtlistener_usage/.test(text)) { db.events.push(`count ${values[1]} ${values[2]}`); return []; }
    if (/FROM case_library\s+WHERE opinion_id IS NOT NULL/.test(text)) {
      const [nowIso, days, limit] = values;
      const cutoff = Date.parse(nowIso) - days * DAY_MS;
      const tried = row => (row.screen_tried_at ? Date.parse(row.screen_tried_at) : -Infinity);
      const byTry = (a, b) => (tried(a) - tried(b)) || 0;
      const unscreened = db.rows.filter(row => row.opinion_id != null && row.screen_state === 'unscreened')
        .sort((a, b) => byTry(a, b) || Date.parse(a.first_found) - Date.parse(b.first_found) || Number(a.cluster_id) - Number(b.cluster_id));
      const clear = db.rows.filter(row => row.opinion_id != null && row.screen_state === 'clear' && row.screened_at && Date.parse(row.screened_at) <= cutoff)
        .sort((a, b) => byTry(a, b) || Number(a.cluster_id) - Number(b.cluster_id));
      const lastTryFailed = row => row.screen_tried_at != null && (row.screened_at == null || Date.parse(row.screen_tried_at) > Date.parse(row.screened_at));
      return [...unscreened, ...clear].slice(0, limit).map(row => ({ ...row, last_try_failed: lastTryFailed(row) }));
    }
    if (/UPDATE case_library SET screen_tried_at/.test(text)) {
      const row = find(values[1]);
      if (row) row.screen_tried_at = values[0];
      return [];
    }
    if (/UPDATE case_library SET screen_state = 'clear'/.test(text)) {
      const row = find(values[2]);
      if (!writable(row)) return [];
      Object.assign(row, { screen_state: 'clear', screened_at: values[0], screen_tried_at: values[1] });
      return [{ cluster_id: String(row.cluster_id) }];
    }
    if (/UPDATE case_library SET screen_state = 'held'/.test(text)) {
      const row = find(values[3]);
      if (!writable(row)) return [];
      Object.assign(row, { screen_state: 'held', screened_at: values[0], screen_tried_at: values[1], hold: JSON.parse(values[2]) });
      return [{ cluster_id: String(row.cluster_id) }];
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  db.row = find;
  return db;
}

// A search answered only from the recorded answers named, and only for the exact parameters each was asked with.
function recorded(db, ...names) {
  const answers = names.map(fixture);
  const asked = [];
  const search = async ({ params }) => {
    asked.push(params);
    db?.events.push('search');
    const answer = answers.find(candidate => isDeepStrictEqual(candidate.params, params));
    if (!answer) throw new Error(`no recorded answer for ${JSON.stringify(params)}`);
    return { status: answer.status, body: { count: answer.count, results: answer.results } };
  };
  return { search, asked };
}

// A search that answers each question with what `answer(params)` gives: by default, no results.
function answering(db, answer = () => ({ status: 200, body: { count: 0, results: [] } }), { clock, costMs = 0 } = {}) {
  const asked = [];
  const search = async ({ params }) => {
    asked.push(params);
    db?.events.push('search');
    if (clock) clock.t += costMs;
    return answer(params);
  };
  return { search, asked };
}

function fakeClock(start = NIGHT) {
  const clock = { t: start, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async ms => { clock.sleeps.push(ms); clock.t += ms; };
  return clock;
}

function fakeMail({ sent = true } = {}) {
  const mail = { sent: [] };
  mail.notify = async (subject, html) => {
    mail.sent.push({ subject, html });
    if (sent instanceof Error) throw sent;
    return sent ? { sent: true } : { sent: false, reason: 'no mail login' };
  };
  return mail;
}

// Runs the screen quietly: what it logs is returned, not printed.
async function run({ db, search, mail = fakeMail(), clock = fakeClock(), ...overrides }) {
  const logs = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...parts) => logs.push(parts.join(' '));
  try {
    const result = await screenDecisions({
      sqlClient: db.sql, search, allowance: async () => PLENTY, notify: mail.notify, site: 'nycinjury.ai', now: clock.now, sleep: clock.sleep, ...overrides,
    });
    return { result, logs, mail, clock };
  } finally {
    Object.assign(console, saved);
  }
}

// run() keeps the console quiet while the screen runs and puts it back when the screen throws, so this only checks the throw.
const rejectsQuietly = (promise, pattern) => assert.rejects(promise, pattern);

// The six decisions recorded for the tuning (the report of plan 4 Task 4 says why each was chosen), as dueForScreen gives them.
const SIX = {
  mitchell: { cluster_id: '3606857', opinion_id: '3588600', case_name: 'Mitchell v. . Rochester Railway Co.', citations: ['45 N.E. 354', '151 N.Y. 107', '5 E.H. Smith 107', '1896 N.Y. LEXIS 864'], court: 'New York Court of Appeals', court_id: 'ny', date_filed: '1896-12-01', url: 'https://www.courtlistener.com/opinion/3606857/mitchell-v-rochester-railway-co/' },
  campo: { cluster_id: '5635806', opinion_id: '5481237', case_name: 'Campo v. Scofield', citations: ['301 N.Y. 468', '95 N.E.2d 802'], court: 'New York Court of Appeals', court_id: 'ny', date_filed: '1950-11-30', url: 'https://www.courtlistener.com/opinion/5635806/campo-v-scofield/' },
  perl: { cluster_id: '5943865', opinion_id: '5802405', case_name: 'Perl v. Meher', citations: ['74 A.D.3d 930', '902 N.Y.S.2d 632'], court: APPELLATE, court_id: 'nyappdiv', date_filed: '2010-06-08', url: 'https://www.courtlistener.com/opinion/5943865/perl-v-meher/' },
  licari: { cluster_id: '5685956', opinion_id: '5534961', case_name: 'Licari v. Elliott', citations: ['57 N.Y.2d 230', '441 N.E.2d 1088', '455 N.Y.S.2d 570'], court: 'New York Court of Appeals', court_id: 'ny', date_filed: '1982-10-14', url: 'https://www.courtlistener.com/opinion/5685956/licari-v-elliott/' },
  bello: { cluster_id: '9398198', opinion_id: '9393674', case_name: 'Bello v. Masters Auto Collision of Long Is., Inc.', citations: ['216 A.D.3d 726', '188 N.Y.S.3d 177', '2023 NY Slip Op 02489'], court: APPELLATE, court_id: 'nyappdiv', date_filed: '2023-05-10', url: 'https://www.courtlistener.com/opinion/9398198/bello-v-masters-auto-collision-of-long-is-inc/' },
  rodriguez: { cluster_id: '7173717', opinion_id: '7084086', case_name: 'Rodriguez v. City of N.Y.', citations: ['101 N.E.3d 366', '31 N.Y.3d 312', '76 N.Y.S.3d 898'], court: 'New York Court of Appeals', court_id: 'ny', date_filed: '2018-04-03', url: 'https://www.courtlistener.com/opinion/7173717/rodriguez-v-city-of-ny/' },
};
const ALL_ANSWERS = ['mitchell-q1', 'campo-q1', 'perl-q1', 'perl-q2', 'licari-q1', 'bello-q1', 'bello-q2', 'rodriguez-q1'];

// A decision of the given court with an opinion id, for the tests that make up their own.
let nextId = 100;
const decision = (extra = {}) => {
  nextId += 1;
  return { cluster_id: String(nextId), opinion_id: String(nextId + 50000), case_name: `Party${nextId} v. Other${nextId}`, citations: [`${nextId} A.D.3d 1`], court: APPELLATE, court_id: 'nyappdiv', date_filed: '2020-01-02', url: `https://www.courtlistener.com/opinion/${nextId}/x/`, ...extra };
};
const courtOfAppeals = (extra = {}) => decision({ court: 'New York Court of Appeals', court_id: 'ny', ...extra });
const plainSnippet = result => result.opinions[0].snippet.replace(/<[^>]+>/g, '');
const ago = days => new Date(NIGHT - days * DAY_MS).toISOString();

test('on the recorded answers, the three recorded to hold are held and the three recorded to clear are cleared', async () => {
  const db = fakeLibrary(Object.values(SIX));
  const { search, asked } = recorded(db, ...ALL_ANSWERS);
  const { result, mail, clock } = await run({ db, search });
  assert.deepEqual(result, { screened: 6, cleared: 3, held: 3, requests: 8, notifyFailed: 0, stoppedBecause: null });
  assert.equal(asked.length, 8, 'each recorded question was asked once, with exactly the parameters it was recorded with');
  assert.deepEqual(Object.fromEntries(Object.entries(SIX).map(([name, row]) => [name, db.row(row.cluster_id).screen_state])),
    { mitchell: 'held', campo: 'held', perl: 'held', licari: 'clear', bello: 'clear', rodriguez: 'clear' });

  const mitchell = db.row(SIX.mitchell.cluster_id).hold;
  assert.equal(mitchell.question, 'citing');
  assert.deepEqual(mitchell.later, { case_name: 'SanMiguel v. Grimaldi', url: 'https://www.courtlistener.com/opinion/10717771/sanmiguel-v-grimaldi/', court: 'New York Court of Appeals', date_filed: '2025-10-21' });
  assert.equal(mitchell.passage, 'Comstock, 257 NY at 239; Mitchell v Rochester Ry. Co., 151 NY 107, 110 [1896], overruled by Battalla v State');
  assert.equal(mitchell.found_at, new Date(mitchell.found_at).toISOString());

  // Campo's first citing hit by date (Andrulonis, 1989) has no marked passage; the owner is shown the first one that does.
  const campo = db.row(SIX.campo.cluster_id).hold;
  assert.equal(campo.question, 'citing');
  assert.deepEqual(campo.later, { case_name: 'Arbegast v. Board of Education', url: 'https://www.courtlistener.com/opinion/5632959/arbegast-v-board-of-education/', court: 'New York Court of Appeals', date_filed: '1985-06-06' });
  assert.equal(campo.passage, 'examples see, 1 NY PJI2d 193-195. . The Campo case was overruled in Micallef v Miehle Co. (39 NY2d 376');

  const perl = db.row(SIX.perl.cluster_id).hold;
  assert.equal(perl.question, 'higher-court', "Perl's recorded answers hold it on the higher-court question");
  assert.deepEqual(perl.later, { case_name: 'Perl v. Meher', url: 'https://www.courtlistener.com/opinion/2522412/perl-v-meher/', court: 'New York Court of Appeals', date_filed: '2011-11-22' });
  assert.ok(perl.later.url.includes('/2522412/'), 'the higher court hit is still the first one, cluster 2522412');
  assert.ok(perl.passage.startsWith('18 N.Y.3d 208 (2011) 960 N.E.2d 424'), perl.passage);
  assert.ok(!/[<>]/.test(perl.passage), perl.passage);

  for (const name of ['licari', 'bello', 'rodriguez']) {
    const row = db.row(SIX[name].cluster_id);
    assert.equal(row.hold, null, name);
    assert.equal(row.screened_at, row.screen_tried_at, name);
  }
  assert.equal(mail.sent.length, 3, 'one email for each decision held');
  for (const [i, name] of ['mitchell', 'campo', 'perl'].entries()) assert.ok(mail.sent[i].subject.includes(SIX[name].case_name), mail.sent[i].subject);
  assert.deepEqual(clock.sleeps, Array(7).fill(13000), 'the requests are spaced, and nothing waits before the first');
});

test('clears Licari on its recorded answer', async () => {
  const db = fakeLibrary([SIX.licari]);
  const { search, asked } = recorded(db, 'licari-q1');
  const { result, mail } = await run({ db, search });
  assert.deepEqual(result, { screened: 1, cleared: 1, held: 0, requests: 1, notifyFailed: 0, stoppedBecause: null });
  assert.equal(asked.length, 1);
  assert.equal(db.row(SIX.licari.cluster_id).screen_state, 'clear');
  assert.equal(mail.sent.length, 0);
});

test('a Court of Appeals decision gets no higher court question; an Appellate Division one gets both when the first finds nothing', async () => {
  const db = fakeLibrary([courtOfAppeals(), decision()]);
  const { search, asked } = answering(db);
  const { result } = await run({ db, search });
  assert.equal(result.requests, 3);
  assert.deepEqual(asked.map(params => params.q.split(':')[0]), ['cites', 'cites', 'caseName']);
});

test('the citing question asks for the first party word near each treatment word, and the higher court question for both party words', () => {
  const { citing, higherCourt } = screenQuestions(SIX.bello);
  assert.deepEqual(citing, fixture('bello-q1').params);
  assert.deepEqual(higherCourt, fixture('bello-q2').params);
  assert.equal(screenQuestions(SIX.licari).higherCourt, null);
});

test('"X v. City of New York" from the Appellate Division asks the Court of Appeals about X and City', async () => {
  const db = fakeLibrary([decision({ case_name: 'Garcia v. City of New York', date_filed: '2019-03-04' })]);
  const { search, asked } = answering(db);
  await run({ db, search });
  assert.match(asked[0].q, /^cites:\(\d+\) AND \("Garcia overrule"~15 OR /);
  assert.deepEqual(asked[1], { type: 'o', q: 'caseName:(Garcia AND City)', court: 'ny', filed_after: '2019-03-04', order_by: 'dateFiled desc' });
});

test('the party words: a leading Matter of or In re goes, the caption stop words are passed over, and a side made only of them gives its first word', () => {
  assert.deepEqual(partyWords('Garcia v. City of New York'), ['Garcia', 'City']);
  assert.deepEqual(partyWords('Matter of Smith v. Board of Educ. of City of N.Y.'), ['Smith', 'Educ']);
  assert.deepEqual(partyWords('In re Estate of Brown'), ['Brown', null]);
  assert.deepEqual(partyWords('People v Lopez'), ['People', 'Lopez']);
  assert.deepEqual(partyWords('MATTER OF THE COUNTY OF ERIE V. TOWN OF AMHERST'), ['ERIE', 'AMHERST']);
  assert.deepEqual(partyWords("O'Brien V. Doe-Roe Co."), ['Brien', 'Doe']);
  assert.deepEqual(partyWords('Muñoz v. Pérez'), ['Muñoz', 'Pérez']);
  assert.deepEqual(partyWords('Mitchell v. . Rochester Railway Co.'), ['Mitchell', 'Rochester']);
  assert.deepEqual(partyWords('Ng v. Xu'), [null, null]);
  assert.deepEqual(partyWords('Smith v. 123 Main St. LLC'), ['Smith', 'Main']);
});

test('with no party word on either side, the citing question falls back to the treatment words alone and the higher court question to the name', () => {
  const { citing, higherCourt } = screenQuestions(decision({ opinion_id: '77', case_name: 'Ng v. Xu, 2 J.', date_filed: null }));
  assert.equal(citing.q, 'cites:(77) AND ("overruled" OR "abrogated" OR "superseded" OR "no longer good law")');
  assert.deepEqual(higherCourt, { type: 'o', q: 'caseName:("Ng v Xu J")', court: 'ny', order_by: 'dateFiled desc' }, 'and with no filing date, no filed_after');
  const long = screenQuestions(decision({ case_name: `Ng v. ${'Xu '.repeat(40)}` })).higherCourt.q;
  assert.equal(long, `caseName:("${`Ng v ${'Xu '.repeat(40)}`.slice(0, 60).trim()}")`);
});

test('with one side giving no word, the higher court question names the other alone; a trial court or an unknown court asks both courts above', () => {
  const trial = screenQuestions(decision({ case_name: 'Smith v. Ng', court: 'New York Supreme Court', court_id: 'nysupct' }));
  assert.equal(trial.higherCourt.q, 'caseName:(Smith)');
  assert.equal(trial.higherCourt.court, 'nyappdiv ny');
  assert.match(trial.citing.q, /"Smith overrule"~15/);
  const unknown = screenQuestions(decision({ case_name: 'Ng v. Jones', court: null, court_id: null }));
  assert.equal(unknown.higherCourt.q, 'caseName:(Jones)');
  assert.equal(unknown.higherCourt.court, 'nyappdiv ny');
  assert.match(unknown.citing.q, /"Jones overrule"~15/, 'the second side gives the citing word when the first gives none');
});

// A clear decision due again after the owner cleared its hold: the hold keeps the clusters the owner was shown.
const clearedAfterHold = (hold, extra = {}) => decision({
  screen_state: 'clear', screened_at: ago(40), screen_tried_at: ago(40), decided_at: ago(40), date_filed: '2020-01-02', hold, ...extra,
});
const hitOf = (id, extra = {}) => ({ cluster_id: id, absolute_url: `/opinion/${id}/hit-${id}/`, caseName: `Hit ${id} v. Case`, court_id: 'ny', dateFiled: '2024-01-01', opinions: [{ snippet: `the <mark>Party</mark> rule was <mark>overruled</mark> in ${id}` }], ...extra });
// A hold's lists of the clusters seen, one for each question.
const seenLists = (citing = [], higherCourt = []) => ({ citing, 'higher-court': higherCourt });
// A search that answers the citing question with the first results and the higher court question with the second.
const byQuestion = (db, citing, higherCourt = []) => answering(db, params => (params.q.startsWith('cites')
  ? { status: 200, body: { count: citing.length, results: citing } }
  : { status: 200, body: { count: higherCourt.length, results: higherCourt } }));

test('a re-screen skips the clusters in hold.seen and asks without a date cut', async () => {
  const row = clearedAfterHold({ found_at: ago(41), question: 'citing', later: null, passage: 'p', hits: 2, seen: seenLists([501, 502]) });
  const { citing, higherCourt } = screenQuestions(row);
  assert.equal(citing.filed_after, undefined, 'the citing question has no date');
  assert.equal(higherCourt.filed_after, '2020-01-02', 'the higher court question keeps the filing date alone');

  const db = fakeLibrary([row]);
  const { search, asked } = answering(db, params => (params.q.startsWith('cites') ? { status: 200, body: { count: 3, results: [hitOf(501), hitOf(502), hitOf(503)] } } : { status: 200, body: { count: 0, results: [] } }));
  const { result, mail } = await run({ db, search });
  assert.equal(asked.length, 1, 'a citing hit was found, so the higher court question was not asked');
  assert.equal(asked[0].filed_after, undefined);
  assert.equal(result.held, 1);
  const { hold } = db.row(row.cluster_id);
  assert.equal(hold.later.url, 'https://www.courtlistener.com/opinion/503/hit-503/', 'the owner is shown the cluster not seen before');
  assert.equal(hold.hits, 1, 'the clusters seen before are not counted');
  assert.match(mail.sent[0].html, /1 later decision was found\. It is shown below\./);

  // Every result was seen before: nothing is a hit, and the decision clears.
  const seenAll = clearedAfterHold({ found_at: ago(41), question: 'citing', later: null, passage: 'p', hits: 2, seen: seenLists([501, 502]) }, { court_id: 'ny', court: 'New York Court of Appeals' });
  const db2 = fakeLibrary([seenAll]);
  const second = await run({ db: db2, search: answering(db2, () => ({ status: 200, body: { count: 2, results: [hitOf(501), hitOf(502)] } })).search });
  assert.deepEqual([second.result.cleared, db2.row(seenAll.cluster_id).screen_state], [1, 'clear']);
});

test('a hold keeps the clusters of every hit of its answer, at most 20, and the email says how many were found', async () => {
  const row = courtOfAppeals();
  const db = fakeLibrary([row]);
  const results = Array.from({ length: 25 }, (_, i) => hitOf(600 + i, i === 0 ? { opinions: [{ snippet: 'no mark' }] } : {}));
  const { search } = answering(db, () => ({ status: 200, body: { count: 25, results: [{ cluster_id: Number(row.cluster_id), caseName: 'Itself' }, ...results] } }));
  const { mail } = await run({ db, search });
  const { hold } = db.row(row.cluster_id);
  assert.equal(hold.hits, 25);
  assert.deepEqual(hold.seen, seenLists(results.slice(0, 20).map(result => result.cluster_id)), 'the first 20 hits, the decision itself left out');
  assert.match(mail.sent[0].html, /<p>25 later decisions were found\. The first is shown below\.<\/p><h3>The later decision<\/h3>/);
  assert.doesNotMatch(mail.sent[0].html, /matched/i);
});

test('the cluster of the hit shown is in the hold\'s list even when it lies beyond the first 20 hits', async () => {
  const row = courtOfAppeals();
  const db = fakeLibrary([row]);
  // Only the 23rd hit has a marked passage, so it is the one shown.
  const results = Array.from({ length: 25 }, (_, i) => hitOf(700 + i, i === 22 ? {} : { opinions: [{ snippet: 'no mark' }] }));
  await run({ db, search: answering(db, () => ({ status: 200, body: { count: 25, results } })).search });
  const { hold } = db.row(row.cluster_id);
  assert.equal(hold.later.url, 'https://www.courtlistener.com/opinion/722/hit-722/');
  assert.deepEqual(hold.seen, seenLists([...results.slice(0, 20).map(result => result.cluster_id), 722]));
});

test('when CourtListener has more pages of results, the hold records it and the email says the count is of the first page', async () => {
  const next = 'https://www.courtlistener.com/api/rest/v4/search/?cursor=made-up';
  for (const [results, line] of [
    [Array.from({ length: 20 }, (_, i) => hitOf(800 + i)), '20 later decisions were found on the first page of results, and there are more. The first is shown below.'],
    [[hitOf(830)], '1 later decision was found on the first page of results, and there are more. It is shown below.'],
  ]) {
    const row = courtOfAppeals();
    const db = fakeLibrary([row]);
    const { mail } = await run({ db, search: answering(db, () => ({ status: 200, body: { count: 45, next, results } })).search });
    const { hold } = db.row(row.cluster_id);
    assert.deepEqual([hold.hits, hold.more], [results.length, true]);
    assert.ok(mail.sent[0].html.includes(`<p>${line}</p>`), mail.sent[0].html);
  }

  // Without a next page the hold records nothing of it, and the count reads as before.
  const row = courtOfAppeals();
  const db = fakeLibrary([row]);
  const { mail } = await run({ db, search: answering(db, () => ({ status: 200, body: { count: 2, next: null, results: [hitOf(840), hitOf(841)] } })).search });
  assert.equal(Object.hasOwn(db.row(row.cluster_id).hold, 'more'), false);
  assert.ok(mail.sent[0].html.includes('<p>2 later decisions were found. The first is shown below.</p>'), mail.sent[0].html);
  assert.doesNotMatch(mail.sent[0].html, /first page of results/);
});

test('a held-again row keeps the union of what each hold saw on each question, at most 200, and the other question\'s list as it was', async () => {
  const lastHold = { found_at: ago(41), question: 'higher-court', later: null, passage: 'p', hits: 2, seen: seenLists([501], [601, 602]) };
  // Held again on the citing question: the citing list grows, the higher court list is carried over.
  const citingAgain = clearedAfterHold(lastHold);
  const db = fakeLibrary([citingAgain]);
  await run({ db, search: byQuestion(db, [hitOf(501), hitOf(503)]).search });
  assert.deepEqual(db.row(citingAgain.cluster_id).hold.seen, seenLists([501, 503], [601, 602]));

  // Held again on the higher court question: the other way round.
  const higherAgain = clearedAfterHold(lastHold);
  const db1 = fakeLibrary([higherAgain]);
  await run({ db: db1, search: byQuestion(db1, [hitOf(501)], [hitOf(602), hitOf(603)]).search });
  const { hold } = db1.row(higherAgain.cluster_id);
  assert.deepEqual([hold.question, hold.hits, hold.seen], ['higher-court', 1, seenLists([501], [601, 602, 603])]);

  const full = Array.from({ length: 200 }, (_, i) => 1000 + i);
  const crowded = clearedAfterHold({ found_at: ago(41), question: 'citing', later: null, passage: 'p', hits: 20, seen: seenLists(full, [9]) }, { court_id: 'ny', court: 'New York Court of Appeals' });
  const db2 = fakeLibrary([crowded]);
  await run({ db: db2, search: answering(db2, () => ({ status: 200, body: { count: 1, results: [hitOf(77)] } })).search });
  const { seen } = db2.row(crowded.cluster_id).hold;
  assert.equal(seen.citing.length, 200);
  assert.equal(seen.citing.at(-1), 77, 'the clusters just shown are kept');
  assert.ok(!seen.citing.includes(1000), 'the oldest gives way');
  assert.deepEqual(seen['higher-court'], [9]);

  // A re-hold as unreadable keeps what the earlier holds saw, as it was.
  const failing = clearedAfterHold({ found_at: ago(41), question: 'citing', later: null, passage: 'p', hits: 2, seen: seenLists([501, 502], [601]) }, { court_id: 'ny', court: 'New York Court of Appeals' });
  const db3 = fakeLibrary([failing]);
  await run({ db: db3, search: answering(db3, () => ({ status: 400, body: { detail: 'bad query' } })).search });
  assert.deepEqual(db3.row(failing.cluster_id).hold.seen, seenLists([501, 502], [601]));
  assert.equal(db3.row(failing.cluster_id).hold.question, 'unreadable');
});

test('after a citing hold is cleared, a decision among its hits that the higher court question finds holds it on that question', async () => {
  // The owner was shown 501; 505 was among the hits listed but not shown.
  const row = clearedAfterHold({ found_at: ago(41), question: 'citing', later: null, passage: 'p', hits: 2, seen: seenLists([501, 505]) });
  const db = fakeLibrary([row]);
  const { search, asked } = byQuestion(db, [hitOf(501), hitOf(505)], [hitOf(505, { caseName: row.case_name })]);
  const { result } = await run({ db, search });
  assert.deepEqual(asked.map(params => params.q.split(':')[0]), ['cites', 'caseName']);
  assert.equal(asked[1].filed_after, '2020-01-02');
  assert.equal(result.held, 1);
  const { hold } = db.row(row.cluster_id);
  assert.equal(hold.question, 'higher-court');
  assert.equal(hold.later.url, 'https://www.courtlistener.com/opinion/505/hit-505/');
  assert.deepEqual([hold.hits, hold.seen], [1, seenLists([501, 505], [505])]);
});

test('a hold written with one list counts it for the question it names, or for both questions when it names neither', async () => {
  // Named citing: the higher court question still finds 505.
  const citing = clearedAfterHold({ found_at: ago(41), question: 'citing', later: null, passage: 'p', hits: 2, seen: [501, 505] });
  const db = fakeLibrary([citing]);
  await run({ db, search: byQuestion(db, [hitOf(501), hitOf(505)], [hitOf(505)]).search });
  assert.equal(db.row(citing.cluster_id).screen_state, 'held', 'the higher court question found 505');
  const first = db.row(citing.cluster_id).hold;
  assert.deepEqual([first.question, first.later.url, first.seen], ['higher-court', 'https://www.courtlistener.com/opinion/505/hit-505/', seenLists([501, 505], [505])]);

  // Named higher-court: the citing question still finds 601.
  const higher = clearedAfterHold({ found_at: ago(41), question: 'higher-court', later: null, passage: 'p', hits: 1, seen: [601] });
  const db1 = fakeLibrary([higher]);
  await run({ db: db1, search: byQuestion(db1, [hitOf(601)], [hitOf(601)]).search });
  assert.equal(db1.row(higher.cluster_id).screen_state, 'held', 'the citing question found 601');
  const second = db1.row(higher.cluster_id).hold;
  assert.deepEqual([second.question, second.later.url, second.seen], ['citing', 'https://www.courtlistener.com/opinion/601/hit-601/', seenLists([601], [601])]);

  // An unreadable hold, or one that names no question, the owner sent back to be screened: the list counts for both.
  for (const question of ['unreadable', undefined]) {
    const both = decision({ hold: { found_at: ago(41), question, status: 0, later: null, passage: null, seen: [501] } });
    const db2 = fakeLibrary([both]);
    const { result } = await run({ db: db2, search: byQuestion(db2, [hitOf(501)], [hitOf(501)]).search });
    assert.deepEqual([result.cleared, db2.row(both.cluster_id).screen_state], [1, 'clear'], String(question));
  }
});

test('a hold written with one list for the citing question, held again as unreadable, does not come to count it for the higher court question', async () => {
  const row = clearedAfterHold({ found_at: ago(41), question: 'citing', later: null, passage: 'p', hits: 1, seen: [501] });
  const db = fakeLibrary([row]);
  await run({ db, search: answering(db, () => ({ status: 400, body: { detail: 'bad query' } })).search });
  const unreadable = db.row(row.cluster_id).hold;
  assert.deepEqual([unreadable.question, unreadable.seen], ['unreadable', seenLists([501])]);

  // The owner sends it back to be screened (decideHeld in case-library.js), and the next night the higher court question
  // finds 501.
  Object.assign(db.row(row.cluster_id), { screen_state: 'unscreened', screened_at: null, decided_at: null });
  await run({ db, search: byQuestion(db, [hitOf(501)], [hitOf(501)]).search, clock: fakeClock(NIGHT + DAY_MS) });
  const { hold, screen_state: state } = db.row(row.cluster_id);
  assert.deepEqual([state, hold.question, hold.later.url, hold.seen], ['held', 'higher-court', 'https://www.courtlistener.com/opinion/501/hit-501/', seenLists([501], [501])]);
});

test('a result that is the decision itself is not a hit, whether it names its cluster by id or only by its address', async () => {
  const row = decision();
  const db = fakeLibrary([row]);
  const self = [{ cluster_id: Number(row.cluster_id), caseName: 'Itself', opinions: [{ snippet: 'x' }] }, { absolute_url: `/opinion/${row.cluster_id}/itself/`, caseName: 'Itself again' }];
  const { search } = answering(db, () => ({ status: 200, body: { count: 2, results: self } }));
  const { result } = await run({ db, search });
  assert.equal(result.cleared, 1);
  assert.equal(db.row(row.cluster_id).screen_state, 'clear');
});

test('a hit on the citing question holds the decision without asking the higher court question', async () => {
  const row = decision();
  const db = fakeLibrary([row]);
  const later = { cluster_id: 999, absolute_url: '/opinion/999/later-v-case/', caseName: 'Later v. Case', court: APPELLATE, court_id: 'nyappdiv', dateFiled: '2024-02-03', opinions: [{ snippet: `the <mark>Party</mark> rule was <mark>overruled</mark> ${'z'.repeat(900)}` }] };
  const { search, asked } = answering(db, () => ({ status: 200, body: { count: 1, results: [later] } }));
  const { result } = await run({ db, search });
  assert.equal(asked.length, 1);
  assert.deepEqual(result, { screened: 1, cleared: 0, held: 1, requests: 1, notifyFailed: 0, stoppedBecause: null });
  const { hold } = db.row(row.cluster_id);
  assert.deepEqual(Object.keys(hold), ['found_at', 'question', 'later', 'passage', 'hits', 'seen']);
  assert.deepEqual([hold.hits, hold.seen], [1, seenLists([999])]);
  assert.deepEqual(hold.later, { case_name: 'Later v. Case', url: 'https://www.courtlistener.com/opinion/999/later-v-case/', court: APPELLATE, date_filed: '2024-02-03' });
  assert.ok(hold.passage.startsWith('the Party rule was overruled z'), hold.passage);
  assert.equal(hold.passage.length, 600);
});

test('the owner is shown the first citing hit with a marked passage, else the first citing hit; the higher court question keeps its first hit', async () => {
  const hit = (id, snippet) => ({ cluster_id: id, absolute_url: `/opinion/${id}/hit-${id}/`, caseName: `Hit ${id} v. Case`, court_id: 'ny', dateFiled: '2024-01-01', opinions: [{ snippet }] });
  const cases = [
    { question: 'cites', results: [hit(1, 'opening text'), hit(2, 'the <mark>Party</mark> rule was <mark>overruled</mark>')], expect: 2 },
    { question: 'cites', results: [hit(3, 'opening text'), hit(4, 'more opening text')], expect: 3 },
    { question: 'caseName', results: [hit(5, 'opening text'), hit(6, 'a <mark>marked</mark> passage')], expect: 5 },
  ];
  for (const { question, results, expect } of cases) {
    const row = decision();
    const db = fakeLibrary([row]);
    const { search } = answering(db, params => (params.q.startsWith(question) ? { status: 200, body: { count: results.length, results } } : { status: 200, body: { count: 0, results: [] } }));
    await run({ db, search });
    const { hold } = db.row(row.cluster_id);
    assert.equal(hold.later.url, `https://www.courtlistener.com/opinion/${expect}/hit-${expect}/`, JSON.stringify(results.map(r => r.cluster_id)));
    assert.equal(hold.passage, plainSnippet(results.find(r => r.cluster_id === expect)));
  }
});

test('each request is counted under the screen before it is sent, and the requests are spaced with nothing waiting before the first', async () => {
  const db = fakeLibrary([decision(), courtOfAppeals()]);
  const { search } = answering(db);
  const { clock } = await run({ db, search });
  assert.deepEqual(db.events, ['count screen 1', 'search', 'count screen 1', 'search', 'count screen 1', 'search']);
  assert.deepEqual(clock.sleeps, [13000, 13000]);
});

test('the run stops at the most requests it may send, before a decision it could not finish, keeping the rows written', async () => {
  const rows = [decision(), decision(), decision()];
  const db = fakeLibrary(rows);
  const { search, asked } = answering(db);
  const { result } = await run({ db, search, maxRequests: 5 });
  assert.equal(asked.length, 4, 'the third decision needs two requests and only one is left');
  assert.deepEqual(result, { screened: 2, cleared: 2, held: 0, requests: 4, notifyFailed: 0, stoppedBecause: null });
  assert.deepEqual(rows.map(row => db.row(row.cluster_id).screen_state), ['clear', 'clear', 'unscreened']);
  assert.equal(db.row(rows[2].cluster_id).screen_tried_at, null, 'the decision not started was not touched');
  const limit = db.queries.find(query => /WHERE opinion_id IS NOT NULL/.test(query.text)).values.at(-1);
  assert.equal(limit, 5, 'no more decisions are asked for than requests may be sent');
});

test('the allowance is asked once, and what it leaves above the reserve caps the run, which then says so', async () => {
  const rows = [courtOfAppeals(), courtOfAppeals(), courtOfAppeals(), courtOfAppeals(), courtOfAppeals()];
  const db = fakeLibrary(rows);
  const { search, asked } = answering(db);
  let allowanceAsked = 0;
  const { result } = await run({ db, search, allowance: async () => { allowanceAsked += 1; return { day: 33, hour: 50, minute: 5 }; } });
  assert.equal(allowanceAsked, 1);
  assert.equal(asked.length, 3);
  assert.deepEqual(result, { screened: 3, cleared: 3, held: 0, requests: 3, notifyFailed: 0, stoppedBecause: 'allowance' });
  assert.equal(db.row(rows[3].cluster_id).screen_state, 'unscreened');
});

test('no request is sent and nothing is read when the allowance has nothing to spare or cannot be read', async () => {
  for (const answer of [{ day: 30, hour: 50, minute: 5 }, { day: 125, hour: 5, minute: 5 }, null]) {
    const db = fakeLibrary([courtOfAppeals()]);
    const { search, asked } = answering(db);
    const { result } = await run({ db, search, allowance: async () => answer });
    assert.deepEqual(result, { screened: 0, cleared: 0, held: 0, requests: 0, notifyFailed: 0, stoppedBecause: 'allowance' }, JSON.stringify(answer));
    assert.equal(asked.length, 0);
    assert.equal(db.queries.length, 0);
  }
});

test('the run stops before a request the time budget has no room for, keeping the rows written', async () => {
  const rows = [courtOfAppeals(), courtOfAppeals(), courtOfAppeals()];
  const db = fakeLibrary(rows);
  const clock = fakeClock();
  const { search, asked } = answering(db, undefined, { clock, costMs: 3000 });
  const { result } = await run({ db, search, clock, budgetMs: 30000, spacingMs: 13000 });
  assert.equal(asked.length, 2);
  assert.deepEqual(result, { screened: 2, cleared: 2, held: 0, requests: 2, notifyFailed: 0, stoppedBecause: 'time' });
  assert.equal(db.row(rows[2].cluster_id).screen_state, 'unscreened');
});

test('by default no request starts later than 235 seconds into the run, leaving a slow answer room inside the job\'s five minutes', async () => {
  const rows = [courtOfAppeals(), courtOfAppeals(), courtOfAppeals()];
  const db = fakeLibrary(rows);
  const clock = fakeClock();
  // The third request is checked at 233 s plus its 13 s spacing, 246 s: inside the old 250 s, outside 235 s.
  const { search, asked } = answering(db, undefined, { clock, costMs: 110000 });
  const { result } = await run({ db, search, clock });
  assert.equal(asked.length, 2);
  assert.equal(result.stoppedBecause, 'time');
});

test('a decision the time budget cuts between its two questions is left as it was', async () => {
  const row = decision();
  const db = fakeLibrary([row]);
  const clock = fakeClock();
  const { search, asked } = answering(db, undefined, { clock, costMs: 10000 });
  const { result } = await run({ db, search, clock, budgetMs: 20000, spacingMs: 13000 });
  assert.equal(asked.length, 1);
  assert.equal(result.stoppedBecause, 'time');
  assert.equal(result.screened, 0);
  assert.deepEqual([db.row(row.cluster_id).screen_state, db.row(row.cluster_id).screened_at, db.row(row.cluster_id).screen_tried_at], ['unscreened', null, null]);
});

test('a refused token or rate (401, 403, 429) stops the run and throws, holding nothing and leaving the decision exactly as it was', async () => {
  for (const status of [401, 403, 429]) {
    const first = courtOfAppeals();
    const second = courtOfAppeals({ screen_tried_at: ago(1) });
    const third = courtOfAppeals();
    const db = fakeLibrary([first, third, second]);
    const { search, asked } = answering(db, params => (params.q.includes(`(${second.opinion_id})`) ? { status, body: null } : { status: 200, body: { count: 0, results: [] } }));
    const mail = fakeMail();
    await rejectsQuietly(run({ db, search, mail }), new RegExp(`^Error: CourtListener answered ${status} to the screen of ${second.cluster_id}; the run stopped$`));
    assert.equal(asked.length, 3, 'no further question was sent');
    assert.equal(db.row(first.cluster_id).screen_state, 'clear', 'the decisions screened before it stay written');
    const refused = db.row(second.cluster_id);
    assert.deepEqual([refused.screen_state, refused.screened_at, refused.screen_tried_at, refused.hold], ['unscreened', null, ago(1), null],
      'even a decision whose last try failed is neither held nor given a new try time');
    assert.equal(mail.sent.length, 0);
  }
});

test('a 429 on a decision being screened again leaves it clear with its old date and its old try time', async () => {
  const old = ago(40);
  const row = courtOfAppeals({ screen_state: 'clear', screened_at: old, screen_tried_at: old });
  const db = fakeLibrary([row]);
  const { search } = answering(db, () => ({ status: 429, body: null }));
  await rejectsQuietly(run({ db, search }), /CourtListener answered 429/);
  assert.deepEqual([db.row(row.cluster_id).screen_state, db.row(row.cluster_id).screened_at, db.row(row.cluster_id).screen_tried_at], ['clear', old, old]);
});

test('no answer or a 5xx on a decision whose last try did not fail records its try, stops the run and throws, holding nothing', async () => {
  for (const status of [0, 503]) {
    const first = courtOfAppeals();
    const second = courtOfAppeals();
    const third = courtOfAppeals();
    const again = courtOfAppeals({ screen_state: 'clear', screened_at: ago(40), screen_tried_at: ago(40) });
    const db = fakeLibrary([first, second, third, again]);
    const { search, asked } = answering(db, params => (params.q.includes(`(${second.opinion_id})`) ? { status, body: null } : { status: 200, body: { count: 0, results: [] } }));
    const mail = fakeMail();
    await rejectsQuietly(run({ db, search, mail }), new RegExp(`^Error: CourtListener answered ${status} to the screen of ${second.cluster_id}; the run stopped$`));
    assert.equal(asked.length, 2, 'no further question was sent');
    assert.equal(db.row(first.cluster_id).screen_state, 'clear', 'the decision screened before it stays written');
    const tried = db.row(second.cluster_id);
    assert.deepEqual([tried.screen_state, tried.screened_at, tried.hold], ['unscreened', null, null]);
    assert.equal(tried.screen_tried_at, new Date(NIGHT + 13000).toISOString());
    assert.equal(db.row(third.cluster_id).screen_tried_at, null);
    assert.equal(mail.sent.length, 0);

    // A clear decision screened again: its first failure keeps it clear with its old date.
    const db2 = fakeLibrary([again]);
    await rejectsQuietly(run({ db: db2, search: answering(db2, () => ({ status, body: null })).search }), new RegExp(`CourtListener answered ${status}`));
    assert.deepEqual([db2.row(again.cluster_id).screen_state, db2.row(again.cluster_id).screened_at], ['clear', ago(40)]);
    assert.equal(db2.row(again.cluster_id).screen_tried_at, new Date(NIGHT).toISOString());
  }
});

test('no answer or a 5xx on a decision whose last try failed holds it as unreadable, emails the owner once, and the run goes on', async () => {
  for (const status of [503, 0]) {
    const repeat = courtOfAppeals({ screen_tried_at: ago(1) });
    const next = courtOfAppeals({ screen_state: 'clear', screened_at: ago(40), screen_tried_at: ago(40) });
    const db = fakeLibrary([repeat, next]);
    const { search, asked } = answering(db, params => (params.q.includes(`(${repeat.opinion_id})`) ? { status, body: null } : { status: 200, body: { count: 0, results: [] } }));
    const { result, mail } = await run({ db, search });
    assert.equal(asked.length, 2, 'the next decision was screened');
    assert.deepEqual(result, { screened: 2, cleared: 1, held: 1, requests: 2, notifyFailed: 0, stoppedBecause: null });
    const { hold, screen_state: state } = db.row(repeat.cluster_id);
    assert.equal(state, 'held');
    assert.deepEqual({ ...hold, found_at: 'x' }, { found_at: 'x', question: 'unreadable', status, later: null, passage: null, seen: seenLists() });
    assert.equal(mail.sent.length, 1);
    assert.match(mail.sent[0].html, /could not read/);
    assert.equal(db.row(next.cluster_id).screen_state, 'clear');
  }
});

test('in an outage where every due decision\'s last try failed, one is held and emailed, and the next stops the run with its try recorded', async () => {
  const rows = [courtOfAppeals({ screen_tried_at: ago(3) }), courtOfAppeals({ screen_tried_at: ago(2) }), courtOfAppeals({ screen_tried_at: ago(1) })];
  const db = fakeLibrary(rows);
  const { search, asked } = answering(db, () => ({ status: 503, body: null }));
  const mail = fakeMail();
  await rejectsQuietly(run({ db, search, mail }), new RegExp(`^Error: CourtListener answered 503 to the screen of ${rows[1].cluster_id}; the run stopped$`));
  assert.equal(asked.length, 2);
  assert.deepEqual(rows.map(row => db.row(row.cluster_id).screen_state), ['held', 'unscreened', 'unscreened']);
  assert.equal(db.row(rows[0].cluster_id).hold.status, 503);
  assert.equal(mail.sent.length, 1);
  assert.equal(db.row(rows[1].cluster_id).screen_tried_at, new Date(NIGHT + 13000).toISOString(), 'the second row\'s try time is set');
  assert.equal(db.row(rows[2].cluster_id).screen_tried_at, ago(1));
});

test('when every search answers 400, one decision is held and emailed, and the next stops the run with its try recorded', async () => {
  const rows = [courtOfAppeals(), courtOfAppeals(), courtOfAppeals()];
  const db = fakeLibrary(rows);
  const { search, asked } = answering(db, () => ({ status: 400, body: { detail: 'bad query' } }));
  const mail = fakeMail();
  await rejectsQuietly(run({ db, search, mail }), new RegExp(`^Error: CourtListener answered 400 to the screen of ${rows[1].cluster_id}; the run stopped$`));
  assert.equal(asked.length, 2);
  assert.deepEqual(rows.map(row => db.row(row.cluster_id).screen_state), ['held', 'unscreened', 'unscreened']);
  assert.deepEqual([db.row(rows[0].cluster_id).hold.question, db.row(rows[0].cluster_id).hold.status], ['unreadable', 400]);
  assert.equal(mail.sent.length, 1);
  assert.equal(db.row(rows[1].cluster_id).screen_tried_at, new Date(NIGHT + 13000).toISOString(), 'the second row\'s try time is set');
  assert.equal(db.row(rows[2].cluster_id).screen_tried_at, null);
});

test('one unreadable hold a run, whatever the status: a 400 held first makes a repeat 503 stop the run', async () => {
  const first = courtOfAppeals();
  const repeat = courtOfAppeals({ screen_tried_at: ago(1) });
  const db = fakeLibrary([first, repeat]);
  const { search } = answering(db, params => (params.q.includes(`(${first.opinion_id})`) ? { status: 400, body: null } : { status: 503, body: null }));
  const mail = fakeMail();
  await rejectsQuietly(run({ db, search, mail }), new RegExp(`^Error: CourtListener answered 503 to the screen of ${repeat.cluster_id}; the run stopped$`));
  assert.deepEqual([db.row(first.cluster_id).screen_state, db.row(repeat.cluster_id).screen_state], ['held', 'unscreened']);
  assert.equal(db.row(repeat.cluster_id).screen_tried_at, new Date(NIGHT + 13000).toISOString());
  assert.equal(mail.sent.length, 1);
});

test('the next night, a decision whose screen failed waits behind one never tried', async () => {
  const failing = courtOfAppeals();
  const waiting = courtOfAppeals();
  const db = fakeLibrary([failing, waiting]);
  const first = answering(db, () => ({ status: 503, body: null }));
  await rejectsQuietly(run({ db, search: first.search }), /CourtListener answered 503/);
  assert.ok(db.row(failing.cluster_id).screen_tried_at, 'its try time is set');
  assert.deepEqual(first.asked.map(params => params.q.match(/\((\d+)\)/)[1]), [failing.opinion_id]);
  const second = answering(db);
  await run({ db, search: second.search, clock: fakeClock(NIGHT + DAY_MS) });
  assert.deepEqual(second.asked.map(params => params.q.match(/\((\d+)\)/)[1]), [waiting.opinion_id, failing.opinion_id]);
});

test('an answer the screen cannot read holds the decision as unreadable, emails the owner, and the run goes on', async () => {
  for (const answer of [{ status: 400, body: { detail: 'bad query' } }, { status: 200, body: { detail: 'no results here' } }, { status: 200, body: null }]) {
    const unreadable = courtOfAppeals();
    const next = courtOfAppeals();
    const db = fakeLibrary([unreadable, next]);
    const { search, asked } = answering(db, params => (params.q.includes(`(${unreadable.opinion_id})`) ? answer : { status: 200, body: { count: 0, results: [] } }));
    const { result, mail } = await run({ db, search });
    assert.equal(asked.length, 2, 'the next decision was screened');
    assert.deepEqual(result, { screened: 2, cleared: 1, held: 1, requests: 2, notifyFailed: 0, stoppedBecause: null });
    const { hold, screen_state: state } = db.row(unreadable.cluster_id);
    assert.equal(state, 'held');
    assert.deepEqual({ ...hold, found_at: 'x' }, { found_at: 'x', question: 'unreadable', status: answer.status, later: null, passage: null, seen: seenLists() });
    assert.equal(mail.sent.length, 1);
    assert.match(mail.sent[0].html, /could not read/);
  }
});

test('one email for each decision newly held, and a second run sends none', async () => {
  const rows = [courtOfAppeals(), courtOfAppeals(), courtOfAppeals()];
  const db = fakeLibrary(rows);
  const later = { cluster_id: 4242, absolute_url: '/opinion/4242/later/', caseName: 'Later v. One', court_id: 'ny', dateFiled: '2025-01-01', opinions: [{ snippet: 'x' }] };
  const hits = params => (params.q.includes(`(${rows[1].opinion_id})`) ? { status: 200, body: { count: 0, results: [] } } : { status: 200, body: { count: 1, results: [later] } });
  const mail = fakeMail();
  await run({ db, search: answering(db, hits).search, mail });
  assert.equal(mail.sent.length, 2);
  assert.ok(mail.sent[0].subject.includes(rows[0].case_name) && mail.sent[1].subject.includes(rows[2].case_name));
  const again = answering(db, hits);
  const { result } = await run({ db, search: again.search, mail, clock: fakeClock(NIGHT + DAY_MS) });
  assert.equal(mail.sent.length, 2, 'no email the second night');
  assert.equal(again.asked.length, 0, 'held and clear decisions are not due');
  assert.deepEqual(result, { screened: 0, cleared: 0, held: 0, requests: 0, notifyFailed: 0, stoppedBecause: null });
});

test('a decision the owner banned or decided while the run went on is not overwritten and no email is sent', async () => {
  const row = courtOfAppeals();
  const db = fakeLibrary([row]);
  const later = { cluster_id: 4243, absolute_url: '/opinion/4243/later/', caseName: 'Later v. Two', opinions: [{ snippet: 'x' }] };
  const { search } = answering(db, () => { db.row(row.cluster_id).screen_state = 'banned'; return { status: 200, body: { count: 1, results: [later] } }; });
  const { result, mail } = await run({ db, search });
  assert.deepEqual(result, { screened: 1, cleared: 0, held: 0, requests: 1, notifyFailed: 0, stoppedBecause: null });
  assert.equal(db.row(row.cluster_id).screen_state, 'banned');
  assert.equal(db.row(row.cluster_id).hold, null);
  assert.equal(mail.sent.length, 0);
});

test('a clear decision screened 31 days ago is screened again; one screened 29 days ago is not', async () => {
  const stale = courtOfAppeals({ screen_state: 'clear', screened_at: new Date(NIGHT - 31 * DAY_MS).toISOString(), screen_tried_at: new Date(NIGHT - 31 * DAY_MS).toISOString() });
  const fresh = courtOfAppeals({ screen_state: 'clear', screened_at: new Date(NIGHT - 29 * DAY_MS).toISOString(), screen_tried_at: new Date(NIGHT - 29 * DAY_MS).toISOString() });
  const db = fakeLibrary([stale, fresh]);
  const { search, asked } = answering(db);
  const { result } = await run({ db, search });
  assert.equal(asked.length, 1);
  assert.ok(asked[0].q.startsWith(`cites:(${stale.opinion_id})`));
  assert.equal(result.cleared, 1);
  assert.equal(db.row(stale.cluster_id).screened_at, new Date(NIGHT).toISOString());
  assert.equal(db.row(fresh.cluster_id).screened_at, new Date(NIGHT - 29 * DAY_MS).toISOString());
});

test('never-screened decisions come before clear ones due again, and a decision with no opinion id is never asked about', async () => {
  const due = courtOfAppeals({ screen_state: 'clear', screened_at: new Date(NIGHT - 40 * DAY_MS).toISOString(), screen_tried_at: new Date(NIGHT - 40 * DAY_MS).toISOString() });
  const fresh = courtOfAppeals();
  const noOpinion = courtOfAppeals({ opinion_id: null });
  const held = courtOfAppeals({ screen_state: 'held' });
  const banned = courtOfAppeals({ screen_state: 'banned' });
  const db = fakeLibrary([due, noOpinion, held, banned, fresh]);
  const { search, asked } = answering(db);
  await run({ db, search });
  assert.deepEqual(asked.map(params => params.q.match(/\((\d+)\)/)[1]), [fresh.opinion_id, due.opinion_id]);
  assert.equal(db.row(noOpinion.cluster_id).screen_state, 'unscreened');
});

test("the email shows the decision, the later decision and the passage, escaped, links only for https addresses, and states no conclusion", async () => {
  const row = courtOfAppeals({ case_name: 'Smith <b>v.</b> Jones & Co.', citations: ['1 N.Y.3d 2', '3 N.E.3d 4'], date_filed: '2001-02-03', url: 'javascript:alert(1)' });
  const db = fakeLibrary([row]);
  const later = { cluster_id: 4244, absolute_url: '/opinion/4244/later-v-three/', caseName: 'Later "v." Three', court: 'New York Court of Appeals', court_id: 'ny', dateFiled: '2024-05-06', opinions: [{ snippet: 'the <mark>Smith</mark> rule & its <mark>overruled</mark> <script>x</script>' }] };
  const { search } = answering(db, () => ({ status: 200, body: { count: 1, results: [later] } }));
  const { mail } = await run({ db, search });
  assert.equal(mail.sent.length, 1);
  const { subject, html } = mail.sent[0];
  assert.ok(subject.startsWith('nycinjury.ai: '), subject);
  assert.ok(subject.includes('Smith <b>v.</b> Jones & Co.'), 'the subject names the decision (a subject is text, not HTML)');
  assert.ok(html.includes('Smith &lt;b&gt;v.&lt;/b&gt; Jones &amp; Co.'), html);
  assert.ok(!html.includes('<b>v.</b>') && !html.includes('<script>'), html);
  assert.ok(html.includes('1 N.Y.3d 2') && html.includes('New York Court of Appeals') && html.includes('2001-02-03'), html);
  assert.ok(!/href="javascript:/.test(html), 'an address that is not https is never a link');
  assert.ok(html.includes('<a href="https://www.courtlistener.com/opinion/4244/later-v-three/">'), html);
  assert.ok(html.includes('Later &quot;v.&quot; Three') && html.includes('2024-05-06'), html);
  assert.ok(html.includes('the Smith rule &amp; its overruled x'), html);
  assert.match(html, /admin page/);
  assert.doesNotMatch(`${subject} ${html}`, /good law/i);
});

test('the higher court email says what the screen found there', async () => {
  const row = decision();
  const db = fakeLibrary([row]);
  const later = { cluster_id: 4245, absolute_url: '/opinion/4245/party-v-other/', caseName: row.case_name, court_id: 'ny', dateFiled: '2021-01-01', opinions: [{ snippet: 'Order reversed.' }] };
  const { search } = answering(db, params => (params.q.startsWith('caseName:') ? { status: 200, body: { count: 1, results: [later] } } : { status: 200, body: { count: 0, results: [] } }));
  const { mail } = await run({ db, search });
  assert.equal(db.row(row.cluster_id).hold.question, 'higher-court');
  assert.match(mail.sent[0].html, /higher court/);
});

test('an email that is not sent is logged and counted, the hold stays, and it is not sent again', async () => {
  for (const sent of [false, new Error('SMTP down')]) {
    const row = courtOfAppeals();
    const db = fakeLibrary([row]);
    const later = { cluster_id: 4246, absolute_url: '/opinion/4246/x/', caseName: 'Later v. Four', opinions: [{ snippet: 'x' }] };
    const { search } = answering(db, () => ({ status: 200, body: { count: 1, results: [later] } }));
    const mail = fakeMail({ sent });
    const { result, logs } = await run({ db, search, mail });
    assert.deepEqual(result, { screened: 1, cleared: 0, held: 1, requests: 1, notifyFailed: 1, stoppedBecause: null });
    assert.equal(db.row(row.cluster_id).screen_state, 'held');
    assert.ok(logs.some(line => line.includes(String(row.cluster_id))), logs.join('\n'));
    await run({ db, search, mail, clock: fakeClock(NIGHT + DAY_MS) });
    assert.equal(mail.sent.length, 1);
  }
});
