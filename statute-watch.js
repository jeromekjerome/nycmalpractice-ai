// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// statute-watch.js: the nightly statute watch, the one step of its own job at 01:00 UTC. It reads every section and bill the
// notes file rests on from the Senate's Open Legislation API and compares each official text with the one the owner approved:
// its fingerprint is in the notes file, and the text is kept beside it in rubrics/statutes/. What it finds is kept in the
// table statute_watch (setup-db.js), one row per source, and the owner is emailed:
// - when a text differs from the approved one: once for each new text, with the notes that rest on the source, the places
//   that state its rule, the changed words marked, the official page and the command that approves it;
// - when a text the owner was told had changed reads as the approved one again;
// - when a source could not be read on three New York days running.
//
// - The watch reads and tells. It never writes the notes file or a saved text, and never changes the law object it is given:
//   only `npm run law:approve`, which the owner runs, and the owner's push change what a visitor reads.
// - Anything short of a full answer (a failure, a timeout, a source not reached in time) is unread, never a change.
// - One email for each new text, however many instances run. Before a send the source's row is claimed by an UPDATE that only
//   one instance can win, and the claim's own WHERE checks, against the row as it is then, that the email is still to be sent.
//   Only notify's { sent: true } marks it sent. Any other outcome releases the claim, so the email goes the next night. A
//   claim left by a run that died lapses after ten minutes.
// - More than three emails of one kind in a run go as one email of that kind. An outage, a revoked key or a new format of the
//   Senate's text would otherwise send one email for each of some twenty sources.
// - One budget covers the reads and the sends, so that the run ends inside the function's time limit. Its last quarter (at
//   most 10 s) is kept for the notices: a slow or failing Senate must never use up the time the notices about it need, and
//   the "could not be read for three days" email exists for just that Senate. Reads start, and run, only until that share
//   begins: a source not started by then is unread, and so is a read still in flight, which is stopped, both "not reached".
//   A send may start until the budget ends. A send once started is waited for: giving up on it would release its claim
//   while the mail might still go out, and the next night would send it again.
// - Every statement takes the run's own moment (`today`) as its time, and the days are New York's. No date is read back from
//   the table into this code, where a DATE could arrive as a Date at midnight UTC, which is the evening before in New York:
//   the third day of a streak is tested in the claim's own WHERE.
// - The run throws, so that its step fails and is reported that same night, when it has no reader (the key is not set), when
//   the notes file has nothing to watch, when the table cannot be read or written, and when no source could be read at all.
//   The last is found only after every source has been recorded and every notice due has been sent.
// - A reason that is stored or emailed leaves out any address, since the key travels in the address's query, and passes
//   through withoutKeys. A reader that throws gets a fixed phrase: its error is never quoted.
//
// This file is shared with the sister app (shared-code.json), so it knows nothing of either app: the caller hands over the
// notes file, the reader (with the key bound), the approved texts, the email and the site's name.
import { statuteFingerprint, diffStatuteText, diffToHtml } from './statute-text.js';
import { notesResting, registeredPlaces } from './law-file.js';
import { withoutKeys } from './without-keys.js';

const TIME_ZONE = 'America/New_York';
const DAY_MS = 86_400_000;
// setTimeout takes no longer delay than this: a longer one fires at once.
const LONGEST_TIMER_MS = 2_147_483_647;
// The share of the budget kept for the notices: a quarter of it, and never more than this.
const MOST_KEPT_FOR_NOTICES_MS = 10_000;
// More notices of one kind than this in a run go in one email.
const MOST_SENT_APART = 3;
// The kinds of notice, in the order they are sent, so that the news that matters most goes first while time remains.
const KINDS = ['changed', 'back', 'unread'];
const NOT_REACHED = "not reached before the run's time ran out";
const READER_THREW = 'the reader failed without giving an answer';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// New York's calendar day of a moment, as YYYY-MM-DD.
function newYorkDay(moment) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(moment);
}

// The day `days` after a day (before it, when negative), as YYYY-MM-DD.
function shiftDay(day, days) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// A reason as it may be stored and emailed. An address is left out whole, since the key travels in its query, and so is any
// key= with what follows it; withoutKeys then withholds the key's value and anything shaped like another key.
function clean(reason) {
  return withoutKeys(String(reason ?? '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address withheld]')
    .replace(/key=\S*/gi, '[key withheld]'));
}

function tableFailure(error) {
  return new Error(`the table statute_watch could not be read or written (${clean(error?.message ?? error)}). `
    + 'Run npm run setup-db against the production database.');
}

// The sections and bills of the notes file, each once. A source kept by hand has nothing to read it from.
function sectionsAndBills(law) {
  const seen = new Set();
  return (Array.isArray(law?.sources) ? law.sources : []).filter(source => {
    if (source?.kind !== 'section' && source?.kind !== 'bill') return false;
    if (typeof source.id !== 'string' || !source.id || seen.has(source.id)) return false;
    seen.add(source.id);
    return true;
  });
}

// A read the watch can compare holds a text, empty only for a repealed section. Anything else is unread, with its reason.
function checkedRead(read) {
  if (read?.ok === true) {
    if (typeof read.text === 'string' && (read.text.trim() !== '' || read.repealed === true)) return read;
    return { ok: false, reason: 'the answer had no text' };
  }
  return { ok: false, reason: read?.reason || 'the reader gave no reason' };
}

// The statements. Each takes the run's moment (`at`) wherever the time is now.

// A source read as the approved text. Its difference goes. So does the record that the owner was emailed about it, except
// when that email reported a text the owner did not approve: then the record stays until the email saying the text is back
// has gone, so that a failed send of it is tried again.
function recordSame({ db, at }, id, reportStays) {
  if (reportStays) {
    return db`
      INSERT INTO statute_watch (source_id, last_checked_at, last_read_at) VALUES (${id}, ${at}::timestamptz, ${at}::timestamptz)
      ON CONFLICT (source_id) DO UPDATE SET last_checked_at = EXCLUDED.last_checked_at, last_read_at = EXCLUDED.last_read_at,
        seen_fingerprint = NULL, seen_text = NULL, seen_active_date = NULL, differs_since = NULL,
        unread_since = NULL, unread_emailed_at = NULL, last_error = NULL`;
  }
  return db`
    INSERT INTO statute_watch (source_id, last_checked_at, last_read_at) VALUES (${id}, ${at}::timestamptz, ${at}::timestamptz)
    ON CONFLICT (source_id) DO UPDATE SET last_checked_at = EXCLUDED.last_checked_at, last_read_at = EXCLUDED.last_read_at,
      seen_fingerprint = NULL, seen_text = NULL, seen_active_date = NULL, differs_since = NULL, emailed_fingerprint = NULL,
      unread_since = NULL, unread_emailed_at = NULL, last_error = NULL`;
}

// A source read as a text other than the approved one. The date it first differed is kept through later changes.
function recordDiffering({ db, at }, id, read, fingerprint) {
  const activeDate = read.activeDate == null ? null : String(read.activeDate);
  return db`
    INSERT INTO statute_watch (source_id, seen_fingerprint, seen_text, seen_active_date, differs_since, last_checked_at, last_read_at)
    VALUES (${id}, ${fingerprint}, ${read.text}, ${activeDate}, ${at}::timestamptz, ${at}::timestamptz, ${at}::timestamptz)
    ON CONFLICT (source_id) DO UPDATE SET seen_fingerprint = EXCLUDED.seen_fingerprint, seen_text = EXCLUDED.seen_text,
      seen_active_date = EXCLUDED.seen_active_date, differs_since = COALESCE(statute_watch.differs_since, EXCLUDED.differs_since),
      last_checked_at = EXCLUDED.last_checked_at, last_read_at = EXCLUDED.last_read_at,
      unread_since = NULL, unread_emailed_at = NULL, last_error = NULL`;
}

// A source not read. A streak starts on this New York day unless one is running; a new streak has had no email.
function recordUnread({ db, at, day }, id, reason) {
  return db`
    INSERT INTO statute_watch (source_id, last_checked_at, unread_since, last_error) VALUES (${id}, ${at}::timestamptz, ${day}::date, ${reason})
    ON CONFLICT (source_id) DO UPDATE SET last_checked_at = EXCLUDED.last_checked_at,
      unread_since = COALESCE(statute_watch.unread_since, EXCLUDED.unread_since),
      unread_emailed_at = CASE WHEN statute_watch.unread_since IS NULL THEN NULL ELSE statute_watch.unread_emailed_at END,
      last_error = EXCLUDED.last_error`;
}

// Takes a notice's email for this run, if it is still due and no other run holds it: the notice, or null. Only one instance
// can win the UPDATE, and its WHERE reads the row as it is now, not as this run first read it.
async function claim({ db, at, day }, notice) {
  const id = notice.source.id;
  if (notice.tell === 'changed') {
    // Due while the row still holds this text and no email about it has gone.
    const taken = await db`
      UPDATE statute_watch SET email_claimed_at = ${at}::timestamptz
      WHERE source_id = ${id} AND seen_fingerprint = ${notice.fingerprint} AND emailed_fingerprint IS DISTINCT FROM ${notice.fingerprint}
        AND (email_claimed_at IS NULL OR email_claimed_at < ${at}::timestamptz - INTERVAL '10 minutes')
      RETURNING source_id`;
    return taken.length ? notice : null;
  }
  if (notice.tell === 'back') {
    // Due while the difference is gone and the owner's last email reported a text other than the approved one.
    const taken = await db`
      UPDATE statute_watch SET email_claimed_at = ${at}::timestamptz
      WHERE source_id = ${id} AND seen_fingerprint IS NULL AND emailed_fingerprint <> ${notice.source.fingerprint}
        AND (email_claimed_at IS NULL OR email_claimed_at < ${at}::timestamptz - INTERVAL '10 minutes')
      RETURNING source_id`;
    return taken.length ? notice : null;
  }
  // Due on the third New York day of a streak, two days or more after its first, if the streak has had no email.
  const [taken] = await db`
    UPDATE statute_watch SET email_claimed_at = ${at}::timestamptz
    WHERE source_id = ${id} AND unread_since <= ${shiftDay(day, -2)}::date AND unread_emailed_at IS NULL
      AND (email_claimed_at IS NULL OR email_claimed_at < ${at}::timestamptz - INTERVAL '10 minutes')
    RETURNING source_id, to_char(unread_since, 'YYYY-MM-DD') AS unread_since`;
  return taken ? { ...notice, since: taken.unread_since } : null;
}

// A claimed email that went out: what it told is recorded, and the claim is given up.
function markSent({ db, at }, notice) {
  const id = notice.source.id;
  if (notice.tell === 'changed') return db`UPDATE statute_watch SET emailed_fingerprint = ${notice.fingerprint}, email_claimed_at = NULL WHERE source_id = ${id}`;
  if (notice.tell === 'back') return db`UPDATE statute_watch SET emailed_fingerprint = NULL, email_claimed_at = NULL WHERE source_id = ${id}`;
  return db`UPDATE statute_watch SET unread_emailed_at = ${at}::timestamptz, email_claimed_at = NULL WHERE source_id = ${id}`;
}

// A claimed email that did not go out, for whatever reason: only the claim is given up, so the next night sends it.
function release({ db }, notice) {
  return db`UPDATE statute_watch SET email_claimed_at = NULL WHERE source_id = ${notice.source.id}`;
}

// The emails.

const nameOf = source => String(source.name || source.id);

function officialPage(source) {
  const url = String(source.url ?? '');
  if (!url) return '';
  const shown = escapeHtml(url);
  return `<p>The official page: ${/^https?:\/\//i.test(url) ? `<a href="${shown}">${shown}</a>` : shown}</p>`;
}

// The approved text of a source, or null with the reason there is none: the email then shows the new text whole.
function approvedText(snapshotOf, id) {
  try {
    const text = typeof snapshotOf === 'function' ? snapshotOf(id) : null;
    return typeof text === 'string' ? { text } : { text: null, why: 'No approved text was saved for it' };
  } catch {
    return { text: null, why: 'Its approved text could not be read' };
  }
}

function changedBlock({ source, read, fingerprint }, { law, snapshotOf }) {
  const parts = [`<h3>${escapeHtml(nameOf(source))}</h3>`];
  if (read.repealed) {
    parts.push(read.repealedDate
    ? `<p>The Senate now gives it as repealed on ${escapeHtml(read.repealedDate)}.</p>`
    : '<p>It is no longer in its law\'s current text: it was repealed or renumbered. The Senate gives no date.</p>');
  } else {
    const approved = approvedText(snapshotOf, source.id);
    parts.push(approved.text === null
      ? `<p>${approved.why}, so the new text is shown whole:</p><pre style="white-space:pre-wrap">${escapeHtml(read.text)}</pre>`
      : `<p>What changed, with the approved words struck through and the new words underlined:</p><p>${diffToHtml(diffStatuteText(approved.text, read.text))}</p>`);
  }
  if (read.activeDate) parts.push(`<p>The Senate's date for this text: ${escapeHtml(read.activeDate)}.</p>`);
  const notes = notesResting(law, source.id);
  parts.push(notes.length
    ? `<p>The notes that rest on it:</p><ul>${notes.map(note => `<li>${escapeHtml(note.topic)}: ${escapeHtml(note.rule)}</li>`).join('')}</ul>`
    : '<p>No note rests on it.</p>');
  const places = registeredPlaces(law, source.id);
  const times = count => (Number(count) === 1 ? 'once' : `${escapeHtml(count)} times`);
  parts.push(places.length
    ? `<p>The places that state it:</p><ul>${places.map(place => `<li>${escapeHtml(place.file)}: "${escapeHtml(place.states)}", ${times(place.count)}</li>`).join('')}</ul>`
    : '<p>No registered place states it.</p>');
  parts.push(officialPage(source));
  // law approve refuses a repealed text, which no saved text can match, so a repeal is not offered a command that would fail.
  parts.push(read.repealed
    ? '<p>The approval command refuses a repealed section: edit the source and the notes that rest on it by hand.</p>'
    : `<p>To approve the new text: <code>npm run law:approve -- ${escapeHtml(source.id)} ${escapeHtml(fingerprint)}</code></p>`);
  return parts.join('');
}

function backBlock({ source }) {
  return `<h3>${escapeHtml(nameOf(source))}</h3><p>Its official text reads as the approved text again, so the change you were emailed about is gone`
    + ` and there is nothing to approve.</p>${officialPage(source)}`;
}

function unreadBlock({ source, reason, since }) {
  return `<h3>${escapeHtml(nameOf(source))}</h3><p>It could not be read from the Senate's Open Legislation API on three New York days running,`
    + ` since ${escapeHtml(since)}. The last reason: ${escapeHtml(reason)}.</p>${officialPage(source)}`;
}

const LETTERS = {
  changed: {
    one: name => `${name} has changed`,
    many: count => `${count} watched statutes have changed`,
    block: changedBlock,
    closing: '<p>Until you approve, replies keep using the approved notes. If the rule changed, edit the note and every place listed in the same commit, then push.</p>',
  },
  back: {
    one: name => `${name} is back to the approved text`,
    many: count => `${count} watched statutes are back to the approved text`,
    block: backBlock,
    closing: '<p>Replies kept using the approved notes all along, so nothing needs doing.</p>',
  },
  unread: {
    one: name => `${name} could not be read for three days`,
    many: count => `${count} watched statutes could not be read for three days`,
    block: unreadBlock,
    closing: '<p>While a statute cannot be read, a change to it goes unnoticed. The watch tries again every night and sends nothing more about a statute'
      + ' until it has been read. If every watched statute fails for the same reason, look first at NYSENATE_API_KEY in the deployment\'s settings.</p>',
  },
};

// One email for a batch of notices of one kind. A batch of one is about its source; a larger one opens with the count.
function emailOf(kind, batch, context) {
  const letter = LETTERS[kind];
  const headline = batch.length === 1 ? letter.one(nameOf(batch[0].source)) : letter.many(batch.length);
  const opening = batch.length === 1 ? '' : `<p>${escapeHtml(headline)}. Each is set out below.</p>`;
  return { subject: `${context.prefix}${headline}`, html: opening + batch.map(notice => letter.block(notice, context)).join('<hr>') + letter.closing };
}

/**
 * @param {object} options
 * @param {Date|number|string} options.today  the moment of the run
 * @param {Function} options.sqlClient        a tagged-template SQL client (neon)
 * @param {object} options.law                the notes file as read (readLawFile); it is never changed
 * @param {Function} options.snapshotOf       id => the approved text of a section or bill, or null when none is saved
 * @param {Function} options.readSource       (source, { signal }) => a read of a section or bill (sourceReader, with the key)
 * @param {Function} options.notify           notify(subject, html) => { sent: true } | { sent: false, reason } (sendOperatorNotice)
 * @param {string} [options.site]             the site's name, for the subject of each email
 * @param {number} [options.budgetMs]         the time the reads and the sends may take together; its last quarter (at most
 *                                            10 s) is the notices' alone
 * @param {number} [options.concurrency]      the most reads at once
 * @returns {Promise<{ checked: number, same: string[], differing: string[], unread: string[], emails: string[] }>}
 *   checked: the sections and bills watched, each in exactly one of same, differing and unread, in the notes file's order;
 *   emails: the subjects of the emails that went out
 */
export async function statuteWatch({ today, sqlClient, law, snapshotOf, readSource, notify, site = '', budgetMs = 40000, concurrency = 4 }) {
  if (typeof readSource !== 'function') throw new Error('the statute watch was given no reader of the Senate\'s texts (is NYSENATE_API_KEY set?)');
  if (typeof notify !== 'function') throw new Error('the statute watch was given no way to email the owner');
  const moment = new Date(today);
  if (Number.isNaN(moment.getTime())) throw new Error('the statute watch was given no moment for its run (today)');
  const watched = sectionsAndBills(law);
  if (!watched.length) throw new Error('no sections or bills to watch in the notes file');

  const db = (strings, ...values) => Promise.resolve().then(() => sqlClient(strings, ...values)).catch(error => { throw tableFailure(error); });
  const run = { db, at: moment.toISOString(), day: newYorkDay(moment) };
  const context = { law, snapshotOf, prefix: site ? `${site}: ` : '' };

  // The budget is on the real clock, from now: `today` is the run's moment for the table, and a test sets it to any night.
  // Its last part is the notices' alone, so that a Senate that is slow, or takes every request and never answers, cannot use
  // up the time the notices about it need: the reads end where that part begins, and the sends may start until the end.
  const budget = Math.min(Math.max(Number(budgetMs) || 0, 0), LONGEST_TIMER_MS);
  const started = Date.now();
  const readsEnd = started + budget - Math.min(MOST_KEPT_FOR_NOTICES_MS, Math.floor(budget / 4));
  const deadline = started + budget;
  const timeLeft = () => Date.now() < deadline;
  // The run's signal: every read is given it, and it stops the reads still in flight when the reads' time ends.
  const stop = new AbortController();
  // The timer runs on the monotonic clock and Date.now() on the wall clock, so the timer can fire just before Date.now() reaches
  // readsEnd: a read is never started once the signal has been aborted.
  const readingTimeLeft = () => !stop.signal.aborted && Date.now() < readsEnd;
  const timer = setTimeout(() => stop.abort(), Math.max(readsEnd - Date.now(), 0));
  const stopped = new Promise((_, reject) => stop.signal.addEventListener('abort', () => reject(new Error(NOT_REACHED)), { once: true }));
  stopped.catch(() => {});

  // A read is raced against the end of the reads' time, so that a reader that pays no heed to its signal cannot hold the run.
  // A read stopped there counts as not reached, the same as one never started. The loser settles on its own, with a handler,
  // so that its rejection is never unhandled.
  const readOne = async source => {
    const reading = Promise.resolve().then(() => readSource(source, { signal: stop.signal }));
    reading.catch(() => {});
    try {
      return checkedRead(await Promise.race([reading, stopped]));
    } catch {
      return { ok: false, reason: stop.signal.aborted ? NOT_REACHED : READER_THREW };
    }
  };

  try {
    // Read first, so that a missing table fails the run before the Senate is asked anything.
    const rows = new Map((await db`SELECT source_id, seen_fingerprint, emailed_fingerprint FROM statute_watch`).map(row => [row.source_id, row]));

    // What a source's read leaves, with the notice it may owe the owner (`tell`). Its row is written as soon as the read ends,
    // so that what was learned is kept if the run fails later.
    let failure = null;
    const watchOne = async source => {
      const read = readingTimeLeft() ? await readOne(source) : { ok: false, reason: NOT_REACHED };
      if (failure) return null;
      const row = rows.get(source.id);
      if (!read.ok) {
        const reason = clean(read.reason);
        await recordUnread(run, source.id, reason);
        return { source, state: 'unread', reason, tell: 'unread' };
      }
      const fingerprint = statuteFingerprint(read);
      if (fingerprint === source.fingerprint) {
        // Back to the approved text after the owner was emailed about another text, and did not approve the one last seen:
        // the owner is told. A difference that was never emailed, or that the owner approved, clears without a word.
        const reported = Boolean(row) && row.seen_fingerprint !== source.fingerprint
          && row.emailed_fingerprint != null && row.emailed_fingerprint !== source.fingerprint;
        await recordSame(run, source.id, reported);
        return { source, state: 'same', tell: reported ? 'back' : null };
      }
      await recordDiffering(run, source.id, read, fingerprint);
      return { source, state: 'differing', read, fingerprint, tell: row?.emailed_fingerprint === fingerprint ? null : 'changed' };
    };

    // The reads, `concurrency` at a time. A table that fails stops the reads still running, and the run fails once they end.
    const outcomes = new Array(watched.length);
    let next = 0;
    const worker = async () => {
      while (!failure && next < watched.length) {
        const index = next;
        next += 1;
        try {
          outcomes[index] = await watchOne(watched[index]);
        } catch (error) {
          failure ??= error;
          stop.abort();
        }
      }
    };
    const workers = Math.min(watched.length, Math.max(Math.floor(Number(concurrency)) || 1, 1));
    await Promise.all(Array.from({ length: workers }, worker));
    if (failure) throw failure;

    // The notices, one kind at a time. Each is claimed first; more than three claimed of a kind go in one email. A send is
    // started only while time remains; once started it is waited for, and what it reports decides the claims of its batch.
    const emails = [];
    for (const kind of KINDS) {
      const due = outcomes.filter(outcome => outcome.tell === kind);
      // Nothing is claimed once the time is gone: the notices wait, unclaimed, for the next night.
      if (!due.length || !timeLeft()) continue;
      const claimed = [];
      for (const notice of due) {
        const taken = await claim(run, notice);
        if (taken) claimed.push(taken);
      }
      for (const batch of claimed.length > MOST_SENT_APART ? [claimed] : claimed.map(notice => [notice])) {
        let sent = false;
        let subject = '';
        if (timeLeft()) {
          const email = emailOf(kind, batch, context);
          subject = email.subject;
          try {
            sent = (await notify(email.subject, email.html))?.sent === true;
          } catch {
            sent = false;
          }
        }
        for (const notice of batch) await (sent ? markSent(run, notice) : release(run, notice));
        if (sent) emails.push(subject);
      }
    }

    if (!outcomes.some(outcome => outcome.state !== 'unread')) {
      throw new Error(`no watched section or bill could be read (${[...new Set(outcomes.map(outcome => outcome.reason))].join('; ')})`);
    }
    const idsOf = state => outcomes.filter(outcome => outcome.state === state).map(outcome => outcome.source.id);
    return { checked: watched.length, same: idsOf('same'), differing: idsOf('differing'), unread: idsOf('unread'), emails };
  } finally {
    clearTimeout(timer);
  }
}

// The daily summary's part about the watch.

// A run older than this has missed a night: the watch runs every 24 hours, and two hours more allow for a late start.
const LATE_AFTER_MS = 26 * 3_600_000;
// A source reviewed by hand this many days ago or more is due for another review.
const REVIEW_DUE_DAYS = 90;
const NEW_YORK_TIME = { timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'short' };

const newYorkTime = moment => new Date(moment).toLocaleString('en-US', NEW_YORK_TIME);

// A New York day (YYYY-MM-DD) as the reader sees it: Nov 18, 2026. Noon UTC keeps it on its own day in any zone.
const dayLabel = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', dateStyle: 'medium' });

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const daysIn = count => `${count} ${count === 1 ? 'day' : 'days'}`;

// The run's line, from the last run the job log holds. `count` is the sentence on how many were read, or '' when it is not known.
function runLine(lastRun, moment, count) {
  // Only no record at all is a watch that has not run. A record with no readable time says so instead: a mis-shaped row in the
  // job log must not pass for the healthy state and hide a watch that is running or failing. null and '' would read as 1970.
  if (lastRun == null) return 'The statute watch has not run yet.';
  const given = lastRun.ranAt;
  const ranAt = given == null || given === '' ? NaN : new Date(given).getTime();
  if (Number.isNaN(ranAt)) return "The statute watch's last run time could not be read.";
  const time = newYorkTime(ranAt);
  if (moment.getTime() - ranAt >= LATE_AFTER_MS) return `The statute watch has not run since ${time}.`;
  if (lastRun.ok !== true) return `The statute watch's last run, at ${time}, failed: the owner was emailed the failed step.`;
  const hours = Math.floor((moment.getTime() - ranAt) / 3_600_000);
  const age = hours < 1 ? 'less than an hour' : hours === 1 ? '1 hour' : `${hours} hours`;
  return `The statute watch ran at ${time}, ${age} before this summary.${count ? ` ${count}` : ''}`;
}

// The by-hand sources that are overdue for a review or have never had one, from the law alone: the watch cannot read them.
function reviewLines(law, today) {
  const lines = [];
  for (const source of Array.isArray(law?.sources) ? law.sources : []) {
    if (source?.kind !== 'by_hand') continue;
    // Each line is HTML already, escaped piece by piece, so that the command can be set in <code>.
    const command = `Review it, then run <code>npm run law:reviewed -- ${escapeHtml(source.id)}</code>.`;
    if (source.reviewed_on == null) {
      lines.push(`<p>${escapeHtml(`${nameOf(source)} has not been reviewed by hand yet.`)} ${command}</p>`);
      continue;
    }
    const days = daysBetween(String(source.reviewed_on), today);
    if (days >= REVIEW_DUE_DAYS) lines.push(`<p>${escapeHtml(`${nameOf(source)} was last reviewed by hand on ${dayLabel(String(source.reviewed_on))}, ${days} days ago.`)} ${command}</p>`);
  }
  return lines;
}

/**
 * The statute watch's part of the daily summary, as HTML: when it last ran, each watched section that differs from the
 * approved text, each that could not be read, and each source kept by hand that is due for a review. A difference is listed
 * here whether or not its email went out, so that this summary is the backstop for one that did not. Only the table is read,
 * and never written.
 * @param {object} options
 * @param {Function} options.sqlClient  a tagged-template SQL client (neon)
 * @param {object} options.law          the notes file as read (readLawFile)
 * @param {Date|number|string} options.today  the moment of the summary
 * @param {{ ranAt: Date|string, ok: boolean }|null} options.lastRun  the watch's last run in the job log, or null
 * @returns {Promise<string>} '' only when there is nothing at all to say
 */
export async function statuteWatchSummary({ sqlClient, law, today, lastRun }) {
  const moment = new Date(today);
  const day = newYorkDay(moment);
  const watched = sectionsAndBills(law);
  const names = new Map(watched.map(source => [source.id, nameOf(source)]));

  // A table that cannot be read must not hide the differences it holds, and must not stop the rest of the summary.
  // The failure is not quoted: it may carry a connection string.
  let rows = null;
  try {
    rows = await sqlClient`SELECT source_id, differs_since, last_read_at, to_char(unread_since, 'YYYY-MM-DD') AS unread_since FROM statute_watch`;
  } catch {
    rows = null;
  }

  // Each entry is HTML already: a sentence goes through p(), which escapes it, and a list is built from escaped items.
  const p = sentence => `<p>${escapeHtml(sentence)}</p>`;
  const lines = [];
  if (rows === null) {
    lines.push(p(runLine(lastRun, moment, '')));
    lines.push(p("The statute watch's records could not be read for this summary."));
  } else {
    const readSince = moment.getTime() - LATE_AFTER_MS;
    const read = rows.filter(row => names.has(row.source_id) && row.last_read_at != null
      && new Date(row.last_read_at).getTime() >= readSince && new Date(row.last_read_at).getTime() <= moment.getTime()).length;
    lines.push(p(runLine(lastRun, moment, `It read ${read} of the ${watched.length} watched sections.`)));
    // The law's order, and only sources the law still holds: a row left by a source since removed says nothing to act on.
    const byId = new Map(rows.map(row => [row.source_id, row]));
    const differing = watched.map(source => ({ source, row: byId.get(source.id) })).filter(({ row }) => row?.differs_since != null);
    if (differing.length) {
      const items = differing.map(({ source, row }) => {
        const since = newYorkDay(new Date(row.differs_since));
        return `<li>${escapeHtml(names.get(source.id))} since ${escapeHtml(dayLabel(since))} (${daysIn(daysBetween(since, day))})</li>`;
      });
      lines.push(p(`${differing.length} watched ${differing.length === 1 ? 'section differs' : 'sections differ'} from the approved text:`), `<ul>${items.join('')}</ul>`);
    }
    const unread = watched.map(source => ({ source, row: byId.get(source.id) })).filter(({ row }) => row?.unread_since != null);
    if (unread.length) {
      lines.push(`<ul>${unread.map(({ source, row }) => `<li>${escapeHtml(names.get(source.id))} could not be read since ${escapeHtml(dayLabel(String(row.unread_since).slice(0, 10)))}</li>`).join('')}</ul>`);
    }
  }
  lines.push(...reviewLines(law, day));

  return lines.join('');
}
