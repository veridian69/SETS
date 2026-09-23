#!/usr/bin/env node
// Rolling walk-forward evaluation. Each fold evolves on `fit` hours (train 70% / gate 30%),
// then the leader trades the next `test` hours that evolution never saw. Compares the evolved
// leader with buy & hold and with random genomes that merely pass the same gate.
//
// Usage: node tools/walkforward.mjs [--data dist/data/candles.js] [--fee 0.001]
//                                   [--fit 1800] [--test 600] [--step 600] [--seeds 5] [--gens 50]
//
// The bundled tape (2 399 h) is one bar short of the defaults; `--fit 1500` gives a single fold.
// For a real read, fetch a longer tape first (it is not committed, so the app stays unchanged):
//   python tools/fetch_data.py --hours 8760 --out data/btc-1y.js
//   node tools/walkforward.mjs --data data/btc-1y.js

import { pathToFileURL } from 'node:url';
import { makeSeries } from '../dist/engine/series.js';
import { backtest, FEE, setFee } from '../dist/engine/bot.js';
import { Evolution, randomGenome, passesGate } from '../dist/engine/evolution.js';
import { mulberry32 } from '../dist/engine/rng.js';

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const compound = (a) => a.reduce((x, y) => x * (1 + y), 1) - 1;
const tstat = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a), sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  return sd > 0 ? m / (sd / Math.sqrt(a.length)) : NaN;
};

export function walkForward(candles, { fit = 1800, test = 600, step = 600, seeds = 5, gens = 50, fee = 0.001, randomTries = 3000, randomKeep = 25 } = {}) {
  for (const [k, v] of Object.entries({ fit, test, step })) {
    if (!Number.isInteger(v) || v <= 0) throw new RangeError(`${k} must be a positive integer, got ${v}`);
  }
  // Summaries compound and t-test folds as independent observations, so test windows must not overlap.
  if (step < test) throw new RangeError(`step (${step}) must be >= test (${test}) so test windows do not overlap`);
  const prevFee = FEE;
  setFee(fee);
  try { return run(candles, { fit, test, step, seeds, gens, fee, randomTries, randomKeep }); } finally { setFee(prevFee); }
}

function run(candles, { fit, test, step, seeds, gens, fee, randomTries, randomKeep }) {
  const folds = [];
  for (let a = 0; a + fit + test <= candles.length; a += step) {
    const sub = makeSeries(candles.slice(a, a + fit));           // everything the search may see
    const full = makeSeries(candles.slice(a, a + fit + test));   // plus the unseen test window
    const bh = full.close[full.n - 1] / full.open[fit] - 1;

    const evolved = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const ev = new Evolution(sub, { seed, split: 0.7 });
      for (let g = 0; g < gens; g++) ev.step();
      evolved.push(ev.leader ? backtest(ev.leader.genome, full, fit, full.n).ret : 0); // no leader: stay in cash
    }

    // baseline: random genomes that pass the same OOS gate, no evolution at all
    const r = mulberry32(a + 7), split = Math.floor(sub.n * 0.7), random = [];
    for (let tried = 0; tried < randomTries && random.length < randomKeep; tried++) {
      const g = randomGenome(r);
      if (passesGate(backtest(g, sub, split, sub.n))) random.push(backtest(g, full, fit, full.n).ret);
    }

    folds.push({ from: candles[a + fit][0], to: candles[a + fit + test - 1][0], bh, evolved: mean(evolved), random: mean(random), randomPassed: random.length });
  }
  const col = (k) => folds.map((f) => f[k]);
  const summary = {};
  for (const k of ['bh', 'evolved', 'random']) summary[k] = { mean: mean(col(k)), compounded: compound(col(k)), t: tstat(col(k)) };
  return { fee, folds, summary };
}

function args() {
  const o = { data: 'dist/data/candles.js' };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) {
    const k = v[i].replace(/^--/, '');
    o[k] = k === 'data' ? v[i + 1] : Number(v[i + 1]);
  }
  return o;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const o = args();
  const { CANDLES } = await import(pathToFileURL(o.data).href);
  const res = walkForward(CANDLES, o);
  const pct = (x) => (x * 100).toFixed(1).padStart(6) + '%';
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  console.log(`${CANDLES.length} candles, fee ${res.fee * 100}%, ${res.folds.length} folds\n`);
  if (!res.folds.length) { console.log(`tape too short: need at least fit + test = ${(o.fit ?? 1800) + (o.test ?? 600)} candles. Lower --fit or fetch a longer tape (see header).`); process.exit(1); }
  console.log('fold  test window              buy&hold  evolved  random-gated');
  res.folds.forEach((f, i) => console.log(`${String(i + 1).padStart(3)}   ${day(f.from)}..${day(f.to)}  ${pct(f.bh)}   ${pct(f.evolved)}  ${pct(f.random)} (${f.randomPassed} passed)`));
  console.log();
  for (const k of ['bh', 'evolved', 'random']) {
    const s = res.summary[k];
    console.log(`${k.padEnd(9)} mean/fold ${pct(s.mean)}  compounded ${pct(s.compounded)}  t=${Number.isNaN(s.t) ? 'n/a' : s.t.toFixed(2)}`);
  }
}
