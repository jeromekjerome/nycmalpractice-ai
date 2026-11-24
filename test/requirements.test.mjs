import './test-settings.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from './runner.mjs';
import { calculateRefund } from '../auction.js';

test('a refund depends only on recent declines and the kind of lead', () => {
  assert.equal(calculateRefund.length, 3);
  assert.equal(calculateRefund({ cold: 0, auction: 0 }, false, 25), 25);
  assert.equal(calculateRefund({ cold: 3, auction: 0 }, false, 25), 12.5);
  assert.equal(calculateRefund({ cold: 0, auction: 0 }, true, 100), 50);
  assert.equal(calculateRefund({ cold: 0, auction: 1 }, true, 100), 25);
  assert.equal(calculateRefund({ cold: 0, auction: 2 }, true, 100), 0);
  const code = readFileSync(new URL('../auction.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /retained_at|case_outcome|contingency|fee_percent/i);
});
