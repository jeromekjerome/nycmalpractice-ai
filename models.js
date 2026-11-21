// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The models this app calls, in one place. Each job has a chain: the main model, then its fallbacks in order
// (openaiModelFailover.js walks it). The names used to be repeated in ask.js, auction.js, courtlistener.js and
// server.js, so changing a model meant four edits that had to agree.
//
//   answer     the reply a visitor reads, and the rewrite of a reply the gate blocked
//   aux        the small jobs: classifying the case, the lead score, the case card, grading a reply
//   embedding  not used by any feature today; only the health check calls it
//
// The environment may replace a chain's main model (OPENAI_MODEL_ANSWER, OPENAI_MODEL_AUX,
// OPENAI_MODEL_EMBEDDING) and its fallbacks (the same names with _FALLBACKS, comma separated). A fallback list
// that names only the main model gives a chain of one.
//
// The answer and aux defaults are the owner's choice of 21 November 2026, made from the measurement in
// docs/measurements/ and written down, with the reasons, in measure/chosen.json; test/models.test.mjs holds the
// three together.
// They replaced gpt-4o and gpt-4o-mini (fallbacks gpt-4.1 and gpt-4.1-mini), which OpenAI shuts down on
// 14 January 2027. To change a model, measure it first (npm run models:measure) and record the new choice.
import { buildModelList } from './openaiModelFailover.js';

export const DEFAULTS = Object.freeze({
  answer: Object.freeze(['gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.4-mini']),
  aux: Object.freeze(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-5.4-mini']),
  embedding: Object.freeze(['text-embedding-3-small', 'text-embedding-3-large']),
});

const ENV_NAMES = { answer: 'OPENAI_MODEL_ANSWER', aux: 'OPENAI_MODEL_AUX', embedding: 'OPENAI_MODEL_EMBEDDING' };

function chain(env, name) {
  const [main, ...fallbacks] = DEFAULTS[name];
  return buildModelList(env[ENV_NAMES[name]] || main, env[`${ENV_NAMES[name]}_FALLBACKS`] || fallbacks.join(','));
}

export function chainsFromEnv(env = process.env) {
  return { answer: chain(env, 'answer'), aux: chain(env, 'aux'), embedding: chain(env, 'embedding') };
}

const chains = chainsFromEnv();
export const ANSWER_MODELS = chains.answer;
export const AUX_MODELS = chains.aux;
export const EMBEDDING_MODELS = chains.embedding;
