#!/usr/bin/env ts-node
// Simple CLI to run calibration evaluation on a CSV file.
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { brierScoreMulti, reliabilityBins, plattScalingFit, plattScalingApply } from '../lib/oddsCalibration';

// Expected CSV columns: p_home,p_draw,p_away,result  where result is H/D/A
async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: calibrate-odds <file.csv>');
    process.exit(2);
  }
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error('File not found:', abs);
    process.exit(2);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(abs), crlfDelay: Infinity });
  const preds: any[] = [];
  const outcomes: ('H'|'D'|'A')[] = [];

  for await (const line of rl) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('#')) continue;
    const parts = l.split(',').map((s) => s.trim());
    if (parts[0] === 'p_home') continue; // header
    const [p_home, p_draw, p_away, result] = parts;
    preds.push({ home: Number(p_home), draw: Number(p_draw), away: Number(p_away) });
    outcomes.push(result as 'H'|'D'|'A');
  }

  const brier = brierScoreMulti(preds, outcomes);
  console.log('Brier score (multi):', brier.toFixed(4));

  // reliability for home win
  const probsHome = preds.map((p) => p.home);
  const obsHome = outcomes.map((r) => (r === 'H' ? 1 : 0));
  const bins = reliabilityBins(probsHome, obsHome, 10);
  console.log('Reliability bins (home):');
  console.table(bins.map((b) => ({ bin: `${b.lower.toFixed(2)}-${b.upper.toFixed(2)}`, avgPred: b.avgPred.toFixed(3), obsFreq: b.obsFreq.toFixed(3), count: b.count })));

  // quick platt fit for home probabilities
  const { a, b } = plattScalingFit(probsHome, obsHome, 2000, 0.4);
  const calibrated = plattScalingApply(probsHome, a, b);
  const calibratedBins = reliabilityBins(calibrated, obsHome, 10);
  console.log('Platt scaling params:', { a: a.toFixed(4), b: b.toFixed(4) });
  console.log('Calibrated reliability bins (home):');
  console.table(calibratedBins.map((b) => ({ bin: `${b.lower.toFixed(2)}-${b.upper.toFixed(2)}`, avgPred: b.avgPred.toFixed(3), obsFreq: b.obsFreq.toFixed(3), count: b.count })));
}

main().catch((e) => { console.error(e); process.exit(1); });
