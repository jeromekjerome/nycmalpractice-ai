// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The JSON each of this app's small jobs answers in, as its caller reads it. The OpenAI adapter asks only for a
// JSON object, as it always has; these are for a provider that is given a schema for its answer. The prompts
// still ask for the same in words, and the callers still check what they read.
//
// Every field is required and no other is allowed, the strict form a provider's structured answers take. A field the
// prompt allows to be null takes null beside its own type. The ranges a prompt gives (a score of 1 to 10) are left to
// the prompt. Each adapter sends its own copy of a schema with each request (providers.js hands it this one), so that
// no request can change these.
//
// This app has no seminar, so it has no seminar score.

const string = { type: 'string' };
const number = { type: 'number' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const strings = { type: 'array', items: string };
const oneOf = values => ({ type: 'string', enum: values });
const orNull = schema => ({ anyOf: [schema, { type: 'null' }] });

function object(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

export const SCHEMAS = Object.freeze({
  // extractCaseType in courtlistener.js
  classify: object({
    type: oneOf(['surgical_error', 'misdiagnosis', 'medication_error', 'birth_injury', 'anesthesia_error', 'hospital_negligence', 'nursing_home', 'dental', 'other']),
    terms: string,
  }),
  // scoreLead in auction.js. Its time-limit mark (sol_status) is what keeps a claim likely out of time from being a lead.
  leadScore: object({
    viable: boolean,
    score: number,
    dimensions: object({ injury_severity: number, causation_clarity: number, sol_status: number, expert_viability: number, damages_magnitude: number }),
    preview: string,
    confidence: number,
  }),
  // analyzeMalpracticeSituation in ask.js. The prompt allows no complexity when too little is known, and no deadline
  // warning when none applies.
  caseCard: object({
    score: integer,
    verdict: oneOf(['strong', 'moderate', 'weak']),
    complexityEstimate: orNull(object({ level: oneOf(['Low', 'Medium', 'High']), reason: string })),
    solWarning: orNull(string),
    strengths: strings,
    weaknesses: strings,
  }),
  // The gate's grader, runLlmEvaluator in gatekeeper.js
  grade: object({
    required_checks: { type: 'array', items: object({ id: string, name: string, passed: boolean, evidence_or_gap: string }) },
    prohibited_checks: {
      type: 'array',
      items: object({ id: string, name: string, violated: boolean, offending_quote: string, remediation_instruction: string }),
    },
    coaching: string,
  }),
});
