// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The one- or two-sentence summary firms see before they bid. The AI is told to leave the visitor's details out; this
// checks that it did, and swaps in a plain sentence naming only the case type when it did not.

const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'jr', 'sr', 'ii', 'iii', 'iv', 'esq']);
const STREET_WORDS = 'street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|place|pl|court|ct|parkway|pkwy|highway|hwy|terrace|ter';
const NOT_A_HOUSE_NUMBER = 'minutes?|hours?|days?|weeks?|months?|years?|times?|dollars?|percent';

const PHONE_SHAPE = /(?<!\d)(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}(?!\d)/;
const EMAIL_SHAPE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// A number, up to two more words, then a street word, in any case: "123 main street", "45 W 34th St". A number followed
// by a unit of time or amount ("3 weeks in court") is not a house number.
const STREET_SHAPE = new RegExp(String.raw`(?<![\p{L}\d])\d+[A-Za-z]?\s+(?!(?:${NOT_A_HOUSE_NUMBER})(?![\p{L}]))(?:[\p{L}\d][\p{L}\d.]*\s+){0,2}(?:${STREET_WORDS})(?![\p{L}\d])`, 'iu');

// Every comparable form of one run of letters: with its apostrophes, without them, and each piece between them.
function forms(run) {
  const plain = run.replace(/[’‘`]/g, "'").replace(/^'+|'+$/g, '');
  const out = new Set([plain, plain.replace(/'/g, ''), ...plain.split("'")]);
  return [...out].map((word) => word.toLowerCase()).filter((word) => [...word].length >= 2);
}

function nameParts(name) {
  const parts = new Set();
  for (const run of String(name || '').match(/[\p{L}'’‘`]+/gu) || []) {
    for (const form of forms(run)) if (!TITLES.has(form)) parts.add(form);
  }
  return parts;
}

function holdsName(text, name) {
  const parts = nameParts(name);
  if (!parts.size) return false;
  for (const run of text.match(/[\p{L}'’‘`]+/gu) || []) {
    for (const form of forms(run)) if (parts.has(form)) return true;
  }
  return false;
}

function holdsVisitorNumber(text, phone) {
  const wanted = String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (wanted.length < 7) return false;
  for (const run of text.match(/\d[\d\s.()+-]*\d/g) || []) {
    if (run.replace(/\D/g, '').includes(wanted)) return true;
  }
  return false;
}

function holdsVisitorEmail(text, email) {
  const wanted = String(email || '').trim().toLowerCase();
  return wanted.length > 0 && text.toLowerCase().includes(wanted);
}

function fallbackFor(caseLabel) {
  const label = String(caseLabel || '').trim() || 'injury';
  return `${/^[aeiou]/i.test(label) ? 'An' : 'A'} ${label} request in New York.`;
}

export function previewForFirms(preview, contact, caseLabel) {
  const text = typeof preview === 'string' ? preview.trim() : '';
  if (!text) return fallbackFor(caseLabel);
  const found = holdsName(text, contact?.name)
    || holdsVisitorNumber(text, contact?.phone)
    || holdsVisitorEmail(text, contact?.email)
    || PHONE_SHAPE.test(text)
    || EMAIL_SHAPE.test(text)
    || STREET_SHAPE.test(text);
  return found ? fallbackFor(caseLabel) : text;
}
