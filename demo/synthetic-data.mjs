// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Proprietary and confidential. See LICENSE for terms.

// Synthetic people for the demo copy of the site. Every name, number and story here is invented:
//   - phone numbers are in 555-0100..0199, which North America reserves for fiction;
//   - email addresses use .example domains, which can never be registered;
//   - supervising attorneys' registration numbers read DEMO-nnnn, so none can match a real New York attorney.
// Laws named in the replies are real and public; no case law is quoted here (the live chat cites real cases from
// CourtListener).

// The same prices and auction lengths as TIER_CONFIG in auction.js (a unit test keeps them equal).
export const DEMO_TIERS = {
  cold: { reserve: 25, auctionHours: 0 }, warm: { reserve: 100, auctionHours: 2 },
  hot: { reserve: 200, auctionHours: 4 }, premium: { reserve: 400, auctionHours: 6 },
};

// ── Law firms ─────────────────────────────────────────────────────────────────
// state: what the firm shows on the admin page and in its portal.
//   ready      approved, paid up, card on file
//   pending    paid, waiting for the operator to check the attorney registration
//   suspended  approved, but three auction declines in 30 days
//   declined   approved, but its card declines (Stripe's test card that always declines)
//   unfinished stopped at the phone step: not verified, no subscription
export const FIRMS = [
  { key: 'hartwell', name: 'Hartwell & Ocampo LLP', attorney: 'Ada Hartwell, Esq.', areas: ['other'], area: 'All five boroughs', state: 'ready', phone: '+12125550101' },
  { key: 'brightline', name: 'Brightline Medical Injury Group', attorney: 'Marcus Brightline, Esq.', areas: ['misdiagnosis', 'surgical_error', 'hospital_negligence'], area: 'Brooklyn, Queens', state: 'ready', phone: '+12125550102' },
  { key: 'nakamura', name: 'Nakamura Vance PLLC', attorney: 'Rei Nakamura, Esq.', areas: ['medication_error', 'anesthesia_error', 'dental', 'birth_injury'], area: 'Manhattan, Bronx', state: 'ready', phone: '+12125550103' },
  { key: 'delacroix', name: 'Delacroix Trial Lawyers', attorney: 'Simone Delacroix, Esq.', areas: ['other'], area: 'New York City and Long Island', state: 'ready', phone: '+12125550104' },
  { key: 'quill', name: 'Quill & Mercer', attorney: 'Jonah Quill, Esq.', areas: ['other'], area: 'Staten Island', state: 'pending', phone: '+12125550105' },
  { key: 'okafor', name: 'Okafor Law Office', attorney: 'Chidi Okafor, Esq.', areas: ['surgical_error', 'misdiagnosis'], area: 'Bronx', state: 'suspended', phone: '+12125550106' },
  { key: 'stanton', name: 'Stanton Ruiz LLP', attorney: 'Elena Ruiz, Esq.', areas: ['other'], area: 'Manhattan', state: 'declined', phone: '+12125550107' },
  { key: 'pemberton', name: 'Pemberton Legal', attorney: 'Hugh Pemberton, Esq.', areas: ['nursing_home'], area: 'Queens', state: 'unfinished', phone: '+12125550108' },
].map((firm, i) => ({ ...firm, email: `intake@${firm.key}.example`, registration: `DEMO-${String(i + 1).padStart(4, '0')}` }));

// ── Seeded cases: conversations already finished, in every state a lead can be in ─────────────────────────────
// outcome:
//   auction-open       an auction still running (closesInMinutes), with bids [firm, dollars] in order
//   auction-won        an auction that closed: the winner was charged and has the lead (leadStatus)
//   no-bids            an auction nobody bid on, re-offered as a $25 cold lead to `coldTo`
//   cold               delivered straight to `coldTo` as a $25 cold lead
//   request            a consented request no firm has had yet: the operator places it from the admin page
//   not-viable         scored as not a case (the deadline passed), so nothing was sent
export const CASES = [
  {
    key: 'chest-pain', caseType: 'misdiagnosis', mode: 'personal', tier: 'premium', score: 92,
    dimensions: { injury_severity: 9, causation_clarity: 9, sol_status: 10, expert_viability: 9, damages_magnitude: 9 },
    preview: '54-year-old discharged from a private Brooklyn ER with "anxiety" despite chest pain and an abnormal ECG; heart attack 36 hours later, stent, lasting heart damage. Six weeks ago.',
    contact: { name: 'Teresa Alvarado', phone: '7185550111', email: 'teresa.alvarado@mail.example', bestTime: 'Weekday mornings' },
    outcome: 'auction-open', closesInMinutes: 300, invite: ['hartwell', 'brightline', 'delacroix', 'stanton'], bids: [['hartwell', 450], ['brightline', 520]],
    history: [
      ['user', 'Six weeks ago I went to the ER at a private hospital in Brooklyn with chest pain going down my left arm. They did an ECG, told me it was anxiety, and sent me home.'],
      ['assistant', "I'm sorry you went through that. Being sent home with chest pain and then becoming seriously ill is frightening. Can you tell me what happened after you left the emergency room?"],
      ['user', 'About a day and a half later I collapsed at home. The ambulance took me to another hospital and they said I was having a heart attack. I got a stent and the cardiologist says part of my heart muscle is permanently damaged.'],
      ['assistant', 'Thank you for explaining. A missed heart attack can be a failure-to-diagnose claim if the first doctors did not meet the accepted standard of care, for example by not acting on an abnormal ECG. In New York, a malpractice lawsuit generally must be started within 2 years and 6 months (CPLR 214-a). Do you know whether the first ECG was read as abnormal?'],
      ['user', 'The second hospital got my records and the cardiologist told me the first ECG already showed changes that should have been caught. I have the discharge papers that say anxiety.'],
      ['assistant', 'Those records matter. A New York malpractice case also needs a physician to review it before it is filed (CPLR 3012-a). You are well within the general deadline. Would you like to be put in touch with a New York malpractice attorney who can review this with you?'],
      ['user', 'Yes, I would like to talk to a lawyer.'],
      ['assistant', 'You can use the contact form below this reply. Nothing is sent to a firm until you agree.'],
    ],
  },
  {
    key: 'retained-sponge', caseType: 'surgical_error', mode: 'personal', tier: 'hot', score: 86,
    dimensions: { injury_severity: 8, causation_clarity: 10, sol_status: 7, expert_viability: 9, damages_magnitude: 7 },
    preview: 'Surgical sponge found in the abdomen 5 weeks after a hysterectomy at Bellevue; second surgery, infection. Public hospital: 90-day notice of claim applies.',
    contact: { name: 'Danielle Okoro', phone: '6465550112', email: 'd.okoro@mail.example', bestTime: 'After 5 pm' },
    outcome: 'auction-open', closesInMinutes: 12, invite: ['hartwell', 'brightline', 'delacroix'], bids: [['delacroix', 230]],
    history: [
      ['user', 'I had a hysterectomy at Bellevue in September. For weeks I had fever and pain, and a CT scan last month showed a sponge left inside me.'],
      ['assistant', "I'm sorry. That sounds painful and upsetting. Did you need another operation to remove it?"],
      ['user', 'Yes, they operated again to take it out and I had an abdominal infection afterwards. I was in the hospital another 9 days and missed a month of work.'],
      ['assistant', 'A sponge or instrument left in the body is one of the clearer kinds of surgical error. Because Bellevue is run by NYC Health + Hospitals, a written notice of claim is generally due within 90 days of the incident (General Municipal Law 50-e), which is much sooner than the usual deadline. For a foreign object, New York also allows a lawsuit within one year of discovering it (CPLR 214-a).'],
      ['user', 'Nobody told me about a 90-day deadline. The surgery was about two months ago.'],
      ['assistant', 'Then time is short, and a lawyer should look at this right away. Would you like to be put in touch with a New York malpractice attorney?'],
      ['user', 'Yes please, as soon as possible.'],
      ['assistant', 'You can use the contact form below this reply. Nothing is sent to a firm until you agree.'],
    ],
  },
  {
    key: 'warfarin', caseType: 'medication_error', mode: 'personal', tier: 'warm', score: 74,
    dimensions: { injury_severity: 7, causation_clarity: 8, sol_status: 9, expert_viability: 7, damages_magnitude: 6 },
    preview: 'Pharmacy filled a warfarin prescription at ten times the prescribed strength; internal bleeding, 4 days in hospital, full recovery expected.',
    contact: { name: 'Harold Feinberg', phone: '3475550113', email: '', bestTime: 'Any time' },
    outcome: 'auction-won', invite: ['nakamura', 'hartwell', 'delacroix'], bids: [['hartwell', 101], ['nakamura', 140]], leadStatus: 'pending', closedMinutesAgo: 90,
    history: [
      ['user', 'My blood thinner prescription was filled wrong. The bottle said 10 mg instead of 1 mg and I took it for a week.'],
      ['assistant', "I'm sorry that happened. Were you hurt by the higher dose?"],
      ['user', 'I started bleeding internally and spent four days in the hospital. The doctors say I should recover fully.'],
      ['assistant', 'A dispensing error like this can support a claim against the pharmacy. The usual New York deadline for malpractice is 2 years and 6 months (CPLR 214-a), so you have time, but records are easier to get early. Do you still have the bottle and the pharmacy receipt?'],
      ['user', 'Yes, I kept the bottle and the hospital records.'],
      ['assistant', 'Good. Would you like to be put in touch with a New York attorney who handles medication errors?'],
      ['user', 'Yes.'],
      ['assistant', 'You can use the contact form below this reply.'],
    ],
  },
  {
    key: 'shoulder-dystocia', caseType: 'birth_injury', mode: 'personal', tier: 'hot', score: 84,
    dimensions: { injury_severity: 8, causation_clarity: 7, sol_status: 10, expert_viability: 8, damages_magnitude: 9 },
    preview: 'Newborn with permanent brachial plexus injury after shoulder dystocia; mother says warning signs (large baby, long labor) were not acted on. Child is 14 months old.',
    contact: { name: 'Priya Raman', phone: '9175550114', email: 'priya.raman@mail.example', bestTime: 'Weekends' },
    outcome: 'auction-won', invite: ['nakamura', 'hartwell', 'delacroix'], bids: [['delacroix', 151], ['hartwell', 260]], leadStatus: 'accepted', closedMinutesAgo: 60 * 26,
    history: [
      ['user', "My son was born 14 months ago. His shoulder got stuck during delivery and now his right arm doesn't work properly. The doctors call it Erb's palsy."],
      ['assistant', "I'm so sorry. That must be very hard for your family. Were there signs before the delivery that it could be difficult, such as an estimate that the baby was large?"],
      ['user', 'Yes, the ultrasound said he was over 10 pounds and I have gestational diabetes. Nobody talked to me about a C-section and labor went on for 20 hours.'],
      ['assistant', 'Those are the kinds of facts a birth-injury attorney and a physician reviewer would look at closely. For an injured child, New York pauses the usual deadline while the child is a minor, up to 10 years for malpractice (CPLR 208), so the deadline is not urgent, but evidence is best gathered early.'],
      ['user', 'His physical therapist says the nerve damage is probably permanent.'],
      ['assistant', 'Would you like to be put in touch with a New York attorney who handles birth injuries?'],
      ['user', 'Yes.'],
      ['assistant', 'You can use the contact form below this reply.'],
    ],
  },
  {
    key: 'pressure-ulcers', caseType: 'nursing_home', mode: 'estate', tier: 'warm', score: 72,
    dimensions: { injury_severity: 9, causation_clarity: 6, sol_status: 8, expert_viability: 6, damages_magnitude: 7 },
    preview: "Family of an 81-year-old nursing home resident who died of sepsis from untreated stage 4 pressure ulcers, 5 months ago. Asking about a wrongful death claim.",
    contact: { name: 'Michael Brennan', phone: '5165550115', email: 'mbrennan@mail.example', bestTime: 'Evenings' },
    outcome: 'no-bids', invite: ['hartwell', 'delacroix'], coldTo: [['delacroix', 'pending'], ['hartwell', 'declined', 'not_taking']], closedMinutesAgo: 60 * 30,
    history: [
      ['user', 'My father died five months ago. He was in a nursing home in Queens and developed bedsores that got infected. He died of sepsis.'],
      ['assistant', "I'm very sorry for your loss. Did the family know about the sores before he became ill?"],
      ['user', 'We found out when he was already in the hospital. The nurse there said they were stage 4 and should never have gotten that bad.'],
      ['assistant', 'Severe pressure ulcers can point to neglect. A wrongful death claim in New York is brought by the estate and generally must be started within 2 years of the death (EPTL 5-4.1). Has anyone been appointed to handle your father\'s estate?'],
      ['user', 'Not yet. I am his only son.'],
      ['assistant', 'A lawyer can explain how the estate is opened so a claim can be made. Would you like to be put in touch with a New York attorney?'],
      ['user', 'Yes.'],
      ['assistant', 'You can use the contact form below this reply.'],
    ],
  },
  {
    key: 'nerve-extraction', caseType: 'dental', mode: 'personal', tier: 'cold', score: 61,
    dimensions: { injury_severity: 6, causation_clarity: 6, sol_status: 9, expert_viability: 6, damages_magnitude: 5 },
    preview: 'Lasting numbness of the lower lip and chin after a wisdom tooth extraction 8 months ago; says no x-ray was taken of the nerve position first.',
    contact: { name: 'Kevin Liu', phone: '9295550116', email: 'kevin.liu@mail.example', bestTime: 'Lunchtime' },
    outcome: 'cold', coldTo: [['nakamura', 'accepted'], ['hartwell', 'pending']],
    history: [
      ['user', 'Eight months ago I had a wisdom tooth pulled and since then my lower lip and chin have been numb.'],
      ['assistant', "I'm sorry. Has a doctor told you whether the numbness is likely to improve?"],
      ['user', "An oral surgeon said the nerve was damaged and it may not come back. The first dentist didn't take a 3D scan before pulling it even though the tooth was close to the nerve."],
      ['assistant', 'Nerve injury after an extraction is not always malpractice, but skipping imaging when the tooth sits near the nerve is something a dental expert would review. The usual New York deadline is 2 years and 6 months (CPLR 214-a).'],
      ['user', 'Okay. I would like someone to look at it.'],
      ['assistant', 'You can use the contact form below this reply.'],
    ],
  },
  {
    key: 'va-misread', caseType: 'misdiagnosis', mode: 'personal', tier: 'cold', score: 64,
    dimensions: { injury_severity: 7, causation_clarity: 6, sol_status: 8, expert_viability: 6, damages_magnitude: 6 },
    preview: 'Veteran whose lung nodule on a VA chest x-ray was not followed up for 14 months; now stage 3 lung cancer. Federal provider: 2-year administrative claim applies.',
    contact: { name: 'Raymond Castillo', phone: '7185550117', email: 'r.castillo@mail.example', bestTime: 'Mornings' },
    outcome: 'cold', coldTo: [['delacroix', 'pending']],
    history: [
      ['user', 'I am a veteran. A chest x-ray at the VA hospital in Brooklyn showed a spot on my lung but nobody followed up for over a year.'],
      ['assistant', "I'm sorry to hear that. What happened when it was finally looked at?"],
      ['user', 'They found stage 3 lung cancer last spring. My oncologist said it was probably stage 1 when the first x-ray was taken.'],
      ['assistant', 'Care at a VA facility is a claim against the United States under the Federal Tort Claims Act. A written claim, usually on Standard Form 95, generally must be filed with the agency within 2 years (28 U.S.C. 2401(b)), and a lawsuit can follow only after it is denied or 6 months pass.'],
      ['user', 'I would like to speak with an attorney about this.'],
      ['assistant', 'You can use the contact form below this reply.'],
    ],
  },
  {
    key: 'anesthesia-awareness', caseType: 'anesthesia_error', mode: 'personal', tier: 'warm', score: 71,
    dimensions: { injury_severity: 6, causation_clarity: 7, sol_status: 9, expert_viability: 7, damages_magnitude: 6 },
    preview: 'Patient was aware and in pain during knee surgery under general anesthesia; diagnosed with PTSD afterwards. Three months ago at a private Manhattan surgery center.',
    contact: { name: 'Sofia Petrakis', phone: '6465550118', email: 'sofia.p@mail.example', bestTime: 'Afternoons' },
    outcome: 'request',
    history: [
      ['user', 'During my knee surgery three months ago I woke up. I could feel them working on my knee but I could not move or speak.'],
      ['assistant', "That sounds terrifying, and I'm sorry. Have you had any lasting effects since?"],
      ['user', 'I have nightmares and panic attacks. A psychiatrist diagnosed PTSD. The surgery center was in Manhattan.'],
      ['assistant', 'Awareness under general anesthesia can sometimes result from errors in dosing or monitoring, which an anesthesiology expert would review. The usual New York deadline is 2 years and 6 months (CPLR 214-a).'],
      ['user', 'Can someone call me about this?'],
      ['assistant', 'You can use the contact form below this reply.'],
    ],
  },
  {
    key: 'old-surgery', caseType: 'surgical_error', mode: 'personal', tier: null, score: 22,
    preview: null, contact: null, outcome: 'not-viable',
    history: [
      ['user', 'In 2016 I had back surgery and I have had pain ever since. In 2017 another doctor told me the screws were placed badly.'],
      ['assistant', "I'm sorry you have been in pain for so long. Have you spoken with a lawyer before?"],
      ['user', 'No. I want to know if I can still sue.'],
      ['assistant', 'In New York the deadline for malpractice is generally 2 years and 6 months from the surgery or the end of continuous treatment (CPLR 214-a). Exceptions are narrow, so a claim from 2016 is very likely too late. A lawyer can tell you for certain.'],
    ],
  },
];

// ── Live personas: the persona runner sends these messages to the real chat, one at a time ─────────────────────
// Each is a person the demo has not seen. What the AI replies, how the conversation scores and where the lead goes
// are all decided live.
export const PERSONAS = [
  {
    key: 'er-stroke', mode: 'personal',
    contact: { name: 'Angela Morrison', phone: '7185550121', email: 'angela.morrison@mail.example', bestTime: 'Mornings' },
    messages: [
      'Four months ago my husband went to the ER at a private hospital in Queens with a sudden bad headache, slurred speech and his face drooping on one side. They told him it was a migraine and sent him home after two hours.',
      'The next morning he could not move his left side. Another hospital said he had a stroke and it was too late for the clot-busting drug. He is 58 and now uses a wheelchair.',
      'The neurologist at the second hospital said the symptoms at the first ER were classic stroke signs and he should have had a CT scan right away. We have both hospitals\' records.',
      'Yes, we would like to speak with a lawyer about this.',
    ],
  },
  {
    key: 'sepsis-discharge', mode: 'estate',
    contact: { name: 'Luis Ortega', phone: '3475550122', email: 'luis.ortega@mail.example', bestTime: 'After 6 pm' },
    messages: [
      'My mother died seven weeks ago. She was discharged from Kings County Hospital with a fever and a high white blood cell count after gallbladder surgery.',
      'Two days later she was back by ambulance in septic shock and died the next day. The doctor at the second visit said the infection should have been caught before discharge.',
      'I am her son and the executor of her will. Nobody at the hospital explained anything to us.',
      'Yes, please put me in touch with an attorney.',
    ],
  },
  {
    key: 'retained-guidewire', mode: 'personal',
    contact: { name: 'Nadia Haddad', phone: '9175550123', email: 'nadia.haddad@mail.example', bestTime: 'Weekends' },
    messages: [
      'I had a central line put in during a hospital stay in the Bronx last year. Three weeks ago an x-ray for something else showed a piece of guidewire still in my chest.',
      'I needed a procedure to remove it and the doctor said it could have caused a blood clot. I have had chest pain for months that nobody could explain.',
      'The hospital is private, not a city hospital. I have the x-ray report that shows the wire.',
      'Yes, I want to talk to a lawyer.',
    ],
  },
  {
    key: 'too-late', mode: 'personal',
    contact: { name: 'Gary Whitfield', phone: '5165550124', email: 'gary.w@mail.example', bestTime: 'Any time' },
    messages: [
      'I had my gallbladder removed in 2017 and the surgeon nicked my bile duct. I had two more surgeries in 2017 and 2018.',
      'I have not seen that surgeon or that hospital since 2018. I just never got around to doing anything about it.',
      'Is it too late to sue?',
      'I would still like to talk to someone.',
    ],
  },
];
