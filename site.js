// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// The site's public address, used in the links emailed to law firms. APP_URL overrides it; until the
// site has its own domain, the Vercel address is the one that works.
export const APP_URL = (process.env.APP_URL || 'https://nycmalpractice-ai.vercel.app').replace(/\/+$/, '');

// The wording a visitor agrees to before their contact details and conversation go to law firms.
// public/index.html shows exactly this text (a test checks that they match), and the text stored with
// each consent is this constant, never anything the browser sends.
export const CONTACT_CONSENT_TEXT = "I agree that NYCMalpractice.ai may share my name, phone number, email address (if I give one), preferred time to call and this conversation with up to three licensed New York attorneys, who may contact me by phone, text message or email about my possible claim. Message and data rates may apply. If I give my email address, NYCMalpractice.ai may also email me when an attorney accepts my request. I can withdraw this consent at any time by emailing privacy@nycmalpractice.ai.";

// The most firms one lead goes to (the consent above says "up to three"). An auction lead goes to its winner
// only; a cold lead used to go to every matching firm, so a client could get many calls.
export const MAX_FIRMS_PER_LEAD = 3;

// The contact form is offered from the step where the AI offers a referral.
export const CONTACT_FORM_FROM_STEP = 4;

// The practice areas a firm can choose on the sign-up form and in the portal ('other' means every case type).
export const PRACTICE_AREAS = Object.freeze(['surgical_error', 'misdiagnosis', 'medication_error', 'birth_injury', 'anesthesia_error', 'hospital_negligence', 'nursing_home', 'dental', 'other']);

// How each case type is named in emails to firms and on the admin page.
const CASE_TYPE_LABELS = Object.freeze({
  surgical_error: 'surgical error', misdiagnosis: 'failure to diagnose', medication_error: 'medication error',
  birth_injury: 'birth injury', anesthesia_error: 'anesthesia error', hospital_negligence: 'hospital negligence',
  nursing_home: 'nursing home', dental: 'dental malpractice', other: 'medical malpractice',
});
export const caseTypeLabel = type => CASE_TYPE_LABELS[type] || CASE_TYPE_LABELS.other;
