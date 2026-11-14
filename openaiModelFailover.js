function splitFallbacks(csv = '') {
  return csv
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

export function buildModelList(primary, fallbackCsv = '') {
  const ordered = [primary, ...splitFallbacks(fallbackCsv)].filter(Boolean);
  return [...new Set(ordered)];
}

function buildHealthShape(models, active) {
  return {
    active,
    fallbacks_available: models.filter((m) => m !== active),
  };
}

function isMissingOrDeprecatedModelError(error) {
  const status = error?.status;
  const code = String(error?.code || error?.error?.code || '').toLowerCase();

  if (status === 404 || status === 410) return true;

  return code === 'model_not_found' || code === 'deprecated_model';
}

function isTransientError(error) {
  const status = error?.status;
  if (status === 408 || status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  return false;
}

// A model that refuses a parameter of the request (a 400 unsupported_parameter or unsupported_value) is passed
// over for the next one rather than ending the chain.
function isUnsupportedRequestError(error) {
  const code = String(error?.code || error?.error?.code || '').toLowerCase();
  return error?.status === 400 && (code === 'unsupported_parameter' || code === 'unsupported_value');
}

function shouldTryFallback(error, hasMoreModels) {
  if (!hasMoreModels) return false;
  return isMissingOrDeprecatedModelError(error) || isTransientError(error) || isUnsupportedRequestError(error);
}

// GPT-5 and o-series models are reasoning models: they take max_completion_tokens instead of max_tokens, accept
// only the default temperature, and spend part of that allowance thinking before they write. Every call here was
// written for gpt-4o, so a fallback to such a model failed with a 400 and the chain stopped there: gpt-4.1 behind
// it was never tried. The request is adapted to the model it goes to.
const REASONING_MODEL = /^(gpt-5|o\d)/i;
const REASONING_HEADROOM_TOKENS = 2000;

export function requestFor(model, request) {
  if (!REASONING_MODEL.test(model)) return { model, ...request };
  const { max_tokens: maxTokens, temperature, ...rest } = request;
  return {
    model,
    ...rest,
    ...(maxTokens != null && rest.max_completion_tokens == null ? { max_completion_tokens: maxTokens + REASONING_HEADROOM_TOKENS } : {}),
    reasoning_effort: rest.reasoning_effort ?? 'low',
  };
}

export async function chatCompletionsWithFallback(openai, { models, ...request }) {
  let lastError;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      return await openai.chat.completions.create(requestFor(model, request));
    } catch (error) {
      lastError = error;
      const hasMoreModels = i < models.length - 1;
      if (!shouldTryFallback(error, hasMoreModels)) throw error;
      console.warn(`[AI] chat.completions failed on "${model}": ${error.message}. Trying fallback...`);
    }
  }

  throw lastError;
}

export async function embeddingsWithFallback(openai, { models, ...request }) {
  let lastError;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    try {
      return await openai.embeddings.create({
        model,
        ...request,
      });
    } catch (error) {
      lastError = error;
      const hasMoreModels = i < models.length - 1;
      if (!shouldTryFallback(error, hasMoreModels)) throw error;
      console.warn(`[AI] embeddings failed on "${model}": ${error.message}. Trying fallback...`);
    }
  }

  throw lastError;
}

export async function probeChatModelChain(openai, models) {
  let lastError;

  for (const model of models) {
    try {
      // The same adaptation the real calls get, so the probe reports what a call would find.
      await openai.chat.completions.create(requestFor(model, {
        messages: [{ role: 'user', content: 'health check' }],
        max_tokens: 1,
        temperature: 0,
      }));
      return buildHealthShape(models, model);
    } catch (error) {
      lastError = error;
      console.warn(`[Health] chat model probe failed on "${model}": ${error.message}`);
    }
  }

  console.error(`[Health] chat model chain has no callable model: ${lastError?.message || 'unknown error'}`);
  return buildHealthShape(models, null);
}

export async function probeEmbeddingModelChain(openai, models) {
  let lastError;

  for (const model of models) {
    try {
      await openai.embeddings.create({
        model,
        input: 'health check',
      });
      return buildHealthShape(models, model);
    } catch (error) {
      lastError = error;
      console.warn(`[Health] embedding model probe failed on "${model}": ${error.message}`);
    }
  }

  console.error(`[Health] embedding model chain has no callable model: ${lastError?.message || 'unknown error'}`);
  return buildHealthShape(models, null);
}

export async function probeAllModelChains(openai, { answerModels, auxModels, embeddingModels }) {
  const [answer, aux, embedding] = await Promise.all([
    probeChatModelChain(openai, answerModels),
    probeChatModelChain(openai, auxModels),
    probeEmbeddingModelChain(openai, embeddingModels),
  ]);

  return { answer, aux, embedding };
}
