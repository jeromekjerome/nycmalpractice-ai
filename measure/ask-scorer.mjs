// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Asks one app's own lead scorer about a made-up conversation, several times over, with the small-job model it is
// told, and prints what the model answered and what the app made of it. For checking the rule that a claim out of time is
// never a lead, for each model that may be asked to do the scoring.
//
//   node --env-file=.env measure/ask-scorer.mjs <case> <times> --model <small-job model> [--yes]
//
// The model may be any model of the registry (model-registry.js), whichever provider sells it. It is handed to the app as
// the chain of the small jobs, alone, through the same hand-over a measurement run uses, so that no other model can
// answer. The tool runs behind the measurement's guard: it may reach the three providers' model hosts and nothing else,
// and the app is given the measurement's own database address, which no database answers at. It spends outside the
// site's cap only because NODE_ENV is "test", as the measurement does. Every person in it is invented. The keys come in
// through --env-file and are never printed. It prints its estimate and stops unless --yes is given.
//
// A case belongs to one app, and the tool refuses a case for the other one.
//
// This file is the same in both apps.
import { pathToFileURL } from 'node:url';
import { answerTextOf, installGuard, KEY_FOR, MODEL_HOSTS, withoutKeys } from './guard-fetch.mjs';
import { environmentFor } from './run.mjs';
import { entryFor } from '../model-registry.js';

export const CASES = {
  // nycinjury: a fall in 2019. Negligence claims have three years (CPLR 214), so this one is years out of time.
  'old-fall': {
    app: 'nycinjury', type: 'slip',
    history: [
      ['user', 'In January 2019 I slipped on ice outside a supermarket in Queens and broke my wrist.'],
      ['assistant', 'I am sorry that happened. Did you need treatment, and did you tell the store about the fall?'],
      ['user', 'I had surgery on it that winter and told the manager the same day. It healed, though it still aches.'],
      ['assistant', 'Thank you. In New York a claim like this generally has to be started within three years of the injury.'],
    ],
    latest: 'I never did anything about it at the time. Is it too late? I would still like to talk to a lawyer.',
  },
  // nycinjury: a crash in 2019 with clear fault and a grave injury, so everything but the time limit scores high.
  'old-crash': {
    app: 'nycinjury', type: 'auto',
    history: [
      ['user', 'In March 2019 a delivery truck ran a red light in Brooklyn and hit my car. The driver was ticketed at the scene.'],
      ['assistant', 'I am sorry that happened. How badly were you hurt, and have you been able to work since?'],
      ['user', 'I needed spinal fusion surgery and could not go back to my job as an electrician. I have the police report and all my medical records.'],
      ['assistant', 'Thank you. In New York a claim like this generally has to be started within three years of the crash.'],
    ],
    latest: 'I never did anything about it; I was dealing with the recovery. Is it too late? I would still like to talk to a lawyer.',
  },
  // The same fall, five weeks ago: a sound claim that the rule must leave alone.
  'recent-fall': {
    app: 'nycinjury', type: 'slip',
    history: [
      ['user', 'Five weeks ago I slipped on ice outside a supermarket in Queens and broke my wrist.'],
      ['assistant', 'I am sorry that happened. Did you need treatment, and did you tell the store about the fall?'],
      ['user', 'I had surgery on it last month and told the manager the same day. I am still in a cast.'],
      ['assistant', 'Thank you. In New York a claim like this generally has to be started within three years of the injury.'],
    ],
    latest: 'I have not done anything about it yet. I would like to talk to a lawyer.',
  },
  // NYCMalpractice: the measurement's out-of-time visitor (surgery in 2017, last seen in 2018).
  'too-late': {
    app: 'nycmalpractice', type: 'surgical_error', mode: 'personal',
    history: [
      ['user', 'I had my gallbladder removed in 2017 and the surgeon nicked my bile duct. I had two more surgeries in 2017 and 2018.'],
      ['assistant', 'I am sorry you went through that. Have you seen that surgeon or been treated at that hospital since?'],
      ['user', 'I have not seen that surgeon or that hospital since 2018. I just never got around to doing anything about it.'],
      ['assistant', 'Thank you. In New York a malpractice claim generally has to be started within two years and six months of the treatment.'],
      ['user', 'Is it too late to sue?'],
      ['assistant', 'From what you describe, the time to bring this claim has very likely passed. A lawyer could confirm whether any exception applies.'],
    ],
    latest: 'I would still like to talk to someone.',
  },
  // The same injury, with the last surgery four months ago: a sound claim that the rule must leave alone.
  'in-time': {
    app: 'nycmalpractice', type: 'surgical_error', mode: 'personal',
    history: [
      ['user', 'I had my gallbladder removed seven months ago and the surgeon nicked my bile duct. I had two more surgeries, the last one four months ago.'],
      ['assistant', 'I am sorry you went through that. Are you still being treated for it?'],
      ['user', 'Yes, I still see a specialist for it. The hospital is a private one.'],
      ['assistant', 'Thank you. In New York a malpractice claim generally has to be started within two years and six months of the treatment.'],
    ],
    latest: 'I would like to talk to someone about a claim.',
  },

  // ── Claims that are OLD BUT IN TIME: the rule must not refuse these. ──────────────────────────────────────

  // NYCMalpractice: a child injured at birth five years ago. A child's time does not run as an adult's does
  // (CPLR 208: for malpractice, up to ten years from the act), so this is in time.
  'child-birth-injury': {
    app: 'nycmalpractice', type: 'birth_injury', mode: 'personal',
    history: [
      ['user', 'My son was born in 2020 at a private hospital in Brooklyn. The delivery went wrong and his shoulder was injured. He has Erb\'s palsy and limited use of his right arm.'],
      ['assistant', 'I am sorry. Has he been treated for it since?'],
      ['user', 'Yes, he has had two surgeries and therapy every week. He is five now. We never spoke to a lawyer.'],
      ['assistant', 'Thank you for telling me.'],
    ],
    latest: 'Is it too late to do anything? I would like to talk to a lawyer.',
  },
  // A cancer missed in 2021 and found four months ago: the time runs from discovery (Lavern's Law).
  'cancer-found-late': {
    app: 'nycmalpractice', type: 'misdiagnosis', mode: 'personal',
    history: [
      ['user', 'In 2021 my doctor read a mammogram as normal. Four months ago a new doctor found stage 3 breast cancer and said the tumor was visible on the 2021 scan.'],
      ['assistant', 'I am so sorry. Are you in treatment now?'],
      ['user', 'Yes, chemotherapy. I only found out about the 2021 scan four months ago.'],
      ['assistant', 'Thank you for telling me.'],
    ],
    latest: 'Do I still have time to bring a claim? I would like to talk to a lawyer.',
  },
  // A clamp left in during surgery in 2019 and found three months ago: one year from discovery.
  'object-found-late': {
    app: 'nycmalpractice', type: 'surgical_error', mode: 'personal',
    history: [
      ['user', 'I had abdominal surgery in 2019 at a private hospital. Three months ago a CT scan found a surgical clamp left inside me.'],
      ['assistant', 'I am sorry. Has it been removed?'],
      ['user', 'Yes, I had another operation last month to take it out. I had years of pain nobody could explain.'],
      ['assistant', 'Thank you for telling me.'],
    ],
    latest: 'It has been so long since the surgery. Can I still do something? I want to talk to a lawyer.',
  },
  // An operation in 2020, with the same surgeon treating the injury until eight months ago: continuous treatment.
  'still-treating': {
    app: 'nycmalpractice', type: 'surgical_error', mode: 'personal',
    history: [
      ['user', 'A surgeon at a private hospital operated on my spine in 2020 and damaged a nerve. I have foot drop.'],
      ['assistant', 'I am sorry. Have you kept seeing that surgeon?'],
      ['user', 'Yes, he kept treating me for the nerve damage, with two more procedures, until eight months ago, when I finally changed doctors.'],
      ['assistant', 'Thank you for telling me.'],
    ],
    latest: 'Is it too late since the operation was in 2020? I would like to talk to a lawyer.',
  },
  // Two years and three months since the operation: three months of the two and a half years are left.
  'deadline-near': {
    app: 'nycmalpractice', type: 'surgical_error', mode: 'personal',
    history: [
      ['user', 'Two years and three months ago a surgeon at a private hospital cut my bile duct during a gallbladder operation. I needed a second surgery to repair it.'],
      ['assistant', 'I am sorry. Have you seen that surgeon since?'],
      ['user', 'No, not since the week after the operation.'],
      ['assistant', 'Thank you for telling me.'],
    ],
    latest: 'I know time is running short. I would like to talk to a lawyer now.',
  },
  // The same operation two years and five months ago: one month is left. In time, by a little.
  'one-month-left': {
    app: 'nycmalpractice', type: 'surgical_error', mode: 'personal',
    history: [
      ['user', 'Two years and five months ago a surgeon at a private hospital cut my bile duct during a gallbladder operation. I needed a second surgery to repair it.'],
      ['assistant', 'I am sorry. Have you seen that surgeon since?'],
      ['user', 'No, not since the week after the operation.'],
      ['assistant', 'Thank you for telling me.'],
    ],
    latest: 'I know time is nearly up. I would like to talk to a lawyer now.',
  },
  // And two years and eight months ago: out of time by two months, with nothing to extend it.
  'just-expired': {
    app: 'nycmalpractice', type: 'surgical_error', mode: 'personal',
    history: [
      ['user', 'Two years and eight months ago a surgeon at a private hospital cut my bile duct during a gallbladder operation. I needed a second surgery to repair it.'],
      ['assistant', 'I am sorry. Have you seen that surgeon since?'],
      ['user', 'No, not since the week after the operation.'],
      ['assistant', 'Thank you for telling me.'],
    ],
    latest: 'I would like to talk to a lawyer about it.',
  },
  // nycinjury: a child hit by a car in 2019 at the age of six. Her three years start when she turns eighteen.
  'child-hit': {
    app: 'nycinjury', type: 'auto',
    history: [
      ['user', 'In 2019, when my daughter was six, a car hit her in a crosswalk in the Bronx. The driver ran a stop sign and was ticketed.'],
      ['assistant', 'I am sorry. How badly was she hurt?'],
      ['user', 'She broke her leg in two places and needed surgery. She still limps and has a scar. She is thirteen now. We never made a claim.'],
      ['assistant', 'Thank you for telling me.'],
    ],
    latest: 'Is it too late for her? I would like to talk to a lawyer.',
  },
  // A fall two years and ten months ago: two months of the three years are left.
  'deadline-near-fall': {
    app: 'nycinjury', type: 'slip',
    history: [
      ['user', 'Two years and ten months ago I fell on a broken stair in my apartment building in Queens and tore a ligament in my knee.'],
      ['assistant', 'I am sorry. Did you need surgery, and did the landlord know about the stair?'],
      ['user', 'I had surgery. Tenants had complained about that stair in writing for months before I fell.'],
      ['assistant', 'Thank you for telling me.'],
    ],
    latest: 'I know it has been almost three years. Can I still bring a claim? I want to talk to a lawyer.',
  },
  // Asbestos in the 1990s, mesothelioma diagnosed five months ago: three years from discovery (CPLR 214-c).
  'asbestos': {
    app: 'nycinjury', type: 'product',
    history: [
      ['user', 'I installed asbestos pipe insulation in Brooklyn buildings from 1988 to 1996. Five months ago I was diagnosed with mesothelioma.'],
      ['assistant', 'I am very sorry. Do you know whose products you worked with?'],
      ['user', 'Yes, I remember the brand names on the boxes, and two men from my old crew can confirm it.'],
      ['assistant', 'Thank you for telling me.'],
    ],
    latest: 'It was thirty years ago. Is it too late to bring a claim? I would like to talk to a lawyer.',
  },
};

const USAGE = `node --env-file=.env measure/ask-scorer.mjs <${Object.keys(CASES).join('|')}> <times, 1 to 20> --model <small-job model> [--yes]`;

export function parseScorerArgs(argv) {
  const positional = [];
  let model = null;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--yes') yes = true;
    else if (token === '--model') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--model needs the name of a small-job model');
      model = value;
      i += 1;
    } else if (token.startsWith('--')) throw new Error(`unknown flag ${token}`);
    else positional.push(token);
  }
  const [caseKey, timesText] = positional;
  if (!Object.hasOwn(CASES, caseKey ?? '')) throw new Error(`no case named "${caseKey ?? ''}"; usage: ${USAGE}`);
  const times = Number(timesText);
  if (!Number.isInteger(times) || times < 1 || times > 20) throw new Error('times must be a whole number from 1 to 20');
  if (!model) throw new Error('--model is required: the small-job model to ask');
  const entry = entryFor(model);
  if (!entry) throw new Error(`${model} is not in the registry (model-registry.js). Add it there first.`);
  if (entry.embedding) throw new Error(`${model} is not a chat model`);
  return { caseKey, times, model, yes };
}

// At most: about 2,000 tokens in, and the scorer's 300 out plus the 2,000 of thinking room every adapter gives, a quarter
// on top. `price` is the app's own price table (estimateAiCost), which reads the registry.
export function scorerEstimate(times, model, price) {
  return times * price(model, 2000, 2300) * 1.25;
}

// A fetch that also keeps what each model answered, read on its way back before the app decides anything. An answer that
// is not a JSON object is kept as null.
export function listenTo(fetchImpl, answers) {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    try {
      const host = new URL(typeof input === 'string' ? input : (input?.url ?? String(input))).hostname;
      const text = answerTextOf(host, await response.clone().json());
      if (typeof text === 'string') answers.push(JSON.parse(text));
    } catch {
      answers.push(null);
    }
    return response;
  };
}

// The tool, with everything it reaches handed in so that it can be run against stand-ins. Resolves with the exit code:
// 0 done, 1 refused, 2 nothing run for want of --yes.
export async function runScorer({ argv, env = process.env, log = console.log, logError = console.error, deps = defaultDeps }) {
  let args;
  try {
    args = parseScorerArgs(argv);
  } catch (error) {
    logError(`ask-scorer: ${error.message}`);
    logError(`usage: ${USAGE}`);
    return 1;
  }
  const { caseKey, times, model, yes } = args;
  const chosen = CASES[caseKey];

  // The order matters, as in the measurement: the settings, then the guard, and only then anything of the app.
  Object.assign(env, deps.environmentFor());
  const adapter = await deps.loadAdapter();
  if (adapter.APP !== chosen.app) {
    logError(`"${caseKey}" is a case for ${chosen.app}; this repository is ${adapter.APP}.`);
    return 1;
  }
  const key = KEY_FOR[entryFor(model).provider];
  if (!env[key]) {
    logError(`${key} is not set. Run this with node --env-file=.env from the repository root.`);
    return 1;
  }

  const answers = [];
  const guard = installGuard({ allowHosts: [...MODEL_HOSTS], fetchImpl: listenTo(deps.fetchImpl ?? globalThis.fetch, answers), jobOf: adapter.jobOf });
  const saved = { log: console.log, warn: console.warn, error: console.error };
  try {
    const price = await deps.loadPrice();
    const estimate = Math.max(Math.ceil(scorerEstimate(times, model, price) * 100) / 100, 0.01);
    log(`${adapter.APP}: the lead scorer on "${caseKey}", ${times} time(s), small-job model ${model}. Estimated cost: under $${estimate.toFixed(2)}.`);
    if (!yes) {
      log('Nothing has been run. Add --yes to run it.');
      return 2;
    }

    // The model alone is the chain of the small jobs (and of the reply, which this tool never asks for).
    await adapter.useModels({ answer: model, aux: model });
    const scoreLead = await deps.loadScoreLead();
    const history = chosen.history.map(([role, content]) => ({ role, content }));
    const said = [];
    const keep = (...parts) => said.push(parts.join(' '));
    let leads = 0;
    for (let n = 1; n <= times; n += 1) {
      const before = answers.length;
      console.log = console.warn = console.error = keep;
      let verdict;
      try {
        verdict = chosen.app === 'nycinjury' ? await scoreLead(chosen.latest, history, chosen.type) : await scoreLead(chosen.latest, history, chosen.type, chosen.mode);
      } finally {
        Object.assign(console, saved);
      }
      const written = answers.slice(before).filter(Boolean).at(-1);
      const marks = written?.dimensions ? Object.entries(written.dimensions).map(([name, mark]) => `${name} ${mark}`).join(', ') : 'no marks';
      const isLead = Boolean(verdict?.tier);
      if (isLead) leads += 1;
      log(`${String(n).padStart(2)}. the model: viable ${written?.viable}, score ${written?.score}, confidence ${written?.confidence} (${marks})`);
      log(`    the app:   ${!verdict ? 'no verdict' : isLead ? `a ${verdict.tier} lead, reserve $${verdict.reserve}` : 'not a lead'}`);
    }
    for (const line of said) log(`    app log: ${withoutKeys(line)}`);
    const spent = guard.calls.reduce((sum, call) => sum + price(call.model, call.inputTokens ?? 0, call.outputTokens ?? 0), 0);
    log(`"${caseKey}": a lead in ${leads} of ${times}. Cost $${spent.toFixed(4)} over ${guard.calls.length} call(s); failed ${guard.failed.length}; refused ${guard.refused.length === 0 ? 'none' : [...new Set(guard.refused)].join(', ')}.`);
    return 0;
  } finally {
    guard.restore();
  }
}

const defaultDeps = {
  environmentFor,
  loadAdapter: () => import('./app.mjs'),
  loadPrice: async () => (await import('../ai-budget.js')).estimateAiCost,
  loadScoreLead: async () => (await import('../auction.js')).scoreLead,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runScorer({ argv: process.argv.slice(2) }).then(code => { process.exitCode = code; }, error => {
    console.error(withoutKeys(error?.stack || error));
    process.exitCode = 1;
  });
}
