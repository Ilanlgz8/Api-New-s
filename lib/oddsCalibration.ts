type MultiProb = { home: number; draw: number; away: number };

export function brierScoreMulti(preds: MultiProb[], outcomes: ('H' | 'D' | 'A')[]) {
  if (preds.length !== outcomes.length) throw new Error('length mismatch');
  let sum = 0;
  for (let i = 0; i < preds.length; i += 1) {
    const p = preds[i];
    const o = outcomes[i];
    const oVec = o === 'H' ? [1, 0, 0] : o === 'D' ? [0, 1, 0] : [0, 0, 1];
    const pVec = [p.home, p.draw, p.away];
    sum += pVec.reduce((acc, pv, j) => acc + (pv - oVec[j]) * (pv - oVec[j]), 0);
  }
  return sum / preds.length;
}

export function reliabilityBins(probabilities: number[], outcomes: number[], nBins = 10) {
  // probabilities: predicted probability for the target class (e.g., home win)
  // outcomes: 0/1 observed for that class
  const bins: { lower: number; upper: number; avgPred: number; obsFreq: number; count: number }[] = [];
  const binSize = 1 / nBins;

  for (let b = 0; b < nBins; b += 1) {
    const lower = b * binSize;
    const upper = (b + 1) * binSize;
    const idxs = probabilities.map((p, i) => ({ p, i })).filter((x) => x.p >= lower && x.p < upper).map((x) => x.i);
    const count = idxs.length;
    if (count === 0) {
      bins.push({ lower, upper, avgPred: (lower + upper) / 2, obsFreq: 0, count: 0 });
      continue;
    }
    const avgPred = idxs.reduce((s, i) => s + probabilities[i], 0) / count;
    const obsFreq = idxs.reduce((s, i) => s + outcomes[i], 0) / count;
    bins.push({ lower, upper, avgPred, obsFreq, count });
  }
  return bins;
}

export function plattScalingFit(probabilities: number[], outcomes: number[], steps = 5000, lr = 0.5) {
  // Fit a logistic regression on logit(p): sigmoid(a*logit(p)+b)
  // probabilities in (0,1)
  const eps = 1e-6;
  const logit = (p: number) => Math.log((p + eps) / (1 - p + eps));
  const xs = probabilities.map((p) => logit(Math.max(eps, Math.min(1 - eps, p))));
  const ys = outcomes;

  let a = 1;
  let b = 0;

  for (let step = 0; step < steps; step += 1) {
    let da = 0;
    let db = 0;
    let loss = 0;
    for (let i = 0; i < xs.length; i += 1) {
      const z = a * xs[i] + b;
      const pred = 1 / (1 + Math.exp(-z));
      const err = pred - ys[i];
      loss += -(ys[i] * Math.log(pred + eps) + (1 - ys[i]) * Math.log(1 - pred + eps));
      da += err * xs[i];
      db += err;
    }
    // gradient descent update
    a -= lr * (da / xs.length);
    b -= lr * (db / xs.length);
    // small learning rate schedule
    if (step % 1000 === 0) lr *= 0.98;
  }

  return { a, b };
}

export function plattScalingApply(probabilities: number[], a: number, b: number) {
  const eps = 1e-9;
  return probabilities.map((p) => {
    const logit = Math.log((p + eps) / (1 - p + eps));
    const z = a * logit + b;
    return 1 / (1 + Math.exp(-z));
  });
}

export default {
  brierScoreMulti,
  reliabilityBins,
  plattScalingFit,
  plattScalingApply,
};
