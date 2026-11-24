// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// law.mjs — the statute watch's command line: node law.mjs <command>. The same file in every app; what is each app's
// own (its name, where it keeps statutes) comes from gate-config.js or from `deps`.
//
// It imports nothing at the top that reaches db.js, because db.js loads the local .env, with its live keys, as soon as
// it is imported (the test, which has its own settings, imports this file). The one thing that does reach it, the
// email, is imported only when a test alert is actually sent and no fake was given.
//
// Exit codes: 0 done, 1 refused (or failed), 2 used wrongly.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SITE_NAME, STATUTE_TEXTS_DIR, CURRENT_LAW_FILE } from './gate-config.js';
import { readLawFile, writeLawFile, notesResting, registeredPlaces, requirementsResting, earliestSourceDate, snapshotReader } from './law-file.js';
import { fetchLawIndex, fetchLawTree, sourceReader, tidyStatuteText, statuteFingerprint } from './statute-text.js';

// The ids a saved text may have, the same shape as the plan's source ids (CPLR-214-A, EPTL-5-4.1, INS-5102, BILL-2025-S1234).
// Nothing else is ever used to make a file name, so nothing outside the statutes folder is written.
const SOURCE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9.]+)+$/;

const COMMANDS = {
  'test-alert': 'send one email, to prove a notice reaches the owner',
  find: 'find the statutes to follow',
  fetch: 'fetch the current text of a statute',
  check: 'compare what is kept with the Senate\'s text',
  report: 'print each source with the notes and places that rest on it',
  approve: 'approve a change the check found',
  reviewed: 'record that a source kept by hand has been reviewed',
};

function usage(out) {
  out('Usage: node law.mjs <command>');
  for (const [name, what] of Object.entries(COMMANDS)) out(`  ${name.padEnd(11)} ${what}`);
}

async function testAlert({ notify, siteName, out, err }) {
  const send = notify ?? (await import('./auction.js')).sendOperatorNotice;
  const html = `<p>This is a test from the statute watch of ${siteName}. Nothing needs doing.</p>`
    + '<p>It was sent by <code>npm run law:test-alert</code>, to prove that the watch\'s alerts reach you.</p>';
  let result;
  try {
    result = await send(`${siteName}: a test alert from the statute watch`, html);
  } catch (error) {
    err(`The test alert was not sent: ${error?.message ?? error}`);
    return 1;
  }
  // Only { sent: true } counts as sent.
  if (result?.sent !== true) {
    err(`The test alert was not sent: ${result?.reason ?? 'no reason was given'}`);
    return 1;
  }
  out('The test alert was sent. Check the inbox, and the spam folder if it is not there.');
  return 0;
}

// The laws whose id or name holds the words given, and, with a section, the documents of each whose number or title holds it.
// The CPLR's Senate id is not "CPLR", so a name ("civil practice") or the id is what this works with.
async function find(args, { readIndex, readTree, out, err }) {
  const [name, section, ...extra] = args;
  if (!name || extra.length) {
    err('Usage: node law.mjs find <name|lawId> [section]');
    return 2;
  }
  const index = await readIndex();
  if (!index.ok) {
    err(`The Senate's list of laws was not read: ${index.reason}`);
    return 1;
  }
  const wanted = name.toLowerCase();
  const laws = index.laws.filter(law => `${law.lawId}`.toLowerCase().includes(wanted) || `${law.name}`.toLowerCase().includes(wanted));
  if (!laws.length) {
    err(`No law matches "${name}".`);
    return 1;
  }
  let shown = 0;
  for (const law of laws) {
    out(`${law.lawId}  ${law.name}  ${law.lawType}`);
    if (section === undefined) continue;
    const tree = await readTree(law.lawId);
    if (!tree.ok) {
      err(`The tree of ${law.lawId} was not read: ${tree.reason}`);
      return 1;
    }
    const part = section.toLowerCase();
    const documents = tree.documents.filter(document => `${document.locationId}`.toLowerCase().includes(part) || `${document.title}`.toLowerCase().includes(part));
    for (const document of documents) out(`  ${document.locationId}  ${document.docType}  ${document.title}`);
    shown += documents.length;
  }
  if (section !== undefined && !shown) {
    err(`No document of ${laws.map(law => law.lawId).join(', ')} matches "${section}".`);
    return 1;
  }
  return 0;
}

async function fetchText(args, { readSource, statutesDir, out, err }) {
  const positional = [];
  let saveAs;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--save') {
      saveAs = args[i + 1] ?? '';
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  const [lawId, locationId, ...extra] = positional;
  if (!lawId || !locationId || extra.length || (saveAs !== undefined && !SOURCE_ID.test(saveAs))) {
    err('Usage: node law.mjs fetch <lawId> <locationId> [--save <id>]   (an id looks like CPLR-214-A or EPTL-5-4.1)');
    return 2;
  }
  const read = await readSource({ kind: 'section', lawId, locationId });
  if (!read.ok) {
    err(`${lawId} ${locationId} was not read: ${read.reason}`);
    return 1;
  }
  const text = tidyStatuteText(read.text);
  out(text);
  out(`activeDate: ${read.activeDate}`);
  out(`repealed: ${read.repealed}`);
  out(`fingerprint: ${statuteFingerprint({ text, repealed: read.repealed, repealedDate: read.repealedDate })}`);
  if (saveAs === undefined) return 0;
  const folder = statutesDir instanceof URL ? fileURLToPath(statutesDir) : String(statutesDir);
  const file = join(folder, `${saveAs}.txt`);
  await mkdir(folder, { recursive: true });
  try {
    // 'wx' fails if the file is there, so a saved text is never overwritten, even by two runs at once.
    await writeFile(file, `${text}\n`, { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    err(`${saveAs}.txt is already saved; nothing was written. Approve a change with law approve instead.`);
    return 1;
  }
  out(`Saved ${saveAs}.txt`);
  return 0;
}

// Reads each section and bill the notes file names, one after another, and says whether its text is still the approved one.
// It writes nothing; a source with no fingerprint yet shows the one it now reads, for whoever approves it. By-hand sources
// are not read, since there is nothing to read them from. Exit 0 only when every source reads the same.
async function check({ readSource, lawUrl, out, err }) {
  let law;
  try {
    law = readLawFile(lawUrl);
  } catch (error) {
    err(`The notes file was not read: ${error?.message ?? error}`);
    return 1;
  }
  let allSame = true;
  let read = 0;
  for (const source of (Array.isArray(law.sources) ? law.sources : [])) {
    if (source?.kind !== 'section' && source?.kind !== 'bill' && source?.kind !== 'listing') continue;
    const got = await readSource(source);
    read += 1;
    if (!got.ok) {
      allSame = false;
      out(`${source.id}  unread ${got.reason}`);
      continue;
    }
    const now = statuteFingerprint({ text: got.text, repealed: got.repealed, repealedDate: got.repealedDate });
    let status;
    if (!source.fingerprint) status = `no fingerprint ${now}`;
    else if (now === source.fingerprint) status = 'same';
    else if (got.gone) status = 'gone from its law\'s current text (repealed or renumbered)';
    else status = `differs ${now}`;
    if (status !== 'same') allSame = false;
    out(`${source.id}  ${status}  ${got.activeDate}`);
  }
  // A file with nothing to read (the old shape lists URLs) must not pass for a file that was checked.
  if (!read) {
    err(`no sections or bills to read in ${lawUrl instanceof URL ? fileURLToPath(lawUrl) : lawUrl}`);
    return 1;
  }
  return allSame ? 0 : 1;
}

// A cell of a Markdown table: a pipe or a line break in it would split the row.
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

// Markdown made to be read as one page: each source with the notes and places that rest on it, then the places that state a
// period or amount and are not a rule. With --texts each section's approved text follows it, so the owner can read the law
// beside the notes. It reads the notes file and the saved texts only; it holds no key, makes no request and writes nothing.
const highest = value => (Array.isArray(value) && value.length ? Math.max(...value) : null);

function report(args, { lawUrl, statutesDir, out, err }) {
  const unknown = args.filter(arg => arg !== '--texts');
  if (unknown.length) {
    err('Usage: node law.mjs report [--texts]');
    return 2;
  }
  const withTexts = args.includes('--texts');
  let law;
  try {
    law = readLawFile(lawUrl);
  } catch (error) {
    err('The notes file was not read: ' + (error?.message ?? error));
    return 1;
  }
  // snapshotReader builds each file's address from the folder's, so the folder's must end in a slash.
  const folder = statutesDir instanceof URL ? statutesDir : pathToFileURL(String(statutesDir).replace(/[\\/]*$/, '/'));
  const snapshotOf = snapshotReader(folder);
  const list = value => (Array.isArray(value) ? value : []);
  out('# What the notes of current law rest on');
  out('');
  out('Verified as of ' + (earliestSourceDate(law) ?? 'no dated source') + '.');
  for (const source of list(law.sources)) {
    out('');
    out('## ' + (source.name ?? source.id));
    out('');
    out('- Id: ' + source.id);
    out('- Kind: ' + source.kind);
    if (source.url) out('- Address: ' + source.url);
    if (source.kind === 'by_hand') out('- Status: ' + (source.reviewed_on ? 'reviewed by hand on ' + source.reviewed_on : 'not yet reviewed by hand'));
    else if (source.kind === 'listing') out('- Status: read nightly from the State Bar\'s list; opinions marked reviewed through ' + (highest(source.seen) ?? 'none') + ', last on ' + (source.reviewed_on ?? 'no date'));
    else out('- Status: approved on ' + (source.approved_on ?? 'no date'));
    if (source.active_date) out('- Active date: ' + source.active_date);
    const notes = notesResting(law, source.id);
    out('');
    out('Notes resting on it:');
    if (!notes.length) out('- none');
    for (const note of notes) out('- ' + note.topic + ': ' + note.rule);
    const resting = requirementsResting(law, source.id);
    out('');
    out('Requirements resting on it:');
    if (!resting.length) out('- none');
    for (const item of resting) out('- ' + item.id + ': ' + item.does);
    const places = registeredPlaces(law, source.id);
    out('');
    if (!places.length) {
      out('Places that state it: none');
    } else {
      out('Places that state it:');
      out('');
      out('| File | Phrase | Count | About |');
      out('| --- | --- | --- | --- |');
      for (const place of places) out('| ' + [place.file, place.states, place.count, place.about].map(cell).join(' | ') + ' |');
    }
    if (withTexts && (source.kind === 'section' || source.kind === 'bill')) {
      const text = snapshotOf(source.id);
      out('');
      if (text === null) {
        out('No approved text saved.');
      } else {
        out('Approved text:');
        out('');
        out('~~~~');
        out(text.replace(/\n+$/, ''));
        out('~~~~');
      }
    }
  }
  const apart = list(law.register).filter(entry => entry?.rule === false);
  out('');
  out('## Places that state a period or amount and are not a rule');
  out('');
  if (!apart.length) {
    out('none');
  } else {
    out('| File | Phrase | Count | Why it is not a rule |');
    out('| --- | --- | --- | --- |');
    for (const place of apart) out('| ' + [place.file, place.states, place.count, place.about].map(cell).join(' | ') + ' |');
  }
  out('');
  out('## Requirements');
  out('');
  const requirements = list(law.requirements);
  if (!requirements.length) out('none');
  for (const item of requirements) {
    out('- ' + item.id + ': ' + item.does);
    out('  - Sources: ' + (list(item.sources).join(', ') || 'none'));
    out('  - Files: ' + (list(item.files).join(', ') || 'none'));
    out('  - Tests: ' + (list(item.tests).join(', ') || 'none'));
  }
  return 0;
}

// Today's date in New York as YYYY-MM-DD; the en-CA format is the one that orders year, month, day.
function todayInNewYork(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
}

const listOf = value => (Array.isArray(value) ? value : []);

// The file and the source of an id, or a refusal. Only an id the notes file holds is ever used for a path or a write.
function findSource(id, { lawUrl, err }) {
  let law;
  try {
    law = readLawFile(lawUrl);
  } catch (error) {
    err(`The notes file was not read: ${error?.message ?? error}`);
    return null;
  }
  const source = listOf(law?.sources).find(candidate => candidate?.id === id && SOURCE_ID.test(id));
  if (!source) {
    err(`${id} is not a source in the notes file; nothing was written.`);
    return null;
  }
  return { law, source };
}

// The notes that rest on a source and the places that state it: what the owner edits, in the same commit, if the rule moved.
function printRestingOn(law, id, out) {
  const notes = notesResting(law, id);
  out('Notes resting on it:');
  if (!notes.length) out('  none');
  for (const note of notes) out(`  ${note.topic}: ${note.rule}`);
  const places = registeredPlaces(law, id);
  out('Places that state it:');
  if (!places.length) out('  none');
  for (const place of places) out(`  ${place.file}  "${place.states}"  x${place.count}  ${place.about ?? ''}`.trimEnd());
}

// Records an approved text, after proving that the Senate still serves the very text the owner was emailed. Nothing is written
// until every check has passed; the text goes first, so a failure between the two writes leaves a file the check will flag
// rather than a fingerprint with no text behind it.
async function approve(args, { readSource, lawUrl, statutesDir, now, out, err }) {
  const [id, fingerprint, ...extra] = args;
  if (!id || extra.length || !/^sha256:[0-9a-f]{64}$/.test(fingerprint ?? '')) {
    err('Usage: node law.mjs approve <id> <fingerprint>   (the fingerprint is the sha256:... in the email)');
    return 2;
  }
  const found = findSource(id, { lawUrl, err });
  if (!found) return 1;
  const { law, source } = found;
  if (source.kind === 'by_hand') {
    err(`${id} is kept by hand, so there is no text to approve. Record a review with: npm run law:reviewed -- ${id}`);
    return 1;
  }
  if (source.kind === 'listing') {
    err(`${id} is the State Bar's list, so it is reviewed, not approved. Use: npm run law:reviewed -- ${id} <numbers>`);
    return 1;
  }
  if (source.kind !== 'section' && source.kind !== 'bill') {
    err(`${id} is a source of an unknown kind; nothing was written.`);
    return 1;
  }
  const read = await readSource(source);
  if (!read.ok) {
    err(`${id} was not read: ${read.reason}; nothing was written.`);
    return 1;
  }
  // A repeal's fingerprint can never match a saved text, so approving one would fail every run of the notes-file check, and a
  // repealed section is no longer something a note can rest on.
  if (read.gone) {
    err(`${id} is no longer in its law's current text: it was repealed or renumbered. Nothing was written. Edit the source and the notes resting on it by hand.`);
    printRestingOn(law, id, err);
    return 1;
  }
  if (read.repealed) {
    err(`${id} was repealed on ${read.repealedDate ?? 'a date the Senate does not give'}; nothing was written. Edit the source and the notes resting on it by hand.`);
    printRestingOn(law, id, err);
    return 1;
  }
  const current = statuteFingerprint(read);
  if (current !== fingerprint) {
    err(`The official text of ${id} is no longer the one emailed: it now has the fingerprint ${current}. `
      + 'It has changed again since that email; read the latest one (the next "has changed" email, or npm run law:check). Nothing was written.');
    return 1;
  }
  const folder = statutesDir instanceof URL ? fileURLToPath(statutesDir) : String(statutesDir);
  await mkdir(folder, { recursive: true });
  // Unlike fetch --save, this replaces the old approved text: that is what an approval is.
  await writeFile(join(folder, `${id}.txt`), `${read.text}\n`);
  source.fingerprint = current;
  source.approved_on = todayInNewYork(now);
  source.active_date = read.activeDate;
  writeLawFile(lawUrl, law);
  out(`Approved ${id}: text saved, fingerprint ${current}, approved on ${source.approved_on}, active ${source.active_date}.`);
  printRestingOn(law, id, out);
  out('If the rule changed, edit the note and every place listed in the same commit, then push.');
  return 0;
}

// Renews the review date of a source the API cannot serve, which the owner reads by hand; or, for the State Bar's list, marks
// the opinions the owner has read. Nothing is written until every argument has been checked.
function reviewed(args, { lawUrl, now, out, err }) {
  const [id, ...numbers] = args;
  const usage = 'Usage: node law.mjs reviewed <id> [numbers...]   (numbers are required for the State Bar\'s list, e.g. 1310 1311)';
  if (!id) {
    err(usage);
    return 2;
  }
  const found = findSource(id, { lawUrl, err });
  if (!found) return 1;
  const { law, source } = found;
  if (source.kind === 'listing') {
    const valid = numbers.length > 0 && numbers.every(value => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)));
    if (!valid) {
      err(usage);
      err('Each number must be a positive whole number written in digits.');
      return 2;
    }
    const merged = [...new Set([...listOf(source.seen), ...numbers.map(Number)])].sort((a, b) => a - b);
    source.seen = merged;
    source.reviewed_on = todayInNewYork(now);
    writeLawFile(lawUrl, law);
    out(`Marked opinions ${[...new Set(numbers.map(Number))].sort((a, b) => a - b).join(', ')} of ${id} as reviewed; reviewed_on is ${source.reviewed_on}. Commit the notes file and push it; the watch reads the deployed copy.`);
    return 0;
  }
  if (numbers.length) {
    err(usage);
    err(`${id} takes no numbers.`);
    return 2;
  }
  if (source.kind !== 'by_hand') {
    err(`${id} is read from the Senate, so it is approved, not reviewed. Use: npm run law:approve -- ${id} <fingerprint>`);
    return 1;
  }
  source.reviewed_on = todayInNewYork(now);
  writeLawFile(lawUrl, law);
  out(`Set reviewed_on of ${id} to ${source.reviewed_on}. Commit the notes file and push it; the watch reads the deployed copy.`);
  return 0;
}

export async function main(argv, deps = {}) {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const siteName = deps.siteName ?? SITE_NAME;
  const [command, ...args] = argv;
  if (command === 'test-alert') return testAlert({ notify: deps.notify, siteName, out, err });
  // The key is read when the command runs, not when this file loads.
  const key = () => process.env.NYSENATE_API_KEY;
  if (command === 'find') {
    return find(args, { readIndex: deps.readIndex ?? (() => fetchLawIndex({ key: key() })), readTree: deps.readTree ?? (lawId => fetchLawTree({ lawId, key: key() })), out, err });
  }
  if (command === 'fetch') {
    return fetchText(args, { readSource: deps.readSource ?? sourceReader(key()), statutesDir: deps.statutesDir ?? STATUTE_TEXTS_DIR, out, err });
  }
  if (command === 'check') {
    return check({ readSource: deps.readSource ?? sourceReader(key()), lawUrl: deps.lawUrl ?? CURRENT_LAW_FILE, out, err });
  }
  if (command === 'report') {
    return report(args, { lawUrl: deps.lawUrl ?? CURRENT_LAW_FILE, statutesDir: deps.statutesDir ?? STATUTE_TEXTS_DIR, out, err });
  }
  if (command === 'approve') {
    return approve(args, { readSource: deps.readSource ?? sourceReader(key()), lawUrl: deps.lawUrl ?? CURRENT_LAW_FILE, statutesDir: deps.statutesDir ?? STATUTE_TEXTS_DIR, now: deps.now ?? (() => new Date()), out, err });
  }
  if (command === 'reviewed') {
    return reviewed(args, { lawUrl: deps.lawUrl ?? CURRENT_LAW_FILE, now: deps.now ?? (() => new Date()), out, err });
  }
  usage(out);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
