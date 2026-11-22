// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The measurement's view of this app. It is the one measurement file that differs between the two apps: run.mjs
// and report.mjs reach the app through it, and use the neutral word "type" for the kind of claim.
//
// Nothing of the app is loaded when this file is. The app is imported the first time useModels, classify, find or
// reply is called, and only in a process whose database address is the measurement's own, which no database answers.
// With the fetch guard, that is what keeps a run away from the real database.
import { MEASURE_DATABASE_URL } from './guard-fetch.mjs';

export const APP = 'nycmalpractice';

// The modes whose replies are graded on a seminar rubric. This app has no seminar.
export const SEMINAR_MODES = [];

let loaded = null;
function loadApp() {
  if (process.env.DATABASE_URL !== MEASURE_DATABASE_URL) {
    return Promise.reject(new Error("measure: the app is loaded only in a measurement run, with the measurement's own database address set"));
  }
  loaded ??= import('../ask.js');
  return loaded;
}

// The models a run measures, which the runner hands over once the guard is installed: the answer chain for the reply
// and the rewrite, and the small chain for every other job, each the app's chain alone, so that no other model can
// answer. Each is a list of models in the order they are tried, or one model, which is a chain of one. The
// measurement's word for the small chain is "aux", as in its command and its recorded runs; the app's is "small".
export async function useModels({ answer, aux }) {
  await loadApp();
  const { useChainsForMeasurement } = await import('../model-settings.js');
  useChainsForMeasurement({ answer: [answer].flat(), small: [aux].flat() });
}

// The kind of claim a conversation is about, as the app's small model classifies it.
export async function classify(history, question) {
  const { classifyConversation } = await loadApp();
  const { caseType, terms } = await classifyConversation(history, question);
  return { type: caseType, terms };
}

// The kind of claim and the decisions CourtListener has for it: a live classification and a live search.
export async function find(history, question) {
  const { classifyAndSearch } = await loadApp();
  const { caseType, cases } = await classifyAndSearch(history, question);
  return { type: caseType, cases };
}

// The clock a visitor's reply is given (server.js): the reply deadline from now, less its reserve, and this app's
// limit for each model and job (models.js), so that what is measured is what runs. The clock's files are loaded
// only once the app may be: providers.js reaches the database's client as it loads.
export async function clockForTurn() {
  await loadApp();
  const [{ replyClock }, { limitFor, DEFAULT_ASK_REPLY_DEADLINE_MS, replyReserveMs }] = await Promise.all([import('../providers.js'), import('../models.js')]);
  return replyClock({ deadlineAt: Date.now() + DEFAULT_ASK_REPLY_DEADLINE_MS - replyReserveMs(DEFAULT_ASK_REPLY_DEADLINE_MS), limitFor });
}

// One reply, made as the app makes it for a visitor, with a clock of its own: a turn that is sent again starts
// a new one.
export async function reply(args) {
  const { answerUserQuestion } = await loadApp();
  return answerUserQuestion({ ...args, clock: await clockForTurn() });
}

// A recorded packet, in the words answerUserQuestion takes it in.
export function recordedFor({ type, cases, draft }) {
  return { caseType: type, cases, ...(draft === undefined ? {} : { draft }) };
}

// This app keeps no state between a visitor's turns.
export function stateFor() {
  return null;
}

// The first turn at which each side job is due: the lead score from the second message, the case card from the
// third (answerUserQuestion in ask.js).
export const SIDE_JOBS_FROM_TURN = { leadScore: 2, caseCard: 3 };

// The conversations set out in full for the owner to read: a sponge left in at a city hospital, a stroke sent
// home from a private emergency room, and a family whose mother died after an early discharge.
export const SAMPLE_VISITORS = ['marisol-sponge', 'er-stroke', 'sepsis-discharge'];

// The jobs the app gives a model, by the names its callers give runJob (providers.js), so that a call the
// measurement records and the job that made it are named alike. The small model does the first four; the answer
// model writes the reply and rewrites one the gate blocked.
export const SMALL_JOBS = ['classify', 'leadScore', 'caseCard', 'grade'];
export const REPLY_JOBS = ['reply', 'rewrite'];

// Each small job's prompt opens with words of its own; the rewrite is known by how its last message opens.
// Whatever is left is the reply.
const SMALL_JOB_OPENINGS = [
  ['Classify this NYC malpractice inquiry', 'classify'],
  ['You are a NYC medical malpractice case evaluator', 'leadScore'],
  ['You are a NYC medical malpractice case analyst', 'caseCard'],
  ['You are an uncompromising AI Compliance Gatekeeper', 'grade'],
];

// The words of a piece of a request, whether it is a string or blocks of text (Anthropic's `system` may be either).
function textOf(content) {
  if (Array.isArray(content)) return content.map(block => (typeof block === 'string' ? block : String(block?.text ?? ''))).join('');
  return String(content ?? '');
}

// The job a model request is for, from the request's body, in whichever provider's shape it was sent. The prompt of a
// small job opens its system text or its first message: OpenAI's and Google's requests carry a system message first,
// and Anthropic's carries the system text apart, as the top-level `system`. The rewrite's instruction is the last
// message in every shape (a system message at OpenAI, a user turn with the same words at Anthropic and Google).
export function jobOf(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const openings = [textOf(request?.system), textOf(messages[0]?.content)];
  const small = SMALL_JOB_OPENINGS.find(([opening]) => openings.some(text => text.startsWith(opening)));
  if (small) return small[1];
  return textOf(messages.at(-1)?.content).startsWith('COMPLIANCE GATEKEEPER') ? 'rewrite' : 'reply';
}
