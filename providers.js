// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The one place that asks a model to do a job. A caller names the job and the chain of models to try in order,
// and gets back the text, what it cost in tokens, and which provider and model wrote it; no caller reads a
// provider's own response again. Each provider has an adapter that shapes the request for it
// (provider-openai.js, provider-anthropic.js, provider-google.js). Models are named by the callers' chains and the registry (model-registry.js), never here.
//
// A model that fails in one of the ways failureOf knows (it timed out, refused the key, is gone, gave no answer)
// is passed over for the next in the chain. Anything else is a fault in the app and is rethrown at once. Every
// attempt goes through the spending caps (ai-budget.js).
//
// Every call has a time limit, and a call that runs past it is a timeout whether or not its provider ever answers.
// The calls of one reply share that reply's clock (replyClock): each is given its model's limit for the job, or
// what is left of the reply's time if that is less. A provider that fails once in the reply goes last for the
// rest of it: every other provider's models are asked before its own. So when another provider can answer, a
// provider that hangs costs a reply one wait, not one wait for every call; and a chain of one provider is still
// walked in order, so that a passing failure does not cost the reply its other models.
//
// What one reply learns of a provider is kept for every reply in the provider state (provider-state.js), which the
// app sets up once (configureProviders). A provider marked down there is asked after every other provider, and still
// asked when none of them answers: a provider is never dropped, so that a false alarm cannot stop a reply. When a
// reply ends, the state is told of each provider it asked: a reply is a success for a provider that answered any of
// its jobs, whatever failed beside, and a failure for one that answered none after failing through its own fault.
// Running out of the reply's time is no fault of the provider's.
//
// An adapter is { name, host, call, ping, listModels, allowance }:
//   call({ model, entry, job, system, messages, json, schema, maxTokens, temperature, signal })
//                 -> { text, inputTokens, outputTokens, refused?: true, cutOff?: true }
//   ping(model, { signal })  sends the smallest request the model takes, and resolves with { inputTokens,
//                 outputTokens } once it answers, so that the caps record what the check cost
//   listModels()  the names of the models the provider offers
//   allowance({ model, entry, job, maxTokens })  the output tokens the adapter will ask for, which is what the caps
//                 reserve. An adapter without it is taken to ask for maxTokens.
// `signal` fires when the call's time runs out. The adapter hands it to its provider's client, so that the
// request is cut off and not left running.
import { runWithAiBudget } from './ai-budget.js';
import { entryFor, providerOf } from './model-registry.js';
import { openaiAdapter } from './provider-openai.js';
import { anthropicAdapter } from './provider-anthropic.js';
import { googleAdapter } from './provider-google.js';
import { SCHEMAS } from './job-schemas.js';
import { withoutKeys } from './without-keys.js';

// The reply a visitor reads and the rewrite of one the gate blocked are reply jobs; every other job, the health
// check included, is small.
export function kindOf(job) {
  return job === 'reply' || job === 'rewrite' ? 'reply' : 'small';
}

// The most a model is ever given for one job (the design, section 2): 20 seconds for a reply or a rewrite, 8 for
// any other job. An app's measured limits stay under these; a call with no clock, and a model the app has no
// limit for, are given them.
const CAP_MS = Object.freeze({ reply: 20_000, small: 8_000 });

export function capFor(job) {
  return CAP_MS[kindOf(job)];
}

// With less of the reply's time left than this, no call is started: the job fails at once as out of time, and
// nothing is sent or reserved.
export const MIN_TIME_LEFT_MS = 500;

// The failures that say a provider cannot take this reply's requests just now: it is not answering, is refusing
// us, or is being sent what it cannot take. A provider that fails so goes last for the rest of the reply. A model
// that is gone, a refusal and an empty answer are about one model or one request, and move nothing.
export const PROVIDER_FAILURES = new Set(['timeout', 'connection', 'rate_limit', 'server', 'auth', 'quota', 'bad_request']);

/**
 * One reply's clock, which every model call of the reply is given.
 * @param {object} options
 * @param {number} options.deadlineAt   when the reply is due, in the time `now` reads
 * @param {Function} [options.now]
 * @param {Function} [options.limitFor]  (model, job) -> ms, the app's own measured limit. For a model or job it gives
 *   no usable limit for, and with no limitFor at all, the cap for the job's kind; and never more than the cap.
 * @returns {{ remaining(): number, demote(provider): void, demoted(provider): boolean, answered(provider, state): void,
 *   failed(provider, failure, state): void, end(): Promise<void>, limitFor(model, job): number }}
 *   demote puts a provider last for the rest of the reply (inTurn); demoted says whether it has been. answered and
 *   failed are what runJob tells the clock for the provider state (provider-state.js): that a provider answered a job
 *   of the reply, or failed in a way that counts against it. end() ends the reply for the state; it never rejects.
 */
export function replyClock({ deadlineAt, now = Date.now, limitFor = null }) {
  const sentBack = new Set();
  // What the reply learns of each provider, for its state: whether the provider answered a job, its first failure
  // that counts against it, and the ping started at that failure.
  const learned = new Map();
  let ended = null;
  const about = (provider, state) => {
    if (!learned.has(provider)) learned.set(provider, { state, answered: false, failure: null, pinged: null });
    return learned.get(provider);
  };
  // The reply is over. Each provider is told once: as answered when it answered any job of the reply, whatever failed
  // beside, or as failed when it answered none. A ping still running is waited for as well, so that its call through
  // the caps finishes before the response is sent.
  const tellEach = () => Promise.all([...learned].map(async ([provider, { state, answered, failure, pinged }]) => {
    if (answered) await asking(() => state.replySucceeded(provider));
    else if (failure) await asking(() => state.replyFailed(provider, { reason: failure.reason, markDownNow: failure.markDownNow, pinged }));
    await pinged;
  })).then(() => {});
  return {
    remaining: () => Math.max(0, deadlineAt - now()),
    demote: provider => { sentBack.add(provider); },
    demoted: provider => sentBack.has(provider),
    answered: (provider, state) => {
      if (!ended) about(provider, state).answered = true;
    },
    // The first such failure is kept. Its ping starts at once, so that it runs beside the rest of the reply, unless
    // what it says can no longer matter: the provider has answered already, or the failure (a refused key, a spent
    // quota) marks it down without a ping.
    failed: (provider, failure, state) => {
      if (ended) return;
      const known = about(provider, state);
      if (known.failure) return;
      known.failure = failure;
      if (!known.answered && !failure.markDownNow) known.pinged = asking(() => state.ping(provider));
    },
    // Once: a second call, or one made after the reply has ended, waits for the same telling.
    end: () => (ended ??= tellEach()),
    limitFor: (model, job) => {
      const measured = limitFor?.(model, job);
      return Number.isFinite(measured) && measured > 0 ? Math.min(measured, capFor(job)) : capFor(job);
    },
  };
}

// What the provider state is asked, which can never fail the reply: a failure is logged, and gives null. The state's
// own words are of the database, but are cleaned all the same.
function asking(work) {
  return new Promise(resolve => resolve(work())).catch(error => {
    console.warn(`[AI] The provider state failed: ${withoutKeys(error?.message ?? error)}`);
    return null;
  });
}

// A name the registry does not know is taken to be OpenAI's, as every name was before the registry. No chain the app
// runs with can hold one (model-settings.js refuses it, and gives the built-in chains for a saved row that names one),
// so only the stand-in names of tests reach this.
export function providerOfModel(model) {
  return providerOf(model) ?? 'openai';
}

// The order a chain's models are asked in during a reply: the models of providers that have not failed in the
// reply first, then those of providers that have, then those of providers marked down (`down`, from the provider
// state), each group in the chain's own order. A provider marked down is asked last, never dropped. With no clock
// and nothing down, or when no provider in the chain has failed, it is the chain's own order; a chain of one
// provider keeps its order.
export function inTurn(chain, clock = null, providerFor = providerOfModel, down = new Set()) {
  const group = model => {
    const provider = providerFor(model);
    if (down.has(provider)) return 2;
    return clock?.demoted(provider) ? 1 : 0;
  };
  return [0, 1, 2].flatMap(place => chain.filter(model => group(model) === place));
}

// How an attempt reads in a message: its failure's reason, or "no time left" when the reply's time ran out on it.
const howItFailed = ({ failure, outOfTime }) => (outOfTime ? 'no time left' : failure.reason);

// No model in the chain answered. Each one tried is in `attempts`, in order, with how it failed.
export class ProvidersFailed extends Error {
  constructor(job, attempts) {
    const tried = attempts.map(attempt => `${attempt.model} (${howItFailed(attempt)})`).join(', ');
    super(`No model answered the ${job} job: ${tried || 'the chain names none'}.`);
    this.name = 'ProvidersFailed';
    this.code = 'ai_unavailable';
    this.attempts = attempts;
  }
}

// How an attempt ends when its time runs out before its adapter answers.
class TimeLimitReached extends Error {
  constructor(ms) {
    super(`No answer within ${ms} ms.`);
    this.name = 'TimeLimitReached';
  }
}

export { withoutKeys };

// How the owner is told when a provider refuses a request, and the provider state (provider-state.js). The app sets
// both once (configureProviders), so that this module needs no code of the app's: with nothing set, nobody is told
// and every provider counts as up, as in a measurement run. A job given a `tell` or a `state` of its own in its deps
// uses that instead.
let configuredTell = null;
let configuredState = null;
export function configureProviders({ tell = null, state = null } = {}) {
  configuredTell = typeof tell === 'function' ? tell : null;
  configuredState = state ?? null;
}

const TOLD_MESSAGE_CHARS = 300;

// A failure that sends the job on to the next model. markDownNow: the provider will answer nobody until someone
// acts (its key was refused, its quota is spent). tellOwner: our request was probably shaped wrong for it.
function failure(reason) {
  return { reason, next: true, markDownNow: reason === 'auth' || reason === 'quota', tellOwner: reason === 'bad_request' };
}

// A reached spending cap carries status 503, but it is no failure of the provider's, and no other model may be
// tried.
const BUDGET_CODES = new Set(['ai_budget_exceeded', 'ai_budget_unavailable']);

// The names of the classes an error belongs to. The SDKs tell a call that timed out, one that never connected and
// one whose caller gave up apart by class alone (APIConnectionTimeoutError, APIConnectionError, APIUserAbortError,
// in both the OpenAI and the Anthropic SDK, whose source was read for this: @anthropic-ai/sdk 1.12.0 names them
// the same, and its abort error is no kind of connection error); none of these has a status.
function classesOf(error) {
  const names = new Set();
  for (let proto = Object.getPrototypeOf(Object(error)); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    names.add(proto.constructor?.name);
  }
  return names;
}

// A field of the provider's error, which the SDK copies from the error in the response's body.
function errorField(error, field) {
  return String(error?.[field] ?? error?.error?.[field] ?? '').toLowerCase();
}

function errorFailure(error) {
  if (BUDGET_CODES.has(error?.code)) return null;
  if (error instanceof TimeLimitReached) return failure('timeout');
  const classes = classesOf(error);
  // Nothing aborts a call but its time running out, so an abort is a timeout. The timeout class is itself a kind
  // of connection error, so it is asked about first.
  if (classes.has('APIConnectionTimeoutError') || classes.has('APIUserAbortError')) return failure('timeout');
  if (classes.has('APIConnectionError')) return failure('connection');
  const status = error?.status;
  if (!Number.isInteger(status)) return null;
  // An exhausted quota comes as a 429, as a rate limit does, and only its code tells it apart: insufficient_quota at
  // OpenAI, quota_exceeded (the daily quota used up) at Google, whose per-minute limit is rate_limit_exceeded. At
  // Anthropic an exhausted balance is a 402 of type billing_error, and at Google a depleted prepaid balance is a 402.
  if (errorField(error, 'code') === 'insufficient_quota' || errorField(error, 'type') === 'insufficient_quota' || errorField(error, 'code') === 'quota_exceeded') return failure('quota');
  if (status === 402 || errorField(error, 'type') === 'billing_error') return failure('quota');
  if (status === 404 || status === 410 || ['model_not_found', 'deprecated_model'].includes(errorField(error, 'code'))) return failure('gone');
  // A request too large (413) is as wrong as a malformed one: no other model is the cure.
  if (status === 400 || status === 413) return failure('bad_request');
  if (status === 401 || status === 403) return failure('auth');
  if (status === 408 || status === 429) return failure('rate_limit');
  if (status >= 500 && status <= 599) return failure('server');
  return null;
}

function answerFailure(answer) {
  if (answer?.refused) return failure('refusal');
  // An answer cut off at its limit is still an answer if it has text. A reasoning model that spent its whole
  // allowance thinking has none.
  if (typeof answer?.text !== 'string' || !answer.text.trim()) return failure('empty');
  return null;
}

// What an adapter's error (thrown) or answer (returned) means for the job: null when the answer stands, or when the
// error is no failure of the provider's and must be rethrown; otherwise the failure, which moves the job on.
export function failureOf(errorOrResult) {
  return errorOrResult instanceof Error ? errorFailure(errorOrResult) : answerFailure(errorOrResult);
}

let builtIn = null;
// The adapters a job is run with unless it is given others. Made on first use, so that importing this module
// makes no client.
function adaptersByDefault() {
  return (builtIn ??= adaptersFor(process.env));
}

// OpenAI's adapter always; Anthropic's and Google's only when their keys are set, so that nothing asks Claude or Gemini
// until the owner adds the key.
// A model of a provider with no adapter is passed over (see runJob).
export function adaptersFor(env) {
  return { openai: openaiAdapter(), ...(env?.ANTHROPIC_API_KEY ? { anthropic: anthropicAdapter() } : {}), ...(env?.GEMINI_API_KEY ? { google: googleAdapter() } : {}) };
}

// Sets a limit running: runOut is called once `ms` have passed, unless the limit is cancelled first.
function startTimer(ms, runOut) {
  const timer = setTimeout(runOut, ms);
  return () => clearTimeout(timer);
}

// What `ask` answers, or TimeLimitReached once `ms` have passed, whichever comes first. `ask` is handed the signal
// that fires at the limit, for its provider's request; the job does not wait on an adapter that does not heed it,
// and an answer that comes after the limit is let go. With no time at all, nothing is asked.
function withinLimit(ms, timer, ask) {
  if (ms <= 0) return Promise.reject(new TimeLimitReached(0));
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const cancel = timer(ms, () => {
      reject(new TimeLimitReached(ms));
      controller.abort();
    });
    new Promise(answer => answer(ask(controller.signal))).then(resolve, reject).finally(cancel);
  });
}

// job       'reply', 'rewrite', 'health', or the name of a small job (job-schemas.js holds each one's schema)
// chain     the models to try, in order
// messages  [{ role, content }] as the caller writes them. A system message may come anywhere (the rewrite puts
//           its instruction last), and an adapter passes the order on as its provider takes it. `system`, when
//           given, is a system message put first.
// clock     the reply's clock (replyClock), shared by every call of the reply. Without one, as for the health
//           check, each call is given the cap for its job's kind, the chain is asked in its own order, and the
//           provider state is neither asked nor told anything.
// deps      { adapters, budget, now, timer, providerFor, tell, state }, each with a default; tests pass fakes.
//           providerFor names the provider a model is asked through (the registry's, by default). tell and state
//           default to what configureProviders set.
//
// A health check ('health') pings each model instead of asking it anything, and passes when one answers.
//
// With a clock and a provider state, the job asks the state once, before its first model, which providers of its
// chain are marked down, and asks their models last. It tells the clock which providers answered and which failed in
// a way that counts against them; the clock starts a provider's ping at its first such failure (state.ping), and
// tells the state when the reply ends (clock.end()): state.replySucceeded(provider) for a provider that answered any
// job of the reply, and state.replyFailed(provider, { reason, markDownNow, pinged }) for one that answered none. An
// attempt the reply's time ran out on (outOfTime: true) is no failure of the provider's: it was made with under
// MIN_TIME_LEFT_MS left, or was given only what was left of the clock and cut off at it, or its reservation took what
// was left so that nothing was sent. It neither sends the provider to the back nor counts against it.
//
// When a provider answers 400 (it refused a request the app sent it), deps.tell is called with
// { kind: 'bad_request', provider, model, job, status, code, message }: the provider's own message without any key,
// cut to 300 characters, and nothing of the request. A tell that fails is ignored, and the job ends only once
// every tell has finished, so that a serverless host does not suspend one half-sent.
export async function runJob(request, deps = {}) {
  const told = [];
  try {
    return await attemptJob(request, deps, told);
  } finally {
    await Promise.allSettled(told);
  }
}

async function attemptJob({ job, chain, system, messages, json = false, maxTokens, temperature, clock = null }, deps, told) {
  const { tell = configuredTell, state = configuredState, adapters = adaptersByDefault(), budget = runWithAiBudget, now = Date.now, timer = startTimer, providerFor = providerOfModel } = deps;
  const health = job === 'health';
  const schema = Object.hasOwn(SCHEMAS, job) ? SCHEMAS[job] : null;
  const asSent = system ? [{ role: 'system', content: system }, ...(messages ?? [])] : (messages ?? []);
  const attempts = [];
  let lastError = null;

  // Only a reply's jobs ask and tell the provider state. A call with no clock, such as the health check and the ping
  // the state itself sends, is never counted, and never takes the one request let through to a provider marked down.
  const watched = clock && state ? state : null;
  const down = watched ? await downAmong(chain, watched, providerFor) : new Set();

  // The models not yet asked, kept in the chain's order. Each next one is the first of them in turn (inTurn), so
  // that a provider that has failed in the reply, in an earlier job or earlier in this chain, comes after the
  // others, and the rest of the chain is ordered as a later job's would be.
  const untried = [...chain];
  while (untried.length) {
    const [model] = inTurn(untried, clock, providerFor, down);
    untried.splice(untried.indexOf(model), 1);
    const entry = entryFor(model);
    const provider = providerFor(model);
    const adapter = adapters[provider];
    // No adapter: the provider's key is not set here. Nothing was asked, so nothing is reserved, the provider is not
    // blamed, and the next model is tried.
    if (!adapter) {
      attempts.push({ provider, model, ms: 0, failure: failure('auth') });
      console.warn(`[AI] ${job} skipped "${model}": there is no ${provider} adapter.${untried.length ? ' Trying the next model.' : ''}`);
      continue;
    }
    // Too little of the reply is left for this model or any after it. The provider is not to blame, and keeps its
    // place.
    if (clock && clock.remaining() < MIN_TIME_LEFT_MS) {
      attempts.push({ provider, model, ms: 0, failure: failure('timeout'), outOfTime: true });
      break;
    }
    // The caps' records keep the names the health checks have always had.
    const operation = health ? (entry?.embedding ? 'health.embedding' : 'health.chat') : job;
    const allowance = typeof adapter.allowance === 'function' ? adapter.allowance({ model, entry, job, maxTokens }) : maxTokens;
    const started = now();
    let failed;
    // Whether the call was given what was left of the reply's clock, which was less than its model's own limit.
    let givenWhatWasLeft = false;
    let outOfTime = false;
    try {
      const answer = await budget({
        operation,
        model,
        request: { messages: asSent, max_tokens: allowance },
        // The answer comes back through the caps with its tokens, so that what the attempt cost is recorded even
        // when it is judged a failure below: a refusal or an empty answer is paid for.
        execute: async () => {
          // The limit is read when the model is asked, after the caps' reservation: the limits are measured on the
          // model's own calls, and the reservation's time comes out of the reply's clock, not after its end.
          const own = clock ? clock.limitFor(model, job) : capFor(job);
          const left = clock ? clock.remaining() : Infinity;
          givenWhatWasLeft = left < own;
          const given = (await withinLimit(Math.min(own, left), timer, signal => (health
            ? adapter.ping(model, { signal })
            : adapter.call({ model, entry, job, system, messages, json, schema, maxTokens, temperature, signal })))) ?? {};
          return { ...given, usage: { inputTokens: given.inputTokens ?? 0, outputTokens: given.outputTokens ?? 0 } };
        },
      });
      failed = health ? null : answerFailure(answer);
      if (!failed) {
        attempts.push({ provider, model, ms: now() - started });
        if (watched) clock.answered(provider, watched);
        return {
          text: health ? '' : answer.text,
          inputTokens: answer?.usage?.inputTokens ?? 0,
          outputTokens: answer?.usage?.outputTokens ?? 0,
          provider,
          model,
          attempts,
        };
      }
    } catch (error) {
      if (BUDGET_CODES.has(error?.code)) throw error;
      failed = errorFailure(error);
      if (!failed) throw error;
      lastError = error;
      // Cut off at what was left of the reply's clock, not at the model's own limit: the reply ran out of time.
      outOfTime = givenWhatWasLeft && error instanceof TimeLimitReached;
    }
    const attempt = { provider, model, ms: now() - started, failure: failed, ...(outOfTime ? { outOfTime } : {}) };
    attempts.push(attempt);
    if (failed.tellOwner && tell) {
      const note = { kind: 'bad_request', provider, model, job, status: lastError?.status ?? null, code: errorField(lastError, 'code') || errorField(lastError, 'type') || null, message: withoutKeys(lastError?.message).slice(0, TOLD_MESSAGE_CHARS) };
      told.push(new Promise(resolve => resolve(tell(note))).catch(error => console.warn(`[AI] telling the owner of the ${provider} 400 failed: ${withoutKeys(error?.message)}`)));
    }
    const demoting = Boolean(clock) && !outOfTime && PROVIDER_FAILURES.has(failed.reason) && !clock.demoted(provider);
    if (demoting) {
      clock.demote(provider);
      // The provider's first failure in the reply that is its own fault.
      if (watched) clock.failed(provider, { reason: failed.reason, markDownNow: failed.markDownNow }, watched);
    }
    // The job, the model and the reason only: what a provider says in its error can quote a key back. A provider
    // sent to the back is said so once, at the failure that sent it; the last failure is the caller's to report.
    if (demoting || untried.length) {
      console.warn(`[AI] ${job} failed on "${model}" (${howItFailed(attempt)}).${demoting ? ` ${provider} goes last for the rest of this reply.` : ''}${untried.length ? ' Trying the next model.' : ''}`);
    }
  }

  // Every model refused the request as malformed, so the request itself is wrong, and its 400 is what the caller
  // must see. It is marked first (allRefused), so that a caller can tell it from a 400 of any other origin.
  if (attempts.length && attempts.every(({ failure: { reason } }) => reason === 'bad_request')) {
    lastError.allRefused = true;
    throw lastError;
  }
  throw new ProvidersFailed(job, attempts);
}

// The providers of a chain that the state says are marked down. Each is asked once, before the job's first model, so
// that a provider let through for one request (provider-state.js) keeps its usual place for the whole of this job.
// A state that cannot answer counts every provider as up.
async function downAmong(chain, state, providerFor) {
  const providers = [...new Set(chain.map(providerFor))];
  const verdicts = await Promise.all(providers.map(provider => new Promise(resolve => resolve(state.isDown(provider))).catch(() => false)));
  return new Set(providers.filter((provider, index) => verdicts[index] === true));
}

// Each provider that has an adapter, and its state for the health page: 'up', or { downSince, reason } while it is
// marked down (the provider state's snapshot). With no state, or one that cannot be read, every provider is up.
export async function providerStates({ state = configuredState, adapters = adaptersByDefault() } = {}) {
  const marked = state ? await new Promise(resolve => resolve(state.snapshot())).catch(() => ({})) : {};
  return Object.fromEntries(Object.keys(adapters).map(name => {
    const down = marked?.[name];
    return [name, down ? { downSince: down.downSince, reason: down.reason } : 'up'];
  }));
}

// The models each of `providers` offers today, as its adapter lists them (listModels), for the check of a chain before
// it is saved (model-settings.js): { [provider]: names }, with null for a provider that has no adapter here or whose
// list could not be read. What the provider said is logged without any key, cut to 300 characters.
export async function modelsOffered(providers, { adapters = adaptersByDefault() } = {}) {
  const lists = await Promise.all(providers.map(async provider => {
    const adapter = Object.hasOwn(adapters, provider) ? adapters[provider] : null;
    if (typeof adapter?.listModels !== 'function') return null;
    try {
      const names = await adapter.listModels();
      return Array.isArray(names) ? names.filter(name => typeof name === 'string') : null;
    } catch (error) {
      console.warn(`[AI] The list of models ${provider} offers could not be read: ${withoutKeys(error?.message ?? error).slice(0, TOLD_MESSAGE_CHARS)}`);
      return null;
    }
  }));
  return Object.fromEntries(providers.map((provider, at) => [provider, lists[at]]));
}

// The provider state's ping (provider-state.js), the one small request a failed reply sends its provider: a health
// check of the provider's main model, the first of its models in `chains`. It goes through the caps like any other
// call, and has no clock, so that it is never itself counted. It resolves to true when the model answered, and to
// false when the provider failed it as a reply's call counts against a provider (PROVIDER_FAILURES). A reached cap, a
// model that is gone and a fault in the app say nothing of the provider, and resolve to true.
export function providerPing(chains, deps = {}) {
  const providerFor = deps.providerFor ?? providerOfModel;
  return async provider => {
    const model = chains.flat().find(name => providerFor(name) === provider);
    if (!model) return true;
    try {
      await runJob({ job: 'health', chain: [model] }, deps);
      return true;
    } catch (error) {
      if (error?.allRefused === true) return false;
      return !(error instanceof ProvidersFailed && error.attempts.some(({ failure: failed }) => PROVIDER_FAILURES.has(failed.reason)));
    }
  };
}
