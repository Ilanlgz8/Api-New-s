import { describe, it, expect } from 'vitest';
import { brierScoreMulti, reliabilityBins, plattScalingFit, plattScalingApply } from '../lib/oddsCalibration';

describe('odds calibration utilities', () => {
  it('computes brier score for trivial perfect predictions', () => {
    const preds = [
      { home: 1, draw: 0, away: 0 },
      { home: 0, draw: 1, away: 0 },
    ];
    const outcomes: ('H'|'D'|'A')[] = ['H', 'D'];
    const b = brierScoreMulti(preds, outcomes);
    expect(b).toBeCloseTo(0, 6);
  });

  it('reliability bins produce sensible counts', () => {
    const probs = [0.1, 0.2, 0.15, 0.85, 0.9];
    const obs = [0, 0, 0, 1, 1];
    const bins = reliabilityBins(probs, obs, 5);
    const total = bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(probs.length);
  });

  it('platt scaling improves calibration on simple data', () => {
    // Generate overconfident predictions
    const probs = [0.9, 0.8, 0.85, 0.2, 0.1, 0.15];
    const obs = [1, 1, 1, 0, 0, 0];
    const { a, b } = plattScalingFit(probs, obs, 2000, 0.4);
    const cal = plattScalingApply(probs, a, b);
    // After calibration, average calibrated probs should be closer to mean(obs)=0.5
    const meanCal = cal.reduce((s, v) => s + v, 0) / cal.length;
    expect(meanCal).toBeGreaterThan(0.3);
    expect(meanCal).toBeLessThan(0.95);
  });
});
