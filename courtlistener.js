// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

const BASE_URL = 'https://www.courtlistener.com/api/rest/v4';

const CASE_TYPE_TERMS = {
  surgical_error:      'surgical malpractice wrong-site surgery standard of care New York',
  misdiagnosis:        'failure to diagnose delayed diagnosis misdiagnosis New York malpractice',
  medication_error:    'medication error prescription malpractice pharmacy negligence New York',
  birth_injury:        'birth injury cerebral palsy obstetric malpractice New York',
  anesthesia_error:    'anesthesia malpractice awareness surgery New York negligence',
  hospital_negligence: 'hospital negligence vicarious liability New York Public Health Law',
  nursing_home:        'nursing home negligence elder abuse New York Public Health Law 2801-d',
  dental:              'dental malpractice New York standard of care',
  other:               'medical malpractice standard of care New York CPLR 214-a',
};

export async function searchMalpracticeCases({ query, caseType = 'other', limit = 5 }) {
  try {
    const terms    = CASE_TYPE_TERMS[caseType] || CASE_TYPE_TERMS.other;
    const combined = `${terms} ${query}`.trim();

    const params = new URLSearchParams({
      q:                   combined,
      type:                'o',
      stat_Precedential:   'on',
      court:               'ny nysupct nyappdiv',
      order_by:            'score desc',
      page_size:           String(limit),
    });

    const headers = { 'User-Agent': 'NYCMalpractice.ai/1.0' };
    if (process.env.COURTLISTENER_TOKEN) {
      headers['Authorization'] = `Token ${process.env.COURTLISTENER_TOKEN}`;
    }

    const res = await fetch(`${BASE_URL}/search/?${params}`, { headers });
    if (!res.ok) { console.warn('CourtListener error:', res.status); return []; }

    const data = await res.json();
    return (data.results || []).map(r => ({
      caseName:    r.caseName || r.case_name || '',
      citation:    (r.citation || []).join(', '),
      court:       r.court || '',
      dateFiled:   r.dateFiled || r.date_filed || '',
      snippet:     r.snippet || '',
      absoluteUrl: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : null,
    }));
  } catch (err) {
    console.warn('CourtListener fetch failed:', err.message);
    return [];
  }
}

export async function extractCaseType(text, openai) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Classify this NYC malpractice inquiry into one category.

Categories:
- surgical_error: surgical errors, wrong-site surgery, operating room negligence
- misdiagnosis: failure to diagnose, delayed diagnosis, missed diagnosis, misread imaging
- medication_error: wrong drug, wrong dose, prescription errors, pharmacy errors
- birth_injury: birth injuries, cerebral palsy, Erb's palsy, obstetric malpractice
- anesthesia_error: anesthesia complications, awareness under anesthesia
- hospital_negligence: hospital falls, infections, staffing, vicarious liability for staff
- nursing_home: nursing home neglect, elder abuse, pressure sores, malnutrition
- dental: dental malpractice, extraction errors, nerve damage, failed procedures
- other: general medical malpractice, standard of care questions

Text: "${text.substring(0, 600)}"

Respond ONLY with JSON: {"type": "misdiagnosis", "terms": "brief search terms for case law"}`,
      }],
      response_format: { type: 'json_object' },
      max_tokens: 80,
    });
    return JSON.parse(res.choices[0].message.content);
  } catch {
    return { type: 'other', terms: 'medical malpractice standard of care New York' };
  }
}
