// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Asks each model named on the command line whether its provider lists it, and whether it takes the three kinds of
// request the app sends, sent through the provider's own adapter so that the probe tests exactly the requests production
// will send: a reply, a job that must answer in JSON (with its schema), and a low-temperature rewrite whose last
// message is a system instruction. A model is measured only after it has passed this. The content is synthetic.
//
//   npm run models:probe -- [--yes] <model> [<model> ...]
//
// Each model must be in the registry (model-registry.js), which says whose it is. One line for each model:
// "<name>: reply ok | json ok | rewrite ok". In place of "ok":
//   FAILED <status> <code>  the request was refused
//   EMPTY                   the answer had no text (a thinking model can spend its whole allowance thinking)
//   NOT JSON                the JSON job's answer is not a JSON object
//   CUT OFF                 the answer stopped at its length limit
// A second, indented line gives each request's time and tokens, and the raw usage numbers the provider's response carried
// (every numeric field of `usage`, so that thinking tokens can be told from the total). The ping, which production's health
// checks send, is asked last: "| ping ok".
import { pathToFileURL } from 'node:url';
import { installGuard, KEY_FOR, MODEL_HOSTS, withoutKeys } from './guard-fetch.mjs';
import { environmentFor } from './run.mjs';
import { SCHEMAS } from '../job-schemas.js';
import { entryFor, priceOn } from '../model-registry.js';

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The three providers' hosts, and no others: the guard's own list (measure/guard-fetch.mjs).
export const PROBE_HOSTS = MODEL_HOSTS;

// The three requests, as the app hands them to an adapter. The JSON one is the classifier's job, whose schema the app
// sends; the rewrite has the shape the gate gives it, the instruction last.
export const SHAPES = Object.freeze({
  reply: {
    job: 'reply',
    system: 'You answer questions for a legal information site in plain English, in two sentences.',
    messages: [{ role: 'user', content: 'What is a statute of limitations?' }],
    temperature: 0.7,
    maxTokens: 1000,
  },
  json: {
    job: 'classify',
    json: true,
    messages: [{ role: 'user', content: 'Classify this account as one type of injury claim and give the terms that decided it. Account: "I slipped on a wet floor in a shop." Respond only with JSON.' }],
    maxTokens: 120,
  },
  rewrite: {
    job: 'rewrite',
    temperature: 0.2,
    maxTokens: 1000,
    messages: [
      { role: 'system', content: 'You rewrite sentences in plain English.' },
      { role: 'user', content: 'Rewrite: "The party of the first part shall indemnify the party of the second part."' },
      { role: 'assistant', content: 'The first party will pay back the second party.' },
      { role: 'system', content: 'That draft was blocked for using the word "pay". Rewrite it without that word.' },
    ],
  },
});

export function parseProbeArgs(argv) {
  const yes = argv.includes('--yes');
  const models = argv.filter(arg => arg !== '--yes');
  if (!models.length || models.some(model => !MODEL_NAME.test(model))) {
    return { yes, models, problem: 'usage: npm run models:probe -- [--yes] <model> [<model> ...]' };
  }
  const unknown = models.find(model => !entryFor(model));
  return { yes, models, problem: unknown ? `probe: ${unknown} is not in the registry (model-registry.js). Add it there first.` : null };
}

// The most a run can cost, so that it is never a surprise: for each model every shape's whole allowance (thinking room
// included, 2,000 over each length) is spent, on a few hundred tokens of input, at the model's registry price. Rounded
// up to the cent.
// The ping is counted too: a short message and a few tokens of thinking room.
const WORST_INPUT_TOKENS = 3 * 300 + 20;
const WORST_OUTPUT_TOKENS = Object.values(SHAPES).reduce((sum, shape) => sum + shape.maxTokens + 2000, 0) + 2000;

export function probeCost(models, day = undefined) {
  const dollars = models.reduce((sum, model) => {
    const [input, output] = priceOn(model, day) ?? [20, 100];
    return sum + (WORST_INPUT_TOKENS * input + WORST_OUTPUT_TOKENS * output) / 1_000_000;
  }, 0);
  return Math.ceil(dollars * 100 - 1e-9) / 100;
}

export function probeLine(name, { reply, json, rewrite, ping }) {
  return `${name}: reply ${reply} | json ${json} | rewrite ${rewrite}${ping === undefined ? '' : ` | ping ${ping}`}`;
}

// The raw usage numbers each provider's response carried, which the adapters fold into two counts and so cannot show:
// every numeric field of its `usage` (nested ones as a.b), read from a copy of the response behind the guard. Numbers
// only: no text, no header and no name but the field's own. What was read is held until take() gives it, once.
function numbersOf(value, path = '') {
  if (typeof value === 'number' && Number.isFinite(value)) return [`${path}=${value}`];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, inner]) => numbersOf(inner, path ? `${path}.${key}` : key));
}

export function watchUsage({ fetchImpl }) {
  let latest = null;
  return {
    async fetch(input, init) {
      const response = await fetchImpl(input, init);
      let host = null;
      try {
        host = new URL(String(input?.url ?? input)).hostname;
      } catch {
        host = null;
      }
      if (PROBE_HOSTS.includes(host)) {
        const body = await response.clone().json().catch(() => null);
        const numbers = numbersOf(body?.usage ?? body?.usageMetadata);
        if (numbers.length) latest = `usage ${numbers.join(' ')}`;
      }
      return response;
    },
    take() {
      const taken = latest;
      latest = null;
      return taken;
    },
  };
}

// What a model made of one answer, in a word.
function wordFor(answer, wantsJson) {
  if (typeof answer?.text !== 'string' || !answer.text.trim()) return 'EMPTY';
  if (wantsJson) {
    try {
      const value = JSON.parse(answer.text);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'NOT JSON';
    } catch {
      return 'NOT JSON';
    }
  }
  return answer.cutOff ? 'CUT OFF' : 'ok';
}

function usageNote(watch) {
  const usage = watch.take();
  return usage ? `, ${usage}` : '';
}

function refusalWord(error) {
  const code = error?.code ?? error?.error?.code ?? error?.error?.type ?? error?.type;
  return `FAILED ${error?.status ?? error?.name ?? 'error'} ${code ?? 'unknown'}`;
}

// One model, through its provider's adapter. Resolves with { line, details?, results? }; never rejects, so that one
// model's trouble does not stop the others.
export async function probeModel(model, { adapters, signalFor = () => undefined, watch = { take: () => null } }) {
  const entry = entryFor(model);
  if (!entry) return { line: `${model}: not in the registry` };
  const adapter = adapters[entry.provider];
  if (!adapter) return { line: `${model}: no ${entry.provider} adapter (is ${KEY_FOR[entry.provider]} set?)` };
  try {
    let names;
    try {
      names = await adapter.listModels();
    } catch (error) {
      return { line: `${model}: ${entry.provider}'s list could not be read (${withoutKeys(error?.message || error).slice(0, 160)})` };
    }
    if (!names.includes(model)) return { line: `${model}: not in ${entry.provider}'s list` };
    const results = {};
    const details = [];
    for (const [kind, shape] of Object.entries(SHAPES)) {
      watch.take();
      const started = Date.now();
      const { job, json = false, system, messages, temperature, maxTokens } = shape;
      try {
        const answer = await adapter.call({
          model, entry, job, system, messages, json, maxTokens, temperature,
          schema: json ? SCHEMAS[job] : null,
          signal: signalFor(),
        });
        results[kind] = wordFor(answer, json);
        details.push(`${kind} ${((Date.now() - started) / 1000).toFixed(1)}s, ${answer?.inputTokens ?? 0} in, ${answer?.outputTokens ?? 0} out${usageNote(watch)}`);
      } catch (error) {
        results[kind] = refusalWord(error);
        details.push(`${kind} ${((Date.now() - started) / 1000).toFixed(1)}s: ${withoutKeys(error?.message || error).slice(0, 160)}${usageNote(watch)}`);
      }
    }
    // The health check, which production sends, and which none of the three shapes exercises.
    if (typeof adapter.ping === 'function') {
      watch.take();
      const started = Date.now();
      try {
        const cost = await adapter.ping(model, { signal: signalFor() });
        results.ping = 'ok';
        details.push(`ping ${((Date.now() - started) / 1000).toFixed(1)}s, ${cost?.inputTokens ?? 0} in, ${cost?.outputTokens ?? 0} out${usageNote(watch)}`);
      } catch (error) {
        results.ping = refusalWord(error);
        details.push(`ping ${((Date.now() - started) / 1000).toFixed(1)}s: ${withoutKeys(error?.message || error).slice(0, 160)}${usageNote(watch)}`);
      }
    }
    return { line: probeLine(model, results), details: details.join('; '), results };
  } catch (error) {
    return { line: `${model}: could not be asked (${withoutKeys(error?.message || error)})` };
  }
}

// The whole run, given its adapters. Returns the exit code: 0 done, 1 refused, 2 nothing run for want of --yes.
export async function runProbe({ argv, adapters, log = console.log, signalFor, watch }) {
  const { yes, models, problem } = parseProbeArgs(argv);
  if (problem) {
    log(problem);
    return 1;
  }
  log(`Estimated cost of this run: under $${probeCost(models).toFixed(2)}`);
  if (!yes) {
    log('Nothing has been run. Add --yes to run it.');
    return 2;
  }
  for (const model of models) {
    const { line, details } = await probeModel(model, { adapters, signalFor, watch });
    log(line);
    if (details) log(`  ${details}`);
  }
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const { models, problem } = parseProbeArgs(argv);
  if (problem) {
    console.error(problem);
    return 1;
  }
  const missing = [...new Set(models.map(model => entryFor(model).provider))].map(provider => KEY_FOR[provider]).filter(key => !process.env[key]);
  if (missing.length) {
    console.error(`probe: ${missing.join(', ')} is not set. Run this with npm run models:probe, which loads .env.`);
    return 1;
  }

  // As in a measurement run: the settings, then the guard, then the adapters, which are built here and not through
  // providers.js, so that nothing is loaded that reaches a database.
  Object.assign(process.env, environmentFor());
  const guard = installGuard({ allowHosts: [...PROBE_HOSTS] });
  // Behind the guard, so that only what the guard lets through is read: each response's usage numbers.
  const watch = watchUsage({ fetchImpl: globalThis.fetch });
  globalThis.fetch = watch.fetch;
  const [{ openaiAdapter }, { anthropicAdapter }, { googleAdapter }] = await Promise.all([
    import('../provider-openai.js'), import('../provider-anthropic.js'), import('../provider-google.js'),
  ]);
  const adapters = { openai: openaiAdapter(), anthropic: anthropicAdapter(), google: googleAdapter() };
  const code = await runProbe({ argv, adapters, signalFor: () => AbortSignal.timeout(60_000), watch });
  if (code === 0) console.log(`refused: ${guard.refused.length ? [...new Set(guard.refused)].join(', ') : 'none'}`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(withoutKeys(error?.stack || error));
    process.exitCode = 1;
  });
}
