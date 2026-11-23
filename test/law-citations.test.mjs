// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Finding statute citations and stated periods and amounts in text (law-citations.js). Pure text in, results out.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { findStatuteCitations, findStatedPeriods } from '../law-citations.js';

const CITES = [
  ['CPLR §214', ['CPLR-214']], ['CPLR § 214(5)', ['CPLR-214']], ['CPLR §214-a', ['CPLR-214-A']], ['CPLR 214-a', ['CPLR-214-A']],
  ['CPLR §1411(b)', ['CPLR-1411']], ['EPTL §5-4.1 and §5-4.3', ['EPTL-5-4.1', 'EPTL-5-4.3']],
  ['General Municipal Law § 50-e(5)', ['GML-50-E']], ['GML §50-i', ['GML-50-I']],
  ['Insurance Law §5102(d)', ['INS-5102']], ['NY Ins. Law §5102(d)', ['INS-5102']], ['Court of Claims Act §10(3)', ['CCA-10']],
  ['Public Authorities Law §1212, 1276', ['PAL-1212', 'PAL-1276']], ['Unconsolidated Laws §7107', ['UNCONS-7107']],
  ['VTL §1229-c(8)', ['VTL-1229-C']], ['Public Health Law 2801-d', ['PHL-2801-D']],
  ['28 U.S.C. §§2401(b) and 2675', ['USC-28-2401', 'USC-28-2675']], ['42 U.S.C. §233', ['USC-42-233']],
  ['11 NYCRR §65-1.1', ['NYCRR-11-65-1.1']], ['Administrative Code §§ 7-201(c)(2) and 7-210', ['NYCAC-7-201', 'NYCAC-7-210']],
  ['Chapter 58 of the Laws of 2026', ['LAWS-2026-58']],
  ['CPLR § 1411(a) bars nothing; § 1411(b) does.', ['CPLR-1411', 'CPLR-1411']],
  ['Insurance Law Article 51', []], ['a bare § 12 alone', ['UNKNOWN-12']],
  ['Section 214 of the CPLR', []], ['CPLR Sections 214 and 214-a', ['CPLR-214', 'CPLR-214-A']],
  ['Judiciary Law §487', ['JUD-487']], ['Labor Law § 240(1)', ['LAB-240']], ['General Obligations Law §5-326', ['GOL-5-326']],
  ['Multiple Dwelling Law § 78', ['MDL-78']], ['NYC Administrative Code § 7-210', ['NYCAC-7-210']],
  ['New York City Health and Hospitals Corporation Act § 20', ['HHC-20']], ['the NYC Health and Hospitals Corporation Act §20(2)', ['HHC-20']],
  ['The Example Corporation Act § 5', ['UNKNOWN-5']],
  ['Civil Practice Law and Rules § 3216', ['CPLR-3216']], ['no law here, only 214 days', []],
  ['Unconsol. Laws § 7107', ['UNCONS-7107']], ['Unconsol. Law § 7107', ['UNCONS-7107']],
  ['CPLR § 214, 2020 amendments', ['CPLR-214']], ['CPLR § 214 and 3 others', ['CPLR-214']],
  ['11 NYCRR §65-1.1.\n\nUnconsol. Laws § 7107', ['NYCRR-11-65-1.1', 'UNCONS-7107']],
  // These lists must still give every section, so the defence above cannot cost a citation.
  ['28 U.S.C. §§ 2401(b) and 2675 govern the claim', ['USC-28-2401', 'USC-28-2675']],
  ['CPLR §§ 214, 214-a, and 3216', ['CPLR-214', 'CPLR-214-A', 'CPLR-3216']],
  ['CPLR § 214, § 12 and § 14', ['CPLR-214', 'CPLR-12', 'CPLR-14']],
];

test('findStatuteCitations names each section the way the notes file does', () => {
  for (const [text, ids] of CITES) assert.deepEqual(findStatuteCitations(text).map(c => c.id), ids, text);
});

// A law name the finder does not know must not lend its section to another law, so the section reads as UNKNOWN and shows up loudly.
const BLOG_PARAGRAPH = `- **Subways and buses:** claims against the New York City Transit Authority (subways and many City buses) and the MTA itself require a Notice of Claim within 90 days and a lawsuit within one year and 90 days (Public Authorities Law §§ 1212 and 1276). MTA subsidiaries are exempt from the formal Notice of Claim, but not from the deadline to sue (§ 1276(6)). It is not always obvious which agency runs a route, so treat 90 days as the deadline.
- **NYCHA public housing:** also a 90-day Notice of Claim and one year and 90 days to sue (Public Housing Law § 157).`;
const UNKNOWN_LAWS = [
  [BLOG_PARAGRAPH, ['PAL-1212', 'PAL-1276', 'PAL-1276', 'PHOUS-157']],
  ['Public Authorities Law § 1212. Workers\' Compensation Law § 29.', ['PAL-1212', 'UNKNOWN-29']],
  ['Public Authorities Law § 1212. Penal Law § 120.05, and § 120.10.', ['PAL-1212', 'UNKNOWN-120.05', 'UNKNOWN-120.10']],
  ['Penal Law § 120.05. CPLR § 214, and § 215.', ['UNKNOWN-120.05', 'CPLR-214', 'CPLR-215']],
  ['A tree well is not part of the "sidewalk" under § 7-210.', ['UNKNOWN-7-210']],
  ['CPLR § 208. See § 214.', ['CPLR-208', 'CPLR-214']],
  ['the Court of Claims Act § 10(3)', ['CCA-10']],
  // A known law followed by a comma still owns the section after it.
  ['General Municipal Law, § 50-e applies', ['GML-50-E']],
  ['See the Insurance Law, § 3420(a)', ['INS-3420']],
  ['The Labor Law, §§ 240 and 241', ['LAB-240', 'LAB-241']],
  ['NYC Administrative Code, § 7-210', ['NYCAC-7-210']],
  ['Public Housing Law, § 157', ['PHOUS-157']],
  ['Public Authorities Law § 1212. Workers\' Compensation Law, § 29.', ['PAL-1212', 'UNKNOWN-29']],
];
test('a section after a law the finder does not know is never filed under another law', () => {
  for (const [text, ids] of UNKNOWN_LAWS) assert.deepEqual(findStatuteCitations(text).map(c => c.id), ids, text.slice(0, 60));
});

test('a long paragraph with hundreds of bare section signs is read quickly', () => {
  const words = [];
  let signs = 0;
  for (let i = 1; i <= 5000; i++) {
    words.push(['Alpha', 'Beta', 'Gamma', 'Delta'][i % 4]);
    if (i % 16 === 0) { words.push('§ 12'); signs++; }
  }
  const text = words.join(' ');
  const began = performance.now();
  const found = findStatuteCitations(text);
  const took = performance.now() - began;
  assert.equal(found.length, signs);
  assert.ok(took < 2000, `took ${Math.round(took)} ms`);
});

test('findStatuteCitations returns the citation as it appears, trimmed', () => {
  assert.equal(findStatuteCitations('See  CPLR § 214(5), then more.')[0].raw, 'CPLR § 214(5)');
  assert.deepEqual(findStatuteCitations('EPTL §5-4.1 and §5-4.3').map(c => c.raw), ['EPTL §5-4.1', '§5-4.3']);
});

test('a bare section sign takes the law named most recently in the same paragraph', () => {
  assert.deepEqual(findStatuteCitations('Under the CPLR the period runs; see also § 214.').map(c => c.id), ['CPLR-214']);
});

test('a bare section sign does not reach back past a blank line', () => {
  assert.deepEqual(findStatuteCitations('CPLR § 214\n\n§ 1411').map(c => c.id), ['CPLR-214', 'UNKNOWN-1411']);
  assert.deepEqual(findStatuteCitations('CPLR § 214\n   \n§ 1411').map(c => c.id), ['CPLR-214', 'UNKNOWN-1411']);
  assert.deepEqual(findStatuteCitations('CPLR § 214\n§ 1411').map(c => c.id), ['CPLR-214', 'CPLR-1411']);
});

test('findStatuteCitations returns nothing for empty or non-string input', () => {
  assert.deepEqual(findStatuteCitations(''), []);
  assert.deepEqual(findStatuteCitations(undefined), []);
});

const PERIODS = [
  ['within 90 days', ['90 days']], ['a 90-day notice', ['90-day']], ['1 year and 90 days', ['1 year and 90 days']],
  ['one year and 90 days', ['one year and 90 days']], ['three years', ['three years']], ['2.5 years', ['2.5 years']],
  ['a 2.5-year limit', ['2.5-year']], ['up to $50,000', ['$50,000']], ['$100,000 cap', ['$100,000']], ['$25 lead', ['$25']],
  ['replace with $1', []], ['`${days} days`', []], ['6 months', ['6 months']], ['Six Months', ['six months']],
  ['forty-five days', ['forty-five days']], ['1 year and ninety days', ['1 year and ninety days']],
  ['1 week', ['1 week']], ['30   days', ['30 days']], ['a 30 minute call, 45 minutes', []],
  ['four hours', ['four hours']], ['a 24-hour window', ['24-hour']], ['within 24 hours', ['24 hours']],
  ['$19.99 fee', ['$19.99']],
];

test('findStatedPeriods returns one phrase per occurrence, lowercased', () => {
  for (const [text, phrases] of PERIODS) assert.deepEqual(findStatedPeriods(text).map(p => p.phrase), phrases, text);
  assert.deepEqual(findStatedPeriods('90 days or 90 days').map(p => p.phrase), ['90 days', '90 days']);
});

test('a duration word inside a longer word is not a period', () => {
  assert.deepEqual(findStatedPeriods('someone daylight 5 yearsworth'), []);
});

// A year written "yr" or "yrs", and a half written straight after the digits, as the gatekeeper's checklists and the case
// analysis's deadline notes write them. Each case is its own test, so that one failing does not hide the others.
test('a year written "yr" is a period, hyphenated or spaced', () => {
  assert.deepEqual(findStatedPeriods('the 3-yr SOL and the 2-yr wrongful-death limit').map(p => p.phrase), ['3-yr', '2-yr']);
  assert.deepEqual(findStatedPeriods('CPLR §214 3-yr / EPTL §5-4.1 2-yr / GML §50-e 90-day municipal notice').map(p => p.phrase), ['3-yr', '2-yr', '90-day']);
  assert.deepEqual(findStatedPeriods('within 1 yr').map(p => p.phrase), ['1 yr']);
});

test('a year written "yrs" is a period, lowercased as every phrase is', () => {
  assert.deepEqual(findStatedPeriods('2 yrs after').map(p => p.phrase), ['2 yrs']);
  assert.deepEqual(findStatedPeriods('Three Yrs').map(p => p.phrase), ['three yrs']);
});

test('a half written straight after the digits is part of the number', () => {
  assert.deepEqual(findStatedPeriods('within 2½ years, a 2½-year limit').map(p => p.phrase), ['2½ years', '2½-year']);
});

test('a percentage and an age are still not periods', () => {
  assert.deepEqual(findStatedPeriods('80% of lost wages, under 18').map(p => p.phrase), []);
});

test('"yr" at the start of a longer word is not a period', () => {
  assert.deepEqual(findStatedPeriods('a 2 yrly fee, 3 yrsworth, a 4-yrly review').map(p => p.phrase), []);
});
