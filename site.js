// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// The site's public address, used in the links emailed to law firms. APP_URL overrides it; until the
// site has its own domain, the Vercel address is the one that works.
export const APP_URL = (process.env.APP_URL || 'https://nycmalpractice-ai.vercel.app').replace(/\/+$/, '');

// The wording a visitor agrees to before their contact details and conversation go to law firms.
// public/index.html shows exactly this text (a test checks that they match), and the text stored with
// each consent is this constant, never anything the browser sends.
export const CONTACT_CONSENT_TEXT = "I agree that NYCMalpractice.ai may share my name, phone number, preferred time to call and this conversation with one or more licensed New York attorneys, who may contact me by phone or text message about my possible claim. Message and data rates may apply. I can withdraw this consent at any time by emailing privacy@nycmalpractice.ai.";

// The contact form is offered from the step where the AI offers a referral.
export const CONTACT_FORM_FROM_STEP = 4;

// The practice areas a firm can choose on the sign-up form and in the portal ('other' means every case type).
export const PRACTICE_AREAS = Object.freeze(['surgical_error', 'misdiagnosis', 'medication_error', 'birth_injury', 'anesthesia_error', 'hospital_negligence', 'nursing_home', 'dental', 'other']);
