// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import OpenAI from 'openai';
import { searchMalpracticeCases, extractCaseType } from './courtlistener.js';
import { rememberCases, recallCases } from './case-memory.js';
import { scoreLead } from './auction.js';
import { buildModelList, chatCompletionsWithFallback } from './openaiModelFailover.js';
import { evaluateAndRemediateDraft, renderRubricForPrompt, renderCurrentLawForPrompt } from './gatekeeper.js';

// Each AI call is cut off after 30 seconds and retried once; it could wait 10 minutes.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 1 });
const ANSWER_MODELS = buildModelList(
  process.env.OPENAI_MODEL_ANSWER || 'gpt-4o',
  process.env.OPENAI_MODEL_ANSWER_FALLBACKS || 'gpt-5.4-mini,gpt-4.1'
);
const AUX_MODELS = buildModelList(
  process.env.OPENAI_MODEL_AUX || 'gpt-4o-mini',
  process.env.OPENAI_MODEL_AUX_FALLBACKS || 'gpt-5.4-mini,gpt-4.1'
);

const CASE_TYPE_NAMES = {
  surgical_error:      'Surgical Error / Operating Room Negligence',
  misdiagnosis:        'Failure to Diagnose / Misdiagnosis',
  medication_error:    'Medication / Prescription Error',
  birth_injury:        'Birth Injury',
  anesthesia_error:    'Anesthesia Error',
  hospital_negligence: 'Hospital Negligence',
  nursing_home:        'Nursing Home Neglect',
  dental:              'Dental Malpractice',
  other:               'Medical Malpractice',
};

const NO_CASES_CONTEXT = 'No specific cases retrieved. Apply general NYS medical malpractice principles under CPLR §214-a.';

// What the case card reads: every message the visitor wrote, oldest first (they hold the facts), then the end of
// the AI's last reply for context. It used to read the last 3,000 characters of the whole conversation, and from
// the fourth message on the AI's long replies pushed the visitor's own facts out.
export function analysisTranscript(history, question, { visitorChars = 4000, replyChars = 600 } = {}) {
  const said = [...(history || []).filter(h => h.role === 'user').map(h => String(h.content ?? '')), String(question ?? '')];
  const lines = said.map((text, i) => `Visitor message ${i + 1}: ${text}`);
  // Over the limit, messages from the middle go first: the first one (what happened) and the latest stay.
  while (lines.join('\n').length > visitorChars && lines.length > 2) lines.splice(1, 1);
  let visitor = lines.join('\n');
  if (visitor.length > visitorChars) visitor = visitor.slice(0, visitorChars / 2) + '\n…\n' + visitor.slice(-visitorChars / 2);
  const lastReply = [...(history || [])].reverse().find(h => h.role === 'assistant');
  const reply = lastReply ? String(lastReply.content ?? '') : '';
  return visitor + (reply ? `\n\nThe end of the AI's last reply, for context only:\n${reply.length > replyChars ? '…' + reply.slice(-replyChars) : reply}` : '');
}

// The side analyses (lead score, case card, seminar score) get 20 seconds; one that takes longer is left out of
// this reply rather than holding back an answer that is ready. Each AI call alone may take 30 seconds and a retry.
const DEFAULT_SIDE_CALL_CAP_MS = 20_000;
function sideCall(work) {
  if (!work) return null;
  let timer;
  const late = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), Number(process.env.ASK_SIDE_CALL_CAP_MS) || DEFAULT_SIDE_CALL_CAP_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
const NATIONAL_FALLBACK_NOTE =
  'NOTE: No New York decisions matched this search. The cases below come from a national search and may be ' +
  'from other jurisdictions — treat them as persuasive authority only and do not present them as New York law.';
const RECALLED_NOTE =
  'NOTE: The case law search could not be run just now. The cases below were found earlier for this type of ' +
  'claim and were not matched to these facts; use them only as general examples of how New York courts decide such claims.';

function buildCaseContext(cases, { recalled = false } = {}) {
  if (!cases || cases.length === 0) return NO_CASES_CONTEXT;

  const blocks = cases.map(c => {
    const citations = [...new Set([...(c.citations || []), c.citation].filter(Boolean))];
    return (
      `Case: ${c.caseName}\n` +
      (citations.length ? `Citation: ${citations.join('; ')}\n` : '') +
      (c.court    ? `Court: ${c.court}\n`        : '') +
      (c.dateFiled? `Filed: ${c.dateFiled}\n`    : '') +
      (c.snippet  ? `Excerpt: ${c.snippet}`      : '')
    );
  }).join('\n\n');

  const notes = [recalled && RECALLED_NOTE, cases.some(c => c.scope === 'national') && NATIONAL_FALLBACK_NOTE].filter(Boolean);
  return [...notes, blocks].join('\n\n');
}

// allowLeadScoring is false when the conversation could not be read from the server's record: a lead is
// scored only on a history the server can vouch for.
export async function answerUserQuestion({ question, mode = 'personal', sessionId, history, allowLeadScoring = true }) {
  // The conversation step: the number of the visitor's own message. The history also holds the AI's
  // replies, so counting every message ran steps 1, 3, 5 and skipped steps 2 and 4.
  const turn = history.filter(h => h.role === 'user').length + 1;

  const fullText       = history.map(h => h.content).join(' ') + ' ' + question;
  const classification = (await extractCaseType(fullText, openai)) || {};
  const caseType       = Object.hasOwn(CASE_TYPE_NAMES, classification.type) ? classification.type : 'other';

  // The classifier's terms only. The visitor's own message is never the query: it can hold a name
  // or a phone number, and the query goes to a third party. Without terms, the search uses the
  // case type's terms alone.
  let cases = await searchMalpracticeCases({
    query: typeof classification.terms === 'string' ? classification.terms : '',
    caseType,
    limit: 5,
  });

  // Found decisions are saved for this case type while the reply is written; when the search found
  // nothing (CourtListener throttled, slow or down), the decisions saved last time are used instead.
  let remembering = Promise.resolve();
  let recalled = false;
  if (cases.length > 0) {
    remembering = rememberCases(caseType, cases).catch(err => console.error('Could not save the cases found:', err.message));
  } else {
    cases = await recallCases(caseType).catch(err => { console.error('Could not read the saved cases:', err.message); return []; });
    recalled = cases.length > 0;
  }

  const caseContext = buildCaseContext(cases, { recalled });

  // The prompt for the mode, then the rules the gate grades the reply on (rubrics/*.json).
  const basePrompt = mode === 'estate'
    ? buildEstatePrompt(turn, caseContext, caseType)
    : buildPersonalPrompt(turn, caseContext, caseType);
  const complianceRules = rubricPromptBlock(mode, turn);
  const systemPrompt = complianceRules ? `${basePrompt}\n\n${complianceRules}` : basePrompt;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: question },
  ];

  const parallelTasks = [
    chatCompletionsWithFallback(openai, { models: ANSWER_MODELS, messages, temperature: 0.7, max_tokens: 1000 }),
    turn >= 2 && allowLeadScoring ? sideCall(scoreLead(question, history, caseType, mode)) : Promise.resolve(null),
    turn >= 3 ? sideCall(analyzeMalpracticeSituation(question, history, cases, caseType, mode)) : Promise.resolve(null),
  ];

  const [completion, leadScore, caseAnalysis] = await Promise.all(parallelTasks);
  const draft = completion.choices[0].message.content;

  // Gatekeeper & Coach: grade the draft against the rubric; a blocked draft is rewritten once.
  let answer = draft;
  let evaluation = null;
  try {
    const gated = await evaluateAndRemediateDraft({
      openai,
      auxModels: AUX_MODELS,
      answerModels: ANSWER_MODELS,
      messages,
      draftText: draft,
      turn,
      mode,
      retrievedCases: cases,
    });
    answer = gated.finalText;
    evaluation = gated.evaluation;
  } catch (err) {
    // The gate itself is broken (for example a rubric file missing from the deployment). Keep
    // answering, but make the failure impossible to miss in the logs.
    console.error('[Gatekeeper] UNAVAILABLE — reply served UNGATED:', err);
  }
  await remembering;

  return { answer, cases, caseType, leadScore, caseAnalysis, turn, evaluation };
}

function rubricPromptBlock(mode, turn) {
  try {
    return renderRubricForPrompt(mode, turn);
  } catch (err) {
    console.error('[Gatekeeper] Could not render rubric for the system prompt:', err.message);
    return '';
  }
}

// ─── System Prompts ────────────────────────────────────────────────────────────

function buildPersonalPrompt(turn, caseContext, caseType) {
  const typeName = CASE_TYPE_NAMES[caseType] || 'Medical Malpractice';

  const base = `You are an expert NYC medical malpractice advisor helping someone who was personally harmed by a healthcare provider.
You specialize in New York CPLR §214-a, standard of care analysis, and NYC malpractice litigation.

RELEVANT RECENT CASES (from CourtListener):
${caseContext}

CORE PRINCIPLES:
- Be empathetic — this person has suffered a serious injury at the hands of someone they trusted
- Standard of care: what a reasonably competent provider in the same specialty would have done
- NY deadline: 2 years and 6 months from the act or omission, or from the last treatment where treatment for the same condition continued (CPLR §214-a, continuous treatment)
- Failure to diagnose cancer or a malignant tumor (Lavern's Law, 2018): the 2 years and 6 months run from when the patient knew or reasonably should have known of the error and that it caused injury, but suit must be filed no later than 7 years after the error
- Foreign object left in the body: the claim may still be brought within 1 year of discovering the object (or of facts that would reasonably have led to its discovery), even after the 2 years and 6 months have run; implants, fixation devices and chemical compounds do not count as foreign objects
- Infancy: for a patient who was a minor, the deadline is extended, but in malpractice cases never beyond 10 years after the malpractice (CPLR §208)
- Public hospitals: a claim against NYC Health + Hospitals (for example Bellevue, Kings County or Elmhurst) or another city- or county-run hospital needs a notice of claim within 90 days and a lawsuit within 1 year and 90 days; state-run hospitals have their own short deadlines in the Court of Claims. These are far shorter than the usual deadline, so raise them as soon as a public hospital is involved
- Federal providers: care at a VA or military hospital or clinic, or at a community health center whose staff are deemed federal employees, is a claim against the United States under the Federal Tort Claims Act: a written administrative claim (usually Standard Form 95) to the agency, generally within 2 years after the patient knew or should have known of the injury and its cause, which can be sooner than the 2 years and 6 months above; no lawsuit until the agency denies it or 6 months pass; different rules apply to active-duty service members. Raise it as soon as one may be involved
- Certificate of Merit required (CPLR §3012-a): attorney must certify expert review before filing
- CPLR Article 16 limits the non-economic damages owed by a defendant who is 50% or less at fault
- Always end with: "This is general information, not legal advice."
- Most malpractice firms work on contingency: no attorney's fee unless there is a recovery. Case costs and expenses (medical records, expert reviews, court fees), which are large in malpractice cases, are separate; depending on the retainer agreement the client may have to repay them, so never say a case costs the client nothing`;

  if (turn === 1) return base + `

TURN 1: Acknowledge the difficulty of what they've been through with genuine empathy. Ask ONE focused question to understand: what type of provider was involved, approximately when it happened, and what injury resulted. Do NOT give any legal analysis yet.`;

  if (turn === 2) return base + `

TURN 2: Ask ONE targeted question about the most critical factor — either the timeline (to assess SOL), whether they are still being treated by the same provider or system (continuous treatment doctrine), or the severity and permanence of the injury.`;

  if (turn === 3) return base + `

TURN 3: Provide a preliminary assessment covering: (1) whether the timeline appears within the 2.5-year SOL, (2) whether a later start or a shorter deadline may apply (continuous treatment, a foreign object, a missed cancer diagnosis under Lavern's Law, infancy, a public hospital's 90-day notice of claim, or a federal provider's 2-year administrative claim), (3) the key causation question — what the standard of care required and how it was allegedly breached. Reference relevant cases.`;

  if (turn === 4) return base + `

TURN 4: Explain that malpractice cases require expert medical testimony to establish the standard of care — this is why specialist attorneys who already have medical expert networks are essential. Ask if they'd like to be connected with a qualified NYC malpractice attorney for a free consultation. If they would, tell them they can use the contact form below this reply; do not ask them to type their phone number into the chat.`;

  return base + `

TURN ${turn}: If they want to speak with a qualified NYC malpractice attorney, invite them to use the contact form below this reply to share their name, phone number and best time to call. Never ask them to type contact details into the chat. Consultations are free, and most firms work on contingency; suggest asking how case costs and expenses are handled. Otherwise keep answering their questions.`;
}

function buildEstatePrompt(turn, caseContext, caseType) {
  const typeName = CASE_TYPE_NAMES[caseType] || 'Medical Malpractice';

  const base = `You are an expert NYC medical malpractice advisor helping a family member or estate representative pursue a wrongful death malpractice claim.
You specialize in New York EPTL §5-4.1, wrongful death damages, and estate-based malpractice litigation.

RELEVANT RECENT CASES (from CourtListener):
${caseContext}

CORE PRINCIPLES:
- This is a wrongful death claim — profound loss requiring both compassion and legal precision
- Wrongful death SOL in NY: 2 years from date of death (EPTL §5-4.1) — different from personal injury SOL
- Public hospitals: if NYC Health + Hospitals or another city- or county-run hospital was involved, a notice of claim is due within 90 days of the estate representative's appointment — raise this immediately
- Federal providers: if a VA or military hospital or clinic, or a community health center whose staff are deemed federal employees, was involved, the claim is against the United States under the Federal Tort Claims Act: a written administrative claim (usually Standard Form 95) to the agency, generally within 2 years, and no lawsuit until the agency denies it or 6 months pass — raise this immediately
- The survival claim for the person's own conscious pain and suffering has its own deadline, tied to the malpractice deadline; an attorney must check both
- New York allows only pecuniary (economic) wrongful death damages, not damages for grief; the Grieving Families Act, which would change that and lengthen the deadline, has been vetoed four times (most recently in December 2025) and is not law
- The action is brought by the estate administrator / personal representative, not the family directly
- Damages: pecuniary loss to distributees (lost earnings, services, support), conscious pain & suffering (survival)
- Appointment of estate administrator may be needed first (Surrogate's Court)
- Standard of care and causation analysis are identical to personal injury malpractice
- Always end with: "This is general information, not legal advice."
- Most malpractice firms work on contingency: no attorney's fee unless there is a recovery. Case costs and expenses (medical records, expert reviews, court fees) are separate; depending on the retainer agreement the estate may have to repay them, so never say a case costs the family nothing`;

  if (turn === 1) return base + `

TURN 1: Acknowledge this profound loss with genuine compassion — they have lost a loved one and are now navigating a legal system at an already devastating time. Ask ONE focused question: who passed away, what was the medical provider's alleged error, and approximately when did the death occur. Do NOT give legal analysis yet.`;

  if (turn === 2) return base + `

TURN 2: Ask ONE targeted question about either the estate administration status (is there already an appointed administrator?) or the relationship between the alleged malpractice and the death — this causation link is the central issue in wrongful death claims.`;

  if (turn === 3) return base + `

TURN 3: Provide a preliminary assessment covering: (1) the 2-year wrongful death SOL from date of death and where they stand, (2) whether an estate administrator has been or needs to be appointed, (3) the categories of damages potentially available — pecuniary loss to dependents, survival damages for conscious pain and suffering. Reference relevant cases.`;

  if (turn === 4) return base + `

TURN 4: Explain that wrongful death malpractice claims involve both the legal system and the medical expert world simultaneously — a specialist attorney handles both. The estate needs representation promptly, especially if the 2-year deadline is approaching. Ask if they'd like a referral. If they would, tell them they can use the contact form below this reply; do not ask them to type their phone number into the chat.`;

  return base + `

TURN ${turn}: If they want to speak with a qualified NYC wrongful death / malpractice attorney, invite them to use the contact form below this reply to share their name, phone number and best time to call. Never ask them to type contact details into the chat. Consultations are free. Otherwise keep answering their questions.`;
}

// ─── Case Situation Analysis ───────────────────────────────────────────────────

const cleanText = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
const cleanList = (value, max) => (Array.isArray(value) ? value : []).map(item => cleanText(item, 200)).filter(Boolean).slice(0, max);
const COMPLEXITY_LEVELS = { low: 'Low', medium: 'Medium', high: 'High' };

/**
 * The model's JSON in the shape the case card (public/script.js) shows:
 * { score: 1-10, verdict: 'strong'|'moderate'|'weak', complexityEstimate: { level, reason }|null,
 *   solWarning: string|null, strengths: string[], weaknesses: string[] }
 * The verdict is worked out from the score, so the card's label and meter cannot disagree: the prompt's own
 * example used to pair a score of 7 with "moderate". Returns null when there is no usable score.
 */
export function normalizeCaseAnalysis(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawScore = Number(raw.score);
  if (!Number.isFinite(rawScore)) return null;
  const score = Math.min(10, Math.max(1, Math.round(rawScore)));
  const level = COMPLEXITY_LEVELS[String(raw.complexityEstimate?.level || '').trim().toLowerCase()];
  return {
    score,
    verdict: score >= 7 ? 'strong' : score >= 4 ? 'moderate' : 'weak',
    complexityEstimate: level ? { level, reason: cleanText(raw.complexityEstimate.reason, 200) } : null,
    solWarning: cleanText(raw.solWarning, 300),
    strengths: cleanList(raw.strengths, 3),
    weaknesses: cleanList(raw.weaknesses, 2),
  };
}

async function analyzeMalpracticeSituation(question, history, cases, caseType, mode) {
  try {
    const typeName    = CASE_TYPE_NAMES[caseType] || 'Medical Malpractice';
    const conversation = analysisTranscript(history, question);
    const perspective = mode === 'estate' ? 'estate / wrongful death claimant' : 'injured patient';

    const caseSnippets = cases.slice(0, 3)
      .map(c => c.caseName + (c.snippet ? ': ' + c.snippet.substring(0, 150) : ''))
      .join('\n');
    // New York law the model may state wrongly (rubrics/ny_malpractice_current_law.json).
    const currentLaw = renderCurrentLawForPrompt();

    const res = await chatCompletionsWithFallback(openai, {
      models: AUX_MODELS,
      messages: [{
        role: 'user',
        content: `You are a NYC medical malpractice case analyst evaluating the position of the ${perspective}.
Case type: ${typeName}

Conversation:
${conversation}

Relevant NY cases:
${caseSnippets.substring(0, 500)}
${currentLaw ? `\n${currentLaw}\n` : ''}
Respond ONLY with valid JSON in exactly this shape. Replace every <...> with your own analysis of THIS conversation; never copy the placeholder wording:
{
  "score": <integer 1-10>,
  "verdict": "<strong | moderate | weak>",
  "complexityEstimate": { "level": "<Low | Medium | High>", "reason": "<one line on what makes this case simpler or harder>" },
  "solWarning": "<one sentence on a deadline that may be close or shorter than usual, or null>",
  "strengths": ["<specific factor the user described>", "<another specific factor>"],
  "weaknesses": ["<specific risk, gap or defense in what the user described>"]
}

Rules:
- score: integer 1-10, the overall strength of the malpractice claim on the facts given so far
- verdict: "strong" (7-10), "moderate" (4-6), "weak" (1-3); it must agree with the score
- complexityEstimate: null if too little is known
- solWarning: name the deadline that may be close, or a shorter one that may apply (a public hospital's 90-day notice of claim, a federal provider's 2-year administrative claim); otherwise null. Do not compute a calendar date
- strengths: 2-3 specific factors from what the user actually described
- weaknesses: 1-2 specific risks, gaps or defenses
- Use only facts stated in the conversation. Do not invent facts and do not cite court cases`,
      }],
      response_format: { type: 'json_object' },
      max_tokens: 400,
    });

    return normalizeCaseAnalysis(JSON.parse(res.choices[0].message.content));
  } catch (err) {
    console.error('Case analysis error:', err.message);
    return null;
  }
}
