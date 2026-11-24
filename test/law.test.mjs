// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The statute watch's command line (law.mjs): the test alert that proves a notice can reach the owner. The notice is a
// fake. Nothing here sends mail, reaches the Senate or touches a database.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from '../law.mjs';
import { statuteFingerprint } from '../statute-text.js';
import { formatLawFile } from '../law-file.js';

test('law test-alert sends one email naming the site and the statute watch', async () => {
  const sent = [];
  const code = await main(['test-alert'], { notify: async (subject, html) => { sent.push({ subject, html }); return { sent: true }; }, siteName: 'NYCInjury.ai', out: () => {}, err: () => {} });
  assert.equal(code, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, 'NYCInjury.ai: a test alert from the statute watch');
  assert.match(sent[0].html, /statute watch/);
  assert.match(sent[0].html, /law:test-alert/);
});

test('law with no command, or an unknown one, prints the commands and exits 2', async () => {
  for (const argv of [[], ['nope']]) {
    const printed = [];
    const code = await main(argv, { notify: async () => { throw new Error('no notice for a usage error'); }, out: line => printed.push(line), err: line => printed.push(line) });
    assert.equal(code, 2, JSON.stringify(argv));
    assert.match(printed.join('\n'), /test-alert/);
  }
});

test('law test-alert says so and exits 1 when the notice was not sent', async () => {
  const printed = [];
  const code = await main(['test-alert'], { notify: async () => ({ sent: false, reason: 'the mail settings are not set' }), siteName: 'NYCInjury.ai', out: () => {}, err: line => printed.push(line) });
  assert.equal(code, 1);
  assert.match(printed.join('\n'), /the mail settings are not set/);
});

test('law test-alert exits 1 for any result but sent: true, even one that gives no reason', async () => {
  for (const result of [undefined, {}, { sent: 'yes' }, null]) {
    const printed = [];
    const code = await main(['test-alert'], { notify: async () => result, siteName: 'NYCInjury.ai', out: () => {}, err: line => printed.push(line) });
    assert.equal(code, 1, JSON.stringify(result));
    assert.ok(printed.length > 0);
  }
});

test('law test-alert exits 1, and does not throw, when the notice itself throws', async () => {
  const printed = [];
  const code = await main(['test-alert'], { notify: async () => { throw new Error('boom'); }, siteName: 'NYCInjury.ai', out: () => {}, err: line => printed.push(line) });
  assert.equal(code, 1);
  assert.match(printed.join('\n'), /boom/);
});

// What the Senate would answer, for the commands that read it. The fakes stand in for the three readers.
const INDEX = { ok: true, laws: [
  { lawId: 'CVP', name: 'Civil Practice Law & Rules', lawType: 'CONSOLIDATED', chapter: '8' },
  { lawId: 'EPT', name: 'Estates, Powers & Trusts', lawType: 'CONSOLIDATED', chapter: '17B' },
] };
const TREE = { ok: true, documents: [
  { locationId: '', docType: 'CHAPTER', title: 'Civil Practice Law & Rules' },
  { locationId: '213', docType: 'SECTION', title: 'Actions to be commenced within six years' },
  { locationId: '214', docType: 'SECTION', title: 'Actions to be commenced within three years' },
  { locationId: '214-A', docType: 'SECTION', title: 'Action for medical malpractice' },
  { locationId: '215', docType: 'SECTION', title: 'Actions to be commenced within one year' },
] };
const READ = { ok: true, text: 'S 214. Actions\n1. an action', title: 'Three years', activeDate: '2014-09-22', repealed: false, repealedDate: null };

function collecting() {
  const lines = [];
  return { lines, out: line => lines.push(line), err: line => lines.push(line) };
}

test('law find and law fetch print from the API, with fakes', async () => {
  const found = collecting();
  const asked = [];
  const deps = { ...found, readIndex: async () => INDEX, readTree: async lawId => { asked.push(lawId); return TREE; } };
  assert.equal(await main(['find', 'civil practice'], deps), 0);
  assert.match(found.lines.join('\n'), /CVP/);
  assert.match(found.lines.join('\n'), /Civil Practice Law/);
  assert.doesNotMatch(found.lines.join('\n'), /EPT/);
  assert.deepEqual(asked, []);

  const sectioned = collecting();
  assert.equal(await main(['find', 'cvp', '214'], { ...deps, ...sectioned }), 0);
  const text = sectioned.lines.join('\n');
  assert.deepEqual(asked, ['CVP']);
  assert.match(text, /214\b/);
  assert.match(text, /214-A/);
  assert.doesNotMatch(text, /\b213\b/);

  const none = collecting();
  assert.equal(await main(['find', 'nothing like it'], { ...deps, ...none }), 1);
  assert.match(none.lines.join('\n'), /No law matches/);

  const fetched = collecting();
  const wanted = [];
  assert.equal(await main(['fetch', 'CVP', '214'], { ...fetched, readSource: async source => { wanted.push(source); return READ; } }), 0);
  assert.deepEqual(wanted, [{ kind: 'section', lawId: 'CVP', locationId: '214' }]);
  const shown = fetched.lines.join('\n');
  assert.match(shown, /S 214\. Actions/);
  assert.match(shown, /2014-09-22/);
  assert.match(shown, /repealed: false/);
  assert.ok(shown.includes(statuteFingerprint(READ)));

  const failed = collecting();
  assert.equal(await main(['fetch', 'CVP', '214'], { ...failed, readSource: async () => ({ ok: false, reason: 'status 404' }) }), 1);
  assert.match(failed.lines.join('\n'), /status 404/);
  const unreadIndex = collecting();
  assert.equal(await main(['find', 'cvp'], { ...unreadIndex, readIndex: async () => ({ ok: false, reason: 'the request timed out' }) }), 1);
  assert.match(unreadIndex.lines.join('\n'), /timed out/);
});

test('law find and law fetch need their arguments, and exit 2 without them', async () => {
  for (const argv of [['find'], ['fetch'], ['fetch', 'CVP']]) {
    const printed = collecting();
    assert.equal(await main(argv, { ...printed, readSource: async () => { throw new Error('no read for a usage error'); }, readIndex: async () => { throw new Error('no read for a usage error'); } }), 2, JSON.stringify(argv));
    assert.match(printed.lines.join('\n'), /Usage/);
  }
});

test('law fetch --save saves the Senate\'s backslash-n as a line break', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'statutes-'));
  try {
    const printed = collecting();
    const code = await main(['fetch', 'CVP', '214', '--save', 'CPLR-214'], { ...printed, statutesDir: join(dir, 'statutes'), readSource: async () => ({ ...READ, text: '§ 214. Actions\\n  1. an action' }) });
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, 'statutes', 'CPLR-214.txt'), 'utf8'), '§ 214. Actions\n1. an action\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law fetch --save writes the tidied text with LF and a final newline, and never overwrites', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'statutes-'));
  const statutesDir = join(dir, 'statutes');
  try {
    const deps = { readSource: async () => ({ ...READ, text: 'S 214.\u00a0Actions\r\n  1. an action  ' }), statutesDir };
    const first = collecting();
    assert.equal(await main(['fetch', 'CVP', '214', '--save', 'CPLR-214'], { ...first, ...deps }), 0);
    const file = join(statutesDir, 'CPLR-214.txt');
    assert.equal(readFileSync(file, 'utf8'), 'S 214. Actions\n1. an action\n');

    const second = collecting();
    assert.equal(await main(['fetch', 'CVP', '214', '--save', 'CPLR-214'], { ...second, ...deps, readSource: async () => ({ ...READ, text: 'something else' }) }), 1);
    assert.match(second.lines.join('\n'), /already/);
    assert.equal(readFileSync(file, 'utf8'), 'S 214. Actions\n1. an action\n');

    for (const id of ['../escape', 'cplr-214', 'CPLR', 'CPLR-214/x', 'CPLR-214\\x', '']) {
      const refused = collecting();
      assert.equal(await main(['fetch', 'CVP', '214', '--save', id], { ...refused, ...deps }), 2, id);
    }
    assert.equal(await main(['fetch', 'CVP', '214', '--save'], { ...collecting(), ...deps }), 2);
    assert.deepEqual(readdirSync(statutesDir), ['CPLR-214.txt']);

    const unread = collecting();
    assert.equal(await main(['fetch', 'CVP', '215', '--save', 'CPLR-215'], { ...unread, ...deps, readSource: async () => ({ ok: false, reason: 'status 500' }) }), 1);
    assert.equal(existsSync(join(statutesDir, 'CPLR-215.txt')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law check on a file with no section or bill says so and exits 1, writing nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-check-'));
  try {
    const file = join(dir, 'law.json');
    const original = `${JSON.stringify({ as_of: '2026-11-14', sources: ['https://example.test/a'], notes: [] }, null, 2)}\n`;
    writeFileSync(file, original);
    const io = collecting();
    const code = await main(['check'], { ...io, readSource: async () => { throw new Error('nothing to read'); }, lawUrl: pathToFileURL(file) });
    assert.equal(code, 1);
    assert.match(io.lines.join('\n'), /no sections or bills to read in .*law\.json/);
    assert.equal(readFileSync(file, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law check prints same, differs, unread and no fingerprint, and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-check-'));
  try {
    const FP = statuteFingerprint({ text: 'S 214. Actions\n1. an action' });
    const law = {
      notes: [],
      sources: [
        { id: 'CPLR-214', kind: 'section', lawId: 'CVP', locationId: '214', fingerprint: FP },
        { id: 'CPLR-215', kind: 'section', lawId: 'CVP', locationId: '215', fingerprint: FP },
        { id: 'CPLR-216', kind: 'section', lawId: 'CVP', locationId: '216', fingerprint: FP },
        { id: 'CPLR-217', kind: 'section', lawId: 'CVP', locationId: '217' },
        { id: 'BILL-2025-S1', kind: 'bill', session: 2025, printNo: 'S1', fingerprint: FP },
        { id: 'NYCRR-1', kind: 'by_hand', url: 'https://example.test', reviewed_on: '2026-11-14' },
      ],
    };
    const file = join(dir, 'law.json');
    const original = `${JSON.stringify(law, null, 2)}\n`;
    writeFileSync(file, original);
    const asked = [];
    const readSource = async (source) => {
      asked.push(source.kind === 'bill' ? source.printNo : source.locationId);
      if (source.locationId === '215') return { ...READ, text: 'S 215. Something else' };
      if (source.locationId === '216') return { ok: false, reason: 'status 500' };
      return READ;
    };
    const run = async (lawUrl) => {
      const io = collecting();
      const code = await main(['check'], { ...io, readSource, lawUrl });
      return { code, text: io.lines.join('\n'), lines: io.lines };
    };
    const first = await run(pathToFileURL(file));
    assert.equal(first.code, 1);
    assert.deepEqual(asked, ['214', '215', '216', '217', 'S1'], 'every section and bill is read, one after another, by-hand ones are not');
    assert.match(first.lines[0], /^CPLR-214\s+same\s+2014-09-22$/);
    assert.match(first.lines[1], /^CPLR-215\s+differs sha256:[0-9a-f]{64}\s+2014-09-22$/);
    assert.match(first.lines[2], /^CPLR-216\s+unread status 500/);
    assert.match(first.lines[3], /^CPLR-217\s+no fingerprint sha256:[0-9a-f]{64}\s+2014-09-22$/);
    assert.match(first.lines[4], /^BILL-2025-S1\s+same/);
    assert.equal(readFileSync(file, 'utf8'), original, 'nothing is written');
    assert.deepEqual(readdirSync(dir), ['law.json']);

    // Only when every source reads the same does it exit 0.
    writeFileSync(file, `${JSON.stringify({ notes: [], sources: [law.sources[0], law.sources[5]] }, null, 2)}\n`);
    const clean = await run(pathToFileURL(file));
    assert.equal(clean.code, 0);
    assert.match(clean.text, /CPLR-214\s+same/);
    assert.doesNotMatch(clean.text, /NYCRR-1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law report prints each source with its notes and its places', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-report-'));
  try {
    const statutesDir = join(dir, 'statutes');
    mkdirSync(statutesDir);
    writeFileSync(join(statutesDir, 'CPLR-214.txt'), 'S 214. Actions to be commenced within three years\n');
    const law = {
      sources: [
        { id: 'CPLR-214', kind: 'section', name: 'CPLR 214', lawId: 'CVP', locationId: '214', url: 'https://example.test/214', fingerprint: 'sha256:x', approved_on: '2026-11-14', active_date: '2014-09-22' },
        { id: 'NYCRR-1', kind: 'by_hand', name: 'Court rule 1', url: 'https://example.test/rule', reviewed_on: null },
      ],
      notes: [{ id: 'n1', topic: 'Time to sue', rule: 'Three years for most injuries.', sources: ['CPLR-214'] }],
      register: [
        { file: 'public/index.html', states: 'three years', count: 2, sources: ['CPLR-214'], about: 'the time to sue' },
        { file: 'public/faq.html', states: '33 1/3%', count: 1, rule: false, about: 'a fee example, not a rule' },
      ],
    };
    const file = join(dir, 'law.json');
    const original = `${JSON.stringify(law, null, 2)}\n`;
    writeFileSync(file, original);
    const run = async (...flags) => {
      const io = collecting();
      const code = await main(['report', ...flags], { ...io, lawUrl: pathToFileURL(file), statutesDir: pathToFileURL(`${statutesDir}/`) });
      return { code, text: io.lines.join('\n') };
    };
    const plain = await run();
    assert.equal(plain.code, 0);
    assert.match(plain.text, /Time to sue/);
    assert.match(plain.text, /public\/index\.html/);
    assert.match(plain.text, /public\/faq\.html/);
    assert.match(plain.text, /a fee example, not a rule/);
    assert.match(plain.text, /not yet reviewed by hand/);
    assert.match(plain.text, /approved on 2026-11-14/);
    assert.doesNotMatch(plain.text, /within three years\n/);
    const texts = await run('--texts');
    assert.equal(texts.code, 0);
    assert.match(texts.text, /Actions to be commenced within three years/);
    assert.equal((await run('--nope')).code, 2);
    assert.equal(readFileSync(file, 'utf8'), original, 'nothing is written');
    assert.deepEqual(readdirSync(dir).sort(), ['law.json', 'statutes']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law report keeps a bar in a phrase or a reason inside its table cell', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-report-'));
  try {
    const file = join(dir, 'law.json');
    const law = {
      sources: [{ id: 'CPLR-214', kind: 'section', name: 'CPLR 214', approved_on: '2026-11-14' }],
      notes: [],
      register: [
        { file: 'public/a.html', states: '3 years | 30 days', count: 1, sources: ['CPLR-214'], about: 'either | or' },
        { file: 'public/b.html', states: '5%', count: 1, rule: false, about: 'a fee | not a rule' },
      ],
    };
    writeFileSync(file, `${JSON.stringify(law, null, 2)}\n`);
    const io = collecting();
    assert.equal(await main(['report'], { ...io, lawUrl: pathToFileURL(file) }), 0);
    const rows = io.lines.join('\n').split('\n').filter(line => /^\| public\//.test(line));
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(row.split(/(?<!\\)\|/).length - 2, 4, row);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A small notes file and statutes folder in a temp folder, for approve and reviewed. 3 a.m. UTC on the 23rd is still the 22nd
// in New York, so the fixed clock also proves that "today" is New York's.
const NOW = () => new Date('2026-11-23T03:00:00Z');
const NEW_READ = { ...READ, text: 'S 214. Actions\n2. a changed action', activeDate: '2026-10-01' };

function approvalWorld(dir) {
  const statutesDir = join(dir, 'statutes');
  mkdirSync(statutesDir);
  writeFileSync(join(statutesDir, 'CPLR-214.txt'), 'S 214. Actions\n1. an action\n');
  const law = {
    as_of: '2026-11-14',
    sources: [
      { id: 'CPLR-214', kind: 'section', name: 'CPLR 214', lawId: 'CVP', locationId: '214', url: 'https://example.test/214', fingerprint: statuteFingerprint(READ), approved_on: '2026-11-14', active_date: '2014-09-22' },
      { id: 'BILL-2025-S1', kind: 'bill', name: 'Bill S1', session: 2025, printNo: 'S1', url: 'https://example.test/s1', fingerprint: statuteFingerprint(READ), approved_on: '2026-11-14', active_date: '2025-01-01' },
      { id: 'NYCRR-1', kind: 'by_hand', name: 'Court rule 1', url: 'https://example.test/rule', reviewed_on: '2026-01-01' },
    ],
    notes: [{ id: 'n1', topic: 'Time to sue', rule: 'Three years for most injuries.', sources: ['CPLR-214'] }],
    register: [
      { file: 'public/index.html', states: 'three years', count: 2, sources: ['CPLR-214'], about: 'the time to sue' },
      { file: 'public/faq.html', states: '33 1/3%', count: 1, rule: false, about: 'a fee example, not a rule' },
    ],
  };
  const file = join(dir, 'law.json');
  writeFileSync(file, formatLawFile(law));
  return { law, file, statutesDir, deps: { lawUrl: pathToFileURL(file), statutesDir, now: NOW } };
}

const folderState = dir => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]);

test('law approve with the emailed fingerprint writes the text and the date, and nothing else in the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-approve-'));
  try {
    const { law, file, statutesDir, deps } = approvalWorld(dir);
    const io = collecting();
    const fingerprint = statuteFingerprint(NEW_READ);
    const code = await main(['approve', 'CPLR-214', fingerprint], { ...io, ...deps, readSource: async () => NEW_READ });
    assert.equal(code, 0, io.lines.join('\n'));
    const expected = structuredClone(law);
    Object.assign(expected.sources[0], { fingerprint, approved_on: '2026-11-22', active_date: '2026-10-01' });
    assert.equal(readFileSync(file, 'utf8'), formatLawFile(expected));
    const saved = readFileSync(join(statutesDir, 'CPLR-214.txt'), 'utf8');
    assert.equal(saved, 'S 214. Actions\n2. a changed action\n');
    assert.ok(!saved.includes('\r'));
    assert.deepEqual(readdirSync(statutesDir), ['CPLR-214.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law approve refuses a fingerprint that is no longer the official text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-approve-'));
  try {
    const { file, statutesDir, deps } = approvalWorld(dir);
    const before = readFileSync(file, 'utf8');
    const folderBefore = folderState(statutesDir);
    const io = collecting();
    const emailed = statuteFingerprint({ text: 'an earlier change' });
    const code = await main(['approve', 'CPLR-214', emailed], { ...io, ...deps, readSource: async () => NEW_READ });
    assert.equal(code, 1);
    const said = io.lines.join('\n');
    assert.ok(said.includes(statuteFingerprint(NEW_READ)), 'names the current fingerprint');
    assert.match(said, /changed again/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(folderState(statutesDir), folderBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law approve refuses when the text cannot be read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-approve-'));
  try {
    const { file, statutesDir, deps } = approvalWorld(dir);
    const before = readFileSync(file, 'utf8');
    const folderBefore = folderState(statutesDir);
    const io = collecting();
    const code = await main(['approve', 'CPLR-214', statuteFingerprint(NEW_READ)], { ...io, ...deps, readSource: async () => ({ ok: false, reason: 'status 503' }) });
    assert.equal(code, 1);
    assert.match(io.lines.join('\n'), /status 503/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(folderState(statutesDir), folderBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law approve refuses a repealed text, and says what to edit by hand, writing nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-approve-'));
  try {
    const { file, statutesDir, deps } = approvalWorld(dir);
    const before = readFileSync(file, 'utf8');
    const folderBefore = folderState(statutesDir);
    const repealed = { ...NEW_READ, repealed: true, repealedDate: '2026-09-01' };
    const io = collecting();
    const code = await main(['approve', 'CPLR-214', statuteFingerprint(repealed)], { ...io, ...deps, readSource: async () => repealed });
    assert.equal(code, 1);
    const said = io.lines.join('\n');
    assert.match(said, /repealed on 2026-09-01/);
    assert.match(said, /by hand/);
    assert.match(said, /Time to sue/);
    assert.match(said, /public\/index\.html/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(folderState(statutesDir), folderBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law approve refuses a section gone from its law, and says what to edit by hand, writing nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-approve-'));
  try {
    const { file, statutesDir, deps } = approvalWorld(dir);
    const before = readFileSync(file, 'utf8');
    const folderBefore = folderState(statutesDir);
    const gone = { ...NEW_READ, repealed: true, repealedDate: null, gone: true };
    const io = collecting();
    const code = await main(['approve', 'CPLR-214', statuteFingerprint(gone)], { ...io, ...deps, readSource: async () => gone });
    assert.equal(code, 1);
    const said = io.lines.join('\n');
    assert.ok(said.includes("CPLR-214 is no longer in its law's current text: it was repealed or renumbered. Nothing was written. Edit the source and the notes resting on it by hand."));
    assert.match(said, /Time to sue/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(folderState(statutesDir), folderBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law check says a section is gone from its law, and exits 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-check-'));
  try {
    const FP = statuteFingerprint({ text: 'S 214. Actions\n1. an action' });
    const file = join(dir, 'law.json');
    writeFileSync(file, `${JSON.stringify({ notes: [], sources: [{ id: 'CPLR-214', kind: 'section', lawId: 'CVP', locationId: '214', fingerprint: FP }] }, null, 2)}\n`);
    const io = collecting();
    const code = await main(['check'], { ...io, lawUrl: pathToFileURL(file), readSource: async () => ({ ...READ, repealed: true, repealedDate: null, gone: true }) });
    assert.equal(code, 1);
    assert.match(io.lines[0], /^CPLR-214\s+gone from its law's current text \(repealed or renumbered\)/);
    assert.doesNotMatch(io.lines[0], /differs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law approve refuses an unknown id and a by-hand source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-approve-'));
  try {
    const { file, statutesDir, deps } = approvalWorld(dir);
    const before = readFileSync(file, 'utf8');
    const folderBefore = folderState(statutesDir);
    const fingerprint = statuteFingerprint(NEW_READ);
    const readSource = async () => { throw new Error('nothing is read for a refused id'); };
    const unknown = collecting();
    assert.equal(await main(['approve', 'CPLR-999', fingerprint], { ...unknown, ...deps, readSource }), 1);
    assert.match(unknown.lines.join('\n'), /CPLR-999/);
    const byHand = collecting();
    assert.equal(await main(['approve', 'NYCRR-1', fingerprint], { ...byHand, ...deps, readSource }), 1);
    assert.match(byHand.lines.join('\n'), /law:reviewed -- NYCRR-1/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(folderState(statutesDir), folderBefore);
    assert.deepEqual(readdirSync(dir).sort(), ['law.json', 'statutes']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law approve and law reviewed exit 2 on a missing argument or a fingerprint of the wrong shape', async () => {
  const readSource = async () => { throw new Error('no read for a usage error'); };
  const dir = mkdtempSync(join(tmpdir(), 'law-approve-'));
  try {
    const { file, deps } = approvalWorld(dir);
    const before = readFileSync(file, 'utf8');
    const good = statuteFingerprint(NEW_READ);
    const cases = [
      ['approve'], ['approve', 'CPLR-214'], ['approve', 'CPLR-214', 'sha256:abc'], ['approve', 'CPLR-214', good.toUpperCase()],
      ['approve', 'CPLR-214', good.slice(7)], ['approve', 'CPLR-214', good, 'extra'],
      ['reviewed'], ['reviewed', 'NYCRR-1', 'extra'],
    ];
    for (const argv of cases) {
      const io = collecting();
      assert.equal(await main(argv, { ...io, ...deps, readSource }), 2, JSON.stringify(argv));
      assert.match(io.lines.join('\n'), /Usage/);
    }
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law reviewed renews a by-hand source and refuses any other', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-approve-'));
  try {
    const { law, file, statutesDir, deps } = approvalWorld(dir);
    const folderBefore = folderState(statutesDir);
    const io = collecting();
    assert.equal(await main(['reviewed', 'NYCRR-1'], { ...io, ...deps }), 0);
    assert.ok(io.lines.join('\n').includes('Commit the notes file and push it; the watch reads the deployed copy.'));
    const expected = structuredClone(law);
    expected.sources[2].reviewed_on = '2026-11-22';
    assert.equal(readFileSync(file, 'utf8'), formatLawFile(expected));
    assert.match(io.lines.join('\n'), /2026-11-22/);
    assert.deepEqual(folderState(statutesDir), folderBefore);

    const afterReview = readFileSync(file, 'utf8');
    for (const id of ['CPLR-214', 'BILL-2025-S1']) {
      const refused = collecting();
      assert.equal(await main(['reviewed', id], { ...refused, ...deps }), 1, id);
      assert.match(refused.lines.join('\n'), /law:approve/);
    }
    const unknown = collecting();
    assert.equal(await main(['reviewed', 'NYCRR-9'], { ...unknown, ...deps }), 1);
    assert.match(unknown.lines.join('\n'), /NYCRR-9/);
    assert.equal(readFileSync(file, 'utf8'), afterReview);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law approve prints the notes and places to edit if the rule changed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-approve-'));
  try {
    const { deps } = approvalWorld(dir);
    const io = collecting();
    assert.equal(await main(['approve', 'CPLR-214', statuteFingerprint(NEW_READ)], { ...io, ...deps, readSource: async () => NEW_READ }), 0);
    const said = io.lines.join('\n');
    assert.match(said, /Time to sue/);
    assert.match(said, /Three years for most injuries\./);
    assert.match(said, /public\/index\.html/);
    assert.match(said, /three years/);
    assert.doesNotMatch(said, /public\/faq\.html/);
    assert.match(said, /If the rule changed, edit the note and every place listed in the same commit, then push\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A notes file with the State Bar's list of opinions and a requirement resting on it.
function listingWorld(dir) {
  const { law, file, statutesDir, deps } = approvalWorld(dir);
  law.sources.push({ id: 'NYSBA-OPINIONS', kind: 'listing', name: 'State Bar opinions', url: 'https://example.test/opinions', watch_from: 1300, seen: [1301, 1305], fingerprint: 'sha256:abc', reviewed_on: '2026-11-01' });
  law.requirements = [
    { id: 'REQ-1', does: 'Tells visitors who is answering', sources: ['NYSBA-OPINIONS', 'CPLR-214'], files: ['public/index.html'], tests: ['test/law.test.mjs'] },
  ];
  writeFileSync(file, formatLawFile(law));
  return { law, file, statutesDir, deps };
}

test('law reviewed adds opinion numbers to a listing in numeric order, once each, and sets the date', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-listing-'));
  try {
    const { law, file, deps } = listingWorld(dir);
    const io = collecting();
    assert.equal(await main(['reviewed', 'NYSBA-OPINIONS', '1311', '1310'], { ...io, ...deps }), 0);
    const expected = structuredClone(law);
    const listing = expected.sources.find(source => source.id === 'NYSBA-OPINIONS');
    listing.seen = [1301, 1305, 1310, 1311];
    listing.reviewed_on = '2026-11-22';
    assert.equal(readFileSync(file, 'utf8'), formatLawFile(expected));
    assert.match(io.lines.join('\n'), /1310, 1311/);
    assert.match(io.lines.join('\n'), /2026-11-22/);
    assert.ok(io.lines.join('\n').includes('Commit the notes file and push it; the watch reads the deployed copy.'));
    const after = readFileSync(file, 'utf8');
    const again = collecting();
    assert.equal(await main(['reviewed', 'NYSBA-OPINIONS', '1310', '1310', '1305'], { ...again, ...deps }), 0);
    assert.equal(readFileSync(file, 'utf8'), after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law reviewed refuses bad numbers, no numbers, and numbers for a by-hand source, writing nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-listing-'));
  try {
    const { file, deps } = listingWorld(dir);
    const before = readFileSync(file, 'utf8');
    const cases = [
      ['reviewed', 'NYSBA-OPINIONS'], ['reviewed', 'NYSBA-OPINIONS', '13x0'], ['reviewed', 'NYSBA-OPINIONS', '1310', '13x0'],
      ['reviewed', 'NYSBA-OPINIONS', '0'], ['reviewed', 'NYSBA-OPINIONS', '-5'], ['reviewed', 'NYSBA-OPINIONS', '12.5'],
      ['reviewed', 'NYSBA-OPINIONS', '1e3'], ['reviewed', 'NYSBA-OPINIONS', ''],
      ['reviewed', 'NYCRR-1', '1310'],
    ];
    for (const argv of cases) {
      const io = collecting();
      assert.equal(await main(argv, { ...io, ...deps }), 2, JSON.stringify(argv));
      assert.match(io.lines.join('\n'), /Usage|number/);
      assert.equal(readFileSync(file, 'utf8'), before, JSON.stringify(argv));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law approve on a listing exits 1 and points to law:reviewed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-listing-'));
  try {
    const { file, deps } = listingWorld(dir);
    const before = readFileSync(file, 'utf8');
    const io = collecting();
    const readSource = async () => { throw new Error('nothing is read for a listing'); };
    assert.equal(await main(['approve', 'NYSBA-OPINIONS', statuteFingerprint(NEW_READ)], { ...io, ...deps, readSource }), 1);
    assert.match(io.lines.join('\n'), /law:reviewed -- NYSBA-OPINIONS <numbers>/);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law check reads a listing and prints same or differs, and a file with only a listing is not empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-listing-'));
  try {
    const file = join(dir, 'law.json');
    const FP = 'sha256:' + 'a'.repeat(64);
    const law = { notes: [], sources: [{ id: 'NYSBA-OPINIONS', kind: 'listing', url: 'https://example.test/opinions', watch_from: 1300, seen: [], fingerprint: FP }] };
    writeFileSync(file, formatLawFile(law));
    const asked = [];
    const run = async (text) => {
      const io = collecting();
      const code = await main(['check'], { ...io, lawUrl: pathToFileURL(file), readSource: async (source) => { asked.push(source.kind); return { ok: true, text, repealed: false, repealedDate: null, activeDate: '2026-11-23' }; } });
      return { code, text: io.lines.join('\n') };
    };
    const same = await run('x');
    law.sources[0].fingerprint = statuteFingerprint({ text: 'x', repealed: false, repealedDate: null });
    writeFileSync(file, formatLawFile(law));
    const equal = await run('x');
    assert.equal(equal.code, 0);
    assert.match(equal.text, /^NYSBA-OPINIONS\s+same/m);
    assert.equal(same.code, 1);
    assert.match(same.text, /^NYSBA-OPINIONS\s+differs sha256:[0-9a-f]{64}/m);
    assert.doesNotMatch(same.text, /no sections or bills/);
    assert.deepEqual(asked, ['listing', 'listing']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('law report shows a listing status, the requirements resting on each source, and a closing Requirements list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-listing-'));
  try {
    const { file, statutesDir } = listingWorld(dir);
    writeFileSync(join(statutesDir, 'NYSBA-OPINIONS.txt'), 'SHOULD NOT APPEAR\n');
    const before = readFileSync(file, 'utf8');
    const run = async (...flags) => {
      const io = collecting();
      const code = await main(['report', ...flags], { ...io, lawUrl: pathToFileURL(file), statutesDir: pathToFileURL(`${statutesDir}/`) });
      return { code, text: io.lines.join('\n') };
    };
    const plain = await run();
    assert.equal(plain.code, 0);
    assert.match(plain.text, /read nightly from the State Bar's list; opinions marked reviewed through 1305, last on 2026-11-01/);
    assert.match(plain.text, /Requirements resting on it:\n- REQ-1: Tells visitors who is answering/);
    assert.equal((plain.text.match(/Requirements resting on it:/g) ?? []).length, 4);
    assert.match(plain.text, /Requirements resting on it:\n- none/);
    const closing = plain.text.slice(plain.text.indexOf('## Requirements'));
    assert.match(closing, /REQ-1/);
    assert.match(closing, /Tells visitors who is answering/);
    assert.match(closing, /NYSBA-OPINIONS, CPLR-214/);
    assert.match(closing, /public\/index\.html/);
    assert.match(closing, /test\/law\.test\.mjs/);
    const texts = await run('--texts');
    assert.equal(texts.code, 0);
    assert.doesNotMatch(texts.text, /SHOULD NOT APPEAR/);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
