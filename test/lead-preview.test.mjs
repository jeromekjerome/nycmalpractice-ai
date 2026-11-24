// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The check on the summary firms see before bidding (lead-preview.js).
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { test } from './runner.mjs';
import { previewForFirms } from '../lead-preview.js';

const contact = { name: "Maria O'Brien-Lopez", phone: '5551234567', email: 'maria@example.com' };
const label = 'motor vehicle';
const fallback = 'A motor vehicle request in New York.';

test('a summary with none of the visitor details is kept as written', () => {
  const kept = 'A rear-end crash in March with a neck injury.';
  assert.equal(previewForFirms(kept, contact, label), kept);
  assert.equal(previewForFirms(kept, null, label), kept);
  assert.equal(previewForFirms('A fall in a store.', { name: 'Dr. J. Smith' }, label), 'A fall in a store.');
});
test('a summary holding any part of the visitor name is replaced', () => {
  for (const text of ['Maria was hit.', 'MARIA was hit.', "Ms. O'Brien fell.", 'Ms. O’Brien fell.', 'Lopez was hit.']) assert.equal(previewForFirms(text, contact, label), fallback, text);
  assert.equal(previewForFirms('The driver will not pay.', { name: 'Will Roe' }, label), fallback);
});
test('a summary holding a phone number, email address or street address is replaced', () => {
  for (const text of ['Call 555-123-4567.', 'Call (555) 123-4567.', 'Call 5551234567.', 'Call 555.123.4567.', 'Her son is at 212-555-0199.', 'Write maria@example.com.', 'Write a.b@c.org.', 'Hit at 123 Main Street.', 'Lives at 45 W 34th St.', 'Hit at 123 main street.', 'Lives at 45 w 34th st.']) {
    assert.equal(previewForFirms(text, contact, label), fallback, text);
  }
});
test('a missing summary becomes the case type, with the right article', () => {
  for (const empty of ['', '   ', null, undefined, 42]) assert.equal(previewForFirms(empty, contact, label), fallback);
  assert.equal(previewForFirms('', null, 'anesthesia error'), 'An anesthesia error request in New York.');
});
test('timeline and amount phrases are kept as written', () => {
  for (const text of ['Settled 3 weeks in court.', '2 months in court after the crash.', 'A crash in 2023 with 3 broken ribs.', 'Bills reached 1234567 dollars.', '10 days after ER drive.', 'Settled 3 Weeks In Court.']) {
    assert.equal(previewForFirms(text, contact, label), text);
  }
});
