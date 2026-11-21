// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// What a measurement run may reach. Everything the app sends (to OpenAI, to CourtListener, to the database) goes
// through global fetch, so replacing it is enough to hold a run to the hosts it was given: a request to any other
// host is refused before anything is sent. The local .env holds the real database address, and this is what
// keeps a run from ever touching it.
//
// It also keeps a record of each model call, for the cost, the timing and the checks in the report.
//
// Install it before any app module is imported: the OpenAI client keeps the fetch it finds when it is made.

const MODEL_HOST = 'api.openai.com';

// The database address a measurement run gives the app. No database answers at it.
export const MEASURE_DATABASE_URL = 'postgres://measure:measure@measure.invalid/none';

// A provider can quote a key back in an error ("Incorrect API key provided: sk-..."). Nothing shaped like one is
// kept in a run file or printed: OpenAI's keys, and the forty hexadecimal characters of a CourtListener token.
export function withoutKeys(text) {
  return String(text ?? '')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_*-]{8,}/g, '[key withheld]')
    .replace(/\b[0-9a-f]{40}\b/gi, '[key withheld]');
}

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
 * @param {Function} [options.fetchImpl] the fetch that allowed requests are sent with
 * @param {Function} [options.jobOf]     names the job a model request is for, from the request's body
 * @returns {{ calls: object[], failed: object[], refused: string[], restore: () => void }}
 *
 * calls: one entry for each model call that was answered: { host, model, inputTokens, outputTokens, ms }, with
 *   job           when jobOf was given and named one
 *   json          when the request asked for a JSON object: whether the answer's text is one
 *   finish        how the answer ended ("stop", or "length" when it was cut off)
 *   reasoningTokens  the part of outputTokens spent thinking, when there was any
 * The model is the name that was asked for, which is the name the price table knows; the answer may name a
 * snapshot of it.
 * failed: one entry for each model call that was refused or never answered: { host, model, job?, status | error, ms }.
 */
export function installGuard({ allowHosts, fetchImpl = globalThis.fetch, jobOf = null }) {
  const allowed = new Set(allowHosts);
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
    if (!allowed.has(host)) {
      refused.push(host);
      throw new Error(`measure: refused a request to ${host}`);
    }
    if (host !== MODEL_HOST) return fetchImpl(input, init);

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
      const choice = body.choices?.[0];
      const reasoningTokens = Number(body.usage.completion_tokens_details?.reasoning_tokens) || 0;
      calls.push({
        host,
        model: request?.model ?? body.model,
        inputTokens: Number(body.usage.prompt_tokens) || 0,
        outputTokens: Number(body.usage.completion_tokens) || 0,
        ms,
        ...jobFor(request),
        ...(request?.response_format?.type === 'json_object' ? { json: isJsonObject(choice?.message?.content) } : {}),
        ...(typeof choice?.finish_reason === 'string' ? { finish: choice.finish_reason } : {}),
        ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      });
    } else if (request && !response.ok) {
      failed.push({ host, model: request.model, ...jobFor(request), status: response.status, ms });
    }
    return response;
  };

  return { calls, failed, refused, restore() { globalThis.fetch = before; } };
}
