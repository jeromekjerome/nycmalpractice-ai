// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.

// The topic searches that fill the case library (library-refresh.js): for each case type the classifier gives, a few
// searches of CourtListener, each a topic id and the words it searches for. The words are plain search words, written to be
// read by the owner; none names a statute. Every word of a search is required, so each topic is a few words a decision of
// its kind would hold. The nightly job runs the topics searched longest ago first, so the order here is only where a
// never-searched topic starts. Case types are the classifier's own (ask.js, CASE_TYPE_NAMES).

export const CASE_TOPICS = {
  surgical_error: [
    { id: 'surgical-error-departure', q: 'surgeon malpractice departure from accepted practice during operation' },
    { id: 'surgical-error-retained-sponge', q: 'malpractice surgical sponge left inside patient' },
    { id: 'surgical-error-wrong-site', q: 'malpractice wrong site surgery' },
    { id: 'surgical-error-perforation', q: 'malpractice surgery perforation during procedure' },
    { id: 'surgical-error-postoperative-care', q: 'malpractice postoperative care complication surgeon' },
  ],
  misdiagnosis: [
    { id: 'misdiagnosis-failure-to-diagnose', q: 'malpractice failure to diagnose physician departure causation' },
    { id: 'misdiagnosis-delayed-cancer-diagnosis', q: 'malpractice delayed diagnosis cancer' },
    { id: 'misdiagnosis-radiology', q: 'radiologist malpractice misread film imaging' },
    { id: 'misdiagnosis-emergency-room', q: 'malpractice emergency room discharged patient misdiagnosed' },
    { id: 'misdiagnosis-test-results', q: 'malpractice failure to follow up abnormal test results' },
  ],
  medication_error: [
    { id: 'medication-error-wrong-drug', q: 'malpractice wrong medication administered to patient' },
    { id: 'medication-error-dosage', q: 'malpractice medication dosage overdose' },
    { id: 'medication-error-pharmacy', q: 'pharmacist negligence prescription dispensed' },
    { id: 'medication-error-monitoring', q: 'malpractice prescribed medication failure to monitor side effects' },
    { id: 'medication-error-allergic-reaction', q: 'malpractice drug allergic reaction prescribed' },
  ],
  birth_injury: [
    { id: 'birth-injury-labor-delivery', q: 'obstetrician malpractice labor delivery infant injured' },
    { id: 'birth-injury-fetal-distress', q: 'malpractice fetal distress delayed cesarean' },
    { id: 'birth-injury-shoulder-dystocia', q: 'malpractice shoulder dystocia brachial plexus' },
    { id: 'birth-injury-oxygen-deprivation', q: 'malpractice infant brain injury oxygen deprivation birth' },
    { id: 'birth-injury-prenatal-care', q: 'malpractice prenatal care pregnancy obstetrician' },
  ],
  anesthesia_error: [
    { id: 'anesthesia-error-anesthesiologist', q: 'anesthesiologist malpractice departure anesthesia' },
    { id: 'anesthesia-error-intubation', q: 'malpractice intubation airway anesthesia' },
    { id: 'anesthesia-error-monitoring', q: 'malpractice anesthesia monitoring oxygen brain damage' },
    { id: 'anesthesia-error-nerve-block', q: 'malpractice nerve block anesthesia injury' },
    { id: 'anesthesia-error-sedation', q: 'malpractice sedation respiratory arrest procedure' },
  ],
  hospital_negligence: [
    { id: 'hospital-negligence-vicarious-liability', q: 'hospital vicarious liability malpractice employee physician' },
    { id: 'hospital-negligence-nursing-staff', q: 'hospital nursing staff negligence patient care' },
    { id: 'hospital-negligence-patient-fall', q: 'hospital patient fall negligence supervision' },
    { id: 'hospital-negligence-infection', q: 'hospital acquired infection malpractice' },
    { id: 'hospital-negligence-attending-orders', q: 'hospital staff followed private attending physician orders malpractice' },
  ],
  nursing_home: [
    { id: 'nursing-home-pressure-ulcers', q: 'nursing home resident pressure ulcers negligence' },
    { id: 'nursing-home-resident-fall', q: 'nursing home resident fall negligence supervision' },
    { id: 'nursing-home-malnutrition', q: 'nursing home resident malnutrition dehydration' },
    { id: 'nursing-home-neglect', q: 'nursing home resident neglect abuse staff' },
    { id: 'nursing-home-medical-care', q: 'nursing home malpractice resident medical care' },
  ],
  dental: [
    { id: 'dental-departure', q: 'dentist malpractice departure from accepted dental practice' },
    { id: 'dental-extraction', q: 'dental malpractice tooth extraction' },
    { id: 'dental-nerve-injury', q: 'dentist malpractice nerve injury' },
    { id: 'dental-implant', q: 'dental implant malpractice' },
    { id: 'dental-informed-consent', q: 'dentist lack of informed consent dental treatment' },
  ],
  other: [
    { id: 'other-standard-of-care', q: 'medical malpractice departure from accepted standard of care expert' },
    { id: 'other-informed-consent', q: 'medical malpractice lack of informed consent' },
  ],
};
