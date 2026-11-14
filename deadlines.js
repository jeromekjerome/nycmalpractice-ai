// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// A claim against a public hospital has a far shorter first deadline than the usual 2 years and 6
// months: a written notice within 90 days (General Municipal Law § 50-e for New York City and county
// hospitals; Court of Claims Act § 10 for State hospitals such as SUNY Downstate). When the visitor's
// own words name one, the page shows that deadline beside the reply. Only the visitor's messages are
// read, because the replies themselves name Bellevue as an example. A false alarm costs a sentence of
// reading; a missed one can cost the claim, so the names are matched generously.
const PUBLIC_HOSPITAL_NAMES = [
  'nyc\\s*health\\s*(?:\\+|and|&)\\s*hospitals', 'health\\s*(?:\\+|and|&)\\s*hospitals', 'h\\s*\\+\\s*h', 'hhc',
  'bellevue', 'kings\\s+county\\s+(?:hospital|medical)', 'elmhurst', 'jacobi', 'harlem\\s+hospital',
  'lincoln\\s+(?:hospital|medical)', 'metropolitan\\s+hospital', 'north\\s+central\\s+bronx', 'queens\\s+hospital',
  'woodhull', 'coney\\s+island\\s+hospital', 'south\\s+brooklyn\\s+health', 'gouverneur', 'cumberland\\s+(?:hospital|diagnostic|health)',
  'morrisania', 'belvis', 'sydenham', 'sea\\s+view\\s+(?:hospital|nursing|rehab)', 'coler', 'mckinney\\s+(?:nursing|rehab|center)',
  'carter\\s+(?:specialty|hospital|rehab)', 'gotham\\s+health',
  'suny\\s+downstate', 'downstate\\s+(?:medical|hospital|health)', 'university\\s+hospital\\s+of\\s+brooklyn', 'stony\\s+brook\\s+(?:university|hospital|medicine)',
  'suny\\s+upstate', 'upstate\\s+(?:university|medical)', 'nassau\\s+university\\s+medical', 'erie\\s+county\\s+medical', 'westchester\\s+medical\\s+center',
  '(?:public|city|municipal|county|state)[\\s-]+(?:run\\s+)?(?:hospital|clinic|nursing\\s+home)', '(?:city|county|state)[\\s-]+run',
];
const PUBLIC_HOSPITAL = new RegExp('(?<![\\p{L}\\p{N}])(?:' + PUBLIC_HOSPITAL_NAMES.join('|') + ')(?![\\p{L}\\p{N}])', 'iu');

export function mentionsPublicHospital(messages) {
  return (messages || []).some(message => message?.role === 'user' && PUBLIC_HOSPITAL.test(String(message.content ?? '')));
}
