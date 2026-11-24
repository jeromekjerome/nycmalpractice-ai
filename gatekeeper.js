// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// gatekeeper.js — Deterministic Dual-Criteria Gatekeeper + Auto-Retry ("Gatekeeper & Coach").
//
// Every AI reply is graded against a declarative JSON rubric (rubrics/*.json) before it is served:
//   1. An LLM evaluator grades each required / prohibited criterion (skipped in deterministic mode).
//   2. A deterministic gate then re-checks, in code, everything code can decide — unanchored case
//      citations, the mandatory disclaimer, the Socratic question mark, guarantee language — and
//      overrides the evaluator. gate_status is computed here, never taken from a model.
//   3. A BLOCKED draft gets up to `max_auto_retries` remediation passes.
// No Silent Fixes: every attempt and the diagnosis of the first failure are kept on the report.
//
// Compliance rules live in the rubric JSON. This file only interprets them. It is the same file in
// every app; what differs between apps (modes, rubric files, defaults) is in gate-config.js.

import { readFileSync } from 'fs';
import { auditDraftCitations, flagUnanchoredCitations, textOutsideCitations, VERIFY_PLACEHOLDER } from './citator.js';
import { runJob } from './providers.js';
import { withoutKeys } from './without-keys.js';
import { earliestSourceDate } from './law-file.js';
import {
  RUBRIC_FILES, CURRENT_LAW_FILE, SERVICE_DESCRIPTION, DEFAULT_HUMAN_VERIFICATION_CHECKLIST, DEFAULT_GATE_TARGETS, normalizeMode,
} from './gate-config.js';

export { DEFAULT_HUMAN_VERIFICATION_CHECKLIST };

const rubricCache = new Map();
let currentLawCache = null;
const DEFAULT_REQUIRED_PHRASE = 'This is general information, not legal advice';

// The three attestations a supervising attorney makes on lead.html before accepting a lead.
export const HITL_ATTESTATION_KEYS = Object.freeze([
  'sol_and_notice_verified',
  'conflict_check_completed',
  'case_quality_reviewed',
]);

export function isHitlVerificationComplete(hitlVerification) {
  if (!hitlVerification || typeof hitlVerification !== 'object') return false;
  return HITL_ATTESTATION_KEYS.every(key => hitlVerification[key] === true);
}

const MAX_RETRY_CEILING = 3;
const EVALUATOR_MAX_TOKENS = 900;
const REMEDIATION_MAX_TOKENS = 1000;

// ─── Rubrics ───────────────────────────────────────────────────────────────────

/** Load the rubric for a mode (gate-config.js names the file for each mode). */
export function loadRubric(mode) {
  const key = normalizeMode(mode);
  if (!rubricCache.has(key)) {
    rubricCache.set(key, JSON.parse(readFileSync(RUBRIC_FILES[key], 'utf8')));
  }
  return structuredClone(rubricCache.get(key));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function criteriaOf(rubric) {
  const usable = list => (Array.isArray(list) ? list : []).filter(c => isObject(c) && typeof c.id === 'string' && c.id);
  return {
    required: usable(rubric?.required_criteria),
    prohibited: usable(rubric?.prohibited_criteria),
  };
}

// An error's words as the gate keeps them in its audit and logs them, with nothing shaped like a key: a provider's own
// message can quote back the key it was sent, and the audit reaches a firm's lead page. Cleaned before it is cut short.
function errorText(err) {
  return withoutKeys(typeof err?.message === 'string' && err.message ? err.message : String(err));
}

function findDeterministicCriterion(rubric, mode, type) {
  const { required, prohibited } = criteriaOf(rubric);
  const declared = [...required, ...prohibited].find(c => c?.deterministic_check?.type === type);
  if (declared) return declared;
  const fallbackId = DEFAULT_GATE_TARGETS[mode]?.[type];
  if (!fallbackId) return null;
  return [...required, ...prohibited].find(c => c.id === fallbackId) || { id: fallbackId, name: fallbackId };
}

/** Load the current-law notes (gate-config.js names the file): statutory changes the models cannot know from training. */
export function loadCurrentLawNotes() {
  if (!currentLawCache) currentLawCache = JSON.parse(readFileSync(CURRENT_LAW_FILE, 'utf8'));
  return structuredClone(currentLawCache);
}

/**
 * The current-law notes as a prompt block. Returns '' (and logs) if the file cannot be read, so
 * a missing notes file degrades the prompts instead of taking the product down.
 * A law object may be given (a test does); with none, the notes file is read. The date is the file's own `as_of` when it has
 * one, and otherwise the earliest approval or review among the sources the notes rest on.
 */
export function renderCurrentLawForPrompt(given) {
  let law = given;
  if (!law) {
    try {
      law = loadCurrentLawNotes();
    } catch (err) {
      console.error('[Gatekeeper] Current-law notes unavailable:', err.message);
      return '';
    }
  }
  const notes = (Array.isArray(law.notes) ? law.notes : []).filter(note => note && note.rule);
  if (!notes.length) return '';
  // With no date to give, the line makes no claim of verification; the notes are still the corrections the model needs.
  const verifiedAt = law.as_of ?? earliestSourceDate(law);
  const verified = verifiedAt ? ` (verified as of ${verifiedAt})` : '';
  return [
    `CURRENT ${String(law.jurisdiction || 'New York').toUpperCase()} LAW${verified}. These statutory changes may post-date your training data. Where they apply they control over anything you remember, and you must not state the superseded rule as current law:`,
    ...notes.map(note => `- ${note.topic}: ${note.rule}`),
  ].join('\n');
}

/**
 * Render a rubric as a compact instruction block for a system prompt, so the drafting model is
 * told the same rules it will be graded on (the rules still come only from the JSON), followed
 * by the current-law notes.
 */
export function renderRubricForPrompt(mode, turn) {
  const rubric = loadRubric(mode);
  const { required, prohibited } = criteriaOf(rubric);
  const line = c => `- ${c.name}: ${c.description}${c.turn_guidance ? ` ${c.turn_guidance}` : ''}`;
  const currentLaw = renderCurrentLawForPrompt();
  return [
    `COMPLIANCE GATE — every reply is checked against these rules before the user sees it. This is turn ${turn}.`,
    'Your reply MUST:',
    ...required.map(line),
    'Your reply MUST NOT:',
    ...prohibited.map(line),
    'Case law: cite only the cases listed in the context above, using the exact case name and citation shown there. Never cite a case from memory. Say what a listed case decided only as far as its Excerpt shows; when the excerpt does not show the holding, mention the case as a related New York decision without characterising it. Statutes may be cited.',
    ...(currentLaw ? ['', currentLaw] : []),
  ].join('\n');
}

// ─── Report plumbing ───────────────────────────────────────────────────────────

function baselineReport(rubric) {
  const { required, prohibited } = criteriaOf(rubric);
  return {
    domain_id: rubric?.domain_id || null,
    gate_status: 'BLOCKED',
    required_checks: required.map(c => ({
      id: c.id,
      name: c.name,
      passed: true,
      evidence_or_gap: 'Not graded by the LLM evaluator (deterministic evaluation).',
      source: 'not_evaluated',
    })),
    prohibited_checks: prohibited.map(c => ({
      id: c.id,
      name: c.name,
      violated: false,
      offending_quote: 'None',
      remediation_instruction: '',
      source: 'not_evaluated',
    })),
    citation_audit: [],
    human_verification_checklist: [],
    coaching: '',
  };
}

function ensureCheck(list, criterion, defaults) {
  let check = list.find(c => c && c.id === criterion.id);
  if (!check) {
    check = { id: criterion.id, name: criterion.name || criterion.id, ...defaults };
    list.push(check);
  }
  return check;
}

function isEvaluatorVerdict(check) {
  return check.source === 'llm' || check.source === 'unresolved';
}

// Code is about to record its own failing result on a check the evaluator has already failed.
// The evaluator's finding may be about different words, so it is kept on the check, where it
// stays open until the evaluator looks again (see carryUnresolvedFindings).
function keepEvaluatorFinding(check) {
  if (check.evaluator_finding || !isEvaluatorVerdict(check)) return;
  if ('violated' in check) {
    if (check.violated !== true) return;
    check.evaluator_finding = {
      source: check.source,
      offending_quote: check.offending_quote,
      remediation_instruction: check.remediation_instruction,
    };
  } else if (check.passed === false) {
    check.evaluator_finding = { source: check.source, evidence_or_gap: check.evidence_or_gap };
  }
}

// The evaluator's own failing finding on a check, whether it is the check's result or sits behind
// a result recorded by code. Null when the evaluator did not fail the check.
function evaluatorFindingOf(check) {
  if (check.evaluator_finding) return check.evaluator_finding;
  if (!isEvaluatorVerdict(check)) return null;
  if ('violated' in check) {
    return check.violated === true
      ? { offending_quote: check.offending_quote, remediation_instruction: check.remediation_instruction }
      : null;
  }
  return check.passed === false ? { evidence_or_gap: check.evidence_or_gap } : null;
}

function failedRequired(report) {
  return (report.required_checks || []).filter(c => c.passed !== true);
}

function violatedProhibited(report) {
  return (report.prohibited_checks || []).filter(c => c.violated === true);
}

function describeChecks(checks) {
  return checks.map(c => `${c.id} (${c.name})`).join(', ');
}

function normalizeForPhrase(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ');
}

function containsPhrase(text, phrase) {
  return normalizeForPhrase(text).includes(normalizeForPhrase(phrase).trim());
}

// Does the reply say anything beyond the mandatory disclaimer and citation flags?
function hasSubstance(text, requiredPhrase) {
  let rest = normalizeForPhrase(text).split(VERIFY_PLACEHOLDER.toLowerCase()).join(' ');
  if (requiredPhrase) rest = rest.split(normalizeForPhrase(requiredPhrase).trim()).join(' ');
  return /[\p{L}\p{N}]/u.test(rest);
}

// Capitalised words that can sit around a citation without being the name of another authority.
const GENERIC_CAPITALISED = new Set(`
  a an i the in under see as per cf accord but and or also however here there this that these those
  it its for from with when where while although because since if so thus both like unlike
  similarly likewise according following citing compare contrast applying given note recall
  court courts appeals appellate division department dept supreme term judicial justice judge
  first second third fourth circuit district federal united states new york ny nyc city state
  county plaintiff plaintiffs defendant defendants cplr gml vtl eptl insurance law section article
  january february march april may june july august september october november december
`.split(/\s+/).filter(Boolean));

// True when a quote names something besides the citations found in it: a capitalised word that is
// neither generic nor part of one of those citations ("…and the famous Palsgraf decision").
function namesAnotherAuthority(quote, citationsInQuote) {
  const known = new Set(
    citationsInQuote
      .flatMap(item => String(item.citation_text).split(/[^\p{L}\p{N}]+/u))
      .map(word => word.toLowerCase())
      .filter(Boolean)
  );
  const capitalised = textOutsideCitations(quote).match(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}'’-]*/gu) || [];
  return capitalised.some(word => {
    const key = word.toLowerCase().replace(/['’]s$/u, '');
    return !GENERIC_CAPITALISED.has(key) && !known.has(key);
  });
}

// ─── Sentences ─────────────────────────────────────────────────────────────────

// Abbreviations whose period is normally followed by a capitalised word in the same sentence
// ("Dr. Patel", "Driver v. Carrier", "N.Y. Ins. Law"). Reading one of these as a full stop would
// cut a sentence in half, so when in doubt two sentences are treated as one.
const NON_TERMINAL_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'hon', 'sen', 'rep', 'gov', 'st', 'mt', 'ft', 'v', 'vs', 'cf',
  'inc', 'corp', 'co', 'ltd', 'llc', 'llp', 'bros', 'assn', 'hosp', 'auth', 'ctr', 'univ', 'natl',
  'mfg', 'transp', 'dept', 'div', 'app', 'misc', 'supp', 'ins', 'veh', 'traf', 'gen', 'mun', 'pub',
  'civ', 'prac', 'proc', 'sup', 'ct', 'cir', 'dist', 'art', 'sec',
]);
const NUMBER_ABBREVIATIONS = new Set(['no', 'nos']);

// Is the period at `index` part of an abbreviation rather than the end of a sentence?
function isAbbreviationPeriod(line, index) {
  const rest = line.slice(index + 1);
  const next = /^\s*(\S)/.exec(rest)?.[1] || '';
  // A sentence does not continue in lower case, so "Inc. paid" and "v. the City" are one sentence.
  if (/\p{Ll}/u.test(next)) return true;

  let start = index;
  while (start > 0 && /[\p{L}\p{N}.]/u.test(line[start - 1])) start--;
  const token = line.slice(start, index).toLowerCase();
  if (!token) return false;
  if (/^(?:\p{L}\.)*\p{L}$/u.test(token)) return true;                 // an initial, "N.Y", "U.S"
  if (NON_TERMINAL_ABBREVIATIONS.has(token)) return true;
  return NUMBER_ABBREVIATIONS.has(token) && /\d/.test(next);           // "No. 5"
}

/**
 * The sentences of a reply as [{ start, end }] offsets into `text`. A line break always ends a
 * sentence. A list marker or block-quote mark at the start of a line is not part of one, and
 * closing quotes or emphasis markers after a full stop stay with the sentence they close.
 */
function sentenceSpans(text) {
  const spans = [];
  const push = (base, line, from, to) => {
    while (from < to && /\s/.test(line[from])) from++;
    while (to > from && /\s/.test(line[to - 1])) to--;
    if (to > from) spans.push({ start: base + from, end: base + to });
  };

  const lineRe = /[^\n]+/g;
  let line;
  while ((line = lineRe.exec(text)) !== null) {
    const content = line[0];
    let cursor = /^\s*(?:(?:[-*+]|\d{1,3}[.)])\s+|>\s*)*/.exec(content)[0].length;
    const stopRe = /[.?!]+["'”’)\]*_`]*(?=\s|$)/g;
    stopRe.lastIndex = cursor;
    let stop;
    while ((stop = stopRe.exec(content)) !== null) {
      if (stop[0][0] === '.' && !stop[0].startsWith('..') && isAbbreviationPeriod(content, stop.index)) continue;
      push(line.index, content, cursor, stop.index + stop[0].length);
      cursor = stop.index + stop[0].length;
    }
    push(line.index, content, cursor, content.length);
  }
  return spans;
}

// Remove whole sentences from a reply without disturbing the rest of it: the space that
// separated the sentence from its neighbour goes with it, and a line left holding nothing but a
// list marker goes too. `spans` are [{ start, end }] from sentenceSpans().
function removeSentences(text, spans) {
  let out = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    let { start, end } = span;
    const lineStart = out.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = out.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = out.length;
    const nothingAfter = !out.slice(end, lineEnd).trim();
    const onlyMarkerBefore = /^\s*(?:(?:[-*+]|\d{1,3}[.)])\s+|>\s*)*$/.test(out.slice(lineStart, start));

    if (nothingAfter && onlyMarkerBefore) {
      // The sentence was the whole line (or the whole list item): drop the line.
      start = lineStart;
      end = lineEnd < out.length ? lineEnd + 1 : lineEnd;
      if (start === 0) {
        while (end < out.length && out[end] === '\n') end++;                        // first line: no leading gap
      } else if (end === out.length) {
        start -= 1;                                                                 // last line: its line break goes too
      } else if (out.slice(0, start).endsWith('\n\n') && out[end] === '\n') {
        end += 1;                                                                   // middle: do not leave a double gap
      }
    } else if (nothingAfter) {
      // Last sentence on its line: the space before it goes; trailing spaces (a Markdown hard break) stay.
      while (start > lineStart && (out[start - 1] === ' ' || out[start - 1] === '\t')) start--;
    } else {
      // Followed by another sentence: the space between them goes.
      while (end < lineEnd && (out[end] === ' ' || out[end] === '\t')) end++;
    }
    out = `${out.slice(0, start)}${out.slice(end)}`;
  }
  return out;
}

// ─── Forbidden patterns ────────────────────────────────────────────────────────

const NEGATION = /\b(?:no|not|never|cannot|nobody|nothing|without|neither|nor)\b|n['’]t\b/i;
// Phrases that contain a negation word and negate nothing ("no-fault", "no doubt", "don't worry").
const NOT_A_NEGATION = /\bno[- ]fault\b|\bno (?:doubt|question|matter|problem|worries)\b|\bnot only\b|\bwithout (?:a |any )?(?:doubt|question)\b|\b(?:do not|don['’]t) worry\b/gi;
// Where a new clause starts inside a sentence: what comes before it does not negate what follows.
const CLAUSE_BREAK = /[;:]|\s[—–-]\s|\b(?:but|however|yet)\b/gi;

// Does the part of a sentence before `index` negate what follows ("no lawyer can promise a …")?
function negatedBefore(sentence, index) {
  let clause = sentence.slice(0, index);
  let lastBreak = -1;
  for (const m of clause.matchAll(CLAUSE_BREAK)) lastBreak = m.index + m[0].length;
  if (lastBreak !== -1) clause = clause.slice(lastBreak);
  return NEGATION.test(clause.replace(NOT_A_NEGATION, ' '));
}

/**
 * Sentences that match a rubric's forbidden patterns, as [{ quote, start, end }]. Each pattern is
 * applied to one sentence at a time, with Markdown emphasis ignored, so a match can neither span
 * two sentences nor be hidden by "**guaranteed**". With `negation_guard`, a sentence that negates
 * the match or merely asks about it is not a hit (unless the check sets skip_questions to false).
 */
function findForbiddenMatches(text, check) {
  const sources = Array.isArray(check?.patterns) ? check.patterns : (typeof check?.patterns === 'string' ? [check.patterns] : []);
  const patterns = [];
  for (const source of sources) {
    try {
      patterns.push(new RegExp(source, 'gi'));
    } catch (err) {
      console.warn(`[Gatekeeper] Ignoring invalid rubric pattern ${JSON.stringify(source)}: ${err.message}`);
    }
  }
  if (!patterns.length) return [];
  // A question is skipped under negation_guard unless the check sets skip_questions to false.
  const skipQuestions = check.skip_questions !== false;

  // One character for one character, so offsets into `plain` are offsets into `text`.
  const plain = text.replace(/[*_`]/g, ' ');
  const hits = [];
  for (const span of sentenceSpans(text)) {
    const sentence = plain.slice(span.start, span.end);
    const isQuestion = /\?["'”’)\]\s]*$/.test(sentence);
    const matched = patterns.some(re => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(sentence)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }
        if (!check.negation_guard || !((isQuestion && skipQuestions) || negatedBefore(sentence, m.index))) return true;
      }
      return false;
    });
    if (matched) hits.push({ quote: text.slice(span.start, span.end), start: span.start, end: span.end });
  }
  return hits;
}

// ─── Deterministic gate ────────────────────────────────────────────────────────

/**
 * Deterministic Dual-Criteria Gatekeeper invariant. Whatever an LLM evaluator reported, verify in
 * code and override:
 *   1. any UNANCHORED citation, or one CourtListener reports NOT_FOUND_404 → the rubric's
 *      citation_anchoring criterion is violated, quoting the exact citation(s);
 *   2. a rubric with a required_phrase check: the phrase (the disclaimer) must be present;
 *   3. a rubric with a requires_question_mark check: the reply must contain "?";
 *   4. gate_status = PASSED only if every required check passed, no prohibited check is violated
 *      and no citation is unanchored.
 * Always populates citation_audit and human_verification_checklist. Mutates and returns `report`.
 *
 * @param {object} report  evaluation report ({ required_checks, prohibited_checks, … }); may be sparse
 * @param {string} draftText
 * @param {number} turn
 * @param {string} mode  one of the modes in gate-config.js
 * @param {Array} retrievedCases  CourtListener cases retrieved for this turn
 * @param {{enableCourtListener?: boolean, fetchImpl?: Function, rubric?: object}} [options]
 */
export async function enforceDeterministicGate(report, draftText, turn, mode, retrievedCases = [], options = {}) {
  const gateMode = normalizeMode(mode);
  const rubric = options.rubric || loadRubric(gateMode);
  const text = String(draftText ?? '');
  const { required, prohibited } = criteriaOf(rubric);

  if (!report || typeof report !== 'object') throw new TypeError('enforceDeterministicGate: report must be an object');
  report.required_checks = (Array.isArray(report.required_checks) ? report.required_checks : []).filter(isObject);
  report.prohibited_checks = (Array.isArray(report.prohibited_checks) ? report.prohibited_checks : []).filter(isObject);
  report.domain_id = report.domain_id || rubric.domain_id || null;
  report.mode = gateMode;
  report.turn = turn;

  // A verdict the caller supplied without saying where it came from is the evaluator's, and its
  // flag is read however it was written ("true", 1), so a string can never pass for "not violated".
  for (const check of report.required_checks) {
    if (typeof check.source !== 'string' || !check.source) check.source = 'llm';
    const outcome = outcomeOf(check.passed, 'pass');
    if (outcome) check.passed = outcome === 'pass';
  }
  for (const check of report.prohibited_checks) {
    if (typeof check.source !== 'string' || !check.source) check.source = 'llm';
    const outcome = outcomeOf(check.violated, 'fail');
    if (outcome) check.violated = outcome === 'fail';
  }

  // Every rubric criterion has a result, even if the caller's report was sparse.
  for (const c of required) {
    ensureCheck(report.required_checks, c, {
      passed: true, evidence_or_gap: 'Not graded by the LLM evaluator (deterministic evaluation).', source: 'not_evaluated',
    });
  }
  for (const c of prohibited) {
    ensureCheck(report.prohibited_checks, c, {
      violated: false, offending_quote: 'None', remediation_instruction: '', source: 'not_evaluated',
    });
  }

  // 1. Citations — deterministic parser + packet anchoring (+ optional CourtListener lookup).
  report.citation_audit = await auditDraftCitations(text, retrievedCases, {
    enableCourtListener: options.enableCourtListener === true,
    fetchImpl: options.fetchImpl,
    lookupCache: options.lookupCache,
  });
  const offending = report.citation_audit.filter(
    item => item.status === 'UNANCHORED' || item.courtlistener_status === 'NOT_FOUND_404'
  );
  const citationCriterion = findDeterministicCriterion(rubric, gateMode, 'citation_anchoring');
  if (citationCriterion) {
    const check = ensureCheck(report.prohibited_checks, citationCriterion, {
      violated: false, offending_quote: 'None', remediation_instruction: '', source: 'not_evaluated',
    });
    const allowsPlaceholder = /verify citation/i.test(citationCriterion.description || '');
    // What the evaluator's own complaint (if any) is about. Formal citations are the citator's to
    // decide; anything else it names ("the famous Palsgraf decision") only the evaluator can see.
    const evaluatorFlagged = isEvaluatorVerdict(check) && check.violated === true;
    const quoted = evaluatorFlagged ? await auditDraftCitations(check.offending_quote, retrievedCases) : [];
    const beyondCitator = evaluatorFlagged && (quoted.length === 0 || namesAnotherAuthority(check.offending_quote, quoted));
    const citatorCanOverrule = evaluatorFlagged && !beyondCitator;

    if (offending.length) {
      const offendingList = offending
        .map(item => `${item.citation_text} [${item.status}${item.courtlistener_status !== 'UNCHECKED' ? ` / CourtListener: ${item.courtlistener_status}` : ''}]`)
        .join('; ');
      const notFound = offending.filter(item => item.courtlistener_status === 'NOT_FOUND_404');
      if (beyondCitator) keepEvaluatorFinding(check);
      check.violated = true;
      check.offending_quote = offendingList;
      check.offending_citations = offending.map(item => item.citation_text);
      check.remediation_instruction =
        `Deterministic citator blocked unanchored case authority: ${offendingList}. ` +
        'Remove every case citation that is not in the retrieved CourtListener packet' +
        (allowsPlaceholder ? `, or mark it ${VERIFY_PLACEHOLDER}.` : '.') +
        (notFound.length ? ` CourtListener has no record of: ${notFound.map(item => item.citation_text).join('; ')} — remove ${notFound.length === 1 ? 'it' : 'them'} entirely.` : '');
      check.source = 'deterministic';
    } else if (check.source === 'not_evaluated') {
      check.offending_quote = 'None';
      check.remediation_instruction = '';
      check.source = 'deterministic';
    } else if (check.violated === true) {
      // The evaluator flagged a citation and the citator found nothing unanchored. If its quote is
      // nothing but citations the citator has settled — anchored to the packet, or carrying the
      // flag the rubric allows — the evaluator is simply wrong about them, and the code result
      // wins. A quote that names anything else — on its own ("the Palsgraf case") or beside an
      // anchored citation ("Driver v. Carrier and the famous Palsgraf decision") — is left
      // standing: that is a form only the evaluator can catch.
      const flaggedInDraft = item => {
        if (item.status === 'PLACEHOLDER_FLAGGED') return true;
        const key = normalizeForQuote(item.citation_text);
        return report.citation_audit.some(
          audited => audited.status === 'PLACEHOLDER_FLAGGED' && normalizeForQuote(audited.citation_text).includes(key)
        );
      };
      const settled = item => item.status === 'ANCHORED' || (allowsPlaceholder && flaggedInDraft(item));
      if (citatorCanOverrule && quoted.every(settled)) {
        check.evaluator_note = `Evaluator flagged "${clip(check.offending_quote, 200)}", but every citation in it is anchored to the retrieved CourtListener packet${allowsPlaceholder ? ' or carries the flag the rubric allows' : ''}; not counted.`;
        check.violated = false;
        check.offending_quote = 'None';
        check.remediation_instruction = '';
        check.source = 'deterministic';
      }
    }
  }

  // 2. Mandatory phrase (client disclaimer). Exact, so the code result is authoritative both ways.
  const phraseCriterion = findDeterministicCriterion(rubric, gateMode, 'required_phrase');
  const phrase = phraseCriterion ? (phraseCriterion.deterministic_check?.phrase || DEFAULT_REQUIRED_PHRASE) : null;
  if (phraseCriterion) {
    const check = ensureCheck(report.required_checks, phraseCriterion, { passed: true, evidence_or_gap: '', source: 'not_evaluated' });
    const present = containsPhrase(text, phrase);
    check.passed = present;
    check.evidence_or_gap = present
      ? `Required phrase present: "${phrase}"`
      : `Mandatory disclaimer missing. The reply must include: "${phrase}."`;
    check.source = 'deterministic';
  }

  // 3. Socratic question mark (professor). Necessary, not sufficient: "exactly one" stays with the evaluator.
  const questionCriterion = findDeterministicCriterion(rubric, gateMode, 'requires_question_mark');
  if (questionCriterion) {
    const check = ensureCheck(report.required_checks, questionCriterion, { passed: true, evidence_or_gap: '', source: 'not_evaluated' });
    if (!text.trim().includes('?')) {
      keepEvaluatorFinding(check);
      check.passed = false;
      check.evidence_or_gap = 'The reply contains no question mark. It must ask exactly ONE Socratic question and end with "?".';
      check.source = 'deterministic';
    } else if (check.source === 'not_evaluated') {
      check.evidence_or_gap = 'Contains a question mark (single-question count is graded by the LLM evaluator).';
      check.source = 'deterministic';
    }
  }

  // An empty reply satisfies nothing, whatever an evaluator said or was unable to say. (The
  // checks code has just decided on their own terms keep their result.)
  if (!hasSubstance(text, phrase)) {
    for (const check of report.required_checks) {
      if (check.source === 'deterministic') continue;
      keepEvaluatorFinding(check);
      check.passed = false;
      check.evidence_or_gap = 'The reply is empty: there is nothing in it that could satisfy this criterion.';
      check.source = 'deterministic';
    }
  }

  // Rubric-declared forbidden patterns (e.g. a guaranteed dollar payout).
  for (const criterion of prohibited) {
    if (criterion?.deterministic_check?.type !== 'forbidden_patterns') continue;
    const check = ensureCheck(report.prohibited_checks, criterion, {
      violated: false, offending_quote: 'None', remediation_instruction: '', source: 'not_evaluated',
    });
    const hits = findForbiddenMatches(text, criterion.deterministic_check);
    if (hits.length) {
      keepEvaluatorFinding(check);
      check.violated = true;
      check.offending_quote = hits.map(h => h.quote).join(' | ');
      check.remediation_instruction =
        `Remove the prohibited language: ${hits.map(h => `"${h.quote}"`).join('; ')}. ${criterion.description}`;
      check.source = 'deterministic';
    }
  }

  // 4. Gate status — computed in code from the checks.
  const allRequiredPassed = report.required_checks.length > 0 && report.required_checks.every(c => c.passed === true);
  const noProhibitedViolated = report.prohibited_checks.every(c => c.violated !== true);
  const noUnanchoredCitations = offending.length === 0;
  report.gate_status = (allRequiredPassed && noProhibitedViolated && noUnanchoredCitations) ? 'PASSED' : 'BLOCKED';

  // HITL sign-off items for the reviewing law firm (lead.html).
  const checklist = Array.isArray(rubric.human_verification_checklist)
    ? rubric.human_verification_checklist.filter(item => typeof item === 'string' && item.trim())
    : [];
  report.human_verification_checklist = checklist.length ? checklist : [...DEFAULT_HUMAN_VERIFICATION_CHECKLIST];

  return report;
}

// ─── LLM evaluator ─────────────────────────────────────────────────────────────

function casesForPrompt(retrievedCases) {
  const lines = (Array.isArray(retrievedCases) ? retrievedCases : [])
    .filter(Boolean)
    .map(c => {
      const citations = [...new Set([...(Array.isArray(c.citations) ? c.citations : []), c.citation].filter(Boolean))];
      return `- ${c.caseName || 'Unknown'}${citations.length ? ` — ${citations.join('; ')}` : ''}`;
    });
  return lines.length ? lines.join('\n') : '(none retrieved — the reply may not cite any case law)';
}

function rubricForPrompt(rubric) {
  const pick = c => ({
    id: c.id,
    name: c.name,
    description: c.description,
    ...(c.turn_guidance ? { turn_guidance: c.turn_guidance } : {}),
    ...(c.violation_examples ? { violation_examples: c.violation_examples } : {}),
  });
  const { required, prohibited } = criteriaOf(rubric);
  return {
    domain_id: rubric.domain_id,
    domain_name: rubric.domain_name,
    required_criteria: required.map(pick),
    prohibited_criteria: prohibited.map(pick),
  };
}

function conversationTail(messages, limit = 6) {
  return (Array.isArray(messages) ? messages : [])
    .filter(m => m && m.role !== 'system' && typeof m.content === 'string')
    .slice(-limit)
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content.slice(0, 700)}`)
    .join('\n\n') || '(no prior messages)';
}

// The grader's verdicts, and who gave them: { verdicts, gradedBy: { provider, model } }.
async function runLlmEvaluator({ smallModels, rubric, draftText, turn, mode, retrievedCases, messages, deps, clock }) {
  const system = [
    `You are an uncompromising AI Compliance Gatekeeper and Enablement Coach for ${SERVICE_DESCRIPTION}.`,
    'You grade ONE AI-generated reply (the DRAFT) against a JSON rubric before it is shown to a member of the public.',
    '',
    'Rules:',
    '1. Return exactly one result for every item in required_criteria and every item in prohibited_criteria, using its exact id and name.',
    '2. Apply each criterion\'s description together with its turn_guidance for the TURN NUMBER given. If a criterion does not apply on this turn, mark it passed (required) or not violated (prohibited) and say "Not applicable on this turn".',
    '3. A required criterion passes only if the DRAFT itself satisfies it: quote the words that prove it, or state precisely what is missing.',
    '4. A prohibited criterion is violated only if you can quote the offending words verbatim from the DRAFT. If you cannot quote them, it is not violated. offending_quote is one passage copied exactly from the DRAFT with nothing added to it: no label, no note in brackets, no commentary.',
    '5. Case citations: the only cases the DRAFT may cite are those under RETRIEVED CASES. Citing a listed case is allowed. Statutes are not case citations. When a citation criterion is violated, offending_quote must be only the case name or citation exactly as the DRAFT writes it, not the sentence around it.',
    '6. Judge only the rubric. Do not reward or penalise tone, length or style beyond what a criterion says.',
    '7. CURRENT LAW NOTES, when supplied, are authoritative and may be newer than your training data. Never mark a draft down for following them. A draft fails for outdated law only if it affirmatively states a superseded rule as current law — quote that sentence. Citing an amended statute by number is correct, and a draft is never required to mention that the law changed.',
    '8. coaching: 1-3 plain-English sentences telling the drafter exactly what to change, or "No changes needed."',
    '',
    'Respond ONLY with JSON of this exact shape:',
    '{"required_checks":[{"id":"...","name":"...","passed":true,"evidence_or_gap":"..."}],"prohibited_checks":[{"id":"...","name":"...","violated":false,"offending_quote":"None","remediation_instruction":"..."}],"coaching":"..."}',
  ].join('\n');

  const currentLaw = renderCurrentLawForPrompt();
  const user = [
    '=== RUBRIC ===',
    JSON.stringify(rubricForPrompt(rubric), null, 2),
    '',
    `=== MODE === ${mode}`,
    `=== TURN NUMBER === ${turn}`,
    '',
    ...(currentLaw ? ['=== CURRENT LAW NOTES ===', currentLaw, ''] : []),
    '=== RETRIEVED CASES (the only case law the draft may cite) ===',
    casesForPrompt(retrievedCases),
    '',
    '=== CONVERSATION SO FAR (most recent last) ===',
    conversationTail(messages),
    '',
    '=== DRAFT TO EVALUATE ===',
    draftText,
  ].join('\n');

  const res = await runJob({
    job: 'grade',
    chain: smallModels,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    json: true,
    temperature: 0,
    maxTokens: EVALUATOR_MAX_TOKENS,
    clock,
  }, deps);

  const parsed = JSON.parse(res.text);
  if (!parsed || typeof parsed !== 'object') throw new Error('LLM evaluator returned a non-object');
  return { verdicts: parsed, gradedBy: { provider: res.provider, model: res.model } };
}

function clip(value, max = 600) {
  const text = typeof value === 'string' ? value : (value == null ? '' : String(value));
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeForQuote(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A free-text field of a verdict, however the model wrote it (a string, or a list of strings).
function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join(' | ');
  return '';
}

function wordsOf(value, limit) {
  const words = normalizeForQuote(value).match(/[\p{L}\p{N}]+/gu) || [];
  return words.length > limit ? words.slice(0, limit) : words;
}

const MIN_QUOTED_RUN = 4;

// The evaluator is told a prohibited criterion is violated only if it can quote the offending
// words. This holds it to that without being defeated by how the quote is presented — a label, a
// note in brackets, several quotes joined together: a run of the draft's own words has to be in
// it, four in a row or the whole quote when it is shorter.
function quoteAppearsInDraft(quote, draftText) {
  const quoted = wordsOf(quote, 200);
  const draft = wordsOf(draftText, 6000);
  if (!quoted.length || !draft.length) return false;
  const needed = Math.min(MIN_QUOTED_RUN, quoted.length);

  // Longest run of consecutive words the two share, one row of the table at a time.
  let previous = new Array(draft.length + 1).fill(0);
  for (let i = 1; i <= quoted.length; i++) {
    const current = new Array(draft.length + 1).fill(0);
    for (let j = 1; j <= draft.length; j++) {
      if (quoted[i - 1] !== draft[j - 1]) continue;
      current[j] = previous[j - 1] + 1;
      if (current[j] >= needed) return true;
    }
    previous = current;
  }
  return false;
}

// How a model spells a verdict when it does not use the boolean it was asked for.
const PASS_WORDS = new Set(['pass', 'passed', 'ok', 'met', 'satisfied', 'compliant', 'not violated', 'not_violated', 'clean']);
const FAIL_WORDS = new Set(['fail', 'failed', 'not passed', 'not met', 'unsatisfied', 'violated', 'violation', 'non-compliant', 'noncompliant']);

// 'pass' | 'fail' | null for one value. `yes` is what a plain true / yes / 1 means for the field
// the value was read from: a pass for "passed", a fail for "violated".
function outcomeOf(value, yes) {
  const no = yes === 'pass' ? 'fail' : 'pass';
  if (typeof value === 'boolean') return value ? yes : no;
  if (typeof value === 'number') return value === 1 ? yes : (value === 0 ? no : null);
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase().replace(/[\s.!]+$/, '');
  if (word === 'true' || word === 'yes' || word === 'y' || word === '1') return yes;
  if (word === 'false' || word === 'no' || word === 'n' || word === '0') return no;
  if (PASS_WORDS.has(word)) return 'pass';
  if (FAIL_WORDS.has(word)) return 'fail';
  return null;
}

const VERDICT_WRAPPERS = ['result', 'verdict', 'outcome'];

// The outcome one verdict entry reports for a criterion, wherever the model put it. A fail in
// any field wins over a pass in another.
function entryOutcome(entry, kind) {
  const yes = kind === 'required' ? 'pass' : 'fail';
  const outcomes = [
    outcomeOf(entry.passed, 'pass'),
    outcomeOf(entry.violated, 'fail'),
    ...['flag', 'status', ...VERDICT_WRAPPERS].map(key => outcomeOf(entry[key], yes)),
  ];
  if (outcomes.includes('fail')) return 'fail';
  return outcomes.includes('pass') ? 'pass' : null;
}

// "REQ-PI-01", "req_pi_01" and "REQ-PI-1" are the same criterion.
function canonicalId(id) {
  return String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '').replace(/(\D)0+(?=\d)/g, '$1');
}

// An entry whose fields sit one level down ({ id, result: { passed, evidence_or_gap } }) is read
// as if they were on the entry itself.
function flattenEntry(entry) {
  const wrapper = VERDICT_WRAPPERS.find(key => isObject(entry[key]));
  return wrapper ? { ...entry[wrapper], ...entry, [wrapper]: undefined } : entry;
}

function verdictEntries(list) {
  if (Array.isArray(list)) return list.filter(isObject).map(flattenEntry);
  if (!isObject(list)) return [];
  // A map keyed by criterion id instead of a list.
  return Object.entries(list).map(([id, value]) => (isObject(value) ? flattenEntry({ id, ...value }) : { id, flag: value }));
}

// Every verdict in an evaluator response, grouped by criterion. Tolerates the shapes a model
// drifts into: one level of wrapping, a map instead of a list, a verdict filed under the wrong
// list, a reformatted id, and the same criterion answered twice.
function collectVerdicts(response) {
  const hasChecks = value => isObject(value) && ('required_checks' in value || 'prohibited_checks' in value);
  let body = response;
  if (!hasChecks(body) && isObject(body)) body = Object.values(body).find(hasChecks) || body;

  const byId = new Map();
  for (const entry of [...verdictEntries(body?.required_checks), ...verdictEntries(body?.prohibited_checks)]) {
    if (typeof entry.id !== 'string' && typeof entry.id !== 'number') continue;
    const key = canonicalId(entry.id);
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(entry);
  }
  return { byId, coaching: typeof body?.coaching === 'string' ? body.coaching : '' };
}

// The verdict for one criterion, or null if the response has none that can be read. When the
// criterion was answered more than once, a fail wins.
function verdictFor(byId, check, kind) {
  let passing = null;
  for (const entry of byId.get(canonicalId(check.id)) || []) {
    const outcome = entryOutcome(entry, kind);
    if (outcome === 'fail') return { outcome, entry };
    if (outcome === 'pass' && !passing) passing = { outcome, entry };
  }
  return passing;
}

const NO_VERDICT_NOTE = 'The LLM evaluator returned no verdict for this criterion.';

// Overlay the evaluator's verdicts onto a baseline report and return the ids of the criteria it
// gave a usable verdict for. A criterion it skipped keeps the baseline result and says so.
function applyLlmVerdicts(report, response, draftText, { withCoaching = true } = {}) {
  const { byId, coaching } = collectVerdicts(response);
  const graded = new Set();

  for (const check of report.required_checks) {
    const verdict = verdictFor(byId, check, 'required');
    if (!verdict) {
      check.evidence_or_gap = NO_VERDICT_NOTE;
      continue;
    }
    const passed = verdict.outcome === 'pass';
    graded.add(check.id);
    check.passed = passed;
    check.evidence_or_gap = clip(textOf(verdict.entry.evidence_or_gap)) || (passed ? 'Passed.' : 'Failed.');
    check.source = 'llm';
  }
  for (const check of report.prohibited_checks) {
    const verdict = verdictFor(byId, check, 'prohibited');
    if (!verdict) {
      check.evaluator_note = NO_VERDICT_NOTE;
      continue;
    }
    const violated = verdict.outcome === 'fail';
    const quote = textOf(verdict.entry.offending_quote) || textOf(verdict.entry.quote) || textOf(verdict.entry.evidence_or_gap);
    graded.add(check.id);
    check.source = 'llm';
    if (violated && !quoteAppearsInDraft(quote, draftText)) {
      // Reported without words that are in the draft: not counted, but kept on the record — and
      // not treated as clearing a finding from an earlier attempt (see carryUnresolvedFindings).
      check.violated = false;
      check.offending_quote = 'None';
      check.remediation_instruction = '';
      check.evaluator_note = `Evaluator reported a violation it could not quote from the draft (${clip(quote, 200) || 'no quote given'}); not counted.`;
      check.unverified_violation = true;
      continue;
    }
    check.violated = violated;
    check.offending_quote = violated ? clip(quote) : 'None';
    check.remediation_instruction = violated ? clip(textOf(verdict.entry.remediation_instruction)) : '';
  }
  if (withCoaching && coaching) report.coaching = clip(coaching, 800);
  return graded;
}

const UNRESOLVED_PREFIX = 'Unresolved from the previous attempt (the rewrite could not be re-evaluated): ';

// A failure the evaluator found is cleared only by a later evaluator verdict. When a rewrite could
// not be graded — the evaluator was down, skipped the criterion, or repeated its complaint
// without quoting the rewrite — the earlier finding stands, so an outage can never turn a BLOCKED
// reply into a PASSED one. That holds whether the finding was the check's own result or sat
// behind a result code recorded on the same check.
function carryUnresolvedFindings(report, previous) {
  for (const earlier of previous.required_checks || []) {
    const finding = evaluatorFindingOf(earlier);
    if (!finding) continue;
    const check = report.required_checks.find(c => c.id === earlier.id);
    if (!check || check.source !== 'not_evaluated') continue;
    const gap = String(finding.evidence_or_gap || '');
    check.passed = false;
    check.evidence_or_gap = gap.startsWith(UNRESOLVED_PREFIX) ? gap : `${UNRESOLVED_PREFIX}${gap}`;
    check.source = 'unresolved';
  }
  for (const earlier of previous.prohibited_checks || []) {
    const finding = evaluatorFindingOf(earlier);
    if (!finding) continue;
    const check = report.prohibited_checks.find(c => c.id === earlier.id);
    if (!check || !(check.source === 'not_evaluated' || check.unverified_violation === true)) continue;
    check.evaluator_note = check.unverified_violation
      ? 'Unresolved from the previous attempt: the evaluator reported this again without quoting the rewrite, so the earlier finding stands.'
      : 'Unresolved from the previous attempt: the rewrite could not be re-evaluated, so the earlier finding stands.';
    check.violated = true;
    check.offending_quote = finding.offending_quote;
    check.remediation_instruction = finding.remediation_instruction;
    check.source = 'unresolved';
    delete check.unverified_violation;
  }
}

// What has to change, check by check. With `withEvaluatorFindings`, a finding of the evaluator's
// that sits behind a code-level result on the same check is listed as well.
function coachingFor(failed, violated, { withEvaluatorFindings = true } = {}) {
  if (!failed.length && !violated.length) return 'No changes needed.';
  const behind = c => (withEvaluatorFindings && c.evaluator_finding ? [c.evaluator_finding] : []);
  return [
    ...failed.flatMap(c => [c, ...behind(c)].map(f => `[${c.id}] ${c.name}: ${f.evidence_or_gap}`)),
    ...violated.flatMap(c => [c, ...behind(c)].map(f => `[${c.id}] ${c.name}: ${f.remediation_instruction || `remove "${f.offending_quote}"`}`)),
  ].join(' ');
}

// Coaching has to describe the gated result, not just what the evaluator saw. On a blocked reply
// the evaluator's note is kept and anything the code-level checks caught is appended to it. On a
// passed reply the coaching is "No changes needed."; advice from the evaluator that says
// otherwise (because code overruled it) is kept as the evaluator's, not presented as the gate's.
function finalizeCoaching(report) {
  const failed = failedRequired(report);
  const violated = violatedProhibited(report);
  const note = typeof report.coaching === 'string' ? report.coaching.trim() : '';
  const noteSaysClean = !note || /^no changes needed\.?$/i.test(note);

  if (report.gate_status !== 'BLOCKED') {
    if (!noteSaysClean) report.evaluator_coaching = note;
    return 'No changes needed.';
  }
  if (noteSaysClean) return coachingFor(failed, violated);

  const codeFailed = failed.filter(c => c.source === 'deterministic');
  const codeViolated = violated.filter(c => c.source === 'deterministic');
  return (codeFailed.length || codeViolated.length)
    ? `${note} Deterministic gate: ${coachingFor(codeFailed, codeViolated, { withEvaluatorFindings: false })}`
    : note;
}

// Criteria the evaluator had to grade and did not. (A criterion code decides both ways — the
// mandatory phrase — does not need its verdict.)
function ungradedCriteria(ctx, graded) {
  const { required, prohibited } = criteriaOf(ctx.rubric);
  const phraseCriterion = findDeterministicCriterion(ctx.rubric, ctx.mode, 'required_phrase');
  return [...required, ...prohibited]
    .map(c => c.id)
    .filter(id => !graded.has(id) && id !== phraseCriterion?.id);
}

// Grade one draft: LLM verdicts (unless deterministic) → deterministic gate.
// `previous` is the report of the blocked attempt this draft replaces, when there is one. `gradedBy` is the
// model whose verdicts the report holds ({ provider, model }), or null when code graded the draft alone; carried
// verdicts come with the model that gave them.
async function evaluateDraft(ctx, draftText, { carriedVerdicts = null, carriedGradedBy = null, previous = null } = {}) {
  let report = baselineReport(ctx.rubric);
  let evaluator = 'deterministic';
  let verdicts = null;
  let gradedBy = null;

  if (carriedVerdicts) {
    // The earlier verdicts, about a draft that has only had the disclaimer appended since. The
    // advice that came with them was about the draft before that, so it is not carried.
    applyLlmVerdicts(report, carriedVerdicts, draftText, { withCoaching: false });
    verdicts = carriedVerdicts;
    gradedBy = carriedGradedBy;
    evaluator = 'carried_forward';
  } else {
    // An empty draft is not sent to the evaluator: the deterministic gate fails it outright.
    if (!ctx.deterministicOnly && String(draftText ?? '').trim()) {
      try {
        const { verdicts: response, gradedBy: grader } = await runLlmEvaluator({ ...ctx, draftText });
        const graded = applyLlmVerdicts(report, response, draftText);
        if (graded.size === 0) throw new Error('the evaluator returned no usable verdict for any criterion');
        verdicts = response;
        gradedBy = grader;
        const skipped = ungradedCriteria(ctx, graded);
        evaluator = skipped.length ? 'llm_incomplete' : 'llm';
        if (skipped.length) report.evaluator_error = `The evaluator returned no usable verdict for: ${skipped.join(', ')}`;
      } catch (err) {
        console.error('[Gatekeeper] LLM evaluator unavailable, using deterministic evaluation:', errorText(err));
        report = baselineReport(ctx.rubric);
        report.evaluator_error = clip(errorText(err), 300);
        evaluator = 'deterministic_fallback';
        verdicts = null;
        gradedBy = null;
      }
    }
    if (previous) carryUnresolvedFindings(report, previous);
  }

  await enforceDeterministicGate(report, draftText, ctx.turn, ctx.mode, ctx.retrievedCases, {
    enableCourtListener: ctx.enableCourtListener,
    fetchImpl: ctx.fetchImpl,
    lookupCache: ctx.lookupCache,
    rubric: ctx.rubric,
  });

  report.evaluator = evaluator;
  report.coaching = finalizeCoaching(report);
  return { report, verdicts, gradedBy };
}

// ─── Remediation ───────────────────────────────────────────────────────────────

// Code-level repairs for the rules code can fix exactly. Returns { text, repairs[] }.
function applyDeterministicRepairs(draftText, ctx) {
  const repairs = [];
  let text = String(draftText ?? '');
  const { prohibited } = criteriaOf(ctx.rubric);

  // Prohibited guarantee language: drop the offending sentence(s).
  for (const criterion of prohibited) {
    if (criterion?.deterministic_check?.type !== 'forbidden_patterns') continue;
    const hits = findForbiddenMatches(text, criterion.deterministic_check);
    if (!hits.length) continue;
    text = removeSentences(text, hits);
    for (const hit of hits) {
      repairs.push(`Removed sentence violating ${criterion.id} (${criterion.name}): "${clip(hit.quote, 200)}"`);
    }
  }

  // Unanchored citations: flag each one so it can never read as verified authority.
  if (findDeterministicCriterion(ctx.rubric, ctx.mode, 'citation_anchoring')) {
    const flagged = flagUnanchoredCitations(text, ctx.retrievedCases);
    if (flagged.flagged.length) {
      text = flagged.text;
      repairs.push(`Flagged unanchored citation(s) with ${VERIFY_PLACEHOLDER}: ${flagged.flagged.join('; ')}`);
    }
  }

  // Mandatory phrase: append it.
  const phraseCriterion = findDeterministicCriterion(ctx.rubric, ctx.mode, 'required_phrase');
  if (phraseCriterion) {
    const check = phraseCriterion.deterministic_check || {};
    const phrase = check.phrase || DEFAULT_REQUIRED_PHRASE;
    if (!containsPhrase(text, phrase)) {
      const sentence = check.repair_text || `${phrase}.`;
      text = `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${sentence}`;
      repairs.push(`Appended mandatory disclaimer required by ${phraseCriterion.id}: "${sentence}"`);
    }
  }

  return { text, repairs };
}

// Everything the rewrite has to fix: each failing check, and any finding of the evaluator's that
// sits behind a code-level result on the same check.
function remediationBrief(report) {
  const behind = c => (c.evaluator_finding ? [c.evaluator_finding] : []);
  return [
    ...failedRequired(report).flatMap(c => [c, ...behind(c)].map(f =>
      `- [${c.id}] ${c.name}: FAILED. Gap to fix: ${f.evidence_or_gap}`)),
    ...violatedProhibited(report).flatMap(c => [c, ...behind(c)].map(f =>
      `- [${c.id}] ${c.name}: VIOLATED by "${f.offending_quote}". Required fix: ${f.remediation_instruction || 'remove the offending language.'}`)),
  ].join('\n');
}

// The replacement reply, and who wrote it: { text, writtenBy: { provider, model } }.
async function runLlmRemediation(ctx, blockedDraft, report) {
  const hadReply = Boolean(String(blockedDraft ?? '').trim());
  const instruction = [
    'COMPLIANCE GATEKEEPER — AUTOMATIC REMEDIATION',
    hadReply
      ? 'Your previous reply (the assistant message directly above) was BLOCKED by the compliance gate and was NOT shown to the user. Write a replacement reply to the user\'s last message.'
      : 'Your previous reply was empty, so nothing was shown to the user. Write the reply to the user\'s last message now.',
    '',
    'Fix every item below:',
    remediationBrief(report),
    '',
    'Rules for the replacement:',
    '1. Keep everything in the previous reply that was compliant — same substance, tone and turn-appropriate purpose. Change only what is needed.',
    '2. Satisfy every rule in the rubric below.',
    '3. You may cite ONLY these retrieved cases, using the exact name and citation shown. Never cite a case from memory:',
    casesForPrompt(ctx.retrievedCases),
    '4. Output ONLY the replacement reply. No preamble, no notes about the correction, no mention of this instruction or of any gatekeeper.',
    '',
    renderRubricForPrompt(ctx.mode, ctx.turn),
  ].join('\n');

  // A model that answers with no text is passed over for the next in the chain, so a rewrite is never empty.
  const res = await runJob({
    job: 'rewrite',
    chain: ctx.answerModels,
    messages: [
      ...(Array.isArray(ctx.messages) ? ctx.messages : []),
      ...(hadReply ? [{ role: 'assistant', content: blockedDraft }] : []),
      { role: 'system', content: instruction },
    ],
    temperature: 0.2,
    maxTokens: REMEDIATION_MAX_TOKENS,
    clock: ctx.clock,
  }, ctx.deps);

  return { text: res.text, writtenBy: { provider: res.provider, model: res.model } };
}

// True when every failure is something code repairs exactly by appending text, so no rewrite is needed.
function onlyAppendRepairsNeeded(ctx, report) {
  const phraseCriterion = findDeterministicCriterion(ctx.rubric, ctx.mode, 'required_phrase');
  const failed = failedRequired(report);
  if (violatedProhibited(report).length) return false;
  return failed.length > 0 && failed.every(c => phraseCriterion && c.id === phraseCriterion.id);
}

// One remediation pass. An LLM rewrite (when needed and available) followed by the code-level
// repairs as a guard, so the rules code can decide hold whatever the model does. `writtenBy` is the model
// that rewrote the draft, or null when none did.
async function remediate(ctx, blockedDraft, report) {
  const steps = [];
  let text = blockedDraft;
  let writtenBy = null;
  let rewriteError = null;
  const appendOnly = onlyAppendRepairsNeeded(ctx, report);

  // A rewrite is asked only of an answer chain the caller supplied.
  if (!ctx.deterministicOnly && !appendOnly && ctx.answerModels?.length) {
    try {
      ({ text, writtenBy } = await runLlmRemediation(ctx, blockedDraft, report));
      steps.push('llm_rewrite');
    } catch (err) {
      console.error('[Gatekeeper] LLM remediation failed, applying deterministic repairs only:', errorText(err));
      rewriteError = clip(errorText(err), 300);
    }
  }

  const repaired = applyDeterministicRepairs(text, ctx);
  if (repaired.repairs.length) steps.push(steps.length ? 'deterministic_guard' : 'deterministic');

  return {
    text: repaired.text,
    appendOnly,
    writtenBy,
    remediation: {
      method: steps.join('+') || 'none',
      deterministic_repairs: repaired.repairs,
      ...(rewriteError ? { llm_rewrite_error: rewriteError } : {}),
    },
  };
}

// ─── Public pipeline ───────────────────────────────────────────────────────────

function attemptRecord(number, draftText, report, remediation) {
  return {
    attempt_number: number,
    gate_status: report.gate_status,
    evaluator: report.evaluator,
    draft_text: draftText,
    ...(remediation ? { remediation } : {}),
    required_checks: structuredClone(report.required_checks),
    prohibited_checks: structuredClone(report.prohibited_checks),
    citation_audit: structuredClone(report.citation_audit),
    coaching: report.coaching,
    ...(report.evaluator_coaching ? { evaluator_coaching: report.evaluator_coaching } : {}),
    ...(report.evaluator_error ? { evaluator_error: report.evaluator_error } : {}),
  };
}

function buildInitialCoaching(report) {
  const failed = failedRequired(report);
  const violated = violatedProhibited(report);
  const passed = report.gate_status === 'PASSED';
  return {
    attempt_number: 1,
    gate_status: report.gate_status,
    summary: passed
      ? 'Attempt 1 passed every Required and Prohibited criterion; no remediation was needed.'
      : `Attempt 1 was BLOCKED on ${describeChecks([...failed, ...violated])}.`,
    failed_required: failed.map(c => ({
      id: c.id, name: c.name, evidence_or_gap: c.evidence_or_gap,
      ...(c.evaluator_finding ? { evaluator_finding: c.evaluator_finding } : {}),
    })),
    violated_prohibited: violated.map(c => ({
      id: c.id, name: c.name, offending_quote: c.offending_quote, remediation_instruction: c.remediation_instruction,
      ...(c.evaluator_finding ? { evaluator_finding: c.evaluator_finding } : {}),
    })),
    coach_note: report.coaching,
  };
}

// GATEKEEPER_MODE, lower-cased: "deterministic", "llm", or anything else for the default.
function gateModeSetting() {
  return String(process.env.GATEKEEPER_MODE || '').trim().toLowerCase();
}

function courtListenerLookupEnabled() {
  return !/^(?:off|false|0|no)$/i.test(String(process.env.GATEKEEPER_COURTLISTENER_LOOKUP || 'on').trim());
}

/**
 * Evaluate a draft reply and, if the gate blocks it, auto-remediate (up to the rubric's
 * max_auto_retries). Returns the text to serve plus the full evaluation, which keeps every
 * attempt and the diagnosis of the first failure (No Silent Fixes).
 *
 * In NODE_ENV === 'test' (or GATEKEEPER_MODE=deterministic) evaluation and remediation are pure
 * code — no model or CourtListener calls are made. GATEKEEPER_MODE=llm asks the model grader even
 * in a test environment: the model measurement (measure/) runs as one, so that the spending cap and
 * the database stay out of it, and the grader is what it is there to compare. Everywhere else the
 * model grader is already the default, so there the setting changes nothing. Without a grader chain
 * the draft is graded by code, and without an answer chain it is never rewritten by a model.
 *
 * The evaluation records who wrote the reply that is served and who graded it, each as
 * { provider, model }: writtenBy is the rewrite's model when a rewrite is served, and otherwise the
 * draft's; gradedBy is null when code graded the reply alone.
 *
 * The grades and the rewrite are given the reply's clock, when there is one. A step that finds too
 * little of the reply's time left fails at once, and the gate does what it does when that step fails:
 * the steps run in turn, so the second grade gives way first, then the rewrite, then the first grade.
 *
 * @param {object} params
 * @param {string[]} params.smallModels  model chain for the evaluator
 * @param {string[]} params.answerModels model chain for the remediation rewrite
 * @param {Array} params.messages       the chat messages that produced the draft (system + history + user)
 * @param {string} params.draftText     Attempt 1
 * @param {object|null} [params.writtenBy]  who wrote the draft, { provider, model }; null when no model did
 * @param {number} params.turn
 * @param {string} params.mode  one of the modes in gate-config.js
 * @param {Array} [params.retrievedCases]
 * @param {boolean} [params.deterministicOnly]  override the mode switch (tests)
 * @param {Function} [params.fetchImpl]         injected fetch for the CourtListener lookup (tests)
 * @param {object} [params.deps]                handed on to runJob (providers.js): tests pass fake adapters
 * @param {object|null} [params.clock]          the reply's clock (replyClock in providers.js), handed on to runJob
 * @returns {Promise<{finalText: string, evaluation: object}>}
 */
export async function evaluateAndRemediateDraft({
  smallModels = [],
  answerModels = [],
  messages = [],
  draftText,
  writtenBy = null,
  turn,
  mode,
  retrievedCases = [],
  deterministicOnly,
  fetchImpl,
  deps = {},
  clock = null,
}) {
  const gateMode = normalizeMode(mode);
  const rubric = loadRubric(gateMode);
  const configuredRetries = Number.parseInt(rubric.max_auto_retries, 10);
  const maxRetries = Number.isFinite(configuredRetries)
    ? Math.min(Math.max(configuredRetries, 0), MAX_RETRY_CEILING)
    : 1;

  const ctx = {
    smallModels,
    answerModels,
    deps,
    clock,
    messages,
    turn,
    mode: gateMode,
    rubric,
    retrievedCases: Array.isArray(retrievedCases) ? retrievedCases : [],
    fetchImpl,
    enableCourtListener: courtListenerLookupEnabled(),
    // What CourtListener said about a citation holds for every attempt at this reply: a second
    // lookup that is throttled must not turn "no such citation" back into "not checked".
    lookupCache: new Map(),
    deterministicOnly: typeof deterministicOnly === 'boolean'
      ? deterministicOnly
      : (!smallModels?.length ||
         gateModeSetting() === 'deterministic' ||
         (process.env.NODE_ENV === 'test' && gateModeSetting() !== 'llm')),
  };

  const attempts = [];
  const remediationNotes = [];
  let currentText = String(draftText ?? '');
  // Who wrote the text that would be served now: the draft's writer, until a rewrite is served instead.
  let author = writtenBy ?? null;

  let { report, verdicts, gradedBy } = await evaluateDraft(ctx, currentText);
  attempts.push(attemptRecord(1, currentText, report));
  const initialCoaching = buildInitialCoaching(report);

  let retriesUsed = 0;
  while (report.gate_status === 'BLOCKED' && retriesUsed < maxRetries) {
    const { text, remediation, appendOnly, writtenBy: rewrittenBy } = await remediate(ctx, currentText, report);
    if (text === currentText) {
      const stillFailing = describeChecks([...failedRequired(report), ...violatedProhibited(report)]);
      remediationNotes.push(
        remediation.method.includes('llm_rewrite')
          ? `The automatic rewrite returned the draft unchanged; still failing: ${stillFailing}`
          : `No automatic repair was available for: ${stillFailing}` +
            (remediation.llm_rewrite_error ? ` (LLM rewrite failed: ${remediation.llm_rewrite_error})` : '')
      );
      break;
    }
    retriesUsed += 1;
    currentText = text;
    if (rewrittenBy) author = rewrittenBy;

    // When the only change was appending the mandatory disclaimer, nothing the evaluator graded
    // has changed, so its verdicts carry over instead of paying for a second evaluation.
    const carry = appendOnly && !remediation.method.includes('llm_rewrite') ? verdicts : null;
    const next = await evaluateDraft(ctx, currentText, { carriedVerdicts: carry, carriedGradedBy: gradedBy, previous: report });
    report = next.report;
    verdicts = next.verdicts;
    gradedBy = next.gradedBy;
    attempts.push(attemptRecord(retriesUsed + 1, currentText, report, remediation));
  }

  if (report.gate_status === 'BLOCKED') {
    console.warn(
      `[Gatekeeper] ${rubric.domain_id} turn ${turn}: reply served with gate BLOCKED after ${attempts.length} attempt(s) — ` +
      describeChecks([...failedRequired(report), ...violatedProhibited(report)])
    );
  }

  const evaluation = {
    domain_id: rubric.domain_id,
    domain_name: rubric.domain_name,
    rubric_version: rubric.version || null,
    mode: gateMode,
    turn,
    gate_status: report.gate_status,
    first_pass_compliant: attempts[0].gate_status === 'PASSED',
    auto_retries_used: retriesUsed,
    max_auto_retries: maxRetries,
    final_attempt_number: attempts.length,
    evaluator: report.evaluator,
    // Kept on the record and never sent to the visitor's browser (toPublicEvaluation names what it sends).
    writtenBy: author,
    gradedBy,
    required_checks: report.required_checks,
    prohibited_checks: report.prohibited_checks,
    citation_audit: report.citation_audit,
    human_verification_checklist: report.human_verification_checklist,
    coaching: report.coaching,
    initial_coaching: initialCoaching,
    attempts,
    ...(remediationNotes.length ? { remediation_notes: remediationNotes } : {}),
    evaluated_at: new Date().toISOString(),
  };

  return { finalText: currentText, evaluation };
}

/**
 * The evaluation as it may be sent to the end user's browser. Text the gate blocked — earlier
 * drafts, the quotes lifted from them, and coaching that repeats them — stays server-side (it is
 * kept in full on the lead record for the reviewing firm). The verdict on the reply that was
 * actually served is passed through unchanged.
 */
export function toPublicEvaluation(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const attempts = Array.isArray(evaluation.attempts) ? evaluation.attempts : [];
  const idName = c => ({ id: c.id, name: c.name });
  // A finding carried over from an earlier draft describes text that was never served.
  const withheld = finding => ({
    ...finding,
    ...('evidence_or_gap' in finding ? { evidence_or_gap: 'Unresolved from the previous attempt (the rewrite could not be re-evaluated).' } : {}),
    ...('offending_quote' in finding ? { offending_quote: 'Withheld (from an earlier draft).', remediation_instruction: '' } : {}),
  });
  const servedOnly = check => {
    if (!check || typeof check !== 'object') return check;
    const view = check.source === 'unresolved' ? withheld(check) : { ...check };
    if (view.evaluator_finding?.source === 'unresolved') view.evaluator_finding = withheld(view.evaluator_finding);
    return view;
  };

  return {
    domain_id: evaluation.domain_id,
    mode: evaluation.mode,
    turn: evaluation.turn,
    gate_status: evaluation.gate_status,
    first_pass_compliant: evaluation.first_pass_compliant,
    auto_retries_used: evaluation.auto_retries_used,
    max_auto_retries: evaluation.max_auto_retries,
    final_attempt_number: evaluation.final_attempt_number,
    evaluator: evaluation.evaluator,
    required_checks: (evaluation.required_checks || []).map(servedOnly),
    prohibited_checks: (evaluation.prohibited_checks || []).map(servedOnly),
    citation_audit: evaluation.citation_audit,
    human_verification_checklist: evaluation.human_verification_checklist,
    initial_coaching: evaluation.initial_coaching
      ? {
          attempt_number: 1,
          gate_status: evaluation.initial_coaching.gate_status,
          summary: evaluation.initial_coaching.summary,
          failed_required: (evaluation.initial_coaching.failed_required || []).map(idName),
          violated_prohibited: (evaluation.initial_coaching.violated_prohibited || []).map(idName),
        }
      : null,
    attempts: attempts.map(a => ({
      attempt_number: a.attempt_number,
      gate_status: a.gate_status,
      evaluator: a.evaluator,
      failed_required: (a.required_checks || []).filter(c => c.passed !== true).map(idName),
      violated_prohibited: (a.prohibited_checks || []).filter(c => c.violated === true).map(idName),
      ...(a.remediation ? { remediation_method: a.remediation.method } : {}),
    })),
    evaluated_at: evaluation.evaluated_at,
  };
}
