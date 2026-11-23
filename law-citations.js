// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Finds statute citations and stated periods and amounts in text. It is pure: text in, results out, no imports and no files.
// Two tests use it on the app's own copy. One fails when a cited statute is missing from the notes file, and the other fails
// when a stated period or amount is missing from the register. Both need the same reading of the text, so it lives here once.

// The law names it knows, and the prefix each takes in a source id. A law name met that is not here is added here, with a test case.
const LAWS = [
  ['CPLR', 'CPLR'], ['Civil Practice Law and Rules', 'CPLR'],
  ['EPTL', 'EPTL'], ['Estates, Powers and Trusts Law', 'EPTL'],
  ['GML', 'GML'], ['General Municipal Law', 'GML'],
  ['Insurance Law', 'INS'], ['Ins\\. Law', 'INS'],
  ['VTL', 'VTL'], ['Vehicle and Traffic Law', 'VTL'],
  ['Court of Claims Act', 'CCA'],
  ['Health and Hospitals Corporation Act', 'HHC'],
  ['Public Authorities Law', 'PAL'],
  ['Unconsolidated Laws', 'UNCONS'], ['Unconsol\\. Laws', 'UNCONS'], ['Unconsol\\. Law', 'UNCONS'],
  ['Public Health Law', 'PHL'], ['Public Housing Law', 'PHOUS'],
  ['Judiciary Law', 'JUD'],
  ['Labor Law', 'LAB'],
  ['General Obligations Law', 'GOL'],
  ['Multiple Dwelling Law', 'MDL'],
  ['Administrative Code', 'NYCAC'], ['Admin\\. Code', 'NYCAC'],
];
const PREFIX_BY_NAME = new Map(LAWS.map(([name, prefix]) => [name.replace(/\\/g, '').toLowerCase(), prefix]));
// "NY Ins. Law" and "NYC Administrative Code" are the same laws with a place in front, so the place is left out of the match.
const LAW_NAME = LAWS.map(([name]) => name).sort((a, b) => b.length - a.length).join('|');

// Hours count because some legal periods are stated in them (the City's Administrative Code sets some). Minutes do not: only business timings use them.
const UNITS = 'hours?|days?|weeks?|months?|years?';
// A section number: "214", "214-a", "5-4.1", "65-1.1". Subdivisions such as "(5)" or "(c)(2)" follow it and are not part of the id.
const SECTION = '\\d+(?:\\.\\d+)?(?:-\\d+(?:\\.\\d+)?)?(?:-[A-Za-z]\\b)?';
// A number that is really the start of "90 days" is not a section, whichever way the list reaches it.
const NOT_A_PERIOD = `(?!\\d+(?:\\.\\d+)?\\s*(?:${UNITS})\\b)`;
const ITEM = new RegExp(`(?:(§§?|Sections?)\\s*)?${NOT_A_PERIOD}(${SECTION})((?:\\([A-Za-z0-9]{1,4}\\))*)`, 'iy');
const JOINER = /(?:,\s*(?:and|or)\s+|,\s*|\s+(?:and|or)\s+|\s*&\s*)/y;

// After a joiner, a number with no sign of its own may be the next section ("§1212, 1276") or may be something else in the
// sentence ("§ 214, 2020 amendments", "§ 214 and 3 others"). A short count or a year that is followed by a word of its own
// (other than "and" or "or") is read as the something else. Anything longer or odder is kept: a missed citation costs more
// than a loud false one, so "§§ 2401(b) and 2675 govern the claim" still gives both.
function isStrayNumber(item, rest) {
  if (item[1] || item[3]) return false;
  if (!/^(?:\d{1,2}|(?:19|20)\d\d)$/.test(item[2])) return false;
  return /^\s+(?!and\b|or\b)[A-Za-z]/i.test(rest);
}

// Where a citation starts: a title and a code (28 U.S.C., 11 NYCRR), a chapter of the session laws, a law name, or a bare section sign.
const HEAD = new RegExp([
  '(?<usc>\\d+)\\s+U\\.S\\.C\\.\\s*',
  '(?<nycrr>\\d+)\\s+NYCRR\\s*',
  'Chapter\\s+(?<chapter>\\d+)\\s+of\\s+the\\s+Laws\\s+of\\s+(?<year>\\d{4})',
  `(?<![A-Za-z])(?<law>${LAW_NAME})\\b\\s*`,
  '(?<bare>§§?)\\s*',
].map(part => `(?:${part})`).join('|'), 'gi');

// A bare section sign straight after a capitalized name ending in Law, Laws, Act, Code or Rules names a law the table does not know
// ("Penal Law § 120.05"). Giving it the law named earlier would file it under the wrong law and nothing would show, so it stays
// UNKNOWN, and so does every bare sign after it until a known law is named again. The citation test then fails loudly on it.
// A known law name before the sign ("the Labor Law, § 240") is left to the law already named. Only the last 120 characters are
// looked at, which is longer than any name in the table with "the" and a comma, so a long paragraph costs no more than a short one.
const LOOK_BACK = 120;
const UNKNOWN_NAME_BEFORE = /[A-Z][A-Za-z'’.-]*\s+(?:(?:and|of|the|for|[A-Z][A-Za-z'’.-]*)\s+)*(?:Laws?|Act|Code|Rules),?\s*$/;
const KNOWN_NAME_BEFORE = new RegExp(`(?<![A-Za-z])(?:${LAW_NAME}),?\\s*$`, 'i');
function unknownLawBefore(paragraph, at) {
  const near = paragraph.slice(Math.max(0, at - LOOK_BACK), at);
  return UNKNOWN_NAME_BEFORE.test(near) && !KNOWN_NAME_BEFORE.test(near);
}

// A "paragraph" is the text between blank lines. A bare section sign takes the law named most recently inside its own paragraph.
function paragraphs(text) {
  return String(text ?? '').split(/\n[ \t\r]*\n/);
}

export function findStatuteCitations(text) {
  const found = [];
  for (const paragraph of paragraphs(text)) {
    let current = null; // the prefix of the law named most recently in this paragraph
    HEAD.lastIndex = 0;
    let head;
    while ((head = HEAD.exec(paragraph))) {
      const g = head.groups;
      let prefix = null;
      if (g.chapter) {
        found.push({ id: `LAWS-${g.year}-${g.chapter}`, raw: head[0].trim() });
        continue;
      }
      if (g.usc) prefix = `USC-${g.usc}`;
      else if (g.nycrr) prefix = `NYCRR-${g.nycrr}`;
      else if (g.law) prefix = PREFIX_BY_NAME.get(g.law.replace(/\s+/g, ' ').toLowerCase()) || null;
      else if (unknownLawBefore(paragraph, head.index)) prefix = current = 'UNKNOWN';
      else prefix = current || 'UNKNOWN';
      if (!prefix) continue;
      if (!g.bare) current = prefix;

      // The head ends where the list of sections begins. Read the list from there. The patterns are sticky, so each
      // must match exactly at the place the last one stopped, and a joiner is taken only when another section follows it.
      let start = head.index;
      ITEM.lastIndex = HEAD.lastIndex;
      let item = ITEM.exec(paragraph);
      while (item) {
        found.push({ id: `${prefix}-${item[2].toUpperCase()}`, raw: paragraph.slice(start, ITEM.lastIndex).trim() });
        HEAD.lastIndex = ITEM.lastIndex;
        JOINER.lastIndex = ITEM.lastIndex;
        if (!JOINER.exec(paragraph)) break;
        start = JOINER.lastIndex;
        ITEM.lastIndex = JOINER.lastIndex;
        item = ITEM.exec(paragraph);
        if (item && isStrayNumber(item, paragraph.slice(ITEM.lastIndex))) break;
      }
    }
  }
  return found;
}

const ONES = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const TENS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
// A half written straight after the digits is part of the number, as in the case analysis's "2½-year".
const NUMBER = `(?:\\d+(?:\\.\\d+|½)?|(?:${TENS})(?:-(?:one|two|three|four|five|six|seven|eight|nine))?|${ONES})`;
// A year is also written "yr" or "yrs", as in the gatekeeper's checklists ("3-yr"). The phrase keeps the form it is written
// in, so "3-yr" is its own phrase, as "90-day" is.
const PERIOD_UNITS = `${UNITS}|yrs?`;
const STATED = new RegExp([
  // A dollar amount: "$25", "$50,000", "$19.99". A bare "$1" is a replacement token, not money, and "${days}" has no digits at all.
  '(?<amount>\\$\\d+(?:,\\d{3})*(?:\\.\\d+)?)',
  // A hyphenated duration is its own phrase: "90-day" is not "90 days".
  `(?<![\\w.])(?<hyphenated>${NUMBER}-(?:${PERIOD_UNITS})\\b)`,
  // A duration, with the "and 90 days" tail that limitation periods are often stated with.
  `(?<![\\w.])(?<duration>${NUMBER}\\s+(?:${PERIOD_UNITS})\\b(?:\\s+and\\s+${NUMBER}\\s+days?\\b)?)`,
].join('|'), 'gi');

export function findStatedPeriods(text) {
  const phrases = [];
  for (const m of String(text ?? '').matchAll(STATED)) {
    const g = m.groups;
    if (g.amount && g.amount.replace(/\D/g, '').length < 2) continue;
    phrases.push({ phrase: m[0].toLowerCase().replace(/\s+/g, ' ').trim() });
  }
  return phrases;
}
