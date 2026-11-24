// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The nightly statute watch (statute-watch.js): each watched section and bill read, each new text emailed once, and every
// failure told. A table kept in memory stands in for statute_watch: it runs the statements the module sends and refuses any
// it does not know. Its clock is the moment each run is given, so the next night is simply a later moment. The Senate, the
// table and the email are fakes. Nothing here reaches a network or a database.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { statuteWatch, statuteWatchSummary } from '../statute-watch.js';
import { statuteFingerprint } from '../statute-text.js';

const SITE = 'NYCInjury.ai';
const KEY = 'nysenate-sentinel-key-123';
const NOT_REACHED = "not reached before the run's time ran out";
const TEN_MINUTES = 10 * 60_000;

// The watched sections, each with its approved text.
const SECTIONS = {
  'CPLR-214': { name: 'CPLR § 214', locationId: '214', text: 'S 214. Actions to be commenced within three years: for injury to property or person.\n5. an action to recover damages for a personal injury except as provided in sections 214-b, 214-c and 215;' },
  'CPLR-214-A': { name: 'CPLR § 214-a', locationId: '214-A', text: 'S 214-a. Action for medical, dental or podiatric malpractice to be commenced within two years and six months of the act, omission or failure complained of.' },
  'CPLR-208': { name: 'CPLR § 208', locationId: '208', text: 'S 208. Infancy, insanity. If a person entitled to commence an action is under a disability because of infancy or insanity, the time is extended.' },
  'CPLR-215': { name: 'CPLR § 215', locationId: '215', text: 'S 215. Actions to be commenced within one year: 3. an action to recover damages for assault, battery, false imprisonment, libel or slander.' },
  'CPLR-217': { name: 'CPLR § 217', locationId: '217', text: 'S 217. Proceeding against body or officer; actions complaining about conduct; four months.' },
};
const ALL = Object.keys(SECTIONS);
const SNAPSHOTS = Object.fromEntries(ALL.map(id => [id, SECTIONS[id].text]));
const approved = id => SECTIONS[id].text;
const fingerprintOf = text => statuteFingerprint({ text });
// A change of one word, the last, so that an email shows a word struck through and one underlined.
const amended = (id, word = 'amended') => approved(id).replace(/\S+$/, word);
const CHANGED_214 = approved('CPLR-214').replace('within three years', 'within two years');

function section(id) {
  const { name, locationId, text } = SECTIONS[id];
  return { id, kind: 'section', name, lawId: 'CVP', locationId, url: `https://www.nysenate.gov/legislation/laws/CVP/${locationId}`, fingerprint: fingerprintOf(text), approved_on: '2026-11-14', active_date: '2014-09-22' };
}

const BY_HAND = { id: 'NYCRR-11-65-1.1', kind: 'by_hand', name: '11 NYCRR § 65-1.1', url: 'https://govt.westlaw.com/nycrr/', reviewed_on: '2026-11-14' };

// A small notes file: the sections, a source kept by hand (never read), a note on each section, and the places that state
// CPLR 214. A rule and a place hold characters that must arrive escaped.
function notesFile(ids = ['CPLR-214']) {
  return {
    sources: [...ids.map(section), BY_HAND],
    notes: ids.map(id => ({
      id: `note-${id}`,
      topic: `The deadline of ${SECTIONS[id].name}`,
      rule: id === 'CPLR-214' ? 'Three years from the injury, unless <a shorter period> applies & the claim is against a city' : `The period ${SECTIONS[id].name} sets`,
      sources: [id],
    })),
    register: [
      { file: 'public/index.html', states: '3 years', count: 2, sources: ['CPLR-214'], about: 'the general deadline' },
      { file: 'content/blog/deadlines.md', states: '1 year & 90 days', count: 1, sources: ['CPLR-214'], about: 'beside the deadline against a city' },
      { file: 'ask.js', states: '6 months', count: 1, rule: false, about: 'how long a conversation is kept' },
    ],
  };
}

// The notes file after the owner approved `text` for CPLR 214.
function approvedAs(text) {
  const law = notesFile();
  law.sources[0] = { ...law.sources[0], fingerprint: fingerprintOf(text), approved_on: '2026-11-23' };
  return deepFreeze(law);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const COLUMNS = ['source_id', 'seen_fingerprint', 'seen_text', 'seen_active_date', 'differs_since', 'emailed_fingerprint', 'email_claimed_at',
  'last_checked_at', 'last_read_at', 'unread_since', 'unread_emailed_at', 'last_error'];
const CLAIM_FREE = "(email_claimed_at IS NULL OR email_claimed_at < ?::timestamptz - INTERVAL '10 minutes')";
const DIFFERENCE_CLEARED = 'seen_fingerprint = NULL, seen_text = NULL, seen_active_date = NULL, differs_since = NULL';
const STREAK_CLEARED = 'unread_since = NULL, unread_emailed_at = NULL, last_error = NULL';
const NO_DIFFERENCE = { seen_fingerprint: null, seen_text: null, seen_active_date: null, differs_since: null };
const NO_STREAK = { unread_since: null, unread_emailed_at: null, last_error: null };

// The table, and a client that runs the statements statute-watch.js sends; `sent` keeps each one. A moment is kept as the ISO
// string the module passes, and a day as YYYY-MM-DD. plant() puts a row in by hand; gone(message) makes every statement fail,
// as for a table never made.
function watchTable() {
  const rows = new Map();
  const sent = [];
  let missing = null;
  const blank = id => Object.fromEntries(COLUMNS.map(column => [column, column === 'source_id' ? id : null]));
  // INSERT ... ON CONFLICT (source_id) DO UPDATE: a new row takes `fresh`; an existing one takes what `update` makes of the row
  // as it was, since every expression of an UPDATE reads the old row.
  const upsert = (id, fresh, update) => {
    const old = rows.get(id);
    rows.set(id, old ? { ...old, ...update(old) } : { ...blank(id), ...fresh });
    return [];
  };
  const set = (id, fields) => {
    if (rows.has(id)) Object.assign(rows.get(id), fields);
    return [];
  };
  // A claim is taken only while its email is due and nobody holds the claim, or its holder took it more than ten minutes
  // before this run's moment.
  const claim = (claimAt, id, now, due, returning = row => ({ source_id: row.source_id })) => {
    const row = rows.get(id);
    if (!row || !due(row)) return [];
    if (row.email_claimed_at !== null && Date.parse(row.email_claimed_at) >= Date.parse(now) - TEN_MINUTES) return [];
    row.email_claimed_at = claimAt;
    return [returning(row)];
  };
  const statements = new Map([
    ['SELECT source_id, seen_fingerprint, emailed_fingerprint FROM statute_watch',
      () => [...rows.values()].map(({ source_id, seen_fingerprint, emailed_fingerprint }) => ({ source_id, seen_fingerprint, emailed_fingerprint }))],
    // Read, the same as approved, with no reported difference still to be told back: the difference and its report go.
    ['INSERT INTO statute_watch (source_id, last_checked_at, last_read_at) VALUES (?, ?::timestamptz, ?::timestamptz) ON CONFLICT (source_id) DO UPDATE SET '
      + `last_checked_at = EXCLUDED.last_checked_at, last_read_at = EXCLUDED.last_read_at, ${DIFFERENCE_CLEARED}, emailed_fingerprint = NULL, ${STREAK_CLEARED}`,
    ([id, checked, read]) => upsert(id, { last_checked_at: checked, last_read_at: read },
      () => ({ last_checked_at: checked, last_read_at: read, ...NO_DIFFERENCE, emailed_fingerprint: null, ...NO_STREAK }))],
    // Read, the same as approved, with a reported difference still to be told back: its report stays until that email goes.
    ['INSERT INTO statute_watch (source_id, last_checked_at, last_read_at) VALUES (?, ?::timestamptz, ?::timestamptz) ON CONFLICT (source_id) DO UPDATE SET '
      + `last_checked_at = EXCLUDED.last_checked_at, last_read_at = EXCLUDED.last_read_at, ${DIFFERENCE_CLEARED}, ${STREAK_CLEARED}`,
    ([id, checked, read]) => upsert(id, { last_checked_at: checked, last_read_at: read },
      () => ({ last_checked_at: checked, last_read_at: read, ...NO_DIFFERENCE, ...NO_STREAK }))],
    ['INSERT INTO statute_watch (source_id, seen_fingerprint, seen_text, seen_active_date, differs_since, last_checked_at, last_read_at) '
      + 'VALUES (?, ?, ?, ?, ?::timestamptz, ?::timestamptz, ?::timestamptz) ON CONFLICT (source_id) DO UPDATE SET seen_fingerprint = EXCLUDED.seen_fingerprint, '
      + 'seen_text = EXCLUDED.seen_text, seen_active_date = EXCLUDED.seen_active_date, differs_since = COALESCE(statute_watch.differs_since, EXCLUDED.differs_since), '
      + `last_checked_at = EXCLUDED.last_checked_at, last_read_at = EXCLUDED.last_read_at, ${STREAK_CLEARED}`,
    ([id, fingerprint, text, activeDate, since, checked, read]) => upsert(id,
      { seen_fingerprint: fingerprint, seen_text: text, seen_active_date: activeDate, differs_since: since, last_checked_at: checked, last_read_at: read },
      old => ({ seen_fingerprint: fingerprint, seen_text: text, seen_active_date: activeDate, differs_since: old.differs_since ?? since, last_checked_at: checked, last_read_at: read, ...NO_STREAK }))],
    ['INSERT INTO statute_watch (source_id, last_checked_at, unread_since, last_error) VALUES (?, ?::timestamptz, ?::date, ?) ON CONFLICT (source_id) DO UPDATE SET '
      + 'last_checked_at = EXCLUDED.last_checked_at, unread_since = COALESCE(statute_watch.unread_since, EXCLUDED.unread_since), '
      + 'unread_emailed_at = CASE WHEN statute_watch.unread_since IS NULL THEN NULL ELSE statute_watch.unread_emailed_at END, last_error = EXCLUDED.last_error',
    ([id, checked, day, error]) => upsert(id, { last_checked_at: checked, unread_since: day, last_error: error },
      old => ({ last_checked_at: checked, unread_since: old.unread_since ?? day, unread_emailed_at: old.unread_since === null ? null : old.unread_emailed_at, last_error: error }))],
    [`UPDATE statute_watch SET email_claimed_at = ?::timestamptz WHERE source_id = ? AND seen_fingerprint = ? AND emailed_fingerprint IS DISTINCT FROM ? AND ${CLAIM_FREE} RETURNING source_id`,
      ([claimAt, id, seen, notEmailed, now]) => claim(claimAt, id, now, row => row.seen_fingerprint === seen && row.emailed_fingerprint !== notEmailed)],
    [`UPDATE statute_watch SET email_claimed_at = ?::timestamptz WHERE source_id = ? AND seen_fingerprint IS NULL AND emailed_fingerprint <> ? AND ${CLAIM_FREE} RETURNING source_id`,
      ([claimAt, id, approvedFingerprint, now]) => claim(claimAt, id, now, row => row.seen_fingerprint === null && row.emailed_fingerprint !== null && row.emailed_fingerprint !== approvedFingerprint)],
    [`UPDATE statute_watch SET email_claimed_at = ?::timestamptz WHERE source_id = ? AND unread_since <= ?::date AND unread_emailed_at IS NULL AND ${CLAIM_FREE} `
      + "RETURNING source_id, to_char(unread_since, 'YYYY-MM-DD') AS unread_since",
    ([claimAt, id, onOrBefore, now]) => claim(claimAt, id, now, row => row.unread_since !== null && row.unread_since <= onOrBefore && row.unread_emailed_at === null,
      row => ({ source_id: row.source_id, unread_since: row.unread_since }))],
    // The daily summary's one read: each row's differences, last read and unread day, the day as text, as to_char gives it.
    ["SELECT source_id, differs_since, last_read_at, to_char(unread_since, 'YYYY-MM-DD') AS unread_since FROM statute_watch",
      () => [...rows.values()].map(({ source_id, differs_since, last_read_at, unread_since }) => ({ source_id, differs_since, last_read_at, unread_since }))],
    ['UPDATE statute_watch SET emailed_fingerprint = ?, email_claimed_at = NULL WHERE source_id = ?', ([fingerprint, id]) => set(id, { emailed_fingerprint: fingerprint, email_claimed_at: null })],
    ['UPDATE statute_watch SET emailed_fingerprint = NULL, email_claimed_at = NULL WHERE source_id = ?', ([id]) => set(id, { emailed_fingerprint: null, email_claimed_at: null })],
    ['UPDATE statute_watch SET unread_emailed_at = ?::timestamptz, email_claimed_at = NULL WHERE source_id = ?', ([at, id]) => set(id, { unread_emailed_at: at, email_claimed_at: null })],
    ['UPDATE statute_watch SET email_claimed_at = NULL WHERE source_id = ?', ([id]) => set(id, { email_claimed_at: null })],
  ]);
  const client = async (strings, ...values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    sent.push(text);
    if (missing) throw new Error(missing);
    const run = statements.get(text);
    if (!run) throw new Error(`The fake table does not know the statement: ${text}`);
    return run(values);
  };
  return {
    client, rows, sent,
    row: id => rows.get(id),
    plant(id, fields) { rows.set(id, { ...blank(id), last_checked_at: '2026-11-01T01:00:00.000Z', ...fields }); },
    gone(message = 'relation "statute_watch" does not exist') { missing = message; },
  };
}

// The Senate: each id answers a text (read as that text), a failure, or a function of the read. An id given nothing reads as
// its approved text. `asked` keeps each source read, in order, and `most` the most reads at once.
function senateFake(answers) {
  const senate = { answers: { ...answers }, asked: [], inFlight: 0, most: 0 };
  senate.readSource = async (source, { signal } = {}) => {
    senate.asked.push(source.id);
    senate.inFlight += 1;
    senate.most = Math.max(senate.most, senate.inFlight);
    try {
      let answer = senate.answers[source.id] ?? SECTIONS[source.id]?.text;
      if (typeof answer === 'function') answer = await answer({ source, signal });
      return typeof answer === 'string' ? { ok: true, text: answer, title: '', activeDate: '2026-11-01', repealed: false, repealedDate: null } : answer;
    } finally {
      senate.inFlight -= 1;
    }
  };
  return senate;
}

// The email: `attempts` keeps every call and `sent` the ones that went out. `answer` gives each call's outcome, as
// sendOperatorNotice reports it.
function mailbox() {
  const mail = { attempts: [], sent: [], answer: async () => ({ sent: true }) };
  mail.notify = async (subject, html) => {
    mail.attempts.push({ subject, html });
    const result = await mail.answer(subject, html);
    if (result?.sent === true) mail.sent.push({ subject, html });
    return result;
  };
  return mail;
}

// A run still going after this long has hung. The timer also keeps the process alive: without one, a run left waiting on
// nothing lets the process end quietly, before the remaining tests and with no failure shown.
async function within(ms, running) {
  let timer;
  const hung = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the run had not ended after ${ms} ms`)), ms); });
  try {
    return await Promise.race([running, hung]);
  } finally {
    clearTimeout(timer);
  }
}

function world({ ids = ['CPLR-214'], law = notesFile(ids), answers = {}, snapshots = SNAPSHOTS } = {}) {
  const table = watchTable();
  const senate = senateFake(answers);
  const mail = mailbox();
  const before = structuredClone(law);
  deepFreeze(law);
  const watch = (today, options = {}) => within(10_000, statuteWatch({
    today, sqlClient: table.client, law, snapshotOf: id => snapshots[id] ?? null, readSource: senate.readSource, notify: mail.notify, site: SITE, ...options,
  }));
  return { table, senate, mail, law, before, watch };
}

// Runs fn with the Senate's key set to a sentinel, so that a leak of it anywhere shows; the setting is restored after.
async function withKey(fn) {
  const before = process.env.NYSENATE_API_KEY;
  process.env.NYSENATE_API_KEY = KEY;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.NYSENATE_API_KEY; else process.env.NYSENATE_API_KEY = before;
  }
}
const keyless = text => !String(text).includes(KEY) && !String(text).includes('key=');

// The job runs at 01:00 UTC, the evening before in New York: night n is New York's 2026-11-(21 + n).
const night = n => new Date(Date.UTC(2026, 10, 22 + n, 1));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a section that reads as approved sends nothing and is recorded as read', async () => {
  const { table, senate, mail, watch } = world();
  assert.deepEqual(await watch(night(0)), { checked: 1, same: ['CPLR-214'], differing: [], unread: [], emails: [] });
  assert.deepEqual(mail.attempts, []);
  assert.deepEqual(senate.asked, ['CPLR-214']);
  const row = table.row('CPLR-214');
  assert.equal(row.last_checked_at, night(0).toISOString());
  assert.equal(row.last_read_at, night(0).toISOString());
  for (const column of ['seen_fingerprint', 'seen_text', 'differs_since', 'emailed_fingerprint', 'email_claimed_at', 'unread_since', 'last_error']) assert.equal(row[column], null, column);
});

test('a changed section sends one email with its notes, its places, the marked change, its page and the command', async () => {
  await withKey(async () => {
    const { table, mail, watch } = world({ answers: { 'CPLR-214': CHANGED_214 } });
    assert.deepEqual(await watch(night(0)), { checked: 1, same: [], differing: ['CPLR-214'], unread: [], emails: ['NYCInjury.ai: CPLR § 214 has changed'] });
    assert.equal(mail.attempts.length, 1);
    const { subject, html } = mail.sent[0];
    assert.equal(subject, 'NYCInjury.ai: CPLR § 214 has changed');
    assert.ok(html.includes('The deadline of CPLR § 214'), 'the note\'s topic');
    assert.ok(html.includes('unless &lt;a shorter period&gt; applies &amp; the claim is against a city'), 'the note\'s rule, escaped');
    assert.ok(!html.includes('<a shorter period>'));
    assert.ok(html.includes('public/index.html'));
    assert.ok(html.includes('content/blog/deadlines.md') && html.includes('1 year &amp; 90 days'), 'every place, escaped');
    assert.ok(!html.includes('ask.js'), 'only the places that rest on this source');
    assert.match(html, /<del>three<\/del>/);
    assert.match(html, /<ins>two<\/ins>/);
    assert.ok(html.includes('https://www.nysenate.gov/legislation/laws/CVP/214'));
    assert.ok(html.includes(`npm run law:approve -- CPLR-214 ${fingerprintOf(CHANGED_214)}`));
    assert.ok(html.includes('Until you approve the new text (or, for a repealed section, edit the source and the notes by hand), replies keep using the approved notes. If the rule changed, edit the note and every place listed in the same commit, then push.'));
    assert.ok(keyless(html));
    const row = table.row('CPLR-214');
    assert.equal(row.seen_fingerprint, fingerprintOf(CHANGED_214));
    assert.equal(row.seen_text, CHANGED_214);
    assert.equal(row.seen_active_date, '2026-11-01');
    assert.equal(row.differs_since, night(0).toISOString());
    assert.equal(row.emailed_fingerprint, fingerprintOf(CHANGED_214));
    assert.equal(row.email_claimed_at, null);
    assert.ok(keyless(JSON.stringify([...table.rows.values()])));
  });
});

test('a change email for a section no registered place states says the copy may still state its rule in words', async () => {
  await withKey(async () => {
    const { mail, watch } = world({ ids: ['CPLR-215'], answers: { 'CPLR-215': amended('CPLR-215') } });
    await watch(night(0));
    assert.equal(mail.sent.length, 1);
    assert.ok(mail.sent[0].html.includes('The copy may still state its rule in words'));
    assert.ok(!mail.sent[0].html.includes('No registered place states it.'));
  });
});

test('the same change the next night sends nothing more', async () => {
  const { table, mail, watch } = world({ answers: { 'CPLR-214': CHANGED_214 } });
  await watch(night(0));
  assert.deepEqual(await watch(night(1)), { checked: 1, same: [], differing: ['CPLR-214'], unread: [], emails: [] });
  assert.equal(mail.attempts.length, 1);
  assert.equal(table.row('CPLR-214').differs_since, night(0).toISOString());
  assert.equal(table.row('CPLR-214').last_read_at, night(1).toISOString());
});

test('a send that fails is tried again the next night, once', async () => {
  const { table, mail, watch } = world({ answers: { 'CPLR-214': CHANGED_214 } });
  mail.answer = async () => { throw new Error('the mail server hung up'); };
  assert.deepEqual((await watch(night(0))).emails, []);
  assert.equal(mail.attempts.length, 1);
  assert.equal(table.row('CPLR-214').emailed_fingerprint, null);
  assert.equal(table.row('CPLR-214').email_claimed_at, null);
  mail.answer = async () => ({ sent: true });
  assert.deepEqual((await watch(night(1))).emails, ['NYCInjury.ai: CPLR § 214 has changed']);
  assert.deepEqual((await watch(night(2))).emails, []);
  assert.equal(mail.attempts.length, 2);
  assert.equal(mail.sent.length, 1);
});

test('a send reported as not sent counts as not sent', async () => {
  for (const answer of [{ sent: false, reason: 'the mail settings are not set' }, undefined, {}, { sent: 'yes' }]) {
    const { table, mail, watch } = world({ answers: { 'CPLR-214': CHANGED_214 } });
    mail.answer = async () => answer;
    assert.deepEqual((await watch(night(0))).emails, [], JSON.stringify(answer));
    assert.equal(table.row('CPLR-214').emailed_fingerprint, null, JSON.stringify(answer));
    assert.equal(table.row('CPLR-214').email_claimed_at, null, JSON.stringify(answer));
    mail.answer = async () => ({ sent: true });
    assert.deepEqual((await watch(night(1))).emails, ['NYCInjury.ai: CPLR § 214 has changed'], JSON.stringify(answer));
    assert.deepEqual((await watch(night(2))).emails, [], JSON.stringify(answer));
    assert.equal(mail.sent.length, 1, JSON.stringify(answer));
  }
});

test('two runs at once send one email', async () => {
  // Two runs that overlap: both read the row before either claims, and the first to claim holds the email while it is sent.
  const overlapping = world({ answers: { 'CPLR-214': async () => { await delay(5); return CHANGED_214; } } });
  overlapping.mail.answer = async () => { await delay(20); return { sent: true }; };
  const both = await Promise.all([overlapping.watch(night(0)), overlapping.watch(night(0))]);
  assert.equal(overlapping.mail.attempts.length, 1);
  assert.deepEqual(both.flatMap(result => result.emails), ['NYCInjury.ai: CPLR § 214 has changed']);
  assert.equal(overlapping.table.row('CPLR-214').emailed_fingerprint, fingerprintOf(CHANGED_214));
  assert.equal(overlapping.table.row('CPLR-214').email_claimed_at, null);

  // A run that read the row before another run sent the email and marked it, and claims only afterwards, sends nothing: what is
  // still to be sent is decided in the claim, against the row as it is then.
  const late = world({ answers: { 'CPLR-214': CHANGED_214 } });
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const held = late.watch(night(0), { readSource: async source => { await gate; return late.senate.readSource(source); } });
  // Should an assertion below fail first, the held run's later failure must not go unhandled and end the whole process.
  held.catch(() => {});
  assert.deepEqual((await late.watch(night(0))).emails, ['NYCInjury.ai: CPLR § 214 has changed']);
  open();
  const second = await held;
  assert.deepEqual(second.differing, ['CPLR-214']);
  assert.deepEqual(second.emails, []);
  assert.equal(late.mail.attempts.length, 1);
});

test('four new differences in one night go in one combined email, and each is marked emailed', async () => {
  const four = ['CPLR-214', 'CPLR-214-A', 'CPLR-208', 'CPLR-215'];
  const changes = Object.fromEntries(four.map(id => [id, amended(id)]));
  const { table, mail, watch } = world({ ids: four, answers: changes });
  assert.deepEqual((await watch(night(0))).emails, ['NYCInjury.ai: 4 watched statutes have changed']);
  assert.equal(mail.attempts.length, 1);
  const { html } = mail.sent[0];
  for (const id of four) {
    assert.ok(html.includes(`npm run law:approve -- ${id} ${fingerprintOf(changes[id])}`), id);
    assert.ok(html.includes(`https://www.nysenate.gov/legislation/laws/CVP/${SECTIONS[id].locationId}`), id);
    assert.equal(table.row(id).emailed_fingerprint, fingerprintOf(changes[id]), id);
    assert.equal(table.row(id).email_claimed_at, null, id);
  }
  assert.ok(html.includes('The deadline of CPLR § 215'));
  assert.ok(html.includes('Until you approve the new text (or, for a repealed section, edit the source and the notes by hand), replies keep using the approved notes.'));
  assert.deepEqual((await watch(night(1))).emails, []);

  // Three are still one email each.
  const three = four.slice(0, 3);
  const fewer = world({ ids: three, answers: changes });
  assert.deepEqual((await fewer.watch(night(0))).emails, three.map(id => `NYCInjury.ai: ${SECTIONS[id].name} has changed`));
});

test('the budget covers the sends: an email not sent in time goes the next night', async () => {
  const two = ['CPLR-214', 'CPLR-214-A'];
  const { table, mail, watch } = world({ ids: two, answers: { 'CPLR-214': CHANGED_214, 'CPLR-214-A': amended('CPLR-214-A') } });
  // The first email takes longer than the whole budget. It was started in time, so it is waited for and counts; the second is
  // never started.
  mail.answer = async () => { await delay(300); return { sent: true }; };
  assert.deepEqual((await watch(night(0), { budgetMs: 150 })).emails, ['NYCInjury.ai: CPLR § 214 has changed']);
  assert.equal(mail.attempts.length, 1);
  assert.equal(table.row('CPLR-214').emailed_fingerprint, fingerprintOf(CHANGED_214));
  assert.equal(table.row('CPLR-214-A').emailed_fingerprint, null);
  assert.equal(table.row('CPLR-214-A').email_claimed_at, null);
  mail.answer = async () => ({ sent: true });
  assert.deepEqual((await watch(night(1))).emails, ['NYCInjury.ai: CPLR § 214-a has changed']);
  assert.equal(mail.attempts.length, 2);
});

test('a second change while the first is pending sends a second email and keeps the first date', async () => {
  const { table, senate, mail, watch } = world({ answers: { 'CPLR-214': CHANGED_214 } });
  await watch(night(0));
  const again = CHANGED_214.replace('personal injury', 'bodily injury');
  senate.answers['CPLR-214'] = again;
  assert.deepEqual((await watch(night(1))).emails, ['NYCInjury.ai: CPLR § 214 has changed']);
  assert.equal(mail.sent.length, 2);
  // The second email compares the approved text with the newest, so both changes are marked.
  assert.match(mail.sent[1].html, /<del>three<\/del>/);
  assert.match(mail.sent[1].html, /<del>personal<\/del>/);
  assert.ok(mail.sent[1].html.includes(`npm run law:approve -- CPLR-214 ${fingerprintOf(again)}`));
  const row = table.row('CPLR-214');
  assert.equal(row.differs_since, night(0).toISOString());
  assert.equal(row.seen_fingerprint, fingerprintOf(again));
  assert.equal(row.emailed_fingerprint, fingerprintOf(again));
});

test('a text back to the approved one says so once; an approved change clears silently', async () => {
  // Back, after the change was emailed: one short email, then nothing.
  const back = world({ answers: { 'CPLR-214': CHANGED_214 } });
  await back.watch(night(0));
  back.senate.answers['CPLR-214'] = approved('CPLR-214');
  assert.deepEqual(await back.watch(night(1)), { checked: 1, same: ['CPLR-214'], differing: [], unread: [], emails: ['NYCInjury.ai: CPLR § 214 is back to the approved text'] });
  assert.ok(back.mail.sent[1].html.includes('https://www.nysenate.gov/legislation/laws/CVP/214'));
  for (const column of ['seen_fingerprint', 'seen_text', 'differs_since', 'emailed_fingerprint', 'email_claimed_at']) assert.equal(back.table.row('CPLR-214')[column], null, column);
  assert.deepEqual((await back.watch(night(2))).emails, []);
  assert.equal(back.mail.attempts.length, 2);

  // A "back" email that does not go out is tried again the next night, once.
  const retried = world({ answers: { 'CPLR-214': CHANGED_214 } });
  await retried.watch(night(0));
  retried.senate.answers['CPLR-214'] = approved('CPLR-214');
  retried.mail.answer = async () => ({ sent: false, reason: 'the send failed: 421 try again later' });
  assert.deepEqual((await retried.watch(night(1))).emails, []);
  retried.mail.answer = async () => ({ sent: true });
  assert.deepEqual((await retried.watch(night(2))).emails, ['NYCInjury.ai: CPLR § 214 is back to the approved text']);
  assert.deepEqual((await retried.watch(night(3))).emails, []);

  // Approved: the notes file now holds the fingerprint of the text the watch saw, so the next read is the same and says nothing.
  const approvedNow = world({ answers: { 'CPLR-214': CHANGED_214 } });
  await approvedNow.watch(night(0));
  const afterApproval = { law: approvedAs(CHANGED_214), snapshotOf: id => (id === 'CPLR-214' ? CHANGED_214 : null) };
  assert.deepEqual(await approvedNow.watch(night(1), afterApproval), { checked: 1, same: ['CPLR-214'], differing: [], unread: [], emails: [] });
  assert.equal(approvedNow.table.row('CPLR-214').seen_fingerprint, null);
  assert.equal(approvedNow.table.row('CPLR-214').emailed_fingerprint, null);
  assert.deepEqual((await approvedNow.watch(night(2), afterApproval)).emails, []);
  assert.equal(approvedNow.mail.attempts.length, 1);

  // One change emailed, then a second whose email did not go out, and the owner approved the second (from law:check): the
  // approval wins, though the owner was last emailed another text, that night and the next.
  const overtaken = world({ answers: { 'CPLR-214': CHANGED_214 } });
  await overtaken.watch(night(0));
  const again = CHANGED_214.replace('personal injury', 'bodily injury');
  overtaken.senate.answers['CPLR-214'] = again;
  overtaken.mail.answer = async () => ({ sent: false, reason: 'the mail settings are not set' });
  await overtaken.watch(night(1));
  overtaken.mail.answer = async () => ({ sent: true });
  const later = { law: approvedAs(again), snapshotOf: id => (id === 'CPLR-214' ? again : null) };
  assert.deepEqual((await overtaken.watch(night(2), later)).emails, []);
  assert.deepEqual((await overtaken.watch(night(3), later)).emails, []);
  assert.equal(overtaken.mail.sent.length, 1);

  // A difference that was never emailed clears silently when the text goes back.
  const unreported = world({ answers: { 'CPLR-214': CHANGED_214 } });
  unreported.mail.answer = async () => ({ sent: false, reason: 'the mail settings are not set' });
  await unreported.watch(night(0));
  unreported.mail.answer = async () => ({ sent: true });
  unreported.senate.answers['CPLR-214'] = approved('CPLR-214');
  assert.deepEqual((await unreported.watch(night(1))).emails, []);
  assert.equal(unreported.table.row('CPLR-214').seen_fingerprint, null);
  assert.deepEqual((await unreported.watch(night(2))).emails, []);
  assert.equal(unreported.mail.sent.length, 0);
});

test('a read failure is never a change, and the third day of failures sends one email', async () => {
  await withKey(async () => {
    // CPLR 214-a reads every night, so the run as a whole has read something and does not fail.
    const failing = { ok: false, reason: `connect failed for https://legislation.nysenate.gov/api/3/laws/CVP/214?key=${KEY}` };
    const { table, senate, mail, watch } = world({ ids: ['CPLR-214', 'CPLR-214-A'], answers: { 'CPLR-214': failing } });
    for (const n of [0, 1]) {
      assert.deepEqual(await watch(night(n)), { checked: 2, same: ['CPLR-214-A'], differing: [], unread: ['CPLR-214'], emails: [] }, `night ${n}`);
    }
    const row = table.row('CPLR-214');
    // The streak began on New York's day of the first failure: 01:00 UTC on 22 November is the evening of the 21st there.
    assert.equal(row.unread_since, '2026-11-21');
    assert.equal(row.seen_fingerprint, null);
    assert.equal(row.differs_since, null);
    assert.ok(row.last_error && keyless(row.last_error), row.last_error);
    assert.deepEqual((await watch(night(2))).emails, ['NYCInjury.ai: CPLR § 214 could not be read for three days']);
    const { html } = mail.sent[0];
    assert.ok(html.includes('2026-11-21'));
    assert.ok(html.includes(row.last_error));
    assert.ok(keyless(html));
    assert.ok(table.row('CPLR-214').unread_emailed_at);
    assert.deepEqual((await watch(night(3))).emails, []);
    senate.answers['CPLR-214'] = approved('CPLR-214');
    assert.deepEqual((await watch(night(4))).same, ['CPLR-214', 'CPLR-214-A']);
    const cleared = table.row('CPLR-214');
    assert.equal(cleared.unread_since, null);
    assert.equal(cleared.unread_emailed_at, null);
    assert.equal(cleared.last_error, null);
    assert.equal(mail.attempts.length, 1);
  });
});

test('a repealed section is a change that says so', async () => {
  const repealed = { ok: true, text: '', title: 'Repealed', activeDate: '2026-05-26', repealed: true, repealedDate: '2026-05-26' };
  const { table, mail, watch } = world({ answers: { 'CPLR-214': repealed } });
  const result = await watch(night(0));
  assert.deepEqual(result.differing, ['CPLR-214']);
  assert.deepEqual(result.emails, ['NYCInjury.ai: CPLR § 214 has changed']);
  const { html } = mail.sent[0];
  assert.match(html, /repealed on 2026-05-26/);
  // law approve refuses a repealed text, so the email offers no command that would be refused: the notes are edited by hand.
  assert.doesNotMatch(html, /npm run law:approve --/);
  assert.match(html, /by hand/);
  assert.equal(table.row('CPLR-214').emailed_fingerprint, statuteFingerprint(repealed));
});

test('a section gone from its law is one change that says so, and the next night says nothing more', async () => {
  const gone = { ok: true, text: approved('CPLR-214'), title: '', activeDate: '2014-09-22', repealed: true, repealedDate: null, gone: true };
  const { table, mail, watch } = world({ answers: { 'CPLR-214': gone } });
  const first = await watch(night(0));
  assert.deepEqual(first.differing, ['CPLR-214']);
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].subject, 'NYCInjury.ai: CPLR § 214 has changed');
  assert.match(mail.sent[0].html, /no longer in its law's current text/);
  assert.match(mail.sent[0].html, /The Senate gives no date/);
  assert.doesNotMatch(mail.sent[0].html, /npm run law:approve --/);
  assert.equal(table.row('CPLR-214').emailed_fingerprint, statuteFingerprint(gone));
  await watch(night(1));
  assert.equal(mail.sent.length, 1);
});

test('sources not reached before the budget are recorded unread', async () => {
  // One read at a time. CPLR 214 answers at once. CPLR 214-a never answers and pays no heed to its signal, so it is still in
  // flight when the reads' time ends (75 ms into a 100 ms budget, whose last quarter is kept for the notices); it is stopped and
  // counts as not reached, the same as the three after it, which are never started.
  const signals = [];
  const hung = ({ signal }) => { signals.push(signal); return new Promise(() => {}); };
  const { table, senate, watch } = world({ ids: ALL, answers: { 'CPLR-214-A': hung } });
  const started = Date.now();
  const result = await watch(night(0), { budgetMs: 100, concurrency: 1 });
  assert.ok(Date.now() - started < 5000, 'the run ends when its time does');
  assert.deepEqual(result, { checked: 5, same: ['CPLR-214'], differing: [], unread: ['CPLR-214-A', 'CPLR-208', 'CPLR-215', 'CPLR-217'], emails: [] });
  assert.deepEqual(senate.asked, ['CPLR-214', 'CPLR-214-A']);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true, 'the read in flight was told to stop');
  for (const id of ['CPLR-214-A', 'CPLR-208', 'CPLR-215', 'CPLR-217']) {
    assert.equal(table.row(id).last_error, NOT_REACHED, id);
    assert.equal(table.row(id).unread_since, '2026-11-21', id);
    assert.equal(table.row(id).seen_fingerprint, null, id);
  }
});

test('no read starts after the reads are stopped, even when Date.now() is a little behind the timer', async () => {
  // The abort timer runs on the monotonic clock and Date.now() on the wall clock, and the timer can fire a millisecond or so
  // before Date.now() reaches the end of the reads' time. From 60 ms in, Date.now() reads 25 ms behind: the abort at 75 ms
  // then comes while Date.now() still reads 50, short of the end. No worker may start a read on that.
  const signals = [];
  const hung = ({ signal }) => { signals.push(signal); return new Promise(() => {}); };
  const { senate, watch } = world({ ids: ALL, answers: { 'CPLR-214-A': hung } });
  const realNow = Date.now;
  const begin = realNow();
  Date.now = () => { const real = realNow(); return real - begin >= 60 ? real - 25 : real; };
  let result;
  try {
    result = await watch(night(0), { budgetMs: 100, concurrency: 1 });
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(result.unread, ['CPLR-214-A', 'CPLR-208', 'CPLR-215', 'CPLR-217']);
  assert.deepEqual(senate.asked, ['CPLR-214', 'CPLR-214-A']);
  assert.equal(signals.length, 1);
});

test('reads that never end stop where the notices\' share of the budget begins, so the third day\'s combined email still goes', async () => {
  // Five sources, four read at a time. On the first two New York days of the streak every read fails at once. On the third
  // every read hangs until its signal stops it, as a Senate that takes each request and never answers would. The reads are
  // stopped when the last quarter of the 1200 ms budget begins, and the one email for all five goes in that quarter. The run
  // then fails, since nothing was read.
  const { table, senate, mail, watch } = world({ ids: ALL });
  senate.answers = Object.fromEntries(ALL.map(id => [id, { ok: false, reason: 'status 503' }]));
  for (const n of [0, 1]) await assert.rejects(watch(night(n)), /could be read/, `night ${n}`);
  assert.deepEqual(mail.attempts, []);
  const signals = [];
  const untilStopped = ({ signal }) => {
    signals.push(signal);
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ ok: false, reason: 'the request failed' }), { once: true }));
  };
  senate.answers = Object.fromEntries(ALL.map(id => [id, untilStopped]));
  await assert.rejects(watch(night(2), { budgetMs: 1200 }), /could be read/);
  assert.deepEqual(mail.sent.map(({ subject }) => subject), ['NYCInjury.ai: 5 watched statutes could not be read for three days']);
  assert.equal(signals.length, 4, 'four reads were in flight, and the fifth was never started');
  assert.ok(signals.every(signal => signal.aborted), 'every read in flight was told to stop');
  assert.match(mail.sent[0].html, /since 2026-11-21/);
  for (const id of ALL) {
    assert.equal(table.row(id).last_error, NOT_REACHED, id);
    assert.equal(table.row(id).unread_since, '2026-11-21', id);
    assert.ok(table.row(id).unread_emailed_at, id);
    assert.equal(table.row(id).email_claimed_at, null, id);
  }
});

test('a run that reads nothing at all fails, after recording every source', async () => {
  await withKey(async () => {
    const answers = { 'CPLR-214': { ok: false, reason: 'status 401' }, 'CPLR-214-A': { ok: false, reason: `the request failed: key=${KEY}` } };
    const { table, mail, watch } = world({ ids: ['CPLR-214', 'CPLR-214-A'], answers });
    await assert.rejects(watch(night(0)), error => {
      assert.match(error.message, /could be read/);
      assert.match(error.message, /status 401/);
      assert.ok(keyless(error.message), error.message);
      return true;
    });
    for (const id of ['CPLR-214', 'CPLR-214-A']) {
      assert.equal(table.row(id).unread_since, '2026-11-21', id);
      assert.equal(table.row(id).last_checked_at, night(0).toISOString(), id);
      assert.ok(keyless(table.row(id).last_error), id);
    }
    assert.equal(table.row('CPLR-214').last_error, 'status 401');
    assert.deepEqual(mail.attempts, []);
  });
});

test('a missing table fails the run with a message naming npm run setup-db', async () => {
  await withKey(async () => {
    const { table, senate, mail, watch } = world();
    table.gone(`relation "statute_watch" does not exist (the address was postgres://user:pass@db.example.test/neondb?key=${KEY})`);
    await assert.rejects(watch(night(0)), error => {
      assert.match(error.message, /npm run setup-db/);
      assert.match(error.message, /statute_watch/);
      assert.ok(keyless(error.message), error.message);
      return true;
    });
    // It fails before anything is read, so a broken table costs no request to the Senate.
    assert.deepEqual(senate.asked, []);
    assert.deepEqual(mail.attempts, []);
  });
});

test('the law object is unchanged after any run', async () => {
  // The world's notes file is frozen, so a write to it would fail the run, and it is compared with a copy taken before. The
  // nights take every path: one change, four at once, texts back to the approved ones, a repeal, an unread streak to its
  // email, and a run whose time is gone before it reads.
  const { law, before, senate, watch } = world({ ids: ALL });
  const nights = [
    { 'CPLR-214': CHANGED_214 },
    Object.fromEntries(['CPLR-214', 'CPLR-214-A', 'CPLR-208', 'CPLR-215'].map(id => [id, amended(id)])),
    { 'CPLR-208': { ok: false, reason: 'status 500' }, 'CPLR-217': { ok: true, text: '', activeDate: null, repealed: true, repealedDate: '2026-11-20' } },
    { 'CPLR-208': { ok: false, reason: 'status 500' } },
    { 'CPLR-208': { ok: false, reason: 'status 500' } },
  ];
  for (const [n, answers] of nights.entries()) {
    senate.answers = answers;
    await watch(night(n));
    assert.deepEqual(law, before, `night ${n}`);
  }
  await assert.rejects(watch(night(nights.length), { budgetMs: 0 }), /could be read/);
  assert.deepEqual(law, before);
});

test('a run with no reader, or with no section or bill to watch, fails before anything is read or written', async () => {
  const { table, senate, watch } = world();
  await assert.rejects(watch(night(0), { readSource: undefined }), /NYSENATE_API_KEY/);
  await assert.rejects(watch(night(0), { law: deepFreeze({ sources: [BY_HAND], notes: [], register: [] }) }), /no sections or bills to watch in the notes file/);
  await assert.rejects(watch(night(0), { law: deepFreeze({}) }), /no sections or bills to watch in the notes file/);
  assert.deepEqual(table.sent, []);
  assert.deepEqual(senate.asked, []);
});

test('more than three of a kind go in one email for each kind: back to the approved text, and unread on the third day', async () => {
  const four = ['CPLR-214', 'CPLR-214-A', 'CPLR-208', 'CPLR-215'];
  const { table, senate, mail, watch } = world({ ids: four, answers: Object.fromEntries(four.map(id => [id, amended(id)])) });
  assert.deepEqual((await watch(night(0))).emails, ['NYCInjury.ai: 4 watched statutes have changed']);
  senate.answers = {};
  assert.deepEqual((await watch(night(1))).emails, ['NYCInjury.ai: 4 watched statutes are back to the approved text']);
  for (const id of four) assert.ok(mail.sent[1].html.includes(`https://www.nysenate.gov/legislation/laws/CVP/${SECTIONS[id].locationId}"`), id);
  // An outage, or a key the Senate no longer takes: nothing reads on three New York days. Each run fails, and the third day
  // sends one email for all four.
  senate.answers = Object.fromEntries(four.map(id => [id, { ok: false, reason: 'status 403' }]));
  for (const n of [2, 3, 4, 5]) await assert.rejects(watch(night(n)), /could be read/, `night ${n}`);
  assert.deepEqual(mail.sent.map(({ subject }) => subject), [
    'NYCInjury.ai: 4 watched statutes have changed',
    'NYCInjury.ai: 4 watched statutes are back to the approved text',
    'NYCInjury.ai: 4 watched statutes could not be read for three days',
  ]);
  assert.match(mail.sent[2].html, /since 2026-11-23/);
  assert.match(mail.sent[2].html, /status 403/);
  for (const id of four) assert.ok(table.row(id).unread_emailed_at, id);
  assert.equal(mail.attempts.length, 3);
});

test('a claim another run holds keeps the email back, and one taken more than ten minutes before has lapsed', async () => {
  const { table, mail, watch } = world({ answers: { 'CPLR-214': CHANGED_214 } });
  // A run that claimed the email nine minutes ago, and may still be sending it.
  table.plant('CPLR-214', { email_claimed_at: new Date(night(0) - 9 * 60_000).toISOString() });
  assert.deepEqual((await watch(night(0))).emails, []);
  assert.deepEqual(mail.attempts, []);
  // A run that died after claiming it, more than ten minutes ago: the claim has lapsed and the email goes.
  table.row('CPLR-214').email_claimed_at = new Date(night(0) - TEN_MINUTES - 1000).toISOString();
  assert.deepEqual((await watch(night(0))).emails, ['NYCInjury.ai: CPLR § 214 has changed']);
  assert.equal(table.row('CPLR-214').email_claimed_at, null);
});

test('no more than `concurrency` sources are read at once', async () => {
  const slow = Object.fromEntries(ALL.map(id => [id, async () => { await delay(10); return approved(id); }]));
  const two = world({ ids: ALL, answers: slow });
  assert.deepEqual((await two.watch(night(0), { concurrency: 2 })).same, ALL);
  assert.equal(two.senate.most, 2);
  const four = world({ ids: ALL, answers: slow });
  assert.deepEqual((await four.watch(night(0))).same, ALL);
  assert.equal(four.senate.most, 4);
});

test('a changed section with no approved text saved shows the new text whole, escaped, and says so', async () => {
  const text = `${CHANGED_214}\n6. an action under <a new subdivision> & its rules`;
  const { mail, watch } = world({ answers: { 'CPLR-214': text }, snapshots: {} });
  assert.deepEqual((await watch(night(0))).emails, ['NYCInjury.ai: CPLR § 214 has changed']);
  const { html } = mail.sent[0];
  assert.match(html, /No approved text was saved/);
  assert.ok(html.includes('under &lt;a new subdivision&gt; &amp; its rules'));
  assert.doesNotMatch(html, /<del>|<ins>/);
  assert.ok(html.includes(`npm run law:approve -- CPLR-214 ${fingerprintOf(text)}`));
});

test('a reader that throws, or answers with no text, leaves its source unread, and a thrown error is not quoted', async () => {
  await withKey(async () => {
    const thrown = () => { throw new Error(`fetch failed for https://legislation.nysenate.gov/api/3/laws/CVP/214?key=${KEY}`); };
    const empty = { ok: true, text: ' \n ', title: '', activeDate: null, repealed: false, repealedDate: null };
    const { table, watch } = world({ ids: ['CPLR-214', 'CPLR-214-A', 'CPLR-208'], answers: { 'CPLR-214': thrown, 'CPLR-214-A': empty } });
    const result = await watch(night(0));
    assert.deepEqual(result.unread, ['CPLR-214', 'CPLR-214-A']);
    assert.deepEqual(result.same, ['CPLR-208']);
    assert.deepEqual(result.differing, []);
    assert.ok(keyless(table.row('CPLR-214').last_error));
    assert.doesNotMatch(table.row('CPLR-214').last_error, /fetch failed|nysenate/);
    assert.match(table.row('CPLR-214-A').last_error, /no text/);
    // A reader that throws before it gives back a promise leaves its source unread the same way.
    const sync = world({ ids: ['CPLR-214', 'CPLR-214-A'] });
    const reader = source => { if (source.id === 'CPLR-214') throw new Error('boom'); return sync.senate.readSource(source); };
    assert.deepEqual((await sync.watch(night(0), { readSource: reader })).unread, ['CPLR-214']);
  });
});

test('a bill is watched as a section is, and a source kept by hand is never read', async () => {
  const VETOED = 'Vetoed (VETOED) on 2025-12-05\nsigned: no';
  const SIGNED = 'Signed by the governor (SIGNED_BY_GOV) on 2026-11-20\nsigned: yes';
  const bill = { id: 'BILL-2025-S1234', kind: 'bill', name: 'Senate bill S1234 of 2025', session: 2025, printNo: 'S1234', url: 'https://www.nysenate.gov/legislation/bills/2025/S1234', fingerprint: fingerprintOf(VETOED), approved_on: '2026-11-14', active_date: '2025-12-05' };
  const law = { sources: [BY_HAND, bill], notes: [{ id: 'gfa', topic: 'The Grieving Families Act', rule: 'Vetoed: the older wrongful-death rules apply', sources: [bill.id] }], register: [] };
  const { senate, mail, watch } = world({ law, answers: { [bill.id]: SIGNED }, snapshots: { [bill.id]: VETOED } });
  assert.deepEqual(await watch(night(0)), { checked: 1, same: [], differing: [bill.id], unread: [], emails: ['NYCInjury.ai: Senate bill S1234 of 2025 has changed'] });
  assert.deepEqual(senate.asked, [bill.id]);
  const { html } = mail.sent[0];
  assert.match(html, /<del>Vetoed/);
  assert.ok(html.includes('The Grieving Families Act'));
  assert.ok(html.includes(`npm run law:approve -- ${bill.id} ${fingerprintOf(SIGNED)}`));
});

// The daily summary. Its moment is 7 in the morning in New York on 23 November 2026.
const SUMMARY_DAY = new Date(Date.UTC(2026, 10, 23, 12));
const hoursBefore = hours => new Date(SUMMARY_DAY.getTime() - hours * 3_600_000);
const newYorkTime = moment => moment.toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
const daysBefore = days => new Date(Date.UTC(2026, 10, 23 - days)).toISOString().slice(0, 10);
const summaryOf = (w, lastRun, options = {}) => statuteWatchSummary({ sqlClient: w.table.client, law: w.law, today: SUMMARY_DAY, lastRun, ...options });

test('the summary says the watch has not run yet, ran, failed, or is late', async () => {
  const w = world({ ids: ['CPLR-214', 'CPLR-214-A', 'CPLR-208'] });
  assert.match(await summaryOf(w, null), /The statute watch has not run yet\./);
  // 25 hours old is a run; 26 is a night missed.
  const ran = hoursBefore(25);
  const html = await summaryOf(w, { ranAt: ran, ok: true });
  assert.ok(html.includes(`The statute watch ran at ${newYorkTime(ran)}, 25 hours before this summary.`));
  assert.doesNotMatch(html, /has not run/);
  const late = hoursBefore(26);
  const lateHtml = await summaryOf(w, { ranAt: late, ok: true });
  assert.ok(lateHtml.includes(`The statute watch has not run since ${newYorkTime(late)}.`));
  assert.doesNotMatch(lateHtml, /It read/);
  // A run that failed says so, and does not claim a count.
  const failedAt = hoursBefore(3);
  const failed = await summaryOf(w, { ranAt: failedAt, ok: false });
  assert.ok(failed.includes(`The statute watch's last run, at ${newYorkTime(failedAt)}, failed: the owner was emailed the failed step.`));
  assert.doesNotMatch(failed, /It read/);
  // The count is of the sections read in the 26 hours before the summary, out of the sections and bills the law watches.
  w.table.plant('CPLR-214', { last_read_at: hoursBefore(2).toISOString() });
  w.table.plant('CPLR-214-A', { last_read_at: hoursBefore(25).toISOString() });
  w.table.plant('CPLR-208', { last_read_at: hoursBefore(27).toISOString() });
  assert.ok((await summaryOf(w, { ranAt: hoursBefore(6), ok: true })).includes('It read 2 of the 3 watched sections.'));
  // Nothing is written to the table, and the law is untouched.
  assert.deepEqual(w.law, w.before);
});

test('the summary lists each section that differs, with its date and days', async () => {
  const w = world({ ids: ['CPLR-214', 'CPLR-214-A', 'CPLR-208'] });
  const run = { ranAt: hoursBefore(6), ok: true };
  // Nothing differs: no such lines.
  assert.doesNotMatch(await summaryOf(w, run), /differ/);
  // One differs, and the days are New York's: 03:00 UTC on 22 November is the evening of the 21st there.
  w.table.plant('CPLR-214', { differs_since: '2026-11-18T15:00:00.000Z' });
  assert.match(await summaryOf(w, run), /1 watched section differs from the approved text:.*CPLR § 214 since Nov 18, 2026 \(5 days\)/s);
  w.table.plant('CPLR-214-A', { differs_since: '2026-11-22T03:00:00.000Z', seen_fingerprint: 'x', emailed_fingerprint: null });
  // A row for a source the law no longer holds is skipped, and so is a row that differs from nothing.
  w.table.plant('CPLR-GONE', { differs_since: '2026-11-01T15:00:00.000Z' });
  w.table.plant('CPLR-208', { last_read_at: hoursBefore(2).toISOString() });
  const html = await summaryOf(w, run);
  assert.match(html, /2 watched sections differ from the approved text:/);
  assert.ok(html.includes('CPLR § 214 since Nov 18, 2026 (5 days)'));
  assert.ok(html.includes('CPLR § 214-a since Nov 21, 2026 (2 days)'));
  assert.doesNotMatch(html, /GONE|CPLR § 208 since/);
});

test('the summary says how long before it the watch ran, rounded down', async () => {
  const w = world({ ids: ['CPLR-214'] });
  const cases = [[1.5, '1 hour'], [25, '25 hours'], [1 / 3, 'less than an hour'], [3.99, '3 hours']];
  for (const [hours, age] of cases) {
    const ran = hoursBefore(hours);
    const html = await summaryOf(w, { ranAt: ran, ok: true });
    assert.ok(html.includes(`The statute watch ran at ${newYorkTime(ran)}, ${age} before this summary. It read `), `${hours} h`);
  }
});

test('the summary lists a by-hand source at 90 days and not at 89, and one never reviewed', async () => {
  const handSource = (id, name, reviewedOn) => ({ id, kind: 'by_hand', name, url: 'https://example.test/', reviewed_on: reviewedOn });
  const law = {
    sources: [section('CPLR-214'), handSource('RULE-90', 'A rule <b>&</b> reviewed at ninety days', daysBefore(90)),
      handSource('RULE-89', 'A rule reviewed at eighty-nine days', daysBefore(89)), handSource('RULE-NEW', 'A rule never reviewed', null)],
    notes: [], register: [],
  };
  const w = world({ law });
  const html = await summaryOf(w, { ranAt: hoursBefore(6), ok: true });
  assert.ok(html.includes('A rule &lt;b&gt;&amp;&lt;/b&gt; reviewed at ninety days was last reviewed by hand on Aug 25, 2026, 90 days ago. '
    + 'Review it, then run <code>npm run law:reviewed -- RULE-90</code>.'));
  assert.ok(html.includes('A rule never reviewed has not been reviewed by hand yet. Review it, then run <code>npm run law:reviewed -- RULE-NEW</code>.'));
  assert.ok(html.includes('<code>npm run law:reviewed -- ') && !html.includes('`'), 'the command is HTML code, with no Markdown backtick');
  assert.doesNotMatch(html, /RULE-89|eighty-nine/);
  assert.doesNotMatch(html, /<b>/);
  // These lines come from the law alone, so they stay when the table cannot be read.
  w.table.gone();
  const without = await summaryOf(w, { ranAt: hoursBefore(6), ok: true });
  assert.ok(without.includes('<code>npm run law:reviewed -- RULE-90</code>') && without.includes('<code>npm run law:reviewed -- RULE-NEW</code>'));
});

test('the summary lists the sections that could not be read', async () => {
  const w = world({ ids: ['CPLR-214', 'CPLR-214-A'] });
  const run = { ranAt: hoursBefore(6), ok: true };
  w.table.plant('CPLR-214', { unread_since: '2026-11-20', last_error: 'the Senate did not answer' });
  w.table.plant('CPLR-214-A', { last_read_at: hoursBefore(2).toISOString() });
  const html = await summaryOf(w, run);
  assert.ok(html.includes('CPLR § 214 could not be read since Nov 20, 2026'));
  assert.doesNotMatch(html, /CPLR § 214-a could not/);
  // A reason is the table's own and may hold anything: it is not in the summary.
  assert.doesNotMatch(html, /did not answer/);
  // When the table cannot be read the summary still goes, and says so in place of those lines, so that nothing is hidden.
  w.table.gone('connection refused for postgres://user:secret@host/db');
  const gone = await summaryOf(w, run);
  assert.ok(gone.includes("The statute watch's records could not be read for this summary."));
  assert.doesNotMatch(gone, /secret|postgres|differ|could not be read since|It read/);
  assert.ok(gone.includes('The statute watch ran at'));
});

test('a run time the summary cannot read is said so, and one given as an ISO string reads like a Date', async () => {
  const w = world({ ids: ['CPLR-214'] });
  // A job-log row with a bad time is not a watch that has never run: that would look healthy and hide a broken one.
  for (const ranAt of ['not a time', undefined, null, {}, '']) {
    const html = await summaryOf(w, { ranAt, ok: true });
    assert.ok(html.includes("The statute watch's last run time could not be read."), String(ranAt));
    assert.doesNotMatch(html, /has not run/);
  }
  assert.match(await summaryOf(w, null), /has not run yet/);
  const moment = hoursBefore(5);
  const asDate = await summaryOf(w, { ranAt: moment, ok: true });
  assert.equal(await summaryOf(w, { ranAt: moment.toISOString(), ok: true }), asDate);
  assert.ok(asDate.includes(`The statute watch ran at ${newYorkTime(moment)}, `));
});
