// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// What a measurement run may reach. Everything the app sends (to OpenAI, to CourtListener, to the database) goes
// through global fetch, so replacing it is enough to hold a run to the hosts it was given: a request to any other
// host is refused before anything is sent. The local .env holds the real database address, and this is what
// keeps a run from ever touching it.
//
// It also keeps a record of each model call, for the cost, the timing and the checks in the report.
//
// Install it before any app module is imported: a client that keeps the fetch it finds when it is made would keep the real one.

import { withoutKeys } from '../without-keys.js';
import { MEASURE_DATABASE_URL } from '../measure-address.js';
import { tokensOf as openaiTokens, thinkingTokensOf as openaiThinking } from '../provider-openai.js';
import { tokensOf as anthropicTokens, thinkingTokensOf as anthropicThinking } from '../provider-anthropic.js';
import { tokensOf as googleTokens, thinkingTokensOf as googleThinking } from '../provider-google.js';

// The three providers' model hosts, and no others: the one list a run, the probe and the tools that ask a model
// are held to. Which of them a run may reach is what it is given (allowHosts); a call to any of these is recorded.
export const MODEL_HOSTS = Object.freeze(['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com']);

// The setting that holds each provider's key, by the provider's name in the registry.
export const KEY_FOR = Object.freeze({ openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GEMINI_API_KEY' });

// How to read a request to and a response from each host. The token rules are the adapters' own (each provider's
// usage means something different, and a second copy of a rule would drift from the one the caps are counted by).
// Google's endpoint is shaped like OpenAI's chat completions; Anthropic's is the Messages API.
const CHAT_SHAPE = {
  text: body => body?.choices?.[0]?.message?.content,
  finish: body => body?.choices?.[0]?.finish_reason,
  asksForJson: request => ['json_object', 'json_schema'].includes(request?.response_format?.type),
};
const ANTHROPIC_FINISHES = { max_tokens: 'length', end_turn: 'stop', refusal: 'refusal' };
const READERS = {
  'api.openai.com': { ...CHAT_SHAPE, tokens: openaiTokens, thinking: openaiThinking },
  'generativelanguage.googleapis.com': { ...CHAT_SHAPE, tokens: googleTokens, thinking: googleThinking },
  'api.anthropic.com': {
    tokens: anthropicTokens,
    thinking: anthropicThinking,
    // The answer is the text blocks; a thinking block is no part of it.
    text: body => (Array.isArray(body?.content) ? body.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') : undefined),
    // The word the report already reads: "length" for an answer cut off at its allowance.
    finish: body => (typeof body?.stop_reason === 'string' ? (ANTHROPIC_FINISHES[body.stop_reason] ?? body.stop_reason) : undefined),
    asksForJson: request => request?.output_config?.format?.type === 'json_schema',
  },
};

// The text of a model's answer, from the response body of the given host. For the tools that show what a model said.
export function answerTextOf(host, body) {
  const text = READERS[host]?.text(body);
  return typeof text === 'string' ? text : undefined;
}

// The database address a measurement run gives the app, which no database answers at. It is kept in
// measure-address.js, a file that imports nothing, and not in the app's model settings, which read the database.
export { MEASURE_DATABASE_URL };

// Nothing shaped like a key is kept in a run file or printed (without-keys.js). It is imported from there and not
// from providers.js, which would reach the database before this guard is installed.
export { withoutKeys };

function hostOf(input) {
  try {
    return new URL(typeof input === 'string' ? input : (input?.url ?? String(input))).hostname;
  } catch {
    return null;
  }
}

// The body of a request, when it is JSON that names a model: a model call. Anything else is null.
function modelRequest(init) {
  try {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : 'null');
    return typeof body?.model === 'string' && body.model ? body : null;
  } catch {
    return null;
  }
}

function isJsonObject(text) {
  try {
    const value = JSON.parse(String(text ?? ''));
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {string[]} options.allowHosts  the only hosts a request may go to
 * @param {string[]} [options.blockHosts] hosts refused whatever allowHosts says: the failover runs block a provider's host, so that the
 *                                       app's next provider has to answer. A model call to one is kept in `failed`, as a connection that never was
 * @param {Function} [options.fetchImpl] the fetch that allowed requests are sent with
 * @param {Function} [options.jobOf]     names the job a model request is for, from the request's body
 * @returns {{ calls: object[], failed: object[], refused: string[], restore: () => void }}
 *
 * calls: one entry for each model call that was answered: { host, model, inputTokens, outputTokens, ms }, with
 *   job           when jobOf was given and named one
 *   json          when the request asked for JSON (a json_object or json_schema format, or Anthropic's json_schema output
 *                 format): whether the answer's text is a JSON object
 *   finish        how the answer ended ("stop", "length" when it was cut off, "refusal"; Anthropic's words are put into these)
 *   reasoningTokens  the part of outputTokens spent thinking, when there was any
 * The model is the name that was asked for, which is the name the price table knows; the answer may name a
 * snapshot of it. Each count is read as the provider of the host reports it (the adapters' own rules).
 * failed: one entry for each model call that was refused or never answered: { host, model, job?, status | error, ms }.
 */
export function installGuard({ allowHosts, blockHosts = [], fetchImpl = globalThis.fetch, jobOf = null }) {
  const allowed = new Set(allowHosts);
  const blocked = new Set(blockHosts);
  const calls = [];
  const failed = [];
  const refused = [];
  const before = globalThis.fetch;

  const jobFor = request => {
    if (!request || typeof jobOf !== 'function') return {};
    try {
      const job = jobOf(request);
      return typeof job === 'string' && job ? { job } : {};
    } catch {
      return {};
    }
  };

  globalThis.fetch = async (input, init) => {
    const host = hostOf(input);
    if (host === null) {
      refused.push('(unreadable)');
      throw new Error('measure: refused a request to an address it could not read');
    }
    if (blocked.has(host)) {
      refused.push(host);
      const request = modelRequest(init);
      const error = `measure: refused a request to ${host}, which this run blocks`;
      if (request) failed.push({ host, model: request.model, ...jobFor(request), error, ms: 0 });
      throw new Error(error);
    }
    if (!allowed.has(host)) {
      refused.push(host);
      throw new Error(`measure: refused a request to ${host}`);
    }
    const reader = READERS[host];
    if (!reader) return fetchImpl(input, init);

    const request = modelRequest(init);
    const started = Date.now();
    let response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      if (request) failed.push({ host, model: request.model, ...jobFor(request), error: withoutKeys(error?.message || error), ms: Date.now() - started });
      throw error;
    }

    // A copy is read, so the caller still gets the whole answer.
    const body = await response.clone().json().catch(() => null);
    const ms = Date.now() - started;
    if (body?.usage) {
      const finish = reader.finish(body);
      const reasoningTokens = reader.thinking(body.usage);
      calls.push({
        host,
        model: request?.model ?? body.model,
        ...reader.tokens(body.usage),
        ms,
        ...jobFor(request),
        ...(reader.asksForJson(request) ? { json: isJsonObject(reader.text(body)) } : {}),
        ...(typeof finish === 'string' ? { finish } : {}),
        ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      });
    } else if (request && !response.ok) {
      failed.push({ host, model: request.model, ...jobFor(request), status: response.status, ms });
    }
    return response;
  };

  return { calls, failed, refused, restore() { globalThis.fetch = before; } };
}
