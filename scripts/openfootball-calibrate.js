#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Local helpers adapted from lib/footballOddsModel.ts so this script doesn't need TS loaders
// Calibration utilities (inlined from lib/oddsCalibration.ts)
function brierScoreMulti(preds, outcomes) {
  if (preds.length !== outcomes.length) throw new Error('length mismatch');
  let sum = 0;
  for (let i = 0; i < preds.length; i += 1) {
    const p = preds[i]; const o = outcomes[i];
    const oVec = o === 'H' ? [1, 0, 0] : o === 'D' ? [0, 1, 0] : [0, 0, 1];
    const pVec = [p.home, p.draw, p.away];
    for (let j = 0; j < 3; j++) sum += (pVec[j] - oVec[j]) * (pVec[j] - oVec[j]);
  }
  return sum / preds.length;
}

function reliabilityBins(probabilities, outcomes, nBins = 10) {
  const bins = [];
  const binSize = 1 / nBins;
  for (let b = 0; b < nBins; b += 1) {
    const lower = b * binSize; const upper = (b + 1) * binSize;
    const idxs = probabilities.map((p, i) => ({ p, i })).filter((x) => x.p >= lower && x.p < upper).map((x) => x.i);
    const count = idxs.length;
    if (count === 0) bins.push({ lower, upper, avgPred: (lower + upper) / 2, obsFreq: 0, count: 0 });
    else {
      const avgPred = idxs.reduce((s, i) => s + probabilities[i], 0) / count;
      const obsFreq = idxs.reduce((s, i) => s + outcomes[i], 0) / count;
      bins.push({ lower, upper, avgPred, obsFreq, count });
    }
  }
  return bins;
}

function plattScalingFit(probabilities, outcomes, steps = 5000, lr = 0.5) {
  const eps = 1e-6;
  const logit = (p) => Math.log((p + eps) / (1 - p + eps));
  const xs = probabilities.map((p) => logit(Math.max(eps, Math.min(1 - eps, p))));
  const ys = outcomes;
  let a = 1; let b = 0;
  for (let step = 0; step < steps; step += 1) {
    let da = 0; let db = 0;
    for (let i = 0; i < xs.length; i += 1) {
      const z = a * xs[i] + b; const pred = 1 / (1 + Math.exp(-z)); const err = pred - ys[i];
      da += err * xs[i]; db += err;
    }
    a -= lr * (da / xs.length); b -= lr * (db / xs.length);
    if (step % 1000 === 0) lr *= 0.98;
  }
  return { a, b };
}

function plattScalingApply(probabilities, a, b) {
  const eps = 1e-9;
  return probabilities.map((p) => { const logit = Math.log((p + eps) / (1 - p + eps)); const z = a * logit + b; return 1 / (1 + Math.exp(-z)); });
}

function normalizeName(value = '') {
  return String(value).toLowerCase().normalize('NFD').replace(/[-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

const TEAM_RATINGS = new Map([
  ['realmadrid', 97], ['barca', 95], ['barcelona', 95], ['mancity', 96], ['manchestercity', 96],
  ['arsenal', 92], ['liverpool', 93], ['chelsea', 86], ['manunited', 84], ['manchesterunited', 84],
  ['psg', 94], ['parissaintgermain', 94], ['monaco', 82], ['marseille', 82], ['lille', 80], ['lyon', 78]
]);

function seededNoise(value = '') {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 997;
  return (hash % 17) - 8;
}

function teamRating(team) {
  const name = typeof team === 'object' && team ? team.name || '' : String(team || '');
  const key = normalizeName(name);
  for (const k of TEAM_RATINGS.keys()) {
    if (key.includes(k) || k.includes(key)) return TEAM_RATINGS.get(k) + seededNoise(key);
  }
  return 1500 + seededNoise(key); // higher baseline to match lib expectations
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// computePreMatchProbs adapted from lib/footballOddsModel.ts
function computePreMatchProbs_local(match) {
  const home = teamRating(match.homeTeam) || 1500;
  const away = teamRating(match.awayTeam) || 1500;
  const homeAdv = 55;
  let diff = (home + homeAdv) - away;
  try {
    const homeForm = match?._teamForm?.home ?? null;
    const awayForm = match?._teamForm?.away ?? null;
    const h2h = match?._teamForm?.head2head ?? null;
    if (homeForm && awayForm) {
      const formDiff = (homeForm.formScore ?? 0) - (awayForm.formScore ?? 0);
      diff += formDiff * 12;
    } else {
      const seeded = (s) => {
        let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
        return ((h % 17) - 8) / 10;
      };
      const hkey = normalizeName(((match.homeTeam && match.homeTeam.name) || match.homeTeam) || '');
      const akey = normalizeName(((match.awayTeam && match.awayTeam.name) || match.awayTeam) || '');
      diff += (seeded(hkey) - seeded(akey)) * 8;
    }
    if (h2h && typeof h2h.scoreDiff === 'number') diff += Math.max(-20, Math.min(20, h2h.scoreDiff * 6));
  } catch (e) {}
  const k = 0.0045;
  const homeStrength = sigmoid(k * diff);
  const baseDraw = Math.max(0.08, 0.32 - Math.abs(diff) * 0.00085);
  const remaining = Math.max(0.001, 1 - baseDraw);
  const homeProb = Math.max(0.001, Math.min(0.999, remaining * homeStrength));
  const awayProb = Math.max(0.001, Math.min(0.999, remaining * (1 - homeStrength)));
  const s = homeProb + baseDraw + awayProb;
  return { home: homeProb / s, draw: baseDraw / s, away: awayProb / s };
}

function probsToOdds_local(prob, margin = 1.06) {
  const clamp = (v, min = 1.01, max = 100) => Number(Math.max(min, Math.min(max, v)).toFixed(2));
  return { win: clamp(margin / Math.max(1e-9, prob.home)), draw: clamp(margin / Math.max(1e-9, prob.draw)), loss: clamp(margin / Math.max(1e-9, prob.away)) };
}

function computeModelOdds_local(match) {
  const pre = computePreMatchProbs_local(match);
  const isLive = match.status === 'IN_PLAY' || match.status === 'LIVE' || match.status === 'PAUSED';
  const probs = isLive ? pre : pre; // adjustLive not available in this script for simplicity
  const rawOdds = probsToOdds_local(probs, 1.0);
  return { win: rawOdds.win, draw: rawOdds.draw, loss: rawOdds.loss, source: 'model' };
}

const arg = process.argv[2] || 'data/openfootball-2023-24-merged-augmented.json';
if (!fs.existsSync(arg)) {
  console.error('File not found:', arg);
  process.exit(2);
}
const data = JSON.parse(fs.readFileSync(arg, 'utf8'));
const matches = data.matches || [];

const preds = [];
const outcomes = [];
for (const m of matches) {
  const home = m.team1;
  const away = m.team2;
  if (!home || !away) continue;

  const matchObj = {
    homeTeam: (typeof home === 'object' && home) || { name: home },
    awayTeam: (typeof away === 'object' && away) || { name: away },
    status: 'SCHEDULED',
  };

  let odds;
  try {
    odds = computeModelOdds_local(matchObj);
  } catch (e) {
    odds = null;
  }
  if (!odds || typeof odds.win !== 'number') {
    continue;
  }

  const inv = { home: 1 / odds.win, draw: 1 / odds.draw, away: 1 / odds.loss };
  const s = inv.home + inv.draw + inv.away || 1;
  const prob = { home: inv.home / s, draw: inv.draw / s, away: inv.away / s };

  const ft = (m.score && m.score.ft) ? m.score.ft : null;
  let result = 'D';
  if (ft && ft.length >= 2) {
    if (ft[0] > ft[1]) result = 'H';
    else if (ft[0] < ft[1]) result = 'A';
  }

  preds.push(prob);
  outcomes.push(result);
}

console.log('Matches processed:', preds.length);
if (preds.length === 0) {
  console.error('No predictions were produced.');
  process.exit(1);
}

const brier = brierScoreMulti(preds, outcomes);
console.log('Brier multi:', brier.toFixed(4));

const probsHome = preds.map(p => p.home);
const obsHome = outcomes.map(r => r === 'H' ? 1 : 0);
const bins = reliabilityBins(probsHome, obsHome, 10);
console.log('Reliability bins (home):');
console.table(bins.map(b => ({ bin: `${b.lower.toFixed(2)}-${b.upper.toFixed(2)}`, avgPred: b.avgPred.toFixed(3), obsFreq: b.obsFreq.toFixed(3), count: b.count })));

const { a, b } = plattScalingFit(probsHome, obsHome, 3000, 0.4);
const cal = plattScalingApply(probsHome, a, b);
const calBins = reliabilityBins(cal, obsHome, 10);
console.log('Platt params:', { a: a.toFixed(4), b: b.toFixed(4) });
console.log('Calibrated bins (home):');
console.table(calBins.map(b => ({ bin: `${b.lower.toFixed(2)}-${b.upper.toFixed(2)}`, avgPred: b.avgPred.toFixed(3), obsFreq: b.obsFreq.toFixed(3), count: b.count })));
