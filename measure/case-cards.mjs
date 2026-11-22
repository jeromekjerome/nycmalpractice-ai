// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// What does a small-job model write for people? The case card (a list of strengths and weaknesses and a note on the
// deadline) and the lead preview (a summary a firm reads before it bids) are the two small jobs whose words visitors and
// firms read, and a run file keeps neither. This replays the turns of a recorded run at which a case card or a lead
// preview is due, with the named small-job model, and prints the first cards' points and the first previews, each with its
// length. The app keeps at most 200 characters of each point and 300 of the deadline note and cuts the rest, so it also
// counts the points that come back at the limit.
//
//   node --env-file=.env measure/case-cards.mjs <small-job model> <run label> [--count 6] [--yes]
//
// It is the measurement's own replay (the visitor's messages, the replies the named run served, the recorded case law,
// that run's reply as the draft), with the small-job model any model of the registry, whichever provider sells it, and the
// run's own reply model for any rewrite. It runs behind the measurement's guard: the three providers' model hosts and
// nothing else, the measurement's stand-in database address, an estimate first and nothing sent without --yes. The keys
// come in through --env-file and are never printed. Invented visitors only.
//
// This file is the same in both apps.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installGuard, KEY_FOR, MODEL_HOSTS, withoutKeys } from './guard-fetch.mjs';
import { environmentFor } from './run.mjs';
import { entryFor } from '../model-registry.js';

const LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
// What the app keeps of a point and of the deadline note (normalizeCaseAnalysis in ask.js).
const POINT_LIMIT = 200;
const NOTE_LIMIT = 300;

const USAGE = 'node --env-file=.env measure/case-cards.mjs <small-job model> <run label> [--count 6] [--yes]';

export function parseCardsArgs(argv) {
  const positional = [];
  let count = 6;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--yes') yes = true;
    else if (token === '--count') {
      const value = argv[i + 1];
      count = Number(value);
      if (value === undefined || !Number.isInteger(count) || count < 1 || count > 20) throw new Error('--count must be a whole number from 1 to 20');
      i += 1;
    } else if (token.startsWith('--')) throw new Error(`unknown flag ${token}`);
    else positional.push(token);
  }
  const [model, label] = positional;
  if (!model || !label || positional.length > 2) throw new Error(`usage: ${USAGE}`);
  const entry = entryFor(model);
  if (!entry) throw new Error(`${model} is not in the registry (model-registry.js). Add it there first.`);
  if (entry.embedding) throw new Error(`${model} is not a chat model`);
  if (!LABEL.test(label)) throw new Error('the label may hold letters, digits, dots and hyphens only');
  return { model, label, count, yes };
}

// The points that were cut: as long as the limit, or ending with the ellipsis the app puts where it cut one.
export function pointsAtTheLimit(points, limit) {
  return points.filter(point => point.length >= limit || point.endsWith('…')).length;
}

// Worst case: for each turn replayed, the grader, the lead scorer and the case card, each at 4,000 tokens in and 2,500 out
// (the thinking room every adapter gives included), and a rewrite by the run's own reply model for one turn in five, at
// 4,000 in and 3,000 out; a quarter on top. `price` is the app's own price table (estimateAiCost), which reads the registry.
export function cardsEstimate({ turns, model, answer, price }) {
  return (turns * 3 * price(model, 4000, 2500) + Math.ceil(turns / 5) * price(answer, 4000, 3000)) * 1.25;
}

const here = dirname(fileURLToPath(import.meta.url));

// Resolves a file of the measure/ folder to its JSON, or throws the error with its code (ENOENT for a file that is not there).
function readJson(file) {
  return JSON.parse(readFileSync(join(here, file), 'utf8'));
}

const middleOf = lengths => [...lengths].sort((a, b) => a - b)[Math.floor(lengths.length / 2)] ?? 0;

// The tool, with everything it reaches handed in so that it can be run against stand-ins. Resolves with the exit code:
// 0 done, 1 refused, 2 nothing run for want of --yes.
export async function runCaseCards({ argv, env = process.env, log = console.log, logError = console.error, deps = defaultDeps }) {
  let args;
  try {
    args = parseCardsArgs(argv);
  } catch (error) {
    logError(`case-cards: ${error.message}`);
    logError(`usage: ${USAGE}`);
    return 1;
  }
  const { model, label, count, yes } = args;

  let run;
  let packets;
  try {
    run = deps.readJson(`results/${label}.json`);
    packets = deps.readJson('packets.json');
  } catch (error) {
    logError(`case-cards: ${error.code === 'ENOENT' ? `there is no run named ${label} in measure/results (or no recorded packets)` : withoutKeys(error?.message || error)}`);
    return 1;
  }

  // The order matters, as in the measurement: the settings, then the guard, and only then anything of the app.
  Object.assign(env, deps.environmentFor());
  const adapter = await deps.loadAdapter();
  if (run.app !== adapter.APP) {
    logError(`case-cards: ${label} was run on ${run.app}, not ${adapter.APP}`);
    return 1;
  }
  for (const key of new Set([model, run.answer].map(name => KEY_FOR[entryFor(name)?.provider] ?? KEY_FOR.openai))) {
    if (!env[key]) {
      logError(`${key} is not set. Run this with node --env-file=.env from the repository root.`);
      return 1;
    }
  }

  const guard = installGuard({ allowHosts: [...MODEL_HOSTS], fetchImpl: deps.fetchImpl ?? globalThis.fetch, jobOf: adapter.jobOf });
  const saved = { log: console.log, warn: console.warn, error: console.error };
  try {
    const visitors = await deps.loadVisitors();
    // The lead score is due from the second message and the case card from the third, so every turn from the first of
    // those is one at which something is due (a visitor in the seminar has neither).
    const firstDue = Math.min(adapter.SIDE_JOBS_FROM_TURN.leadScore, adapter.SIDE_JOBS_FROM_TURN.caseCard);
    const due = [];
    for (const visitor of visitors) {
      if (adapter.SEMINAR_MODES.includes(visitor.mode)) continue;
      for (let turn = firstDue; turn <= visitor.messages.length; turn += 1) due.push({ visitor, turn });
    }
    const price = await deps.loadPrice();
    const estimate = Math.max(Math.ceil(cardsEstimate({ turns: due.length, model, answer: run.answer, price }) * 100) / 100, 0.01);
    log(`${adapter.APP}: case cards and lead previews, small-job model ${model}, on the conversations of ${label} (replies by ${run.answer}). Estimated cost: under $${estimate.toFixed(2)}.`);
    if (!yes) {
      log('Nothing has been run. Add --yes to run it.');
      return 2;
    }

    // The small model alone is the app's small-job chain; the run's own reply model writes any rewrite.
    await adapter.useModels({ answer: run.answer, aux: model });
    const cards = [];
    const previews = [];
    let missing = 0;
    for (const { visitor, turn } of due) {
      if (cards.length >= count && previews.length >= count) break;
      const history = [];
      for (let n = 1; n < turn; n += 1) {
        const earlier = run.turns.find(candidate => candidate.visitor === visitor.key && candidate.turn === n);
        history.push({ role: 'user', content: visitor.messages[n - 1] }, { role: 'assistant', content: earlier.served });
      }
      const record = run.turns.find(candidate => candidate.visitor === visitor.key && candidate.turn === turn);
      const packet = packets[visitor.key][turn - 1];
      // The app writes to the console as it works; the tool's own output is kept clear of it.
      console.log = console.warn = console.error = () => {};
      let result;
      try {
        result = await adapter.reply({
          question: visitor.messages[turn - 1], mode: visitor.mode, sessionId: `cards-${visitor.key}`, history, gamState: adapter.stateFor?.(visitor.mode) ?? null,
          allowLeadScoring: true, recorded: adapter.recordedFor({ type: packet.type, cases: packet.cases, draft: record.served }),
        });
      } finally {
        Object.assign(console, saved);
      }
      const where = `${visitor.key}:${turn}`;
      if (result?.caseAnalysis) cards.push({ where, card: result.caseAnalysis });
      else if (turn >= adapter.SIDE_JOBS_FROM_TURN.caseCard) missing += 1;
      if (typeof result?.leadScore?.preview === 'string' && result.leadScore.preview) previews.push({ where, preview: result.leadScore.preview });
    }

    const lengths = [];
    let cutPoints = 0;
    let cardsWithACut = 0;
    cards.slice(0, count).forEach(({ where, card }, i) => {
      log(`case card ${i + 1} (${where})`);
      const points = [...(card.strengths ?? []).map(text => ['strength', text]), ...(card.weaknesses ?? []).map(text => ['weakness', text])];
      for (const [kind, text] of points) log(`  ${kind} (${text.length}): ${text}`);
      const note = String(card.solNote ?? card.deadlineNote ?? '');
      log(`  deadline note (${note.length}): ${note}`);
      lengths.push(...points.map(([, text]) => text.length));
      const cut = pointsAtTheLimit(points.map(([, text]) => text), POINT_LIMIT);
      cutPoints += cut;
      if (cut || note.length >= NOTE_LIMIT || note.endsWith('…')) cardsWithACut += 1;
    });
    const shown = cards.slice(0, count);
    previews.slice(0, count).forEach(({ where, preview }, i) => log(`lead preview ${i + 1} (${where}), ${preview.length} characters: ${preview}`));
    log(`\n${model}: ${shown.length} case cards (${missing} due and missing), ${lengths.length} points, middle length ${middleOf(lengths)}, longest ${Math.max(0, ...lengths)}.`);
    log(`Points at the limit (cut short): ${cutPoints} of ${lengths.length} points, ${cardsWithACut} of ${shown.length} cards show at least one cut.`);
    const shownPreviews = previews.slice(0, count).map(({ preview }) => preview.length);
    log(`Lead previews: ${shownPreviews.length}, middle length ${middleOf(shownPreviews)}, longest ${Math.max(0, ...shownPreviews)}.`);
    const spent = guard.calls.reduce((sum, call) => sum + price(call.model, call.inputTokens ?? 0, call.outputTokens ?? 0), 0);
    log(`Cost $${spent.toFixed(4)} over ${guard.calls.length} call(s); failed ${guard.failed.length}; refused ${guard.refused.length === 0 ? 'none' : [...new Set(guard.refused)].join(', ')}.`);
    return 0;
  } finally {
    Object.assign(console, saved);
    guard.restore();
  }
}

const defaultDeps = {
  environmentFor,
  readJson,
  loadAdapter: () => import('./app.mjs'),
  loadVisitors: async () => (await import('./visitors.mjs')).VISITORS,
  loadPrice: async () => (await import('../ai-budget.js')).estimateAiCost,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCaseCards({ argv: process.argv.slice(2) }).then(code => { process.exitCode = code; }, error => {
    console.error(withoutKeys(error?.stack || error));
    process.exitCode = 1;
  });
}
