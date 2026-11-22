// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The models this app calls, in one place: the built-in chains, and each model's time limit for each job. A chain
// is the main model, then its fallbacks in order (runJob in providers.js walks it).
//
//   answer     the reply a visitor reads, and the rewrite of a reply the gate blocked
//   small      the small jobs: classifying the case, the lead score, the case card, grading a reply
//   embedding  not used by any feature today; only the health check calls it
//
// The chains each job runs with are a setting the owner saves from the admin page, kept in the database and checked
// before it is saved (model-settings.js); every job asks for them as it starts. These built-in chains stand behind
// that setting: they are used until chains are saved, and whenever the saved ones cannot be read or name a model
// the registry no longer has. The embedding chain is no setting: the health check alone uses it.
//
// The answer and small defaults are the owner's choice of 21 November 2026, made from the measurement in
// docs/measurements/ and written down, with the reasons, in measure/chosen.json; test/models.test.mjs holds the
// three together.
// They replaced gpt-4o and gpt-4o-mini (fallbacks gpt-4.1 and gpt-4.1-mini), which OpenAI shuts down on
// 14 January 2027. To change a model, measure it first (npm run models:measure) and record the new choice.
import { capFor } from './providers.js';

export const DEFAULTS = Object.freeze({
  answer: Object.freeze(['gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.4-mini']),
  small: Object.freeze(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-5.4-mini']),
  embedding: Object.freeze(['text-embedding-3-small', 'text-embedding-3-large']),
});

// The longest a visitor waits for a reply, 45 seconds unless ASK_REPLY_DEADLINE_MS says otherwise (server.js).
// Every model call of the reply shares this time, and the measurement gives each turn the same (measure/app.mjs).
export const DEFAULT_ASK_REPLY_DEADLINE_MS = 45_000;

// The reply's clock ends this long before the reply's deadline: a tenth of the deadline, never more than a second
// and a half (1,500 ms of today's 45 seconds). A step of the gate that is cut off at the clock's end then leaves
// the gate this long to grade and repair the drafted reply by code, before the visitor is told to send the
// message again.
export function replyReserveMs(deadlineMs) {
  return Math.min(Math.floor(deadlineMs / 10), 1_500);
}

// How long each model is given for each job before the job moves on to the next model, in milliseconds.
// Each is twice the slowest tenth of the model's measured times for the job, rounded up to the next 100 ms, and
// never more than the cap for the job's kind: 8 seconds for a small job, 20 for a reply or a rewrite
// (providers.js). A job with fewer than ten measured calls is given, for the rewrite, the model's limit for the
// reply, and otherwise the cap.
//
// Worked out on 22 November 2026 by npm run models:report (it prints them) from this app's runs of plan 2, in
// measure/results/: providers-1 to providers-3 and small-luna-1 to small-luna-3 (gpt-6.1-terra and gpt-6-luna), and
// the candidates' runs reply-claude-haiku-5-5, reply-claude-sonnet-5-5-low, reply-gemini-3.8-flash,
// reply-gemini-3.5-flash-lite, small-claude-haiku-5-5 and small-gemini-3.5-flash-lite. Every one of them ran at the
// effort its registry entry records (model-registry.js). A job a candidate was not timed for is left out of its entry,
// and is given the cap. Exceptions, from this app's runs of plan 1: gpt-6-luna's reply and rewrite limits
// (reply-gpt-6-luna), since plan 2 asked it only for the small jobs; gpt-6.1-terra's small-job limits
// (small-gpt-6.1-terra), since plan 2 gave it only the reply and the rewrite; and gpt-5.4-mini's entry, not measured
// again. A model this app has not measured, claude-opus-5-5 among them, is given the cap. Re-measure a model before
// changing its limits.
const limits = {
  'gpt-6.1-terra': { reply: 13_800, rewrite: 12_500, classify: 4_500, leadScore: 7_400, caseCard: 8_000, grade: 8_000 },
  'gpt-6-luna': { reply: 14_600, rewrite: 14_600, classify: 4_300, leadScore: 8_000, caseCard: 8_000, grade: 8_000 },
  'gpt-5.4-mini': { reply: 10_100, rewrite: 10_100, classify: 2_400, leadScore: 5_400, caseCard: 6_000, grade: 6_100 },
  'claude-haiku-5-5': { reply: 20_000, rewrite: 20_000, classify: 4_700, leadScore: 8_000, caseCard: 8_000, grade: 8_000 },
  'claude-sonnet-5-5': { reply: 20_000, rewrite: 20_000 },
  'gemini-3.8-flash': { reply: 20_000, rewrite: 20_000 },
  'gemini-3.5-flash-lite': { reply: 13_600, rewrite: 13_600, classify: 1_500, leadScore: 2_000, caseCard: 2_800, grade: 3_400 },
};
export const LIMITS_MS = Object.freeze(Object.fromEntries(Object.entries(limits).map(([model, jobs]) => [model, Object.freeze(jobs)])));

// A model's limit for a job. A model the measurement has not timed is given the cap for the job's kind.
export function limitFor(model, job) {
  return Object.hasOwn(LIMITS_MS, model) && Object.hasOwn(LIMITS_MS[model], job) ? LIMITS_MS[model][job] : capFor(job);
}
