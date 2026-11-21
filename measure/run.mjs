// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The model measurement's runner. It plays the synthetic visitors (visitors.mjs) through the app's own reply
// pipeline with one answer model and one small model, and writes what happened to measure/results/<label>.json
// for report.mjs to read. It runs on the owner's machine, never in production, and reaches OpenAI and
// CourtListener and nothing else (guard-fetch.mjs).
//
//   npm run models:measure -- --label <name> --answer <model> --aux <model> --mode record|reply|small [--from <label>] [--yes]
//
//   record  searches CourtListener live, once for each turn, and keeps what it found in measure/packets.json;
//           it replies from that packet. CourtListener allows this token 5 requests a minute, 50 an hour and
//           125 a day, so a live turn is made at most once a minute and only while the allowance lasts; when
//           the day's runs low the run stops, and running the same command again carries on from there.
//   reply   replays the packets. Each conversation carries this run's own replies forward.
//   small   replays the packets with the drafts and the conversation of the run named by --from, so that every
//           small-job model is shown the same things; it also classifies each turn and grades the drafts that
//           are wrong on purpose.
//
// A run that calls a model prints what it expects to cost and stops there unless --yes is given.
//
// This file is the same in both apps; app.mjs and visitors.mjs are each app's own.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installGuard, MEASURE_DATABASE_URL, withoutKeys } from './guard-fetch.mjs';

const LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const MODES = ['record', 'reply', 'small'];
const VALUE_FLAGS = ['--label', '--answer', '--aux', '--mode', '--from'];

export function parseArgs(argv) {
  const args = { label: null, answer: null, aux: null, mode: null, from: null, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--yes') { args.yes = true; continue; }
    if (!VALUE_FLAGS.includes(flag)) throw new Error(`unknown flag ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    args[flag.slice(2)] = value;
    i += 1;
  }
  for (const name of ['label', 'answer', 'aux', 'mode']) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }
  if (!LABEL.test(args.label)) throw new Error('the label may hold letters, digits, dots and hyphens only');
  if (!MODES.includes(args.mode)) throw new Error(`the mode must be one of ${MODES.join(', ')}`);
  if (args.mode === 'small' && !args.from) throw new Error('a small run needs --from, the label of the run whose drafts it grades');
  if (args.from !== null && !LABEL.test(args.from)) throw new Error('--from must be the label of an earlier run');
  return args;
}

// Stand-ins for every other service the app can reach. node --env-file=.env loads the live settings into the
// process; no code on the measurement's path uses them, and with these in their place none could.
const STAND_INS = {
  STRIPE_SECRET_KEY: 'sk_test_measure',
  STRIPE_WEBHOOK_SECRET: 'whsec_measure',
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'measure',
  TWILIO_PHONE_NUMBER: '+15555550100',
  SMTP_HOST: 'smtp.measure.invalid',
  SMTP_PORT: '465',
  SMTP_USER: 'measure@measure.invalid',
  SMTP_PASS: 'measure',
  NOTIFICATION_EMAIL: 'measure@measure.invalid',
  ALERT_EMAIL: 'measure@measure.invalid',
  ADMIN_SECRET: 'measure',
  CRON_SECRET: 'measure',
  DAILY_DIGEST: 'off',
};

// Settings that would change what a run measures if the local .env happened to hold them.
const CLEARED = ['AI_BUDGET_IN_TESTS', 'OPENAI_MODEL_RATES_JSON', 'DEMO_MODE', 'DEMO_DATABASE_URL'];

// The settings a run gives the app, applied before any app module is imported.
//   NODE_ENV=test       keeps the spending cap, which lives in the database, out of the run
//   DATABASE_URL        an address no database answers at
//   GATEKEEPER_MODE=llm the model grader, which a test environment would otherwise leave out
//   the two chains      one model each, named as its own fallback, so that no other model can answer
export function environmentFor({ answer, aux }) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: MEASURE_DATABASE_URL,
    GATEKEEPER_MODE: 'llm',
    GATEKEEPER_COURTLISTENER_LOOKUP: 'off',
    OPENAI_MODEL_ANSWER: answer,
    OPENAI_MODEL_ANSWER_FALLBACKS: answer,
    OPENAI_MODEL_AUX: aux,
    OPENAI_MODEL_AUX_FALLBACKS: aux,
    ...STAND_INS,
  };
}

// What is kept of one turn. `type` is the kind of claim the reply was written for (from the packet);
// `classifiedType` is what this run's small model made of the same conversation, in a small-job run.
export { CLEARED as CLEARED_SETTINGS };

export function turnRecord({ visitor, turn, ms, type, result, classifiedType = null, error = null }) {
  const evaluation = result?.evaluation ?? null;
  // The first attempt is the model's own draft; later attempts are rewrites.
  const first = evaluation?.attempts?.[0] ?? null;
  return {
    visitor,
    turn,
    ms,
    type,
    classifiedType,
    gateStatus: evaluation?.gate_status ?? null,
    firstPassCompliant: evaluation?.first_pass_compliant === true,
    finalAttempt: evaluation?.final_attempt_number ?? 0,
    // Who graded the first draft: "llm" when the grader's answer was usable for every rule.
    evaluator: first?.evaluator ?? null,
    firstDraftUnanchored: (first?.citation_audit ?? []).filter(citation => citation.status === 'UNANCHORED').length,
    firstDraftFlagged: [
      ...(first?.required_checks ?? []).filter(check => check.passed !== true),
      ...(first?.prohibited_checks ?? []).filter(check => check.violated === true),
    ].map(check => check.id),
    firstDraft: first?.draft_text ?? '',
    served: typeof result?.answer === 'string' ? result.answer : '',
    leadTier: result?.leadScore?.tier ?? null,
    leadScore: result?.leadScore?.score ?? null,
    leadVerdict: result?.leadScore != null && typeof result.leadScore === 'object',
    caseCard: result?.caseAnalysis != null && typeof result.caseAnalysis === 'object',
    ...(error ? { error } : {}),
  };
}

// ─── CourtListener's allowance ────────────────────────────────────────────────

// A turn can spend four searches (New York, then national; the tailored query, then the type's own).
const SEARCHES_A_TURN = 4;
// Below this many of the day's requests the run stops, and leaves the rest of the day's allowance alone.
const DAY_FLOOR = 10;

// What to do before a live search, from the answer of CourtListener's usage API: go on, wait for a window to
// move on, or stop for the day.
export function allowanceDecision(usage, now = Date.now()) {
  const windows = (Array.isArray(usage?.current_usage) ? usage.current_usage : []).filter(window => window?.scope === 'user');
  const windowOf = seconds => windows.find(window => Number(window.window_seconds) === seconds);
  const left = window => (window.blocked ? 0 : Number(window.remaining));

  const day = windowOf(86400);
  if (!day || !Number.isFinite(left(day))) return { action: 'stop', why: "CourtListener's usage report did not give the day's allowance" };
  if (left(day) < DAY_FLOOR) return { action: 'stop', why: `only ${left(day)} of the day's ${day.limit} CourtListener requests are left` };

  for (const [seconds, name] of [[3600, 'hour'], [60, 'minute']]) {
    const window = windowOf(seconds);
    if (!window || left(window) >= SEARCHES_A_TURN) continue;
    const reset = Date.parse(window.reset_at);
    return {
      action: 'wait',
      until: (Number.isFinite(reset) ? reset : now + seconds * 1000) + 2000,
      why: `${left(window)} of ${window.limit} CourtListener requests are left this ${name}`,
    };
  }
  return { action: 'go' };
}

// ─── What a run is expected to cost ───────────────────────────────────────────

// What a reasoning model may spend thinking on one call, on top of what it writes.
const REASONING_ALLOWANCE_TOKENS = 1000;
// The estimate is meant to err on the high side.
const ESTIMATE_MARGIN = 1.25;

// Dollars, from an earlier run's token counts at the prices of the models this run would use.
// `price(model, inputTokens, outputTokens)` and `reasoning(model)` come from the app's own price table and
// request shaping; `replyJobs` are the jobs the answer model does.
export function estimateCost({ mode, answer, aux }, baseRun, { price, reasoning, replyJobs }) {
  let dollars = 0;
  for (const call of baseRun.calls ?? []) {
    const forAnswerModel = call.job ? replyJobs.includes(call.job) : call.model === baseRun.answer;
    // A small-job run is given its drafts: the answer model writes only the rewrites.
    if (mode === 'small' && forAnswerModel && call.job && call.job !== 'rewrite') continue;
    const model = forAnswerModel ? answer : aux;
    const written = Math.max(0, (call.outputTokens ?? 0) - (call.reasoningTokens ?? 0));
    dollars += price(model, call.inputTokens ?? 0, written + (reasoning(model) ? REASONING_ALLOWANCE_TOKENS : 0));
  }
  return dollars * ESTIMATE_MARGIN;
}

// ─── A run ────────────────────────────────────────────────────────────────────

// One reply, from a packet. A call that fails is made once more, as a visitor would send the message again; a
// second failure is kept as a failed turn.
async function play({ app, label, visitor, history, question, packet, draft, now }) {
  const args = {
    question,
    mode: visitor.mode,
    sessionId: `measure-${label}-${visitor.key}`,
    history: structuredClone(history),
    gamState: app.stateFor(visitor.mode),
    allowLeadScoring: true,
    recorded: app.recordedFor({ type: packet.type, cases: packet.cases, draft }),
  };
  for (let attempt = 1; ; attempt++) {
    const started = now();
    try {
      const result = await app.reply(structuredClone(args));
      return { result, ms: now() - started, error: null };
    } catch (error) {
      if (attempt === 2) return { result: null, ms: now() - started, error: withoutKeys(error?.message || error) };
    }
  }
}

/**
 * Run one measurement. Everything it touches is handed in, so that it can be run against stand-ins.
 *
 * @param {object} options
 * @param {object} options.args      from parseArgs
 * @param {object} options.app       the app adapter (app.mjs)
 * @param {Array} options.visitors   the synthetic visitors
 * @param {Array} options.knownBad   the drafts that are wrong on purpose (graded in a small-job run)
 * @param {object} options.store     { read(path), write(path, value), remove(path) } over the measure/ folder
 * @param {object} options.guard     the fetch guard's { calls, failed, refused }
 * @param {object} options.pace      { beforeLiveTurn(): Promise<'go' | 'stop'> }, asked before every live search
 * @returns {Promise<{ status: 'complete' | 'stopped', run: object }>}
 */
export async function measure({ args, app, visitors, knownBad, store, guard, pace, log = () => {}, now = () => Date.now() }) {
  const { label, mode, answer, aux, from } = args;
  const runPath = `results/${label}.json`;
  const partialPath = `results/${label}.partial.json`;
  if (store.read(runPath)) {
    throw new Error(`measure: ${label} already has results; choose another label, or delete measure/${runPath} to run it again`);
  }

  const packets = store.read('packets.json') ?? {};
  const source = mode === 'small' ? store.read(`results/${from}.json`) : null;
  if (mode === 'small' && !source) throw new Error(`measure: there is no run named ${from} to copy drafts from`);
  const sourceTurn = (visitorKey, turn) => {
    const found = source.turns.find(candidate => candidate.visitor === visitorKey && candidate.turn === turn);
    if (!found) throw new Error(`measure: ${from} has no turn ${visitorKey}:${turn} to copy a draft from`);
    return found;
  };

  // A run that was stopped part-way is carried on, when it was the same run.
  const kept = store.read(partialPath);
  const same = kept && kept.mode === mode && kept.answer === answer && kept.aux === aux && (kept.from ?? null) === (from ?? null);
  const run = same ? kept : {
    app: app.APP, label, mode, answer, aux, ...(from ? { from } : {}),
    startedAt: new Date(now()).toISOString(),
    turns: [], knownBad: [], calls: [], failed: [], refused: [],
  };
  const earlier = { calls: run.calls, failed: run.failed, refused: run.refused };
  const collect = () => {
    run.calls = [...earlier.calls, ...guard.calls];
    run.failed = [...earlier.failed, ...guard.failed];
    run.refused = [...earlier.refused, ...guard.refused];
  };
  const save = () => { collect(); store.write(partialPath, run); };
  const made = new Map(run.turns.map(turn => [`${turn.visitor}:${turn.turn}`, turn]));

  // A live search for one turn, under the allowance. null when the allowance says to stop.
  const search = async (history, question, key) => {
    for (let attempt = 1; ; attempt++) {
      if ((await pace.beforeLiveTurn()) === 'stop') return null;
      const found = await app.find(structuredClone(history), question);
      const packet = { type: found.type, cases: Array.isArray(found.cases) ? found.cases : [] };
      // An empty answer may be a slow or throttled search rather than no decisions: it is asked once more.
      if (packet.cases.length > 0 || attempt === 2) return packet;
      log(`${key}: the search found nothing; asking once more`);
    }
  };

  for (const visitor of visitors) {
    const history = [];
    for (let turn = 1; turn <= visitor.messages.length; turn++) {
      const question = visitor.messages[turn - 1];
      const key = `${visitor.key}:${turn}`;
      let record = made.get(key);

      if (!record) {
        let packet = packets[visitor.key]?.[turn - 1];
        if (!packet) {
          if (mode !== 'record') throw new Error(`measure: no recorded packet for ${key}; a record run comes first`);
          packet = await search(history, question, key);
          if (!packet) {
            save();
            return { status: 'stopped', run };
          }
          (packets[visitor.key] ??= [])[turn - 1] = packet;
          store.write('packets.json', packets);
        }

        const draft = mode === 'small' ? sourceTurn(visitor.key, turn).firstDraft : undefined;
        const played = await play({ app, label, visitor, history, question, packet, draft, now });
        const classifiedType = mode === 'small'
          ? await app.classify(structuredClone(history), question).then(classified => classified.type, () => null)
          : null;
        record = turnRecord({ visitor: visitor.key, turn, ms: played.ms, type: packet.type, result: played.result, classifiedType, error: played.error });
        run.turns.push(record);
        made.set(key, record);
        save();
        log(`${key}  ${record.error ? `FAILED (${record.error})` : `${record.gateStatus}${record.firstPassCompliant ? '' : ' after a first draft that was blocked'}`}  ${(record.ms / 1000).toFixed(1)}s`);
      }

      // The conversation goes on: with this run's own reply, or in a small-job run with the copied run's.
      history.push({ role: 'user', content: question });
      const said = mode === 'small' ? sourceTurn(visitor.key, turn).served : record.served;
      if (said) history.push({ role: 'assistant', content: said });
    }
  }

  if (mode === 'small') {
    // From here on the model calls are for the known-bad drafts, which are no part of what a conversation costs.
    run.knownBadFromCall ??= earlier.calls.length + guard.calls.length;
    const graded = new Set(run.knownBad.map(entry => entry.key));
    for (const bad of knownBad) {
      if (graded.has(bad.key)) continue;
      const visitor = visitors.find(candidate => candidate.key === bad.visitor);
      const history = [];
      for (let turn = 1; turn < bad.turn; turn++) {
        history.push({ role: 'user', content: visitor.messages[turn - 1] });
        const said = sourceTurn(visitor.key, turn).served;
        if (said) history.push({ role: 'assistant', content: said });
      }
      const packet = packets[visitor.key]?.[bad.turn - 1];
      if (!packet) throw new Error(`measure: no recorded packet for ${visitor.key}:${bad.turn}; a record run comes first`);
      const played = await play({ app, label, visitor, history, question: visitor.messages[bad.turn - 1], packet, draft: bad.draft, now });
      const record = turnRecord({ visitor: visitor.key, turn: bad.turn, ms: played.ms, type: packet.type, result: played.result, error: played.error });
      run.knownBad.push({
        key: bad.key,
        breaks: bad.breaks,
        // Caught: the gate did not pass the draft at the first pass.
        caught: played.result?.evaluation?.first_pass_compliant === false,
        flagged: record.firstDraftFlagged,
        evaluator: record.evaluator,
        ...(played.error ? { error: played.error } : {}),
      });
      save();
      log(`known-bad ${bad.key}  ${run.knownBad.at(-1).caught ? 'caught' : 'NOT caught'}`);
    }
  }

  collect();
  run.finishedAt = new Date(now()).toISOString();
  store.write(runPath, run);
  store.remove(partialPath);
  return { status: 'complete', run };
}

// ─── The command ──────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));

// The measure/ folder. A file is written beside itself and renamed into place, so that a run stopped while
// writing leaves the earlier file whole.
const fileStore = {
  read(path) {
    try {
      return JSON.parse(readFileSync(join(here, path), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  },
  write(path, value) {
    const full = join(here, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(`${full}.writing`, `${JSON.stringify(value, null, 1)}\n`);
    renameSync(`${full}.writing`, full);
  },
  remove(path) {
    rmSync(join(here, path), { force: true });
  },
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const MINUTE = 60_000;

// One live turn a minute at most, and none unless CourtListener's own count says there is room.
function courtListenerPace(log) {
  let lastLiveTurn = 0;
  const readUsage = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch('https://www.courtlistener.com/api/rest/v4/api-usage/', {
          headers: { Authorization: `Token ${process.env.COURTLISTENER_TOKEN}` },
          signal: AbortSignal.timeout(15_000),
        });
        return await response.json();
      } catch (error) {
        if (attempt === 2) return null;
        await sleep(15_000);
      }
    }
  };
  return {
    async beforeLiveTurn() {
      await sleep(lastLiveTurn + MINUTE - Date.now());
      for (;;) {
        const decision = allowanceDecision(await readUsage());
        if (decision.action === 'go') {
          lastLiveTurn = Date.now();
          return 'go';
        }
        if (decision.action === 'stop') {
          log(`Stopping: ${decision.why}.`);
          return 'stop';
        }
        // The windows roll, so room can come back before the whole window has passed: look again in five minutes.
        const wait = Math.min(decision.until - Date.now(), 5 * MINUTE);
        log(`Waiting ${Math.ceil(Math.max(wait, 0) / 1000)}s: ${decision.why}.`);
        await sleep(wait);
      }
    },
  };
}

const dollars = amount => `$${(Math.ceil(amount * 100) / 100).toFixed(2)}`;

function summaryOf(list, name) {
  const counts = new Map();
  for (const item of list) counts.set(name(item), (counts.get(name(item)) ?? 0) + 1);
  return counts.size ? [...counts].map(([key, count]) => `${key} x${count}`).join(', ') : 'none';
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`measure: ${error.message}`);
    console.error('usage: npm run models:measure -- --label <name> --answer <model> --aux <model> --mode record|reply|small [--from <label>] [--yes]');
    return 1;
  }
  for (const name of args.mode === 'record' ? ['OPENAI_API_KEY', 'COURTLISTENER_TOKEN'] : ['OPENAI_API_KEY']) {
    if (!process.env[name]) {
      console.error(`measure: ${name} is not set. Run this with npm run models:measure, which loads .env.`);
      return 1;
    }
  }

  // The order matters: the settings, then the guard, and only then anything of the app.
  Object.assign(process.env, environmentFor(args));
  for (const name of CLEARED) delete process.env[name];
  const app = await import('./app.mjs');
  // Only a recording run has any business with CourtListener.
  const guard = installGuard({ allowHosts: args.mode === 'record' ? ['api.openai.com', 'www.courtlistener.com'] : ['api.openai.com'], jobOf: app.jobOf });
  const { estimateAiCost, hasPrice } = await import('../ai-budget.js');
  const { isReasoningModel } = await import('../openaiModelFailover.js');
  const { VISITORS, KNOWN_BAD } = await import('./visitors.mjs');

  for (const model of [args.answer, args.aux]) {
    if (!hasPrice(model)) {
      console.error(`measure: there is no price on record for ${model}. Add it to the table in ai-budget.js first.`);
      return 1;
    }
  }

  if (args.mode === 'record') {
    console.log('Estimated cost of this run: under $3.00');
  } else {
    const baseLabel = args.from ?? 'base-1';
    const base = fileStore.read(`results/${baseLabel}.json`);
    if (!base) {
      console.error(`measure: there is no run named ${baseLabel} to estimate the cost from. A record run comes first.`);
      return 1;
    }
    const estimate = estimateCost(args, base, { price: estimateAiCost, reasoning: isReasoningModel, replyJobs: app.REPLY_JOBS });
    console.log(`Estimated cost of this run: ${dollars(estimate)}`);
  }
  if (!args.yes) {
    console.log('Nothing has been run. Add --yes to run it.');
    return 2;
  }

  const turns = VISITORS.reduce((count, visitor) => count + visitor.messages.length, 0);
  console.log(`${app.APP}: ${args.mode} run "${args.label}", answer model ${args.answer}, small model ${args.aux}, ${VISITORS.length} visitors, ${turns} turns.`);
  const { status, run } = await measure({
    args, app, visitors: VISITORS, knownBad: KNOWN_BAD, store: fileStore, guard,
    pace: courtListenerPace(line => console.log(line)), log: line => console.log(line),
  });

  const spent = run.calls.reduce((sum, call) => sum + estimateAiCost(call.model, call.inputTokens, call.outputTokens), 0);
  if (status === 'stopped') {
    const recorded = Object.values(fileStore.read('packets.json') ?? {}).reduce((count, list) => count + list.filter(Boolean).length, 0);
    console.log(`Stopped with ${recorded} of ${turns} turns recorded. Run the same command again later and it carries on from there.`);
  } else {
    console.log(`Done: ${run.turns.length} turns, written to measure/results/${args.label}.json.`);
  }
  console.log(`cost so far: ${dollars(spent)} over ${run.calls.length} model calls`);
  console.log(`model calls that failed: ${summaryOf(run.failed, failure => `${failure.model} ${failure.status ?? failure.error}`)}`);
  console.log(`refused: ${summaryOf(run.refused, host => host)}`);
  return status === 'stopped' ? 3 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(withoutKeys(error?.stack || error));
    process.exitCode = 1;
  });
}
