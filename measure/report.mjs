// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The model measurement's report. It reads the run files that run.mjs wrote, sets each run beside the bar a
// model must pass, and writes docs/measurements/<date>-<app>.md for the owner to choose from. It also prints each
// model's time limit for each job that follows from the runs (timeLimits), which an app's own limits are set from.
//
//   npm run models:report -- --app <app> --baseline <labels> [--small-baseline <labels>] [--replies <labels>]
//                            [--smalls <labels>] [--pairs <labels>] [--samples <labels>] [--note "<text>"]...
//
// Labels are separated by commas. --baseline names today's models' runs (a recording run and its repeats);
// --small-baseline names today's models' small-job runs; --replies and --smalls name the candidates' runs;
// --pairs names reply runs in which both models were changed together, shown for information;
// --samples names runs whose replies are set out in full beside today's, in a second file.
//
// A run may use a model of any of the three providers (OpenAI, Anthropic, Google): the report names each model's provider
// from the registry (model-registry.js), and prices every call at that model's price.
//
// The bar, from the design (docs/superpowers/specs/2026-11-19-ai-providers-design.md, section 4):
//   a reply model      passes the gate after the one rewrite at least as often as today's model's worst run
//                      (judged on the number of turns that did not pass);
//                      has no more first drafts citing a case that cannot be anchored than today's worst run;
//                      passes the seminar rubric at least as often as today's worst run;
//                      and the slowest tenth of its replies takes at most 10 seconds.
//   a small-job model  gives a usable answer every time; agrees with the answer today's model gives most often
//                      (case type, lead tier, the grader's first verdict) at least as often as today's model
//                      agrees with its own other runs; keeps the average lead score within 3 points; catches
//                      every known-bad draft that today's model catches in every run; and the slowest tenth of
//                      each job's calls takes at most 4 seconds.
//
// This file is the same in both apps.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MEASURE_DATABASE_URL } from './guard-fetch.mjs';
import { entryFor, priceOn } from '../model-registry.js';
import { VISITORS } from './visitors.mjs';
import * as app from './app.mjs';

const REPLY_SLOWEST_TENTH_LIMIT_MS = 10_000;
const SMALL_SLOWEST_TENTH_LIMIT_MS = 4_000;
const LEAD_SCORE_TOLERANCE = 3;
// A reply run counts as a measurement of its model while no more than this share of its first drafts went
// ungraded by the model grader.
const UNGRADED_SHARE_ALLOWED = 0.1;
// The site gives a turn up after this long and asks the visitor to send the message again.
const TURN_DEADLINE_MS = 45_000;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

// ─── Counting ─────────────────────────────────────────────────────────────────

// The nearest-rank percentile: the smallest value with at least that share of the values at or under it.
function percentile(values, share) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)];
}

const keyOf = turn => `${turn.visitor}:${turn.turn}`;
const rate = (list, test) => (list.length ? list.filter(test).length / list.length : 1);
const visitorsIn = run => new Set(run.turns.map(turn => turn.visitor)).size || 1;
// `day` prices the calls at the price in force on that day ('YYYY-MM-DD'), for a price a provider has announced; without
// it, at today's.
const costOf = (calls, price, day = undefined) => calls.reduce((sum, call) => sum + price(call.model, call.inputTokens ?? 0, call.outputTokens ?? 0, '', day), 0);
// A call that ran out of time: the limit cut it off (the clock a run is made under does that), which the SDKs and the
// guard record as a timeout or an abort and never with a status. Its own time is the limit it was given, which is less
// than it needed, so it is counted as over any limit and not as the time it took.
const timedOut = failure => failure?.status === undefined && /timed out|timeout|abort/i.test(String(failure?.error ?? ''));
const timeOf = failure => (timedOut(failure) ? Infinity : failure.ms);
// The calls that were refused or never answered, by what they failed on: "429 x2, Request timed out. x1".
function failureSummary(failures) {
  const counts = new Map();
  for (const failure of failures) {
    const what = String(failure.status ?? failure.error ?? 'unknown');
    counts.set(what, (counts.get(what) ?? 0) + 1);
  }
  return [...counts].map(([what, count]) => `${what} x${count}`).join(', ');
}
// A reply is served and passed: an empty reply is no reply, whatever the gate said of it.
const passedFinally = turn => turn.gateStatus === 'PASSED' && Boolean(turn.served);

function seminarTest({ visitors = VISITORS, seminarModes = app.SEMINAR_MODES } = {}) {
  const modeOf = new Map(visitors.map(visitor => [visitor.key, visitor.mode]));
  return turn => seminarModes.includes(modeOf.get(turn.visitor));
}

/**
 * What a run says of its answer model.
 * `price(model, inputTokens, outputTokens)` is the app's own price table (estimateAiCost). `visitors` and `adapter`
 * are the app's own (visitors.mjs, app.mjs) unless others are given.
 */
export function replyStats(run, { price, visitors = VISITORS, adapter = app, day = undefined } = {}) {
  const isSeminar = seminarTest({ visitors, seminarModes: adapter.SEMINAR_MODES });
  const replyJobs = adapter.REPLY_JOBS;
  const seminar = run.turns.filter(isSeminar);
  // The reply job's own calls: the drafts and the rewrites, which go to the same chain.
  const replyCalls = (run.calls ?? []).filter(call => replyJobs.includes(call.job));
  // And those of its calls that were refused or never answered. Each still took the time it took, so a call that
  // ran out of time counts as slow: as over any limit.
  const failures = (run.failed ?? []).filter(failure => replyJobs.includes(failure.job));
  const replyTimes = [...replyCalls.map(call => call.ms), ...failures.map(timeOf)];
  // A first draft the model grader did not grade (its answer was cut off or could not be used, or never came) was
  // passed or failed by code alone, which says nothing of the rules only a model can judge. Such a draft is left
  // out of the pass rates and counted apart. An empty draft and a turn that failed are failures, and are counted.
  const ungraded = turn => !turn.error && Boolean(turn.firstDraft) && turn.evaluator !== 'llm';
  const graded = run.turns.filter(turn => !ungraded(turn));
  return {
    turns: run.turns.length,
    firstPassRate: rate(graded, turn => turn.firstPassCompliant === true),
    finalPassRate: rate(graded, passedFinally),
    // The bar is judged on how many turns did not pass, which means the same whatever was left out of the rates.
    finalFailures: graded.filter(turn => !passedFinally(turn)).length,
    seminarFinalPassRate: rate(seminar.filter(turn => !ungraded(turn)), passedFinally),
    seminarFinalFailures: seminar.filter(turn => !ungraded(turn) && !passedFinally(turn)).length,
    // Drafts, not citations: a draft with two citations that could not be anchored is one draft.
    unanchoredFirstDrafts: run.turns.filter(turn => turn.firstDraftUnanchored > 0).length,
    emptyFirstDrafts: run.turns.filter(turn => !turn.error && !turn.firstDraft).length,
    failedTurns: run.turns.filter(turn => turn.error).length,
    cutOff: replyCalls.filter(call => call.finish === 'length').length,
    ungradedFirstDrafts: run.turns.filter(ungraded).length,
    retriedTurns: run.turns.filter(turn => (turn.attempts ?? 1) > 1).length,
    turnsOverDeadline: run.turns.filter(turn => turn.ms > TURN_DEADLINE_MS).length,
    replyCallsFailed: failures.length,
    replyCallFailures: failureSummary(failures),
    replyCallsTimedOut: failures.filter(timedOut).length,
    replyMedianMs: percentile(replyTimes, 0.5),
    replySlowestTenthMs: percentile(replyTimes, 0.9),
    // The whole turn: the reply, the side analyses, the grading and any rewrite. It leaves out the classification
    // and the search, which come first on the site.
    turnMedianMs: percentile(run.turns.map(turn => turn.ms), 0.5),
    turnSlowestTenthMs: percentile(run.turns.map(turn => turn.ms), 0.9),
    costPerConversation: replyCalls.length ? costOf(replyCalls, price, day) / visitorsIn(run) : 0,
  };
}

// For each visitor's turn, the answer the runs give most often. A tie goes to the earliest run's answer.
export function majority(runs, pick) {
  const tallies = new Map();
  runs.forEach((run, order) => {
    for (const turn of run.turns) {
      const answers = tallies.get(keyOf(turn)) ?? new Map();
      const answer = pick(turn);
      const tally = answers.get(answer) ?? { count: 0, first: order };
      answers.set(answer, { count: tally.count + 1, first: tally.first });
      tallies.set(keyOf(turn), answers);
    }
  });
  const reference = new Map();
  for (const [key, answers] of tallies) {
    const [winner] = [...answers].sort(([, a], [, b]) => b.count - a.count || a.first - b.first)[0];
    reference.set(key, winner);
  }
  return reference;
}

// The share of a run's turns whose answer is the reference's. Only turns the reference holds are compared (and,
// when `applies` is given, only those it lets through); with nothing to compare the agreement is whole.
export function agreement(run, reference, pick, applies = () => true) {
  const compared = run.turns.filter(turn => applies(turn) && reference.has(keyOf(turn)));
  return rate(compared, turn => pick(turn) === reference.get(keyOf(turn)));
}

// How well today's model agrees with itself: how often two of its runs give the same answer, for the pair of
// runs that agrees least. The order the runs are given in changes nothing. With fewer than two runs it is not
// known, and null says so.
//
// A candidate is measured against the answer today's runs give most often (majority), a steadier mark than any
// one run, so today's own model would score a little above this figure on the candidate's measure. The bar asks
// a candidate for at least this figure.
export function selfAgreement(runs, pick, applies = () => true) {
  if (runs.length < 2) return null;
  let least = 1;
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const other = new Map(runs[j].turns.map(turn => [keyOf(turn), pick(turn)]));
      least = Math.min(least, agreement(runs[i], other, pick, applies));
    }
  }
  return least;
}

/**
 * What a small-job run says of its small model.
 * `reference` holds, for each turn, the answer today's model gives most often: { type, tier, verdict }.
 */
export function smallStats(run, reference, baselineAverageLeadScore, { price, visitors = VISITORS, adapter = app, day = undefined } = {}) {
  const isSeminar = seminarTest({ visitors, seminarModes: adapter.SEMINAR_MODES });
  const smallJobs = adapter.SMALL_JOBS;
  const due = adapter.SIDE_JOBS_FROM_TURN;
  const leadDue = turn => !isSeminar(turn) && turn.turn >= due.leadScore;
  const cardDue = turn => !isSeminar(turn) && turn.turn >= due.caseCard;
  const calls = run.calls ?? [];
  const smallCalls = calls.filter(call => smallJobs.includes(call.job));
  // Small-job calls that were refused or never answered. They are counted apart from unusable answers: such a
  // call is made again, and it may be the account's rate limit that refused it and not the model.
  const failures = (run.failed ?? []).filter(failure => smallJobs.includes(failure.job));
  const answered = run.turns.filter(turn => !turn.error);
  // Where a visitor was written with a definite case type, the classifier has a right answer to be held to.
  // Agreement with today's model does not show it: a candidate that is right where today's is wrong disagrees.
  const writtenAs = new Map(visitors.filter(visitor => visitor.caseType && visitor.caseType !== 'other').map(visitor => [visitor.key, visitor.caseType]));
  const withRightAnswer = run.turns.filter(turn => writtenAs.has(turn.visitor) && turn.classifiedType !== null);

  // Was there a usable answer each time one was due?
  const checks = [
    // The grader, on every draft it was given (an empty draft is failed in code and never reaches it).
    ...answered.filter(turn => turn.firstDraft).map(turn => turn.evaluator === 'llm'),
    ...answered.filter(leadDue).map(turn => turn.leadVerdict === true),
    ...answered.filter(cardDue).map(turn => turn.caseCard === true),
    // Every answer that had to be a JSON object, the classifier's and the seminar score's among them: the app
    // falls back quietly when those two cannot be read, so only the call itself shows it.
    ...smallCalls.filter(call => typeof call.json === 'boolean').map(call => call.json),
  ];

  const jobs = {};
  for (const job of smallJobs) {
    const made = smallCalls.filter(call => call.job === job);
    const failed = failures.filter(failure => failure.job === job);
    if (!made.length && !failed.length) continue;
    // A call that failed is timed with its job, for as long as it took: a call cut off at its time limit, as over any limit.
    const times = [...made.map(call => call.ms), ...failed.map(timeOf)];
    jobs[job] = {
      calls: made.length,
      failed: failed.length,
      medianMs: percentile(times, 0.5),
      slowestTenthMs: percentile(times, 0.9),
      jsonValid: rate(made.filter(call => typeof call.json === 'boolean'), call => call.json),
    };
  }
  // (Compared, not subtracted: two jobs that were cut off are both Infinity.)
  const slowest = Object.entries(jobs).sort(([, a], [, b]) => (b.slowestTenthMs > a.slowestTenthMs ? 1 : b.slowestTenthMs < a.slowestTenthMs ? -1 : 0))[0] ?? null;

  // A score a model wrote as text ("80") is still a score: left out, the average would be of fewer leads, or of
  // none, and the lead-score rule would pass with nothing judged.
  const scores = run.turns.map(turn => turn.leadScore)
    .filter(score => (typeof score === 'number' || (typeof score === 'string' && score.trim() !== '')) && Number.isFinite(Number(score)))
    .map(Number);
  const averageLeadScore = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
  // The calls made while grading the known-bad drafts are no part of a conversation.
  const inConversations = calls.slice(0, run.knownBadFromCall ?? calls.length).filter(call => smallJobs.includes(call.job));

  return {
    jsonValidRate: rate(checks, Boolean),
    typeAgreement: agreement(run, reference.type, turn => turn.classifiedType),
    typeRight: withRightAnswer.length ? rate(withRightAnswer, turn => turn.classifiedType === writtenAs.get(turn.visitor)) : null,
    tierAgreement: agreement(run, reference.tier, turn => turn.leadTier, leadDue),
    verdictAgreement: agreement(run, reference.verdict, turn => turn.firstPassCompliant),
    averageLeadScore,
    leadScoreShift: averageLeadScore === null || typeof baselineAverageLeadScore !== 'number' ? null : averageLeadScore - baselineAverageLeadScore,
    knownBadCaught: (run.knownBad ?? []).filter(entry => entry.caught).map(entry => entry.key),
    failedTurns: run.turns.filter(turn => turn.error).length,
    failedCalls: failures.length,
    failedCallSummary: failureSummary(failures),
    callsTimedOut: failures.filter(timedOut).length,
    // Answers that stopped at their allowance, which thinking can spend and leave no text.
    cutOff: smallCalls.filter(call => call.finish === 'length').length,
    medianMs: percentile([...smallCalls.map(call => call.ms), ...failures.map(timeOf)], 0.5),
    slowestTenthMs: slowest ? slowest[1].slowestTenthMs : null,
    slowestJob: slowest ? slowest[0] : null,
    jobs,
    costPerConversation: inConversations.length ? costOf(inConversations, price, day) / visitorsIn(run) : 0,
  };
}

// ─── The bar ──────────────────────────────────────────────────────────────────

const percent = value => `${Math.round(value * 1000) / 10}%`;
const seconds = ms => (ms === null || ms === undefined ? 'not timed' : ms === Infinity ? 'past its time limit' : `${(ms / 1000).toFixed(1)}s`);
const money = value => `$${value.toFixed(3)}`;

function verdict(rules) {
  const missed = rules.filter(rule => !rule.ok);
  return { ok: missed.length === 0, reasons: missed.map(rule => rule.reason), failed: missed.map(rule => rule.key) };
}

// A reply model against today's model's runs.
export function replyBar(stats, baselines) {
  if (!baselines.length) return { ok: false, reasons: ["there is no run of today's model to set it beside"], failed: ['baseline'] };
  const mostFailures = Math.max(...baselines.map(baseline => baseline.finalFailures));
  const mostUnanchored = Math.max(...baselines.map(baseline => baseline.unanchoredFirstDrafts));
  const mostSeminarFailures = Math.max(...baselines.map(baseline => baseline.seminarFinalFailures));
  const some = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  return verdict([
    { key: 'finalPass', ok: stats.finalFailures <= mostFailures,
      reason: `${some(stats.finalFailures, 'turn', 'turns')} did not pass after the rewrite, more than in today's worst run (${mostFailures})` },
    { key: 'unanchored', ok: stats.unanchoredFirstDrafts <= mostUnanchored,
      reason: `${some(stats.unanchoredFirstDrafts, 'first draft cites', 'first drafts cite')} a case that could not be anchored, more than in today's worst run (${mostUnanchored})` },
    { key: 'seminar', ok: stats.seminarFinalFailures <= mostSeminarFailures,
      reason: `${some(stats.seminarFinalFailures, 'seminar turn', 'seminar turns')} did not pass, more than in today's worst run (${mostSeminarFailures})` },
    { key: 'speed', ok: typeof stats.replySlowestTenthMs === 'number' && stats.replySlowestTenthMs <= REPLY_SLOWEST_TENTH_LIMIT_MS,
      reason: stats.replySlowestTenthMs === Infinity
        ? `more than a tenth of its replies were cut off at the time limit they were given, which counts as over the ${seconds(REPLY_SLOWEST_TENTH_LIMIT_MS)} allowed`
        : typeof stats.replySlowestTenthMs === 'number'
          ? `the slowest tenth of its replies takes ${seconds(stats.replySlowestTenthMs)}, over the ${seconds(REPLY_SLOWEST_TENTH_LIMIT_MS)} allowed`
          : 'none of its replies was timed' },
    // Not a rule of the design's bar but a condition of the measurement: the pass rates are counted over the
    // drafts the model grader graded, and too few of those is no measurement.
    { key: 'graded', ok: !(stats.ungradedFirstDrafts > UNGRADED_SHARE_ALLOWED * stats.turns),
      reason: `${stats.ungradedFirstDrafts} of its ${stats.turns} first drafts were graded by code alone because the model grader's answer did not come or could not be used, too many for the run to count` },
  ]);
}

// A small-job model against today's model's agreement with itself and the known-bad drafts today's model catches.
export function smallBar(stats, baselineSelf, baselineCaught) {
  // With no run of today's model, or only one, there is nothing to hold a candidate to.
  if (!baselineSelf) return { ok: false, reasons: ["there is no small-job run of today's model to set it beside"], failed: ['baseline'] };
  if ([baselineSelf.typeAgreement, baselineSelf.tierAgreement, baselineSelf.verdictAgreement].some(value => typeof value !== 'number')) {
    return { ok: false, reasons: ["today's small-job model was run once, so how well it agrees with itself is not known"], failed: ['baseline'] };
  }
  const missed = baselineCaught.filter(key => !stats.knownBadCaught.includes(key));
  const agreed = (key, name, value, floor) => ({
    key, ok: value >= floor, reason: `gives the same ${name} as today's on ${percent(value)}, under today's own ${percent(floor)}`,
  });
  return verdict([
    { key: 'json', ok: stats.jsonValidRate === 1, reason: `gives a usable answer on ${percent(stats.jsonValidRate)} of the times one was due, not every time` },
    agreed('type', 'case type', stats.typeAgreement, baselineSelf.typeAgreement),
    agreed('tier', 'lead tier', stats.tierAgreement, baselineSelf.tierAgreement),
    agreed('verdict', 'first verdict', stats.verdictAgreement, baselineSelf.verdictAgreement),
    { key: 'leadScore', ok: typeof stats.leadScoreShift !== 'number' || Math.abs(stats.leadScoreShift) <= LEAD_SCORE_TOLERANCE,
      reason: `moves the average lead score by ${typeof stats.leadScoreShift === 'number' ? stats.leadScoreShift.toFixed(1) : '?'} points, more than ${LEAD_SCORE_TOLERANCE}` },
    { key: 'knownBad', ok: missed.length === 0, reason: `did not catch ${missed.join(', ')}` },
    { key: 'speed', ok: typeof stats.slowestTenthMs !== 'number' || stats.slowestTenthMs <= SMALL_SLOWEST_TENTH_LIMIT_MS,
      reason: stats.slowestTenthMs === Infinity
        ? `more than a tenth of its ${stats.slowestJob ?? 'slowest job'} calls were cut off at the time limit they were given, which counts as over the ${seconds(SMALL_SLOWEST_TENTH_LIMIT_MS)} allowed`
        : `the slowest tenth of its ${stats.slowestJob ?? 'slowest job'} calls takes ${seconds(stats.slowestTenthMs)}, over the ${seconds(SMALL_SLOWEST_TENTH_LIMIT_MS)} allowed` },
  ]);
}

// The runs a report is given must be what their flags say they are, or its tables would be wrong with no sign of
// it. Returns what is wrong, one line each; an empty list means the runs can be set beside one another.
export function checkRuns({ app: appName, baseline, smallBaseline = [], replies = [], smalls = [], pairs = [] }) {
  const problems = [];
  const today = baseline[0];
  const todays = new Set(baseline.map(run => run.label));
  const seen = new Set();
  const each = (runs, check) => {
    for (const run of runs) {
      if (run.app !== appName) problems.push(`${run.label} was run on ${run.app}, not ${appName}`);
      if (!run.finishedAt) problems.push(`${run.label} is a run that was stopped part-way`);
      check(run);
      if (seen.has(run.label)) problems.push(`${run.label} is given twice`);
      seen.add(run.label);
    }
  };
  const isSmall = run => run.mode === 'small';
  const todaysModels = run => run.answer === today.answer && run.aux === today.aux;
  const notTodays = run => `${run.label} used ${run.answer} with ${run.aux}, not today's ${today.answer} with ${today.aux}`;
  const draftsFromToday = run => {
    if (!todays.has(run.from)) problems.push(`${run.label} took its drafts from ${run.from}, which is not one of today's runs`);
  };

  each(baseline, run => {
    if (isSmall(run)) problems.push(`${run.label} is a small-job run, given as a reply run`);
    else if (!todaysModels(run)) problems.push(notTodays(run));
  });
  each(replies, run => {
    if (isSmall(run)) problems.push(`${run.label} is a small-job run, given as a reply run`);
    else if (run.aux !== today.aux) problems.push(`${run.label} was graded by ${run.aux}, not today's ${today.aux}`);
  });
  each(smallBaseline, run => {
    if (!isSmall(run)) problems.push(`${run.label} is not a small-job run`);
    else if (!todaysModels(run)) problems.push(notTodays(run));
    else draftsFromToday(run);
  });
  each(smalls, run => {
    if (!isSmall(run)) problems.push(`${run.label} is not a small-job run`);
    else if (run.answer !== today.answer) problems.push(`${run.label} had its rewrites written by ${run.answer}, not today's ${today.answer}`);
    else draftsFromToday(run);
  });
  // A pair is any reply run: both of its models may differ from today's.
  each(pairs, run => {
    if (isSmall(run)) problems.push(`${run.label} is a small-job run, given as a pair`);
  });
  return problems;
}

// ─── The page ─────────────────────────────────────────────────────────────────

function table(headings, rows) {
  const line = cells => `| ${cells.map(cell => String(cell).replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ')).join(' | ')} |`;
  return [line(headings), `|${headings.map(() => '---').join('|')}|`, ...rows.map(line)].join('\n');
}

const mean = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
// Cheapest first; a tie goes to the faster.
const byValue = speedOf => (a, b) => a.stats.costPerConversation - b.stats.costPerConversation || (speedOf(a.stats) ?? Infinity) - (speedOf(b.stats) ?? Infinity);
const barCell = bar => (bar.ok ? 'passes' : bar.reasons.join('; '));

/**
 * Judges the runs: every reply run against today's reply runs, and every small-job run against today's small-job runs.
 * The report and the upload to the site (upload.mjs) both read their rows from here, so they cannot disagree.
 * Gives each run as { run, stats, bar }, and the figures the small-job bar was set from.
 */
export function scoreRuns({ baseline, smallBaseline = [], replies = [], smalls = [] }, { price, visitors = VISITORS, adapter = app } = {}) {
  const context = { price, visitors, adapter };
  const isSeminar = seminarTest({ visitors, seminarModes: adapter.SEMINAR_MODES });
  const leadDue = turn => !isSeminar(turn) && turn.turn >= adapter.SIDE_JOBS_FROM_TURN.leadScore;

  // The reply models.
  const baseReply = baseline.map(run => ({ run, stats: replyStats(run, context) }));
  const baseReplyStats = baseReply.map(row => row.stats);
  for (const row of baseReply) row.bar = replyBar(row.stats, baseReplyStats);
  const candidateReply = replies.map(run => {
    const stats = replyStats(run, context);
    return { run, stats, bar: replyBar(stats, baseReplyStats) };
  });

  // The small-job models.
  const reference = {
    type: majority(smallBaseline, turn => turn.classifiedType),
    tier: majority(smallBaseline, turn => turn.leadTier),
    verdict: majority(smallBaseline, turn => turn.firstPassCompliant),
  };
  const baselineSelf = smallBaseline.length ? {
    typeAgreement: selfAgreement(smallBaseline, turn => turn.classifiedType),
    tierAgreement: selfAgreement(smallBaseline, turn => turn.leadTier, leadDue),
    verdictAgreement: selfAgreement(smallBaseline, turn => turn.firstPassCompliant),
  } : null;
  const baselineLeadScore = mean(smallBaseline.map(run => smallStats(run, reference, null, context).averageLeadScore).filter(score => score !== null));
  const everyRunCaught = smallBaseline.length
    ? (smallBaseline[0].knownBad ?? []).map(entry => entry.key).filter(key => smallBaseline.every(run => (run.knownBad ?? []).some(entry => entry.key === key && entry.caught)))
    : [];
  const smallRow = run => {
    const stats = smallStats(run, reference, baselineLeadScore, context);
    return { run, stats, bar: smallBar(stats, baselineSelf, everyRunCaught) };
  };
  const baseSmall = smallBaseline.map(smallRow);
  const candidateSmall = smalls.map(smallRow);
  return { baseReply, candidateReply, baseSmall, candidateSmall, reference, baselineSelf, baselineLeadScore, everyRunCaught };
}

/**
 * The report, as Markdown. Every argument is data: the runs are already read.
 * @param {object} options
 * @param {string} options.app
 * @param {string} options.date           YYYY-MM-DD
 * @param {object[]} options.baseline       today's models' runs
 * @param {object[]} options.smallBaseline  today's models' small-job runs
 * @param {object[]} options.replies        the reply candidates' runs
 * @param {object[]} options.smalls         the small-job candidates' runs
 * @param {object[]} [options.pairs]        reply runs with both models changed together, shown for information
 * @param {string[]} [options.notes]
 * @param {Function} options.price          estimateAiCost
 */
export function renderReport({ app: appName, date, baseline, smallBaseline, replies, smalls, pairs = [], notes = [], price, visitors = VISITORS, adapter = app }) {
  const isSeminar = seminarTest({ visitors, seminarModes: adapter.SEMINAR_MODES });
  const leadDue = turn => !isSeminar(turn) && turn.turn >= adapter.SIDE_JOBS_FROM_TURN.leadScore;
  const context = { price, visitors, adapter };
  const { baseReply, candidateReply, baseSmall, candidateSmall, reference, baselineSelf, baselineLeadScore, everyRunCaught } = scoreRuns({ baseline, smallBaseline, replies, smalls }, { price, visitors, adapter });

  const turnsMeasured = baseline[0]?.turns.length ?? 0;
  const visitorsMeasured = baseline[0] ? visitorsIn(baseline[0]) : 0;
  const today = baseline[0] ? `\`${baseline[0].answer}\` for the reply and \`${baseline[0].aux}\` for the small jobs` : 'none';
  const grader = baseline[0] ? `\`${baseline[0].aux}\`` : "today's small model";
  const out = [];
  out.push(`# Model measurement for ${appName}, ${date}`, '');
  out.push(`${visitorsMeasured} synthetic visitors and ${turnsMeasured} turns, played through the app's own reply pipeline. Today's models, the ones now live, are ${today}, and every candidate is set beside their runs. `
    + 'Runs of models that are no longer live are history and are no part of the comparison. '
    + `Every reply run was graded by ${grader}, held fixed whichever model wrote the reply, so that one grader judges them all. `
    + 'The case law for each turn was searched once and replayed for every run, so every model was given the same decisions. '
    + "A small-job model's runs were given today's reply model's drafts.", '');

  // Each model in these runs, whose it is and what it was asked to do, from the registry.
  const roles = new Map();
  const asked = (model, role) => roles.set(model, new Set([...(roles.get(model) ?? []), role]));
  for (const run of [...baseline, ...replies, ...pairs]) { asked(run.answer, 'the reply'); asked(run.aux, pairs.includes(run) ? 'the small jobs' : 'grading every reply'); }
  for (const run of [...smallBaseline, ...smalls]) { asked(run.answer, 'the reply'); asked(run.aux, 'the small jobs'); }
  const dollarsOf = prices => `$${prices[0].toFixed(2)} / $${prices[1].toFixed(2)}`;
  const priceWords = model => {
    const now = priceOn(model, date);
    if (!now) return 'no price on record';
    const later = Object.keys(entryFor(model)?.priceFrom ?? {}).filter(day => day > date).sort();
    return [dollarsOf(now), ...later.map(day => `then ${dollarsOf(priceOn(model, day))} from ${day}`)].join(', ');
  };
  const ROLE_ORDER = ['the reply', 'the small jobs', 'grading every reply'];
  out.push('## The models and their providers', '');
  out.push(table(
    ['Model', 'Provider', 'Used for', 'Price a million tokens, in / out'],
    [...roles].map(([model, used]) => [model, entryFor(model)?.provider ?? 'not in the registry', ROLE_ORDER.filter(role => used.has(role)).join(', '), priceWords(model)]),
  ), '');

  // An app with no seminar has no seminar column.
  const hasSeminar = adapter.SEMINAR_MODES.length > 0;
  const failedCell = (count, summary) => (count ? `${count} (${summary})` : 0);
  out.push('## Reply models', '');
  out.push(table(
    ['Run', 'Model', 'First draft passes', 'Passes after the rewrite', ...(hasSeminar ? ['Seminar passes'] : []), 'First drafts with a case that could not be anchored', 'Empty first drafts', 'Replies cut off at their allowance', 'Bar'],
    [...baseReply, ...candidateReply].map(({ run, stats, bar }) => [
      run.label, run.answer, percent(stats.firstPassRate), percent(stats.finalPassRate), ...(hasSeminar ? [percent(stats.seminarFinalPassRate)] : []), stats.unanchoredFirstDrafts, stats.emptyFirstDrafts, stats.cutOff, barCell(bar),
    ]),
  ), '');

  out.push("### Each reply model's time, cost and trouble", '');
  out.push(table(
    ['Run', 'Model', 'A reply takes (middle)', 'A reply takes (slowest tenth)', 'A whole turn takes (middle)', 'A whole turn takes (slowest tenth)', 'Turns over 45 seconds', 'Turns that failed', 'Turns sent twice',
      'First drafts the model grader did not grade', 'Reply calls that failed', 'Replies cost, a conversation'],
    [...baseReply, ...candidateReply].map(({ run, stats }) => [
      run.label, run.answer, seconds(stats.replyMedianMs), seconds(stats.replySlowestTenthMs), seconds(stats.turnMedianMs), seconds(stats.turnSlowestTenthMs), stats.turnsOverDeadline, stats.failedTurns, stats.retriedTurns,
      stats.ungradedFirstDrafts, failedCell(stats.replyCallsFailed, stats.replyCallFailures), money(stats.costPerConversation),
    ]),
  ), '');
  out.push("The pass rates are counted over the first drafts the model grader graded. Today's grader's answer is now and then cut off at its length limit, and the gate then grades that draft by code alone, on the site as here; those drafts are counted in the second table and left out of the rates.", '');
  out.push('A whole turn is the reply, the side analyses, the grading and any rewrite. It does not count the classification and the search for case law, which come first on the site and add a second or two; the site gives a turn up after 45 seconds. '
    + 'A reply call that failed is timed for as long as it took, so one that ran out of time counts as slow.', '');

  out.push('## Small-job models', '');
  if (!baseSmall.length && !candidateSmall.length) {
    out.push('No small-job run was given.', '');
  } else {
    const compared = value => (smallBaseline.length ? percent(value) : 'nothing to compare with');
    out.push(table(
      ['Run', 'Model', 'A usable answer when one was due', "Same case type as today's", 'Case type right, where the visitor was written with one', "Same lead tier as today's", "Same first verdict as today's", 'Average lead score', 'Known-bad drafts caught',
        'Slowest job (slowest tenth)', 'Small-job calls that failed', 'Small-job answers cut off at their allowance', 'Small jobs cost, a conversation', 'Bar'],
      [...baseSmall, ...candidateSmall].map(({ run, stats, bar }) => [
        run.label, run.aux, percent(stats.jsonValidRate), compared(stats.typeAgreement), stats.typeRight === null ? 'none was' : percent(stats.typeRight), compared(stats.tierAgreement), compared(stats.verdictAgreement),
        stats.averageLeadScore === null ? 'none scored' : `${stats.averageLeadScore.toFixed(1)}${typeof stats.leadScoreShift === 'number' ? ` (${stats.leadScoreShift >= 0 ? '+' : ''}${stats.leadScoreShift.toFixed(1)})` : ''}`,
        `${stats.knownBadCaught.length} of ${(run.knownBad ?? []).length}`,
        stats.slowestJob ? `${stats.slowestJob}, ${seconds(stats.slowestTenthMs)}` : 'not timed', failedCell(stats.failedCalls, stats.failedCallSummary), stats.cutOff, money(stats.costPerConversation), barCell(bar),
      ]),
    ), '');
    if (smallBaseline.length >= 2) {
      out.push(`Today's small-job model, run ${smallBaseline.length} times, gives itself the same answer on ${percent(baselineSelf.typeAgreement)} of case types, ${percent(baselineSelf.tierAgreement)} of lead tiers and ${percent(baselineSelf.verdictAgreement)} of first verdicts, `
        + "for the pair of its runs that agrees least. A candidate is held to those figures. It is measured against the answer today's runs give most often, a steadier mark than any one run, so today's own model would score a little above its own figures. "
        + `Today's average lead score is ${baselineLeadScore === null ? 'not known' : baselineLeadScore.toFixed(1)}. Today's model catches these known-bad drafts in every run: ${everyRunCaught.length ? everyRunCaught.join(', ') : 'none'}.`, '');
    } else {
      out.push(`Today's small-job model was run ${smallBaseline.length === 1 ? 'once' : 'not at all'}, so how well it agrees with itself is not known and no candidate can be held to it.`, '');
    }
    out.push("Agreement with today's model is what the bar asks, but it cannot tell a candidate that is wrong from one that is right where today's model is wrong. Where a visitor was written with a definite case type, the next column says how often each model named it; the turn-by-turn differences are set out further down.", '');
    out.push('A usable answer is counted each time one was due: the grade of a draft, a lead score, a case card, and every answer that had to be JSON. A call that was refused or never answered is counted apart, in its own column, with what it failed on: such a call is made again, and it may be the account that was refused and not the model.', '');

    out.push("### Each small job's time", '');
    out.push(table(
      ['Run', 'Model', 'Job', 'Calls answered', 'Calls that failed', 'Middle', 'Slowest tenth', 'Answers that were JSON'],
      [...baseSmall, ...candidateSmall].flatMap(({ run, stats }) => Object.entries(stats.jobs).map(([job, timed]) => [run.label, run.aux, job, timed.calls, timed.failed, seconds(timed.medianMs), seconds(timed.slowestTenthMs), percent(timed.jsonValid)])),
    ), '');
  }

  if (baseSmall.length || candidateSmall.length) {
    // Draft by draft, what each run's grader made of it. A draft blocked under a rule other than the one it breaks
    // was still kept from the visitor, but the rewrite it was sent for would be aimed at the wrong fault.
    const smallRuns = [...baseSmall, ...candidateSmall].map(row => row.run);
    const drafts = [];
    for (const run of smallRuns) {
      for (const entry of run.knownBad ?? []) {
        if (!drafts.some(draft => draft.key === entry.key)) drafts.push({ key: entry.key, breaks: entry.breaks ?? '' });
      }
    }
    const made = (run, draft) => {
      const entry = (run.knownBad ?? []).find(candidate => candidate.key === draft.key);
      if (!entry) return 'not shown';
      if (entry.error) return 'the turn failed';
      if (!entry.caught) return 'NOT caught';
      const flagged = entry.flagged ?? [];
      return !draft.breaks || flagged.includes(draft.breaks) || !flagged.length ? 'caught' : `caught under ${flagged.join(', ')}`;
    };
    out.push('### The drafts that are wrong on purpose', '');
    out.push(table(['Draft', 'The rule it breaks', ...smallRuns.map(run => `${run.aux} (${run.label})`)], drafts.map(draft => [draft.key, draft.breaks, ...smallRuns.map(run => made(run, draft))])), '');
  }

  // The answers that stopped at their allowance and the calls that ran out of time, by model: a model whose answers were
  // cut off was not given room enough to be judged, and a call the clock cut off is counted as over any limit.
  const rowsGiven = [
    ...[...baseReply, ...candidateReply].map(({ run, stats }) => ({ run, model: run.answer, cutOff: stats.cutOff, timedOut: stats.replyCallsTimedOut, answers: ['reply', 'replies'], calls: ['reply call', 'reply calls'] })),
    ...[...baseSmall, ...candidateSmall].map(({ run, stats }) => ({ run, model: run.aux, cutOff: stats.cutOff, timedOut: stats.callsTimedOut, answers: ['answer', 'answers'], calls: ['small-job call', 'small-job calls'] })),
  ];
  const many = (count, [one, more]) => `${count} ${count === 1 ? one : more}`;
  const cutOffRows = rowsGiven.filter(row => row.cutOff > 0);
  const timedOutRows = rowsGiven.filter(row => row.timedOut > 0);
  if (cutOffRows.length || timedOutRows.length) {
    out.push('## Answers and calls that were cut off', '');
    if (cutOffRows.length) {
      out.push('### Answers cut off at their allowance', '');
      out.push(...cutOffRows.map(row => `- \`${row.model}\` (${row.run.label}): ${many(row.cutOff, row.answers)} cut off at its allowance: raise the headroom and measure again before judging.`), '');
    }
    if (timedOutRows.length) {
      out.push('### Calls cut off at their time limit', '');
      out.push(...timedOutRows.map(row => `- \`${row.model}\` (${row.run.label}): ${many(row.timedOut, row.calls)}. It is counted as over any limit, so its slowest tenth is longer than what the table shows.`), '');
    }
  }

  // What passes, cheapest first.
  const passingReply = candidateReply.filter(row => row.bar.ok).sort(byValue(stats => stats.replySlowestTenthMs));
  const passingSmall = candidateSmall.filter(row => row.bar.ok).sort(byValue(stats => stats.slowestTenthMs));
  // A rule every one of today's own runs misses is said so, beside a candidate that misses it.
  const alsoMissedToday = (rows, key) => rows.length > 0 && rows.every(row => row.bar.failed.includes(key));
  const missedLine = (row, model, baseRows) => `- \`${model}\` (${row.run.label}): ${row.bar.reasons.map((reason, i) => (alsoMissedToday(baseRows, row.bar.failed[i]) ? `${reason} (today's model misses this rule too)` : reason)).join('; ')}`;

  out.push('## What passes', '');
  out.push('### For the reply', '');
  if (!candidateReply.length) out.push('No reply candidate was measured.', '');
  else {
    if (passingReply.length) {
      out.push('Every rule passed, cheapest first (a tie goes to the faster):', '');
      passingReply.forEach((row, i) => out.push(`${i + 1}. \`${row.run.answer}\` (${row.run.label}): ${money(row.stats.costPerConversation)} a conversation, slowest tenth ${seconds(row.stats.replySlowestTenthMs)}`));
      out.push('');
    } else {
      out.push('No reply candidate passes every rule.', '');
    }
    const missedReply = candidateReply.filter(row => !row.bar.ok);
    if (missedReply.length) out.push('These did not pass:', '', ...missedReply.map(row => missedLine(row, row.run.answer, baseReply)), '');
  }
  out.push('### For the small jobs', '');
  if (!candidateSmall.length) out.push('No small-job candidate was measured.', '');
  else {
    if (passingSmall.length) {
      out.push('Every rule passed, cheapest first (a tie goes to the faster):', '');
      passingSmall.forEach((row, i) => out.push(`${i + 1}. \`${row.run.aux}\` (${row.run.label}): ${money(row.stats.costPerConversation)} a conversation, slowest job's slowest tenth ${seconds(row.stats.slowestTenthMs)}`));
      out.push('');
    } else {
      out.push('No small-job candidate passes every rule.', '');
    }
    const missedSmall = candidateSmall.filter(row => !row.bar.ok);
    if (missedSmall.length) out.push('These did not pass:', '', ...missedSmall.map(row => missedLine(row, row.run.aux, baseSmall)), '');
  }
  const baselineMissesReply = baseReply.filter(row => !row.bar.ok);
  const baselineMissesSmall = baseSmall.filter(row => !row.bar.ok);
  if (baselineMissesReply.length || baselineMissesSmall.length) {
    out.push("Today's own models, set beside the same rules:", '',
      ...baselineMissesReply.map(row => `- \`${row.run.answer}\` (${row.run.label}): ${row.bar.reasons.join('; ')}`),
      ...baselineMissesSmall.map(row => `- \`${row.run.aux}\` (${row.run.label}): ${row.bar.reasons.join('; ')}`), '');
  }

  if (pairs.length) {
    out.push('## Both models changed together', '');
    out.push("For information. Each row is one run with the reply model and the small-job model both changed, as the site would run after a switch. These runs are not held to the bar, whose marks are today's models' runs: a grader that is stricter than today's blocks more first drafts, so these figures are not to be read against the reply table's.", '');
    out.push(table(
      ['Run', 'Reply model', 'Small-job model', 'First draft passes', 'Passes after the rewrite', ...(hasSeminar ? ['Seminar passes'] : []), 'Turns not passed after the rewrite', 'First drafts with a case that could not be anchored',
        'First drafts the model grader did not grade', 'A whole turn takes (middle)', 'A whole turn takes (slowest tenth)', 'Calls that failed', 'All jobs cost, a conversation'],
      pairs.map(run => {
        const stats = replyStats(run, context);
        return [run.label, run.answer, run.aux, percent(stats.firstPassRate), percent(stats.finalPassRate), ...(hasSeminar ? [percent(stats.seminarFinalPassRate)] : []), stats.finalFailures, stats.unanchoredFirstDrafts,
          stats.ungradedFirstDrafts, seconds(stats.turnMedianMs), seconds(stats.turnSlowestTenthMs), failedCell((run.failed ?? []).length, failureSummary(run.failed ?? [])), money(costOf(run.calls ?? [], price) / visitorsIn(run))];
      }),
    ), '');
    out.push('The cost is of every job in the run but the classification, which a replayed run does not make; it adds a small fraction of a cent.', '');
  }

  out.push('## What a conversation costs', '');
  const todayReply = mean(baseReply.map(row => row.stats.costPerConversation));
  const todaySmall = mean(baseSmall.map(row => row.stats.costPerConversation));
  const together = (reply, small) => (reply === null || small === null ? 'not known' : money(reply + small));
  const costRows = [];
  if (baseline[0]) {
    costRows.push(['Today', baseline[0].answer, baseline[0].aux, todayReply === null ? 'not known' : money(todayReply), todaySmall === null ? 'not measured' : money(todaySmall), together(todayReply, todaySmall)]);
  }
  for (const row of candidateReply) {
    costRows.push([`${row.run.label}${row.bar.ok ? '' : ' (did not pass)'}`, row.run.answer, "today's", money(row.stats.costPerConversation), todaySmall === null ? 'not measured' : money(todaySmall), together(row.stats.costPerConversation, todaySmall)]);
  }
  for (const row of candidateSmall) {
    costRows.push([`${row.run.label}${row.bar.ok ? '' : ' (did not pass)'}`, "today's", row.run.aux, todayReply === null ? 'not known' : money(todayReply), money(row.stats.costPerConversation), together(todayReply, row.stats.costPerConversation)]);
  }
  if (passingReply.length && passingSmall.length) {
    costRows.push(['The cheapest of each that passes', passingReply[0].run.answer, passingSmall[0].run.aux, money(passingReply[0].stats.costPerConversation), money(passingSmall[0].stats.costPerConversation),
      together(passingReply[0].stats.costPerConversation, passingSmall[0].stats.costPerConversation)]);
  }
  out.push(table(['', 'Reply model', 'Small-job model', 'Replies', 'Small jobs', 'Together'], costRows), '');
  out.push("At each provider's published standard prices (the registry's, model-registry.js). Input that a provider has cached is billed lower, so a real conversation costs a little under these figures.", '');

  // Where a provider has announced a price for a later day, what the same conversation would cost then.
  const later = [];
  for (const row of candidateReply) {
    for (const day of Object.keys(entryFor(row.run.answer)?.priceFrom ?? {}).filter(announced => announced > date).sort()) {
      later.push([row.run.label, row.run.answer, money(replyStats(row.run, { ...context, day: date }).costPerConversation), money(replyStats(row.run, { ...context, day }).costPerConversation), day]);
    }
  }
  for (const row of candidateSmall) {
    for (const day of Object.keys(entryFor(row.run.aux)?.priceFrom ?? {}).filter(announced => announced > date).sort()) {
      later.push([row.run.label, row.run.aux, money(smallStats(row.run, reference, baselineLeadScore, { ...context, day: date }).costPerConversation), money(smallStats(row.run, reference, baselineLeadScore, { ...context, day }).costPerConversation), day]);
    }
  }
  if (later.length) {
    out.push('## At a later price', '');
    out.push('A provider has announced a new price for these models. The same calls, costed at the price from the day it takes effect, beside the price today:', '');
    out.push(table(['Run', 'Model', 'A conversation costs now', 'A conversation costs at the later price', 'From'], later), '');
  }

  out.push("## Where a small-job candidate differs from today's usual answer", '');
  if (!candidateSmall.length) out.push('No small-job candidate was measured.', '');
  else if (!smallBaseline.length) out.push("There is no small-job run of today's model to compare a candidate with.", '');
  const shown = value => (value === null || value === undefined ? 'none' : String(value));
  for (const { run } of smallBaseline.length ? candidateSmall : []) {
    const differences = [];
    for (const turn of run.turns) {
      const key = keyOf(turn);
      const parts = [];
      if (reference.type.has(key) && turn.classifiedType !== reference.type.get(key)) parts.push(`case type ${shown(turn.classifiedType)}, where today's says ${shown(reference.type.get(key))}`);
      if (leadDue(turn) && reference.tier.has(key) && turn.leadTier !== reference.tier.get(key)) parts.push(`lead tier ${shown(turn.leadTier)}, where today's says ${shown(reference.tier.get(key))}`);
      if (reference.verdict.has(key) && turn.firstPassCompliant !== reference.verdict.get(key)) {
        parts.push(`first verdict ${turn.firstPassCompliant ? 'passed' : `blocked${turn.firstDraftFlagged?.length ? ` (${turn.firstDraftFlagged.join(', ')})` : ''}`}, where today's says ${reference.verdict.get(key) ? 'passed' : 'blocked'}`);
      }
      if (parts.length) differences.push(`- ${turn.visitor}, turn ${turn.turn}: ${parts.join('; ')}`);
    }
    out.push(`**\`${run.aux}\` (${run.label})**`, '', ...(differences.length ? differences : ['- nothing differs']), '');
  }

  out.push('## Cheap first, stronger on a block', '');
  out.push('For information only. A cheaper model would write the first draft, and the model below would write only when the gate blocked that draft. Whether the replies would then pass was not measured.', '');
  const strong = passingReply[0] ?? null;
  const cheaper = strong ? candidateReply.filter(row => row.run.label !== strong.run.label && row.stats.costPerConversation < strong.stats.costPerConversation) : [];
  if (!strong) out.push('No reply candidate passes, so there is no model to put behind a cheaper one.', '');
  else if (!cheaper.length) out.push(`\`${strong.run.answer}\`, the cheapest candidate that passes, is also the cheapest measured: there is nothing cheaper to put in front of it.`, '');
  else {
    const strongCalls = (strong.run.calls ?? []).filter(call => adapter.REPLY_JOBS.includes(call.job));
    const oneStrongReply = strongCalls.length ? costOf(strongCalls, price) / strongCalls.length : 0;
    for (const row of cheaper) {
      const blocked = row.run.turns.filter(turn => !turn.firstPassCompliant).length;
      const cost = row.stats.costPerConversation + (blocked / visitorsIn(row.run)) * oneStrongReply;
      out.push(`- \`${row.run.answer}\` first, \`${strong.run.answer}\` on a block: about ${money(cost)} a conversation (\`${row.run.answer}\` alone costs ${money(row.stats.costPerConversation)}, and the gate blocked ${percent(blocked / (row.run.turns.length || 1))} of its first drafts).`);
    }
    out.push('');
  }

  out.push('## Notes', '');
  out.push(...notes.map(note => `- ${note}`));
  out.push('- Times are of single calls made from one machine on one day. They show which model is quicker, not what a visitor will always wait.');
  if (adapter.SEMINAR_MODES.length) out.push("- The seminar is measured as a new student's first session each turn; on the site, points and streaks carry from turn to turn.");
  out.push('- The gate did not look citations up on CourtListener in these runs, so a case counts as anchored only when it is among the decisions the reply was given.');
  out.push('');
  return out.join('\n');
}

// The replies of chosen runs, set out turn by turn beside one another.
export function renderSamples({ app: appName, date, runs, visitorKeys, visitors = VISITORS }) {
  const nameOf = run => `${run.answer} (${run.label})`;
  const out = [`# Sample conversations for ${appName}, ${date}`, ''];
  out.push(`The replies each of these runs served, turn by turn: ${runs.map(nameOf).join(', ')}. `
    + 'The visitor says the same things in every run. Each run carries its own replies forward, so from the second turn on the models are answering slightly different conversations.', '');
  for (const key of visitorKeys) {
    const visitor = visitors.find(candidate => candidate.key === key);
    if (!visitor) continue;
    out.push(`## ${key}`, '');
    visitor.messages.forEach((message, i) => {
      out.push(`### Turn ${i + 1}`, '', `**Visitor:** ${message}`, '');
      for (const run of runs) {
        const made = run.turns.find(turn => turn.visitor === key && turn.turn === i + 1);
        const note = !made ? ' (no such turn in this run)' : made.error ? ` (the turn failed: ${made.error})` : made.gateStatus !== 'PASSED' ? ' (served with the gate still blocking it)' : made.firstPassCompliant ? '' : ' (after a rewrite)';
        out.push(`**${nameOf(run)}${note}:**`, '', ...String(made?.served || '(nothing was served)').split('\n').map(line => `> ${line}`.trimEnd()), '');
      }
    });
  }
  return out.join('\n');
}

// ─── Time limits ──────────────────────────────────────────────────────────────

// The most a model is given for one job, whatever its times (the design, section 2): providers.js gives a call
// no more. This file loads nothing of the app, so the caps are written here as well.
const REPLY_CAP_MS = 20_000;
const SMALL_CAP_MS = 8_000;
// A job's limit is set by a model's times for it only from this many calls.
const CALLS_FOR_A_LIMIT = 10;

/**
 * Each model's time limit for each job it did in the runs, as the design sets it (section 2): twice the slowest
 * tenth of its calls for the job, never more than the cap for the job's kind (a reply job's or a small job's),
 * rounded up to the next 100 ms. A job with fewer than ten calls is given, if it is a reply job after the first
 * (the rewrite), the model's limit for the first (the reply), and otherwise the cap. A call that failed is timed
 * with its job, for as long as it took, except that one the limits of the run cut off took longer than that limit and
 * counts as over any limit (so a job with more than a tenth of its calls cut off is given the cap). `over` counts the
 * calls that took longer than the limit: how often the job would have been cut off and passed to the next model.
 * @returns {Array<{ model, job, calls, slowestTenthMs, limitMs, setBy: 'times' | 'cap' | 'few' | 'reply', over }>}
 */
export function timeLimits(runs, { adapter = app } = {}) {
  const replyJobs = adapter.REPLY_JOBS;
  const jobs = [...replyJobs, ...adapter.SMALL_JOBS];
  const timesOf = new Map();
  for (const run of runs) {
    for (const call of [...(run.calls ?? []), ...(run.failed ?? [])]) {
      if (!jobs.includes(call.job) || !Number.isFinite(call.ms)) continue;
      if (!timesOf.has(call.model)) timesOf.set(call.model, new Map());
      const byJob = timesOf.get(call.model);
      // A call the limit in force cut off took longer than that limit: it is over any limit set from these times.
      byJob.set(call.job, [...(byJob.get(call.job) ?? []), timedOut(call) ? Infinity : call.ms]);
    }
  }
  const rows = [];
  for (const [model, byJob] of timesOf) {
    const limitOf = {};
    for (const job of jobs) {
      const times = byJob.get(job) ?? [];
      const cap = replyJobs.includes(job) ? REPLY_CAP_MS : SMALL_CAP_MS;
      const slowestTenthMs = percentile(times, 0.9);
      let limitMs = cap;
      let setBy = 'few';
      if (times.length >= CALLS_FOR_A_LIMIT) {
        limitMs = Math.min(Math.ceil((2 * slowestTenthMs) / 100) * 100, cap);
        setBy = limitMs === cap ? 'cap' : 'times';
      } else if (replyJobs.indexOf(job) > 0) {
        limitMs = limitOf[replyJobs[0]];
        setBy = 'reply';
      }
      limitOf[job] = limitMs;
      if (times.length) rows.push({ model, job, calls: times.length, slowestTenthMs, limitMs, setBy, over: times.filter(ms => ms > limitMs).length });
    }
  }
  return rows;
}

const SET_BY = {
  times: 'twice the slowest tenth',
  cap: 'the cap',
  few: `the cap: fewer than ${CALLS_FOR_A_LIMIT} calls`,
  reply: `the reply's: fewer than ${CALLS_FOR_A_LIMIT} calls`,
};

// The limits as a table, which the report command prints.
export function renderLimits(rows) {
  return table(['Model', 'Job', 'Calls', 'Slowest tenth', 'Limit', 'Set by', 'Calls over the limit'],
    rows.map(row => [row.model, row.job, row.calls, seconds(row.slowestTenthMs), seconds(row.limitMs), SET_BY[row.setBy], row.over]));
}

// ─── The command ──────────────────────────────────────────────────────────────

const LIST_FLAGS = { '--baseline': 'baseline', '--small-baseline': 'smallBaseline', '--replies': 'replies', '--smalls': 'smalls', '--pairs': 'pairs', '--samples': 'samples' };

export function parseReportArgs(argv) {
  const args = { app: null, baseline: [], smallBaseline: [], replies: [], smalls: [], pairs: [], samples: [], notes: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== '--app' && flag !== '--note' && !(flag in LIST_FLAGS)) throw new Error(`unknown flag ${flag}`);
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--app') args.app = value;
    else if (flag === '--note') args.notes.push(value);
    else {
      const labels = value.split(',').map(label => label.trim()).filter(Boolean);
      const bad = labels.find(label => !LABEL.test(label));
      if (bad !== undefined) throw new Error(`"${bad}" is not the label of a run`);
      args[LIST_FLAGS[flag]] = labels;
    }
  }
  if (!args.app) throw new Error('--app is required');
  if (!args.baseline.length) throw new Error("--baseline is required: the labels of today's models' runs");
  return args;
}

const here = dirname(fileURLToPath(import.meta.url));

function readRun(label) {
  try {
    return JSON.parse(readFileSync(join(here, 'results', `${label}.json`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`there is no finished run named ${label} in measure/results`);
    throw error;
  }
}

async function main() {
  let args;
  try {
    args = parseReportArgs(process.argv.slice(2));
    if (args.app !== app.APP) throw new Error(`this is ${app.APP}, not ${args.app}`);
  } catch (error) {
    console.error(`report: ${error.message}`);
    console.error('usage: npm run models:report -- --app <app> --baseline <labels> [--small-baseline <labels>] [--replies <labels>] [--smalls <labels>] [--pairs <labels>] [--samples <labels>] [--note "<text>"]');
    return 1;
  }
  // The price table is the app's own, and its file opens the database client as it loads: it is given the
  // measurement's address, which no database answers at. The report reads files and asks nothing of anyone.
  process.env.DATABASE_URL = MEASURE_DATABASE_URL;
  const { estimateAiCost } = await import('../ai-budget.js');

  let runs;
  try {
    runs = Object.fromEntries(['baseline', 'smallBaseline', 'replies', 'smalls', 'pairs', 'samples'].map(name => [name, args[name].map(readRun)]));
  } catch (error) {
    console.error(`report: ${error.message}`);
    return 1;
  }
  const problems = checkRuns({ app: app.APP, ...runs });
  if (problems.length) {
    console.error('report: these runs cannot be set beside one another:');
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const folder = join(here, '..', 'docs', 'measurements');
  mkdirSync(folder, { recursive: true });

  const reportPath = join(folder, `${date}-${app.APP}.md`);
  writeFileSync(reportPath, renderReport({ app: app.APP, date, ...runs, notes: args.notes, price: estimateAiCost }));
  console.log(`Wrote docs/measurements/${date}-${app.APP}.md`);
  if (runs.samples.length) {
    writeFileSync(join(folder, `${date}-${app.APP}-samples.md`), renderSamples({ app: app.APP, date, runs: [runs.baseline[0], ...runs.samples], visitorKeys: app.SAMPLE_VISITORS }));
    console.log(`Wrote docs/measurements/${date}-${app.APP}-samples.md`);
  }
  // The figures an app's own time limits are set from. The samples are runs given a second time, and are left out.
  const timed = [...runs.baseline, ...runs.smallBaseline, ...runs.replies, ...runs.smalls, ...runs.pairs];
  console.log(`\nEach model's time limit for each job, from ${timed.map(run => run.label).join(', ')}:\n`);
  console.log(renderLimits(timeLimits(timed)));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(error);
    process.exitCode = 1;
  });
}
