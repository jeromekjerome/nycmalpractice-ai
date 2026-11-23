// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The notes file's reading, checking, dating and writing (law-file.js), on small law objects and temp folders. It never
// reads the real notes file.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readLawFile, formatLawFile, writeLawFile, checkLawFile, earliestSourceDate, notesResting, registeredPlaces, snapshotReader,
} from '../law-file.js';
import { statuteFingerprint } from '../statute-text.js';

const TEXT = 'S 214. Actions to be commenced within three years.';
const TEXTS = { 'CPLR-214': TEXT, 'BILL-2025-S1234': 'A bill text.' };
const snapshotOf = id => TEXTS[id] ?? null;

const sound = () => ({
  jurisdiction: 'New York',
  notes: [
    { id: 'N1', topic: 'Limits', rule: 'Three years.', sources: ['CPLR-214', 'NYCRR-1'] },
    { id: 'N2', topic: 'A bill', rule: 'Pending.', sources: ['BILL-2025-S1234'] },
  ],
  sources: [
    { id: 'CPLR-214', kind: 'section', name: 'CPLR § 214', lawId: 'CVP', locationId: '214', url: 'https://www.nysenate.gov/legislation/laws/CVP/214', fingerprint: statuteFingerprint({ text: TEXT }), approved_on: '2026-11-24', active_date: '2014-09-22' },
    { id: 'BILL-2025-S1234', kind: 'bill', name: 'S1234', session: 2025, printNo: 'S1234', url: 'https://www.nysenate.gov/legislation/bills/2025/S1234', fingerprint: statuteFingerprint({ text: 'A bill text.' }), approved_on: '2026-11-25', active_date: '2026-01-01' },
    { id: 'NYCRR-1', kind: 'by_hand', name: '11 NYCRR 1', url: 'https://example.test/1', reviewed_on: '2026-11-20' },
    { id: 'GML-50-I', kind: 'by_hand', name: 'GML 50-i', url: 'https://example.test/gml', reviewed_on: '2026-01-01' },
  ],
  register_files: ['ask.js'],
  register: [
    { file: 'ask.js', states: '3 years', count: 1, sources: ['CPLR-214'], about: 'the limit' },
    { file: 'ask.js', states: '6 months', count: 1, rule: false, about: 'not a legal rule' },
    { file: 'public/index.html', states: '90 days', count: 1, sources: ['GML-50-I'], about: 'notice of claim' },
  ],
});

function problemsOf(change) {
  const law = sound();
  change(law);
  return checkLawFile(law, { snapshotOf });
}

test('checkLawFile finds nothing wrong with a sound file', () => {
  assert.deepEqual(checkLawFile(sound(), { snapshotOf }), []);
});

test('checkLawFile names each defect', () => {
  const cases = [
    ['a note source no source defines', law => { law.notes[0].sources.push('NOPE-1'); }, /N1.*NOPE-1/],
    ['a duplicate source id', law => { law.sources.push({ ...law.sources[2] }); }, /NYCRR-1.*more than once/],
    ['a section without a fingerprint', law => { delete law.sources[0].fingerprint; }, /CPLR-214 has no fingerprint/],
    ['a section without approved_on', law => { delete law.sources[0].approved_on; }, /CPLR-214 has no approved_on/],
    ['a section without lawId', law => { delete law.sources[0].lawId; }, /CPLR-214.*no lawId/],
    ['a section without locationId', law => { law.sources[0].locationId = ''; }, /CPLR-214.*no locationId/],
    ['a bill without session', law => { delete law.sources[1].session; }, /BILL-2025-S1234.*no session/],
    ['a bill without printNo', law => { delete law.sources[1].printNo; }, /BILL-2025-S1234.*no printNo/],
    ['a snapshot that differs from the fingerprint', law => { law.sources[0].fingerprint = statuteFingerprint({ text: 'other' }); }, /CPLR-214.*does not match/],
    ['a section with no saved text', law => { law.sources[0].id = 'CPLR-999'; law.notes[0].sources[0] = 'CPLR-999'; law.register[0].sources = ['CPLR-999']; }, /CPLR-999 has no saved approved text/],
    ['a by-hand source without a url', law => { delete law.sources[2].url; }, /NYCRR-1.*no url/],
    ['a by-hand source without the key reviewed_on', law => { delete law.sources[2].reviewed_on; }, /NYCRR-1.*no reviewed_on/],
    ['a note on a by-hand source not yet reviewed', law => { law.sources[2].reviewed_on = null; }, /N1.*NYCRR-1.*not been reviewed/],
    ['an as_of left in the file', law => { law.as_of = '2026-11-14'; }, /as_of/],
    ['a kind that is none of the three', law => { law.sources[2].kind = 'rumor'; }, /NYCRR-1.*rumor/],
    ['a register entry naming an unknown source', law => { law.register[0].sources = ['NOPE-2']; }, /3 years.*NOPE-2/],
    ['a note with no sources key', law => { delete law.notes[1].sources; }, /N2.*no sources/],
    ['a note with an empty list of sources', law => { law.notes[1].sources = []; }, /N2.*no sources/],
    ['an approved_on written as 11/23/2026', law => { law.sources[0].approved_on = '11/23/2026'; }, /CPLR-214.*approved_on/],
    ['an active_date that is not a real day', law => { law.sources[1].active_date = '2026-13-01'; }, /BILL-2025-S1234.*active_date/],
    ['a reviewed_on written as 11/23/2026', law => { law.sources[2].reviewed_on = '11/23/2026'; }, /NYCRR-1.*reviewed_on/],
    ['a register entry with neither sources nor rule: false', law => { delete law.register[1].rule; }, /6 months.*ask\.js.*no source/],
  ];
  // Every case is tried, so a failure lists all the defects the check misses, not only the first.
  const missed = cases.filter(([, change, expected]) => !problemsOf(change).some(problem => expected.test(problem))).map(([name]) => name);
  assert.deepEqual(missed, []);
});

test('checkLawFile accepts real dates and a null reviewed_on, and flags 2026-02-30', () => {
  assert.deepEqual(problemsOf(law => { law.sources[2].reviewed_on = null; law.notes[0].sources = ['CPLR-214']; }), []);
  assert.equal(problemsOf(law => { law.sources[0].approved_on = '2026-02-30'; }).filter(problem => /CPLR-214.*approved_on/.test(problem)).length, 1);
});

test('checkLawFile accepts a by-hand source with reviewed_on null when no note rests on it', () => {
  const problems = problemsOf((law) => { law.sources[3].reviewed_on = null; });
  assert.deepEqual(problems, []);
});

test('earliestSourceDate takes the earliest approval or review among the sources the notes rest on', () => {
  // GML-50-I is older (2026-01-01) but only the register names it, so it is ignored.
  assert.equal(earliestSourceDate(sound()), '2026-11-20');
  const law = sound();
  law.sources[2].reviewed_on = null;
  assert.equal(earliestSourceDate(law), '2026-11-24');
  law.notes = [];
  assert.equal(earliestSourceDate(law), null);
  assert.equal(earliestSourceDate({ notes: [{ sources: ['X'] }], sources: [{ id: 'X', kind: 'by_hand', reviewed_on: null }] }), null);
});

test('notesResting and registeredPlaces find what names a source', () => {
  const law = sound();
  assert.deepEqual(notesResting(law, 'CPLR-214').map(note => note.id), ['N1']);
  assert.deepEqual(notesResting(law, 'GML-50-I'), []);
  assert.deepEqual(registeredPlaces(law, 'GML-50-I').map(entry => entry.file), ['public/index.html']);
  assert.deepEqual(registeredPlaces(law, 'BILL-2025-S1234'), []);
});

test('formatLawFile is two-space JSON with a final LF, and writeLawFile writes exactly that', () => {
  const law = { a: 1, b: [{ c: 'é' }] };
  assert.equal(formatLawFile(law), '{\n  "a": 1,\n  "b": [\n    {\n      "c": "é"\n    }\n  ]\n}\n');
  const dir = mkdtempSync(join(tmpdir(), 'law-file-'));
  try {
    const url = pathToFileURL(join(dir, 'law.json'));
    writeLawFile(url, law);
    const bytes = readFileSync(url);
    assert.equal(bytes.toString('utf8'), formatLawFile(law));
    assert.ok(!bytes.includes(13), 'no CR');
    assert.deepEqual(readLawFile(url), law);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshotReader reads id.txt from a folder, null when it is missing, and throws any other failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'law-file-'));
  try {
    writeFileSync(join(dir, 'CPLR-214.txt'), `${TEXT}\n`);
    mkdirSync(join(dir, 'BAD-1.txt'));
    const read = snapshotReader(pathToFileURL(`${dir}/`));
    assert.equal(read('CPLR-214'), `${TEXT}\n`);
    assert.equal(read('CPLR-999'), null);
    assert.throws(() => read('BAD-1'));
    // The saved file ends in a newline, and still has the fingerprint of the text.
    assert.equal(statuteFingerprint({ text: read('CPLR-214') }), statuteFingerprint({ text: TEXT }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
