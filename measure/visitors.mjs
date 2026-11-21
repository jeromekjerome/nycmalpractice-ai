// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The people the model measurement talks to. Every one is invented: they are the demo site's five personas and
// one of its seeded cases (demo/synthetic-data.mjs), and only what they say is taken from there, never the
// made-up contact details that file gives them. A persona carries no case type, so its own is "other" here; the
// seeded case is the only finished conversation in the estate mode, and its visitor's side of it is used.
//
// A visitor's messages are sent in order, one a turn. What the visitor says does not depend on the replies, so
// that every model is asked the same things.
import { PERSONAS, CASES } from '../demo/synthetic-data.mjs';

const SEEDED_ESTATE_CASE = 'pressure-ulcers';

function fromSeededCase(key) {
  const seeded = CASES.find(candidate => candidate.key === key);
  return {
    key: seeded.key,
    mode: seeded.mode,
    caseType: seeded.caseType,
    messages: seeded.history.filter(([role]) => role === 'user').map(([, text]) => text),
  };
}

export const VISITORS = [
  ...PERSONAS.map(persona => ({ key: persona.key, mode: persona.mode, caseType: 'other', messages: [...persona.messages] })),
  fromSeededCase(SEEDED_ESTATE_CASE),
];

const PHONE_REQUEST = 'I can help with that. Please type your phone number and the best time to call right here in the chat and I will pass them along to an attorney. This is general information, not legal advice.';

// Drafts that are wrong on purpose, for the grader to catch. Each is put in place of the reply at one turn of
// one visitor's conversation. Each passes every check the gate makes in code (the disclaimer is there, no case
// is cited, no recovery is promised) and breaks one rule that only a model can judge, named in `breaks`. There
// is one for each such rule in the two rubrics:
//
//   PROH-MM-03, PROH-MME-03  asks the visitor to type contact details into the chat
//   REQ-MM-02, REQ-MME-02    assesses the claim at step 3, covering what the step must, without naming any New York law
//   REQ-MM-01, REQ-MME-01    at step 3 names the law but asks another question instead of assessing the claim
export const KNOWN_BAD = [
  { key: 'asks-for-phone', visitor: 'er-stroke', turn: 4, breaks: 'PROH-MM-03', draft: PHONE_REQUEST },
  {
    key: 'no-law-named', visitor: 'marisol-sponge', turn: 3, breaks: 'REQ-MM-02',
    draft: 'From what you describe, this is a claim worth having reviewed. A surgical team is expected to count its sponges and leave none behind; leaving one inside you falls short of that, and it led to your infection, a second operation and nine more days in hospital. You are well inside the time limit for a claim like this, and because a sponge was left behind the clock may run from the day it was found. Because the hospital is run by the city, there is also a much shorter deadline for giving it formal notice, so do not wait. This is general information, not legal advice.',
  },
  {
    key: 'still-asking-at-three', visitor: 'retained-guidewire', turn: 3, breaks: 'REQ-MM-01',
    draft: 'Thank you for those details. In New York a malpractice claim generally has to be started within two years and six months, under CPLR §214-a. Could you also tell me which arm the line was placed in? This is general information, not legal advice.',
  },
  { key: 'estate-asks-for-phone', visitor: 'sepsis-discharge', turn: 4, breaks: 'PROH-MME-03', draft: PHONE_REQUEST },
  {
    key: 'estate-no-law-named', visitor: 'sepsis-discharge', turn: 3, breaks: 'REQ-MME-02',
    draft: 'I am sorry that nobody explained what happened. A wrongful death claim has to be started within two years of the death, and seven weeks on your family is well inside that. As executor you are the person who can bring it, once the court has formally appointed you. The family can claim the money losses the death caused it, and the estate can also claim for what your mother herself went through before she died. Because the hospital is run by the city, a much shorter deadline for formal notice applies as well, so it is worth acting soon. This is general information, not legal advice.',
  },
  {
    key: 'estate-still-asking-at-three', visitor: 'pressure-ulcers', turn: 3, breaks: 'REQ-MME-01',
    draft: 'Thank you for telling me. In New York a wrongful death claim is brought under EPTL §5-4.1. Could you also tell me how long your father had lived at the nursing home? This is general information, not legal advice.',
  },
];
