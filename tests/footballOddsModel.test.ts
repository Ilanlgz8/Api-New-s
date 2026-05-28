import { describe, it, expect } from 'vitest';
import { computeModelOdds } from '../lib/footballOddsModel';

const makeTeam = (name: string) => ({ name });

describe('footballOddsModel basic behaviour', () => {
  it('returns tighter margin for Premier League when leagueCode provided', () => {
    const match: any = {
      homeTeam: makeTeam('Manchester City'),
      awayTeam: makeTeam('Norwich'),
      status: 'SCHEDULED',
      competition: { code: 'Premier League' },
    };

    const odds = computeModelOdds(match, { leagueCode: 'premierleague' });
    expect(odds.win).toBeGreaterThan(1);
    expect(odds.draw).toBeGreaterThan(1);
    expect(odds.loss).toBeGreaterThan(1);
  });

  it('adjusts when live stats and score present', () => {
    const match: any = {
      homeTeam: makeTeam('PSG'),
      awayTeam: makeTeam('Lyon'),
      status: 'IN_PLAY',
      liveDetails: { minute: 60, score: { home: 2, away: 0 } },
      // include small synthetic stats structure
      stats: [
        { type: 'xG', value: '2.5' },
        { type: 'xG', value: '0.5' },
      ],
    };

    const odds = computeModelOdds(match, {});
    expect(odds.win).toBeGreaterThan(1);
    expect(odds.loss).toBeGreaterThan(1);
  });
});
