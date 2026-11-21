// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The measurement's view of this app. It is the one measurement file that differs between the two apps: run.mjs
// and report.mjs reach the app through it, and use the neutral word "type" for the kind of claim.
//
// Nothing of the app is loaded when this file is. The app is imported the first time classify, find or reply is
// called, and only in a process whose database address is the measurement's own, which no database answers.
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

// One reply, made as the app makes it for a visitor.
export async function reply(args) {
  const { answerUserQuestion } = await loadApp();
  return answerUserQuestion(args);
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

// The jobs the app gives a model. The small model does the first four; the answer model writes the reply and
// rewrites one the gate blocked.
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

// The job a model request is for, from the request's body.
export function jobOf(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const first = String(messages[0]?.content ?? '');
  const small = SMALL_JOB_OPENINGS.find(([opening]) => first.startsWith(opening));
  if (small) return small[1];
  return String(messages.at(-1)?.content ?? '').startsWith('COMPLIANCE GATEKEEPER') ? 'rewrite' : 'reply';
}
