// Copyright (c) 2026 Jerome W. Dewald. All rights reserved.
// Source available for evaluation only; see LICENSE.

// The JSON each of this app's small jobs answers in (job-schemas.js), as its caller reads it and its prompt asks
// for it.
import './test-settings.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from './runner.mjs';
import { SCHEMAS } from '../job-schemas.js';

const fields = schema => Object.keys(schema.properties);
const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('each small job has a schema, naming the fields its caller reads, and this app, which has no seminar, has no seminar score', () => {
  assert.deepEqual(Object.keys(SCHEMAS), ['classify', 'leadScore', 'caseCard', 'grade']);
  assert.deepEqual(fields(SCHEMAS.classify), ['type', 'terms']);
  assert.deepEqual(fields(SCHEMAS.leadScore), ['viable', 'score', 'dimensions', 'preview', 'confidence']);
  assert.deepEqual(fields(SCHEMAS.caseCard), ['score', 'verdict', 'complexityEstimate', 'solWarning', 'strengths', 'weaknesses']);
  assert.deepEqual(fields(SCHEMAS.caseCard.properties.complexityEstimate.anyOf[0]), ['level', 'reason']);
  assert.deepEqual(fields(SCHEMAS.grade), ['required_checks', 'prohibited_checks', 'coaching']);
  assert.deepEqual(fields(SCHEMAS.grade.properties.required_checks.items), ['id', 'name', 'passed', 'evidence_or_gap']);
  assert.deepEqual(fields(SCHEMAS.grade.properties.prohibited_checks.items), ['id', 'name', 'violated', 'offending_quote', 'remediation_instruction']);
});

test("the lead score's five marks are the ones the scorer's prompt asks for, the time limit among them", () => {
  // The marks as the prompt in auction.js writes them, in its order. The time limit's mark (sol_status) is what keeps
  // a claim likely out of time from ever being a lead.
  const asked = [...source('auction.js').match(/"dimensions": \{([^}]*)\}/)[1].matchAll(/"(\w+)":/g)].map(match => match[1]);
  assert.deepEqual(asked, ['injury_severity', 'causation_clarity', 'sol_status', 'expert_viability', 'damages_magnitude']);
  assert.deepEqual(fields(SCHEMAS.leadScore.properties.dimensions), asked);
});

test('where a prompt offers a fixed set of answers, its schema allows those and no others', () => {
  // The classifier's categories, one a line, as courtlistener.js writes them.
  const categories = source('courtlistener.js').match(/Categories:\n([\s\S]*?)\n\n/)[1];
  assert.deepEqual(SCHEMAS.classify.properties.type.enum, [...categories.matchAll(/^- ([a-z_]+):/gm)].map(match => match[1]));
  // The case card's verdict and complexity, as ask.js writes them.
  const offered = pattern => source('ask.js').match(pattern)[1].split(/\s*\|\s*/);
  assert.deepEqual(SCHEMAS.caseCard.properties.verdict.enum, offered(/"verdict": "<([a-z |]+)>"/));
  assert.deepEqual(SCHEMAS.caseCard.properties.complexityEstimate.anyOf[0].properties.level.enum, offered(/"level": "<([A-Za-z |]+)>"/));
});

test('where the case card prompt allows null, its schema takes null beside the field', () => {
  // The prompt allows no complexity when too little is known, and no deadline warning when none applies.
  const ask = source('ask.js');
  assert.match(ask, /- complexityEstimate: null if too little is known/);
  assert.match(ask, /"solWarning": "<[^"]*, or null>"/);
  const nothing = { type: 'null' };
  assert.deepEqual(SCHEMAS.caseCard.properties.complexityEstimate.anyOf[1], nothing);
  assert.deepEqual(SCHEMAS.caseCard.properties.solWarning, { anyOf: [{ type: 'string' }, nothing] });
});

test('every object in a schema requires each of its fields and allows no other', () => {
  const objects = [];
  const visit = (node, at) => {
    if (node.type === 'object') objects.push([at, node]);
    for (const [name, child] of Object.entries(node.properties ?? {})) visit(child, `${at}.${name}`);
    if (node.items) visit(node.items, `${at}[]`);
    for (const option of node.anyOf ?? []) visit(option, at);
  };
  for (const [job, schema] of Object.entries(SCHEMAS)) visit(schema, job);
  // The four jobs, the lead score's marks, the case card's complexity, and each kind of check the grader returns.
  assert.equal(objects.length, 8);
  for (const [at, node] of objects) {
    assert.deepEqual(node.required, Object.keys(node.properties), at);
    assert.equal(node.additionalProperties, false, at);
  }
});
