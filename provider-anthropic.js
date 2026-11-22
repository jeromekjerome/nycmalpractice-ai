// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// Anthropic's Claude models, as providers.js asks them: one client, each job shaped into a Messages API request, and
// each answer read into the shape every adapter gives back. Written from the Claude API reference and the SDK's own
// types (@anthropic-ai/sdk), not from the OpenAI adapter's habits: the current Claude models take no temperature, no
// forced tool and no prefilled answer, their thinking is adaptive and its depth is set by an effort, and a refusal
// comes back as an ordinary answer whose stop reason is "refusal".
import Anthropic, { APIConnectionError } from '@anthropic-ai/sdk';

// A Claude model thinks before it writes, and what it spends thinking comes out of the same max_tokens as the answer,
// as a reasoning model's does at OpenAI. A call is given the job's own allowance and this much more to think in. A
// thinking model that spends it all gives no text, which runJob passes over as an empty answer.
const THINKING_HEADROOM_TOKENS = 2000;

// The Messages API requires max_tokens; a job that gives none is asked for this much.
const DEFAULT_OUTPUT_TOKENS = 4096;

// The health check: one short user message and the least output the API takes. Its effort is the lowest, so that the
// model spends nothing on thinking it will not be let to finish.
const PING = { messages: [{ role: 'user', content: 'health check' }], max_tokens: 1 };

// The SDK does not retry a call: the chain of models is the retry. Its own 30 seconds are only a backstop, since
// runJob gives each call a shorter limit and cuts it off through the signal. The client asks for the global fetch
// at each call, as the OpenAI adapter's does, because the measurement's guard and the tests' fake world replace the
// global fetch and it must not matter whether they do so before the client is made or after.
function newClient() {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 30_000,
    maxRetries: 0,
    fetch: (...args) => globalThis.fetch(...args),
  });
}

// The reply and the rewrite are asked at the entry's reply effort, every other job at its small effort. (The same
// rule as kindOf in providers.js, which this file cannot import without a cycle.)
function effortFor(entry, job) {
  return entry?.effort?.[job === 'reply' || job === 'rewrite' ? 'reply' : 'small'];
}

// What a job's messages become. The Messages API takes the system text apart, and a conversation of user and
// assistant turns that begins with the user's and ends with the user's: its first message must be the user's, and a
// request that ends with the assistant's turn is a prefill, which the current models refuse. The callers write
// OpenAI-style messages, in which a system message may come anywhere. The leading run of them (and the `system` given
// apart) is the top-level system text. One that comes after the conversation has begun, such as the instruction the
// gate puts after a blocked draft, becomes a user turn with the same words. Consecutive turns of one role are joined
// into one, with a blank line between, so that the turns alternate. No word of any prompt changes, but for one case:
// the assistant's turns before the user's first are left out. A conversation can begin so only when it is the
// history the page sent (used when the stored conversation cannot be read), cut to its last messages or sent wrong.
export function messagesFor({ system, messages }) {
  const leading = system ? [String(system)] : [];
  const turns = [];
  let begun = false;
  for (const { role, content } of messages ?? []) {
    if (role === 'system' && !begun) {
      leading.push(String(content));
      continue;
    }
    begun = true;
    const as = role === 'assistant' ? 'assistant' : 'user';
    const last = turns.at(-1);
    if (last?.role === as && typeof last.content === 'string' && typeof content === 'string') last.content = `${last.content}\n\n${content}`;
    else turns.push({ role: as, content });
  }
  while (turns[0]?.role === 'assistant') turns.shift();
  return { ...(leading.length ? { system: leading.join('\n\n') } : {}), messages: turns };
}

// The job's request, in the order it is written. The schema is copied, because the app's schemas are shared by every
// job and nothing done to a request may reach them. A JSON job with no schema is sent with no format: its prompt
// asks for JSON in words.
function jobRequest({ model, entry, job, system, messages, json, schema, maxTokens }) {
  const effort = effortFor(entry, job);
  const format = json && schema ? { type: 'json_schema', schema: structuredClone(schema) } : null;
  const outputConfig = { ...(effort ? { effort } : {}), ...(format ? { format } : {}) };
  return {
    model,
    max_tokens: (maxTokens ?? DEFAULT_OUTPUT_TOKENS) + THINKING_HEADROOM_TOKENS,
    ...messagesFor({ system, messages }),
    thinking: { type: 'adaptive' },
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
  };
}

// What the response says it cost: the input the model read, cached or not, and the output it wrote, thinking
// included.
// Exported with thinkingTokensOf for the measurement's guard (measure/guard-fetch.mjs), which reads each response with
// the rule of the adapter that asked for it.
export function tokensOf(usage) {
  return {
    inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
    outputTokens: usage?.output_tokens ?? 0,
  };
}

// The part of output_tokens spent thinking (the live probe: a rewrite's output_tokens 108 with thinking_tokens 93).
export function thinkingTokensOf(usage) {
  return Number(usage?.output_tokens_details?.thinking_tokens) || 0;
}

// A response that cannot be read is a connection that failed (see readable in provider-openai.js): the SDK's own
// APIConnectionError, which failureOf reads so. Only the SDK's call is read so: a TypeError in this file's own code
// is the fault it is.
async function readable(request) {
  try {
    return await request();
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) throw new APIConnectionError({ message: 'The response could not be read.', cause: error });
    throw error;
  }
}

// A response in the shape every adapter gives back. refused: stop reason "refusal" (an ordinary 200, with no text);
// cutOff: it stopped at its allowance, which thinking can spend and leave no text. Only text blocks are the answer.
function answerOf(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return {
    text: blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join(''),
    ...tokensOf(response?.usage),
    ...(response?.stop_reason === 'refusal' ? { refused: true } : {}),
    ...(response?.stop_reason === 'max_tokens' ? { cutOff: true } : {}),
  };
}

// `client` is for tests. Without one the adapter makes its own the first time it is used, not when this module is
// imported. Anthropic's own re-run of a refused request on another model (server-side fallbacks) is never asked for:
// the chain of models is the fallback.
export function anthropicAdapter(client = null) {
  let made = client;
  const anthropic = () => (made ??= newClient());
  return {
    name: 'anthropic',
    host: 'api.anthropic.com',
    async call({ model, entry, job, system, messages, json, schema, maxTokens, signal }) {
      const body = jobRequest({ model, entry, job, system, messages, json, schema, maxTokens });
      const client = anthropic();
      return answerOf(await readable(() => client.messages.create(body, signal ? { signal } : undefined)));
    },
    // What the caps reserve: exactly the max_tokens the request asks for.
    allowance({ job, maxTokens }) {
      return job === 'health' ? PING.max_tokens : (maxTokens ?? DEFAULT_OUTPUT_TOKENS) + THINKING_HEADROOM_TOKENS;
    },
    // Resolves with what the check cost once the model answers, whatever it said, which at one token is nothing
    // (stop reason max_tokens). The signal cuts the check off when its time runs out.
    async ping(model, { signal } = {}) {
      const body = { model, ...PING, output_config: { effort: 'low' } };
      return tokensOf(await readable(() => anthropic().messages.create(body, signal ? { signal } : undefined)).then(response => response?.usage));
    },
    async listModels() {
      const names = [];
      for await (const model of anthropic().models.list()) names.push(model.id);
      return names;
    },
  };
}
