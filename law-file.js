// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// law-file.js — the notes file (rubrics/ny_pi_current_law.json): reading it, checking it, dating it and writing it back.
// The same file in every app. It imports only node builtins and statute-text.js, never gatekeeper.js or anything that reaches
// db.js, because db.js loads the local .env as soon as it is imported.
//
// A source is a statute section or a bill (each with the fingerprint of its approved official text) or one reviewed by hand.
// A note names the sources it rests on, and the file's register names the ones the app's pages and code cite.
import { readFileSync, writeFileSync } from 'node:fs';
import { statuteFingerprint } from './statute-text.js';

const KINDS = ['section', 'bill', 'by_hand'];

export function readLawFile(url) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

// One format, so that a file written by the tools and one checked out on Windows compare the same.
export function formatLawFile(law) {
  return `${JSON.stringify(law, null, 2)}\n`;
}

export function writeLawFile(url, law) {
  writeFileSync(url, formatLawFile(law), 'utf8');
}

const listOf = value => (Array.isArray(value) ? value : []);
const present = value => value !== undefined && value !== null && value !== '';

export function notesResting(law, id) {
  return listOf(law?.notes).filter(note => listOf(note?.sources).includes(id));
}

export function registeredPlaces(law, id) {
  return listOf(law?.register).filter(entry => listOf(entry?.sources).includes(id));
}

// The earliest approval or review among the sources the notes rest on. A source only the register names does not count: the
// date is how old the oldest thing a prompt rests on is. A source not yet reviewed has no date to give.
export function earliestSourceDate(law) {
  const wanted = new Set(listOf(law?.notes).flatMap(note => listOf(note?.sources)));
  const dates = listOf(law?.sources)
    .filter(source => source && wanted.has(source.id))
    .map(source => (source.kind === 'by_hand' ? source.reviewed_on : source.approved_on))
    .filter(date => typeof date === 'string' && date);
  return dates.length ? dates.reduce((earliest, date) => (date < earliest ? date : earliest)) : null;
}

// A real calendar day written YYYY-MM-DD: 2026-02-30 and 11/23/2026 are not.
function isDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const moment = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(moment.getTime()) && moment.toISOString().slice(0, 10) === value;
}
const DATE_FIELDS = ['approved_on', 'active_date', 'reviewed_on'];

// What is wrong with the file, one plain sentence each; [] when it is sound. `snapshotOf(id)` gives the saved approved text
// of a section or bill, or null when none is saved.
export function checkLawFile(law, { snapshotOf } = {}) {
  const problems = [];
  if (Object.hasOwn(law ?? {}, 'as_of')) problems.push('The file still has an "as_of" date; the date now comes from the sources.');

  const sources = listOf(law?.sources);
  const known = new Map();
  for (const source of sources) {
    const id = source?.id;
    if (!present(id)) {
      problems.push('A source has no id.');
      continue;
    }
    if (known.has(id)) {
      problems.push(`The source id ${id} is used more than once.`);
      continue;
    }
    known.set(id, source);
    if (!KINDS.includes(source.kind)) {
      problems.push(`${id} has the kind "${source.kind}", which is not section, bill or by_hand.`);
      continue;
    }
    // A date that is not a real YYYY-MM-DD drops a source out of the 90-day reminder and can be taken for the earliest date.
    for (const field of DATE_FIELDS) {
      if (source[field] != null && !isDay(source[field])) problems.push(`${id} has ${field} "${source[field]}", which is not a real date written YYYY-MM-DD.`);
    }
    if (source.kind === 'by_hand') {
      if (!present(source.url)) problems.push(`${id} is a by-hand source with no url.`);
      // null means "not yet reviewed" and is allowed; leaving the key out is not.
      if (!Object.hasOwn(source, 'reviewed_on')) problems.push(`${id} is a by-hand source with no reviewed_on (null says it has not been reviewed).`);
      continue;
    }
    const identity = source.kind === 'section' ? ['lawId', 'locationId'] : ['session', 'printNo'];
    for (const key of identity) if (!present(source[key])) problems.push(`${id} is a ${source.kind} with no ${key}.`);
    if (!present(source.fingerprint)) problems.push(`${id} has no fingerprint.`);
    if (!present(source.approved_on)) problems.push(`${id} has no approved_on.`);
    const saved = typeof snapshotOf === 'function' ? snapshotOf(id) : null;
    if (saved === null || saved === undefined) {
      problems.push(`${id} has no saved approved text.`);
    } else if (present(source.fingerprint) && statuteFingerprint({ text: saved }) !== source.fingerprint) {
      problems.push(`The saved text of ${id} does not match its fingerprint.`);
    }
  }

  for (const note of listOf(law?.notes)) {
    if (!listOf(note?.sources).length) problems.push(`The note ${note?.id} names no sources.`);
    for (const id of listOf(note?.sources)) {
      const source = known.get(id);
      if (!source) problems.push(`The note ${note.id} rests on ${id}, which no source defines.`);
      else if (source.kind === 'by_hand' && source.reviewed_on === null) problems.push(`The note ${note.id} rests on ${id}, which has not been reviewed.`);
    }
  }

  for (const entry of listOf(law?.register)) {
    const where = `The register entry for "${entry?.states}" in ${entry?.file}`;
    const named = listOf(entry?.sources);
    for (const id of named) if (!known.has(id)) problems.push(`${where} names ${id}, which no source defines.`);
    if (!named.length && entry?.rule !== false) problems.push(`${where} names no source and is not marked rule: false.`);
  }
  return problems;
}

// id => the saved approved text (`${id}.txt` in the folder), or null when there is none. Any other failure is thrown.
export function snapshotReader(dirUrl) {
  return (id) => {
    try {
      return readFileSync(new URL(`${id}.txt`, dirUrl), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };
}
