Calibration integration report

Dataset: data/openfootball-2023-24-merged-augmented.json (1752 matches)

Before (original script internal heuristic):
- Matches: 1752
- Brier multi: 0.6524
- Notes: predictions concentrated in single bin (0.40-0.50)

After (integrated production model run):
- Matches: 1752
- Brier multi: 0.8263
- Platt params: a=-0.3162, b=-0.4496
- Notes: predictions still concentrated but distribution shifted; needs further feature engineering and margin tuning.

Next steps:
- Add live-adjust function into the integrated script or call `lib/footballOddsModel.ts` directly via ts-node/build.
- Add visual reliability plots (recharts) for notebook/report.
- Tune margins by league via `lib/oddsConfig.ts` and re-evaluate.
