// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The real notes file (rubrics/ny_malpractice_current_law.json): sound, written the way formatLawFile writes it, and holding
// a source for every statute the app's own files cite. It reads the repository's files and nothing else.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { readLawFile, formatLawFile, checkLawFile, snapshotReader } from '../law-file.js';
import { findStatuteCitations } from '../law-citations.js';
import { CURRENT_LAW_FILE, STATUTE_TEXTS_DIR } from '../gate-config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NEVER_SCANNED = new Set(['.env', '.env.demo', 'PROJECT_INSTRUCTIONS.md']);

const filesIn = (dir, pick) => {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter(name => !NEVER_SCANNED.has(name)).sort().map(name => join(dir, name)).filter(path => pick(name(path)) && statSync(path).isFile());
};
const name = path => path.split(sep).pop();

const filesUnder = (dir, extensions) => {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NEVER_SCANNED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path, extensions));
    else if (extensions.some(extension => entry.name.endsWith(extension))) found.push(path);
  }
  return found.sort();
};

// The statute watch's own five library files talk about statutes in general; every other root file is scanned, shared or not.
const LIBRARY_FILES = new Set(['statute-text.js', 'law-file.js', 'law-citations.js', 'statute-watch.js', 'law.mjs']);

// Every file whose statute citations the notes file must cover.
function scanList() {
  const files = [
    ...filesIn(ROOT, file => /\.(js|mjs)$/.test(file)).filter(path => !LIBRARY_FILES.has(name(path))),
    ...filesUnder(join(ROOT, 'public'), ['.html', '.js']),
    ...filesIn(join(ROOT, 'rubrics'), file => file.endsWith('.json')),
    ...filesIn(join(ROOT, 'content', 'blog'), file => file.endsWith('.md')),
  ];
  return files;
}

// A JSON file's strings are each their own text; any other file is read whole.
function textsOf(path) {
  const raw = readFileSync(path, 'utf8');
  if (!path.endsWith('.json')) return [raw];
  const texts = [];
  const walk = value => {
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(JSON.parse(raw));
  return texts;
}

test('the notes file is sound', () => {
  const law = readLawFile(CURRENT_LAW_FILE);
  assert.deepEqual(checkLawFile(law, { snapshotOf: snapshotReader(STATUTE_TEXTS_DIR) }), []);
  assert.equal(law.as_of, undefined);
  assert.ok(law.sources.length > 0 && law.sources.every(source => typeof source === 'object'));
  assert.ok(law.notes.every(note => Array.isArray(note.sources) && note.sources.length > 0), 'every note names its sources');
});

test('the notes file comes back from formatLawFile byte for byte', () => {
  const onDisk = readFileSync(fileURLToPath(CURRENT_LAW_FILE), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(formatLawFile(readLawFile(CURRENT_LAW_FILE)), onDisk);
});

test('every statute the app cites is a source of the notes', () => {
  const ids = new Set(readLawFile(CURRENT_LAW_FILE).sources.map(source => source.id));
  const missing = [];
  const found = new Set();
  for (const path of scanList()) {
    for (const text of textsOf(path)) {
      for (const { id, raw } of findStatuteCitations(text)) {
        found.add(id);
        if (!ids.has(id)) missing.push(`${relative(ROOT, path)}: ${raw} (${id})`);
      }
    }
  }
  assert.deepEqual(missing, [], `statutes cited with no source in the notes file:\n${missing.join('\n')}`);
  // Every source is cited somewhere the scan reaches, but the Grieving Families Act, a bill the citation finder has no form
  // for; a note rests on it by name.
  assert.deepEqual([...ids].filter(id => !found.has(id)), ['BILL-GRIEVING-FAMILIES-ACT']);
});

test('no scan list ever names .env, .env.demo or PROJECT_INSTRUCTIONS.md', () => {
  const names = scanList().map(path => name(path));
  for (const forbidden of NEVER_SCANNED) assert.ok(!names.includes(forbidden), `${forbidden} is on the scan list`);
  const listed = scanList().map(path => relative(ROOT, path).split(sep).join('/'));
  assert.ok(listed.includes('summary.js'), 'summary.js states legal periods, so it is scanned though it is shared');
  for (const library of LIBRARY_FILES) assert.ok(!listed.includes(library), `${library} is scanned`);
  assert.ok(listed.length > 10);
  assert.ok(listed.every(path => !path.startsWith('rubrics/statutes/') && !path.endsWith('.md') || path.startsWith('content/blog/')));
  assert.ok(listed.includes('rubrics/ny_malpractice_current_law.json'));
});
