// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The real notes file (rubrics/ny_malpractice_current_law.json): sound, written the way formatLawFile writes it, holding a
// source for every statute the app's own files cite, and registering every period and amount the files of its register
// state. It reads the repository's files and nothing else.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';
import { readLawFile, formatLawFile, checkLawFile, snapshotReader } from '../law-file.js';
import { findStatuteCitations, findStatedPeriods } from '../law-citations.js';
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

// A path as the register writes it: from the repository's root, with forward slashes on every system.
const posix = path => relative(ROOT, path).split(sep).join('/');
const escapeForPattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The register's scope, from register_files. Each item is a path from the repository's root, and only its file name may
// hold a * ("content/blog/*.md"). The three names above are never read, and Markdown counts only under content/blog/.
// What is wrong with the list comes back as problems, beside the files it gives.
function registerScope(law) {
  const files = [];
  const problems = [];
  const seen = new Set();
  const add = path => {
    if (seen.has(posix(path))) problems.push(`register_files: ${posix(path)} is listed more than once`);
    else if (!path.endsWith('.md') || posix(path).startsWith('content/blog/')) files.push(path);
    seen.add(posix(path));
  };
  const patterns = Array.isArray(law?.register_files) ? law.register_files : [];
  if (!patterns.length) problems.push('register_files is missing or empty, so no file would be checked');
  for (const pattern of patterns) {
    const folders = String(pattern).split('/');
    const file = folders.pop();
    if (NEVER_SCANNED.has(file)) problems.push(`register_files: ${pattern} is never read`);
    else if (file.endsWith('.md') && folders.join('/') !== 'content/blog') problems.push(`register_files: ${pattern} is Markdown outside content/blog/`);
    else if (folders.some(folder => folder.includes('*'))) problems.push(`register_files: ${pattern} has a * outside its file name`);
    else if (file.includes('*')) {
      const shape = new RegExp(`^${file.split('*').map(escapeForPattern).join('.*')}$`);
      const matched = filesIn(join(ROOT, ...folders), candidate => shape.test(candidate));
      if (!matched.length) problems.push(`register_files: ${pattern} matches no file`);
      matched.forEach(add);
    } else {
      const path = join(ROOT, ...folders, file);
      if (existsSync(path) && statSync(path).isFile()) add(path);
      else problems.push(`register_files: ${pattern} is not a file`);
    }
  }
  return { files, problems };
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

  // The register's scope is a scan list too: none of its items names one of the three, and its Markdown is the blog's.
  const law = readLawFile(CURRENT_LAW_FILE);
  for (const pattern of law.register_files) {
    const file = String(pattern).split('/').pop();
    assert.ok(!NEVER_SCANNED.has(file), `register_files names ${pattern}`);
    assert.ok(!file.endsWith('.md') || String(pattern).startsWith('content/blog/'), `register_files names Markdown outside the blog: ${pattern}`);
  }
  const scope = registerScope(law).files.map(posix);
  assert.ok(scope.length > 10);
  assert.ok(scope.every(path => !NEVER_SCANNED.has(path.split('/').pop()) && (!path.endsWith('.md') || path.startsWith('content/blog/'))));
});

test('every period and amount in the register\'s files is registered, as often as it appears', () => {
  const law = readLawFile(CURRENT_LAW_FILE);
  const { files, problems } = registerScope(law);
  const found = new Map(); // JSON [file, phrase] -> how many times findStatedPeriods reads it there
  for (const path of files) {
    for (const text of textsOf(path)) {
      for (const { phrase } of findStatedPeriods(text)) {
        const key = JSON.stringify([posix(path), phrase]);
        found.set(key, (found.get(key) ?? 0) + 1);
      }
    }
  }
  const inScope = new Set(files.map(posix));
  const registered = new Map();
  for (const entry of Array.isArray(law.register) ? law.register : []) {
    const key = JSON.stringify([entry?.file, entry?.states]);
    if (!inScope.has(entry?.file)) problems.push(`${entry?.file}: "${entry?.states}" is registered, but ${entry?.file} is not in register_files`);
    else if (registered.has(key)) problems.push(`${entry.file}: "${entry.states}" is registered more than once`);
    else if (!Number.isInteger(entry.count) || entry.count < 1) problems.push(`${entry.file}: "${entry.states}" has the count ${entry.count}, not a whole number above 0`);
    else registered.set(key, entry.count);
  }
  for (const key of new Set([...found.keys(), ...registered.keys()])) {
    const [file, phrase] = JSON.parse(key);
    const count = found.get(key) ?? 0;
    if (registered.get(key) !== count) problems.push(`${file}: "${phrase}" found ${count}, registered ${registered.get(key) ?? 0}`);
  }
  assert.deepEqual(problems, [], `periods and amounts the register does not hold as often as they appear:\n${problems.join('\n')}`);
});

test('every registered rule names sources, and every other entry says why it is not a rule', () => {
  const law = readLawFile(CURRENT_LAW_FILE);
  const problems = checkLawFile(law, { snapshotOf: snapshotReader(STATUTE_TEXTS_DIR) }).filter(problem => problem.startsWith('The register entry'));
  for (const entry of Array.isArray(law.register) ? law.register : []) {
    const where = `The register entry for "${entry?.states}" in ${entry?.file}`;
    if (typeof entry?.about !== 'string' || !entry.about.trim()) problems.push(`${where} has no about saying what it states or why it is not a rule.`);
    if (entry?.rule === false && Array.isArray(entry.sources) && entry.sources.length) problems.push(`${where} is marked rule: false and still names sources.`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
