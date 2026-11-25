// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// gate-config.js — what the Gatekeeper needs to know about this app: its modes, the rubric file for
// each mode, the current-law notes, and the defaults used when a rubric leaves something out.
// gatekeeper.js and citator.js are the same files in every app; this one is not.

// `new URL('<literal>', import.meta.url)` is the asset reference serverless file tracers follow, and
// vercel.json also bundles rubrics/. GET /health reports whether they load.
export const RUBRIC_FILES = {
  personal: new URL('./rubrics/malpractice_personal.json', import.meta.url),
  estate:   new URL('./rubrics/malpractice_estate.json', import.meta.url),
};

// The rubric a mode is graded on. Any other value is graded as a patient's own claim.
export function normalizeMode(mode) {
  return mode === 'estate' ? 'estate' : 'personal';
}

// New York law the models may state wrongly (see the file's "purpose").
export const CURRENT_LAW_FILE = new URL('./rubrics/ny_malpractice_current_law.json', import.meta.url);

// The name the statute watch's notices carry in their subjects.
export const SITE_NAME = 'NYCMalpractice.ai';

// The statutes' texts the app keeps, one file for each statute the statute watch follows.
export const STATUTE_TEXTS_DIR = new URL('./rubrics/statutes/', import.meta.url);

// Who the evaluator is told it grades replies for.
export const SERVICE_DESCRIPTION = 'a New York City medical-malpractice legal-information service';

// Used only if a rubric omits its own checklist, so the report always carries one.
export const DEFAULT_HUMAN_VERIFICATION_CHECKLIST = Object.freeze([
  "Verify the filing deadline against the treatment dates: CPLR §214-a (2 years 6 months; continuous treatment; foreign object; Lavern's Law for cancer), CPLR §208 infancy (10-year cap), and any 90-day notice of claim for a public hospital (GML §50-e)",
  'Confirm conflict-of-interest check completed before contacting prospective claimant',
  'Confirm physician review for the CPLR §3012-a certificate of merit is feasible, and review the anchored CourtListener citations',
  'Shepardize or KeyCite every decision relied on; the automatic screen shown beside each decision is not a citator',
]);

// Criterion ids the deterministic gate targets when a rubric does not declare a deterministic_check.
export const DEFAULT_GATE_TARGETS = {
  personal: { citation_anchoring: 'PROH-MM-01',  required_phrase: 'REQ-MM-03' },
  estate:   { citation_anchoring: 'PROH-MME-01', required_phrase: 'REQ-MME-03' },
};
