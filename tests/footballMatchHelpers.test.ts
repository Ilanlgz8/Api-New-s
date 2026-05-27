import { describe, expect, it } from 'vitest';
import { buildProbableLineup, classifyRow, getOutcome, normalizeLineupBlock } from '../lib/footballMatchHelpers';

describe('footballMatchHelpers', () => {
  it('computes outcome and table zones', () => {
    expect(getOutcome({
      homeTeam: { id: 1 },
      awayTeam: { id: 2 },
      score: { fullTime: { home: 2, away: 1 } },
    }, 1)).toBe('W');

    expect(classifyRow({ position: 3 })).toBe('champions');
    expect(classifyRow({ position: 17 })).toBe('playoff');
  });

  it('normalizes lineups and can infer a probable lineup', () => {
    const block = normalizeLineupBlock({
      team: { name: 'PSG' },
      formation: '4-3-3',
      startXI: [{ player: { id: 9, name: 'Dembele', number: 10 } }],
      substitutes: [],
    }, 'Paris');

    expect(block.teamName).toBe('PSG');
    expect(block.official).toBe(true);
    expect(block.starters[0]).toMatchObject({ name: 'Dembele', shirtNumber: 10 });

    const probable = buildProbableLineup('PSG', [[{
      team: { name: 'PSG' },
      formation: '4-3-3',
      startXI: [{ player: { id: 9, name: 'Dembele', number: 10 } }],
    }]]);

    expect(probable.teamName).toBe('PSG');
    expect(probable.formation).toBe('4-3-3');
    expect(probable.starters).toHaveLength(1);
  });
});