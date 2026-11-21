// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Asks each model named on the command line whether it is in OpenAI's list, and whether it takes the three kinds
// of request the app sends, shaped as the app shapes them (requestFor in openaiModelFailover.js): a reply, a job
// that must answer in JSON, and a low-temperature rewrite. A model is measured only after it has passed this.
//
//   npm run models:probe -- [--yes] <model> [<model> ...]
//
// One line for each model: "<name>: reply ok | json ok | rewrite ok". In place of "ok":
//   FAILED <status> <code>  the request was refused
//   EMPTY                   the answer had no text (a reasoning model can spend its whole allowance thinking)
//   NOT JSON                the JSON job's answer is not a JSON object
// A second, indented line gives each request's time and tokens.
import { pathToFileURL } from 'node:url';
import { installGuard, withoutKeys } from './guard-fetch.mjs';
import { environmentFor } from './run.mjs';

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The three requests, as the app writes them before they are shaped for a model.
const REQUESTS = {
  reply: {
    messages: [
      { role: 'system', content: 'You answer questions for a legal information site in plain English, in two sentences.' },
      { role: 'user', content: 'What is a statute of limitations?' },
    ],
    temperature: 0.7,
    max_tokens: 1000,
  },
  json: {
    messages: [{ role: 'user', content: 'Respond ONLY with JSON, exactly this: {"ok": true}' }],
    response_format: { type: 'json_object' },
    max_tokens: 120,
  },
  rewrite: {
    messages: [
      { role: 'system', content: 'You rewrite sentences in plain English.' },
      { role: 'user', content: 'Rewrite: "The party of the first part shall indemnify the party of the second part."' },
    ],
    temperature: 0.2,
    max_tokens: 1000,
  },
};

// The three requests shaped for one model. `shape` is requestFor.
export function probeRequests(model, shape) {
  return Object.fromEntries(Object.entries(REQUESTS).map(([kind, request]) => [kind, shape(model, request)]));
}

// What a model made of one request, in a word.
export function outcome({ status, body }, { wantsJson = false } = {}) {
  if (status < 200 || status >= 300) return `FAILED ${status} ${body?.error?.code ?? body?.error?.type ?? 'unknown'}`;
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) return 'EMPTY';
  if (wantsJson) {
    try {
      const value = JSON.parse(text);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'NOT JSON';
    } catch {
      return 'NOT JSON';
    }
  }
  return 'ok';
}

export function probeLine(name, { reply, json, rewrite }) {
  return `${name}: reply ${reply} | json ${json} | rewrite ${rewrite}`;
}

async function ask(path, init) {
  const started = Date.now();
  const response = await fetch(`https://api.openai.com/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, body: await response.json().catch(() => null), ms: Date.now() - started };
}

async function main() {
  const argv = process.argv.slice(2);
  const yes = argv.includes('--yes');
  const models = argv.filter(arg => arg !== '--yes');
  if (!models.length || models.some(model => !MODEL_NAME.test(model))) {
    console.error('usage: npm run models:probe -- [--yes] <model> [<model> ...]');
    return 1;
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('probe: OPENAI_API_KEY is not set. Run this with npm run models:probe, which loads .env.');
    return 1;
  }
  console.log('Estimated cost of this run: under $0.25');
  if (!yes) {
    console.log('Nothing has been run. Add --yes to run it.');
    return 2;
  }

  // As in a measurement run: the settings, then the guard, then the app's request shaping.
  Object.assign(process.env, environmentFor({ answer: models[0], aux: models[0] }));
  const guard = installGuard({ allowHosts: ['api.openai.com'] });
  const { requestFor } = await import('../openaiModelFailover.js');

  for (const model of models) {
    try {
      const listed = await ask(`models/${encodeURIComponent(model)}`, { method: 'GET' });
      if (listed.status === 404) {
        console.log(`${model}: not in OpenAI's list`);
        continue;
      }
      if (listed.status !== 200) {
        console.log(`${model}: OpenAI's list could not be read (${listed.status} ${listed.body?.error?.code ?? ''})`.trim());
        continue;
      }
      const results = {};
      const details = [];
      for (const [kind, request] of Object.entries(probeRequests(model, requestFor))) {
        const answer = await ask('chat/completions', { method: 'POST', body: JSON.stringify(request) });
        results[kind] = outcome(answer, { wantsJson: kind === 'json' });
        const usage = answer.body?.usage;
        const thinking = usage?.completion_tokens_details?.reasoning_tokens;
        details.push(`${kind} ${(answer.ms / 1000).toFixed(1)}s` + (usage ? `, ${usage.prompt_tokens} in, ${usage.completion_tokens} out${thinking ? ` (${thinking} thinking)` : ''}` : '')
          + (answer.body?.choices?.[0]?.finish_reason === 'length' ? ', CUT OFF' : '')
          + (results[kind].startsWith('FAILED') && answer.body?.error?.message ? `: ${withoutKeys(answer.body.error.message).slice(0, 160)}` : ''));
      }
      console.log(probeLine(model, results));
      console.log(`  ${details.join('; ')}`);
    } catch (error) {
      console.log(`${model}: could not be asked (${withoutKeys(error?.message || error)})`);
    }
  }
  console.log(`refused: ${guard.refused.length ? [...new Set(guard.refused)].join(', ') : 'none'}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(withoutKeys(error?.stack || error));
    process.exitCode = 1;
  });
}
