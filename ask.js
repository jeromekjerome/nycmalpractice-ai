// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

import OpenAI from 'openai';
import { searchMalpracticeCases, extractCaseType } from './courtlistener.js';
import { scoreLead } from './auction.js';
import { buildModelList, chatCompletionsWithFallback } from './openaiModelFailover.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
const NATIONAL_FALLBACK_NOTE =
  'NOTE: No New York decisions matched this search. The cases below come from a national search and may be ' +
  'from other jurisdictions — treat them as persuasive authority only and do not present them as New York law.';

function buildCaseContext(cases) {
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

  return cases.some(c => c.scope === 'national') ? `${NATIONAL_FALLBACK_NOTE}\n\n${blocks}` : blocks;
}

export async function answerUserQuestion({ question, mode = 'personal', sessionId, history }) {
  // The conversation step: the number of the visitor's own message. The history also holds the AI's
  // replies, so counting every message ran steps 1, 3, 5 and skipped steps 2 and 4.
  const turn = history.filter(h => h.role === 'user').length + 1;

  const fullText       = history.map(h => h.content).join(' ') + ' ' + question;
  const classification = (await extractCaseType(fullText, openai)) || {};
  const caseType       = Object.hasOwn(CASE_TYPE_NAMES, classification.type) ? classification.type : 'other';

  // The classifier's terms only. The visitor's own message is never the query: it can hold a name
  // or a phone number, and the query goes to a third party. Without terms, the search uses the
  // case type's terms alone.
  const cases = await searchMalpracticeCases({
    query: typeof classification.terms === 'string' ? classification.terms : '',
    caseType,
    limit: 5,
  });

  const caseContext = buildCaseContext(cases);

  const systemPrompt = mode === 'estate'
    ? buildEstatePrompt(turn, caseContext, caseType)
    : buildPersonalPrompt(turn, caseContext, caseType);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: question },
  ];

  const parallelTasks = [
    chatCompletionsWithFallback(openai, { models: ANSWER_MODELS, messages, temperature: 0.7, max_tokens: 1000 }),
    turn >= 2 ? scoreLead(question, history, caseType, mode)                         : Promise.resolve(null),
    turn >= 3 ? analyzeMalpracticeSituation(question, history, cases, caseType, mode) : Promise.resolve(null),
  ];

  const [completion, leadScore, caseAnalysis] = await Promise.all(parallelTasks);
  const answer = completion.choices[0].message.content;

  return { answer, cases, caseType, leadScore, caseAnalysis, turn };
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
- Certificate of Merit required (CPLR §3012-a): attorney must certify expert review before filing
- CPLR Article 16 limits the non-economic damages owed by a defendant who is 50% or less at fault
- Always end with: "This is general information, not legal advice."
- Most malpractice firms work on contingency — no upfront cost to the patient`;

  if (turn === 1) return base + `

TURN 1: Acknowledge the difficulty of what they've been through with genuine empathy. Ask ONE focused question to understand: what type of provider was involved, approximately when it happened, and what injury resulted. Do NOT give any legal analysis yet.`;

  if (turn === 2) return base + `

TURN 2: Ask ONE targeted question about the most critical factor — either the timeline (to assess SOL), whether they are still being treated by the same provider or system (continuous treatment doctrine), or the severity and permanence of the injury.`;

  if (turn === 3) return base + `

TURN 3: Provide a preliminary assessment covering: (1) whether the timeline appears within the 2.5-year SOL, (2) whether a later start or a shorter deadline may apply (continuous treatment, a foreign object, a missed cancer diagnosis under Lavern's Law, infancy, or a public hospital's 90-day notice of claim), (3) the key causation question — what the standard of care required and how it was allegedly breached. Reference relevant cases.`;

  if (turn === 4) return base + `

TURN 4: Explain that malpractice cases require expert medical testimony to establish the standard of care — this is why specialist attorneys who already have medical expert networks are essential. Ask if they'd like to be connected with a qualified NYC malpractice attorney for a free consultation. If they would, tell them they can use the contact form below this reply; do not ask them to type their phone number into the chat.`;

  return base + `

TURN ${turn}: If they want to speak with a qualified NYC malpractice attorney, invite them to use the contact form below this reply to share their name, phone number and best time to call. Never ask them to type contact details into the chat. Consultations are free and firms work on contingency. Otherwise keep answering their questions.`;
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
- The survival claim for the person's own conscious pain and suffering has its own deadline, tied to the malpractice deadline; an attorney must check both
- New York allows only pecuniary (economic) wrongful death damages, not damages for grief; the Grieving Families Act, which would change that and lengthen the deadline, has been vetoed four times (most recently in December 2025) and is not law
- The action is brought by the estate administrator / personal representative, not the family directly
- Damages: pecuniary loss to distributees (lost earnings, services, support), conscious pain & suffering (survival)
- Appointment of estate administrator may be needed first (Surrogate's Court)
- Standard of care and causation analysis are identical to personal injury malpractice
- Always end with: "This is general information, not legal advice."
- Most malpractice firms work on contingency — no upfront cost to the estate`;

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

async function analyzeMalpracticeSituation(question, history, cases, caseType, mode) {
  try {
    const typeName    = CASE_TYPE_NAMES[caseType] || 'Medical Malpractice';
    const allText     = history.map(h => h.content).join('\n') + '\n' + question;
    const perspective = mode === 'estate' ? 'estate / wrongful death claimant' : 'injured patient';

    const caseSnippets = cases.slice(0, 3)
      .map(c => c.caseName + (c.snippet ? ': ' + c.snippet.substring(0, 150) : ''))
      .join('\n');

    const res = await chatCompletionsWithFallback(openai, {
      models: AUX_MODELS,
      messages: [{
        role: 'user',
        content: `You are a NYC medical malpractice case analyst evaluating the position of the ${perspective}.
Case type: ${typeName}

Conversation:
${allText.substring(0, 1500)}

Relevant NY cases:
${caseSnippets.substring(0, 500)}

Respond ONLY with valid JSON:
{
  "score": 7,
  "verdict": "moderate",
  "complexityEstimate": { "level": "High", "reason": "Causation requires competing expert testimony on surgical standard of care" },
  "solWarning": null,
  "strengths": ["Clear deviation from standard of care — wrong-site surgery documented in records", "Serious permanent injury supports significant damages"],
  "weaknesses": ["Pre-existing condition may complicate causation argument", "Approaching 2.5-year SOL — filing urgency"]
}

Rules:
- score: 1–10 (overall strength of the malpractice claim)
- verdict: "strong" (7–10), "moderate" (4–6), "weak" (1–3)
- complexityEstimate: case complexity level (Low/Medium/High) and one-line reason; null if too little info
- solWarning: brief SOL alert if timeline is close to NY deadline, otherwise null
- strengths: 2–3 specific factors supporting the claim
- weaknesses: 1–2 risks, gaps, or defenses`,
      }],
      response_format: { type: 'json_object' },
      max_tokens: 400,
    });

    return JSON.parse(res.choices[0].message.content);
  } catch (err) {
    console.error('Case analysis error:', err.message);
    return null;
  }
}
