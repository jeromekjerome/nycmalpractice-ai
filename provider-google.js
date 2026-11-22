// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Google's Gemini models, as providers.js asks them, through Google's OpenAI-compatible endpoint with the openai SDK
// (https://ai.google.dev/gemini-api/docs/openai, read 2026-11-21). One client, each job shaped into a chat completions
// request, and each answer read into the shape every adapter gives back. Every difference from the OpenAI adapter is
// kept explicit below, with what Google's documentation says or, where it is silent, that it is silent.
import OpenAI, { APIConnectionError } from 'openai';
import { messagesFor } from './provider-anthropic.js';
import { entryFor } from './model-registry.js';

// The compatibility page's base address. It ends with a slash, as in its samples.
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

// Gemini 3 thinks before it writes and cannot be told not to ("Reasoning cannot be turned off for Gemini 2.5 Pro,
// Gemini 3, or Gemini 4 models"), and the thinking page says the output limit counts thought tokens ("If the model hits
// the limit while reasoning, the output may be truncated or empty"). So a call is given the job's own allowance and this
// much more to think in, as the OpenAI adapter does for a reasoning model. A model that spends it all gives no text,
// which runJob passes over as an empty answer.
const THINKING_HEADROOM_TOKENS = 2000;

// The length field is max_tokens: the compatibility page names no length field, and the SDK's chat completions take
// this one (the probe checks that Google honours it).
const DEFAULT_OUTPUT_TOKENS = 4096;

// The health check: one short user message and the least output the API takes.
const PING = { messages: [{ role: 'user', content: 'health check' }], max_tokens: 1 };

// The SDK does not retry a call: the chain of models is the retry. Its own 30 seconds are only a backstop, since
// runJob gives each call a shorter limit and cuts it off through the signal. The client asks for the global fetch at
// each call, as the other adapters' do, because the measurement's guard and the tests' fake world replace it.
function newClient() {
  return new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: BASE_URL,
    timeout: 30_000,
    maxRetries: 0,
    fetch: (...args) => globalThis.fetch(...args),
  });
}

// `reasoning_effort` is the compatibility page's setting for thinking ("minimal, low, medium, high"; "low" is
// supported by both of the models here). The reply and the rewrite are asked at the entry's reply effort, every other
// job at its small effort (the rule of kindOf in providers.js, which this file cannot import without a cycle).
function effortFor(entry, job) {
  return entry?.effort?.[job === 'reply' || job === 'rewrite' ? 'reply' : 'small'];
}

// The job's request. No temperature: Google's own pages never recommend one for Gemini 3, and its troubleshooting page
// says a temperature, top_p or top_k "may be returned as 400 for Gemini 4 and 3.6+ models", so none is sent, as at
// OpenAI and Anthropic today. No store field: neither the compatibility page nor the generateContent reference
// documents one. The system text is one leading system message and a later system message becomes a user turn (Gemini
// has a single system instruction; the page says nothing of a later one), so the request ends with the user's turn.
// A JSON job with a schema is asked for as a json_schema response format, the form the openai SDK's own structured
// output helpers send and the compatibility page uses in its samples. The schema is copied, because the app's schemas
// are shared by every job and nothing done to a request may reach them.
function jobRequest({ model, entry, job, system, messages, json, schema, maxTokens }) {
  const { system: systemText, messages: turns } = messagesFor({ system, messages });
  const effort = effortFor(entry, job);
  return {
    model,
    messages: systemText ? [{ role: 'system', content: systemText }, ...turns] : turns,
    ...(json ? { response_format: schema ? { type: 'json_schema', json_schema: { name: job, strict: true, schema: structuredClone(schema) } } : { type: 'json_object' } } : {}),
    max_tokens: (maxTokens ?? DEFAULT_OUTPUT_TOKENS) + THINKING_HEADROOM_TOKENS,
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

// What the response says it cost. Google bills thinking as output ("Output price (including thinking tokens)"). The live
// probe of 2026-11-21 showed that the compatible endpoint reports thinking only inside total_tokens: completion_tokens
// leaves it out and there is no completion_tokens_details (a gemini-3.8-flash rewrite: completion 12, prompt 56, total
// 435, billed 379 as output). So the output is the total less the prompt, and never less than the completion tokens plus
// any reasoning tokens a response does report (which are then not added twice). With no total, those two are summed.
// Exported with thinkingTokensOf for the measurement's guard (measure/guard-fetch.mjs), which reads each response with
// the rule of the adapter that asked for it.
export function tokensOf(usage) {
  const prompt = usage?.prompt_tokens ?? 0;
  const reported = (usage?.completion_tokens ?? 0) + (usage?.completion_tokens_details?.reasoning_tokens ?? 0);
  const total = usage?.total_tokens;
  return {
    inputTokens: prompt,
    outputTokens: Number.isFinite(total) ? Math.max(total - prompt, reported) : reported,
  };
}

// The part of the output spent thinking: what the output holds beyond the text's own completion tokens.
export function thinkingTokensOf(usage) {
  return Math.max(0, tokensOf(usage).outputTokens - (usage?.completion_tokens ?? 0));
}

// A response that cannot be read is a connection that failed (see readable in provider-openai.js).
async function readable(request) {
  try {
    return await request();
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) throw new APIConnectionError({ message: 'The response could not be read.', cause: error });
    throw error;
  }
}

// A completion in the shape every adapter gives back. cutOff: it stopped at its allowance, which thinking can spend and
// leave no text. A blocked answer has no text, and is an empty answer to failureOf.
function answerOf(completion) {
  const choice = completion?.choices?.[0];
  const content = choice?.message?.content;
  return {
    text: typeof content === 'string' ? content : '',
    ...tokensOf(completion?.usage),
    ...(choice?.finish_reason === 'length' ? { cutOff: true } : {}),
  };
}

// `client` is for tests. Without one the adapter makes its own the first time it is used, not when this module is
// imported.
export function googleAdapter(client = null) {
  let made = client;
  const google = () => (made ??= newClient());
  return {
    name: 'google',
    host: 'generativelanguage.googleapis.com',
    async call({ model, entry, job, system, messages, json, schema, maxTokens, signal }) {
      const body = jobRequest({ model, entry, job, system, messages, json, schema, maxTokens });
      const client = google();
      return answerOf(await readable(() => client.chat.completions.create(body, signal ? { signal } : undefined)));
    },
    // What the caps reserve: exactly the max_tokens the request asks for.
    allowance({ job, maxTokens }) {
      return job === 'health' ? PING.max_tokens : (maxTokens ?? DEFAULT_OUTPUT_TOKENS) + THINKING_HEADROOM_TOKENS;
    },
    // Resolves with what the check cost once the model answers, whatever it said. The signal cuts the check off when
    // its time runs out.
    async ping(model, { signal } = {}) {
      const effort = effortFor(entryFor(model), 'health');
      const body = { model, ...PING, ...(effort ? { reasoning_effort: effort } : {}) };
      return tokensOf((await readable(() => google().chat.completions.create(body, signal ? { signal } : undefined)))?.usage);
    },
    // Google names a model "models/<name>" in its own list; the registry's names have no prefix.
    async listModels() {
      const names = [];
      for await (const model of google().models.list()) names.push(String(model.id).replace(/^models\//, ''));
      return names;
    },
  };
}
