// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// OpenAI, as providers.js asks it: one client, each request shaped for the model it goes to, and each answer read
// into the shape every adapter gives back.
import OpenAI, { APIConnectionError } from 'openai';
import { entryFor } from './model-registry.js';

// GPT-5 and later, and the o-series, are reasoning models: they take max_completion_tokens instead of max_tokens,
// accept only the default temperature, and spend part of that allowance thinking before they write. Every call
// here was written for gpt-4o, so a fallback to such a model failed with a 400 and the chain stopped there: gpt-4.1
// behind it was never tried. The request is adapted to the model it goes to.
//
// The registry says which models are reasoning models. A name it does not know, as the probe of a model not yet in
// the registry gives (measure/probe-shapes.mjs), is judged by its name as it was before the registry: gpt-5 and every
// later number (gpt-6.2-sol, gpt-10), not gpt-5 alone, because a later name the pattern missed was sent a gpt-4o
// request, which that model refuses.
const REASONING_NAME = /^(?:gpt-(?:[5-9]|\d{2,})|o\d)/i;
const REASONING_HEADROOM_TOKENS = 2000;

export function isReasoningModel(model) {
  const entry = entryFor(model);
  return entry ? entry.reasoning === true : REASONING_NAME.test(String(model || ''));
}

export function requestFor(model, request) {
  if (!isReasoningModel(model)) return { model, ...request };
  const { max_tokens: maxTokens, temperature, ...rest } = request;
  return {
    model,
    ...rest,
    ...(maxTokens != null && rest.max_completion_tokens == null ? { max_completion_tokens: maxTokens + REASONING_HEADROOM_TOKENS } : {}),
    reasoning_effort: rest.reasoning_effort ?? 'low',
  };
}

// The health check: the smallest request a chat model takes, or the embeddings endpoint for an embedding model.
const CHAT_PING = { messages: [{ role: 'user', content: 'health check' }], max_tokens: 1, temperature: 0 };
const EMBEDDING_PING = 'health check';

// The SDK does not retry a call: the chain of models is the retry. Its own 30 seconds are only a backstop, since
// runJob gives each call a shorter limit and cuts it off through the signal. The client asks for the global fetch
// at each call instead of keeping the one it finds when it is made, because the measurement's guard and the tests'
// fake world replace the global fetch, and it must not matter whether they do so before the client is made or
// after.
function newClient() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 30_000,
    maxRetries: 0,
    fetch: (...args) => globalThis.fetch(...args),
  });
}

// A job's request before it is shaped for the model, its keys in the order the callers have always written them,
// so that the body that leaves the app is the text it was. A setting the job does not give is left out.
function jobRequest({ system, messages, json, maxTokens, temperature }) {
  return {
    messages: system ? [{ role: 'system', content: system }, ...messages] : messages,
    ...(json ? { response_format: { type: 'json_object' } } : {}),
    ...(temperature != null ? { temperature } : {}),
    ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
  };
}

// What the response says it cost. Exported with thinkingTokensOf for the measurement's guard (measure/guard-fetch.mjs),
// which reads each response with the rule of the adapter that asked for it.
export function tokensOf(usage) {
  return { inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0 };
}

// The part of the output a reasoning model spent thinking, which completion_tokens already holds.
export function thinkingTokensOf(usage) {
  return Number(usage?.completion_tokens_details?.reasoning_tokens) || 0;
}

// A response that cannot be read is a connection that failed. When the connection drops after the headers have
// come, the SDK passes on the TypeError fetch raises; when the body is cut short or is not JSON, the SyntaxError
// of reading it. Each becomes the SDK's own APIConnectionError, which failureOf reads as a failed connection, so
// that the next model is asked. Only the SDK's call is read so: a TypeError in this file's own code is the fault
// it is.
async function readable(request) {
  try {
    return await request();
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) throw new APIConnectionError({ message: 'The response could not be read.', cause: error });
    throw error;
  }
}

// A completion in the shape every adapter gives back. refused: the model declined; cutOff: it stopped at its
// allowance, which a reasoning model can spend thinking and leave no text.
function answerOf(completion) {
  const choice = completion?.choices?.[0];
  const content = choice?.message?.content;
  return {
    text: typeof content === 'string' ? content : '',
    ...tokensOf(completion?.usage),
    ...(choice?.message?.refusal ? { refused: true } : {}),
    ...(choice?.finish_reason === 'length' ? { cutOff: true } : {}),
  };
}

// `client` is for tests. Without one the adapter makes its own the first time it is used, not when this module is
// imported.
export function openaiAdapter(client = null) {
  let made = client;
  const openai = () => (made ??= newClient());
  return {
    name: 'openai',
    host: 'api.openai.com',
    async call({ model, system, messages, json, maxTokens, temperature, signal }) {
      const body = requestFor(model, jobRequest({ system, messages, json, maxTokens, temperature }));
      const client = openai();
      return answerOf(await readable(() => client.chat.completions.create(body, signal ? { signal } : undefined)));
    },
    // What the caps reserve: the output this adapter will ask for, the job's own and, for a reasoning model, the
    // room it is given to think.
    allowance({ model, entry, job, maxTokens }) {
      if (job === 'health' && entry?.embedding) return 0;
      const shaped = requestFor(model, job === 'health' ? CHAT_PING : { max_tokens: maxTokens });
      return shaped.max_completion_tokens ?? shaped.max_tokens;
    },
    // Resolves with what the check cost once the model answers, whatever it said. The signal cuts the check off
    // when its time runs out.
    async ping(model, { signal } = {}) {
      const options = signal ? { signal } : undefined;
      if (entryFor(model)?.embedding) {
        const response = await openai().embeddings.create({ model, input: EMBEDDING_PING }, options);
        return { inputTokens: response?.usage?.prompt_tokens ?? 0, outputTokens: 0 };
      }
      return tokensOf((await openai().chat.completions.create(requestFor(model, CHAT_PING), options))?.usage);
    },
    async listModels() {
      const names = [];
      for await (const model of openai().models.list()) names.push(model.id);
      return names;
    },
  };
}
