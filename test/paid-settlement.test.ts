import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidDistribution } from '../src/paid-settlement.ts';

test('paid winner settlement sends 1% to the house and splits the remaining 99%', () => {
  const result = paidDistribution(['a', 'b', 'c'], ['a', 'b'], 1_000_000, false);
  assert.equal(result.houseMinor, 30_000);
  assert.deepEqual([...result.payouts], [['a', 1_485_000], ['b', 1_485_000]]);
  assert.equal([...result.payouts.values()].reduce((sum, value) => sum + value, 0) + result.houseMinor, 3_000_000);
  assert.equal(result.refunds.size, 0);
});

test('flat-price paid round sends the whole pool to the house', () => {
  const result = paidDistribution(['a', 'b'], [], 1_000_000, true);
  assert.equal(result.houseMinor, 2_000_000);
  assert.equal(result.payouts.size, 0);
  assert.equal(result.refunds.size, 0);
});

test('void and no-winner paid rounds refund everyone without a fee', () => {
  for (const result of [paidDistribution(['a', 'b'], [], 1_000_000, false), paidDistribution(['a', 'b'], ['a'], 1_000_000, false, true)]) {
    assert.equal(result.houseMinor, 0);
    assert.deepEqual([...result.refunds], [['a', 1_000_000], ['b', 1_000_000]]);
  }
});
