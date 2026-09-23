import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkForward } from '../tools/walkforward.mjs';
import { FEE } from '../dist/engine/bot.js';
import { CANDLES } from '../dist/data/candles.js';

const small = { fit: 900, test: 300, step: 300, seeds: 2, gens: 3, randomTries: 200, randomKeep: 5 };

test('walk-forward folds tile the tape and never overlap their own fit window', () => {
  const { folds } = walkForward(CANDLES, small);
  assert.equal(folds.length, Math.floor((CANDLES.length - 900 - 300) / 300) + 1);
  folds.forEach((f, i) => {
    assert.equal(f.from, CANDLES[i * 300 + 900][0]);          // test starts right after the fit window
    assert.equal(f.to, CANDLES[i * 300 + 900 + 300 - 1][0]);   // and is exactly `test` bars long
  });
});

test('walk-forward is deterministic, fee-sensitive, and restores the fee', () => {
  const before = FEE;
  const a = walkForward(CANDLES, { ...small, fee: 0.002 });
  const b = walkForward(CANDLES, { ...small, fee: 0.002 });
  const c = walkForward(CANDLES, { ...small, fee: 0 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(FEE, before);
});
