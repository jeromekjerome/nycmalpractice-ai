// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// A claim against a public hospital has a far shorter first deadline than the usual 2 years and 6
// months: within 90 days, a written notice for New York City and county hospitals
// (General Municipal Law § 50-e), and a claim or a notice of intention to file one for State hospitals
// such as SUNY Downstate (Court of Claims Act § 10). When the visitor's
// own words name one, the page shows that deadline beside the reply. Only the visitor's messages are
// read, because the replies themselves name Bellevue as an example. A false alarm costs a sentence of
// reading; a missed one can cost the claim, so the names are matched generously.
// A kind of hospital the visitor says it was not ("private, not a city hospital", "it wasn't state-run") is not
// matched: the generous match used to warn of a 90-day notice for exactly the hospital the visitor ruled out.
const NOT_SAID = "(?<!(?:\\bnot|n['’]t|\\bnever)\\s+(?:(?:at|in|to)\\s+)?(?:(?:a|an|the)\\s+)?)";
const PUBLIC_HOSPITAL_NAMES = [
  'nyc\\s*health\\s*(?:\\+|and|&)\\s*hospitals', 'health\\s*(?:\\+|and|&)\\s*hospitals', 'h\\s*\\+\\s*h', 'hhc',
  'bellevue', 'kings\\s+county\\s+(?:hospital|medical)', 'elmhurst', 'jacobi', 'harlem\\s+hospital',
  'lincoln\\s+(?:hospital|medical)', 'metropolitan\\s+hospital', 'north\\s+central\\s+bronx', 'queens\\s+hospital',
  'woodhull', 'coney\\s+island\\s+hospital', 'south\\s+brooklyn\\s+health', 'gouverneur', 'cumberland\\s+(?:hospital|diagnostic|health)',
  'morrisania', 'belvis', 'sydenham', 'sea\\s+view\\s+(?:hospital|nursing|rehab)', 'coler', 'mckinney\\s+(?:nursing|rehab|center)',
  'carter\\s+(?:specialty|hospital|rehab)', 'gotham\\s+health',
  'suny\\s+downstate', 'downstate\\s+(?:medical|hospital|health)', 'university\\s+hospital\\s+of\\s+brooklyn', 'stony\\s+brook\\s+(?:university|hospital|medicine)',
  'suny\\s+upstate', 'upstate\\s+(?:university|medical)', 'nassau\\s+university\\s+medical', 'erie\\s+county\\s+medical', 'westchester\\s+medical\\s+center',
  NOT_SAID + '(?:public|city|municipal|county|state)[\\s-]+(?:run\\s+)?(?:hospital|clinic|nursing\\s+home)', NOT_SAID + '(?:city|county|state)[\\s-]+run',
];
const PUBLIC_HOSPITAL = new RegExp('(?<![\\p{L}\\p{N}])(?:' + PUBLIC_HOSPITAL_NAMES.join('|') + ')(?![\\p{L}\\p{N}])', 'iu');

// Care from a federal provider is a claim against the United States under the Federal Tort Claims Act: a
// written claim to the agency within 2 years (28 U.S.C. § 2401(b)), sooner than New York's 2 years and 6
// months, and no lawsuit until the agency denies it or 6 months pass (28 U.S.C. § 2675). That covers VA and
// military hospitals and the community health centers whose staff are deemed federal employees
// (42 U.S.C. § 233), so any health center is matched.
const FEDERAL_PROVIDER_NAMES = [
  'federal(?:ly)?', 'u\\.?s\\.?\\s+government', 'united\\s+states\\s+government',
  'v\\.?a\\.?\\s+(?:hospital|medical|clinic|doctor|nurse|facility|center|healthcare|health)', 'the\\s+v\\.?a\\.?',
  'veterans?\\s+(?:affairs|administration|hospital|medical|health)', 'vamc',
  '(?:army|navy|air\\s+force|marine\\s+corps|coast\\s+guard|military)\\s+(?:hospital|base|doctor|clinic|facility|medical|installation)',
  'walter\\s+reed', 'community\\s+health', '(?:family\\s+)?health\\s+cent(?:er|re)s?', 'fqhc', 'indian\\s+health\\s+service',
  'bureau\\s+of\\s+prisons', 'federal\\s+(?:prison|detention)', 'mdc\\s+brooklyn', 'metropolitan\\s+detention',
];
const FEDERAL_PROVIDER = new RegExp('(?<![\\p{L}\\p{N}])(?:' + FEDERAL_PROVIDER_NAMES.join('|') + ')(?![\\p{L}\\p{N}])', 'iu');

const visitorSays = (messages, pattern) =>
  (messages || []).some(message => message?.role === 'user' && pattern.test(String(message.content ?? '')));

export function mentionsPublicHospital(messages) {
  return visitorSays(messages, PUBLIC_HOSPITAL);
}

/** The deadline notices the page shows beside the reply, in order: some of 'public_hospital' and 'federal'. */
export function deadlineNotices(messages) {
  return [
    visitorSays(messages, PUBLIC_HOSPITAL) && 'public_hospital',
    visitorSays(messages, FEDERAL_PROVIDER) && 'federal',
  ].filter(Boolean);
}
