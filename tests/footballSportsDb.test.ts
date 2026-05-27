import { describe, expect, it } from 'vitest';
import { mapSportsDbMatch, matchSportsDbCompetition } from '../lib/footballSportsDb';

describe('footballSportsDb', () => {
  it('matches league names to competition codes', () => {
    expect(matchSportsDbCompetition('UEFA Europa League')).toBe('UEL');
    expect(matchSportsDbCompetition('Bundesliga')).toBe('BL1');
  });

  it('normalizes a SportsDB match with competition metadata', () => {
    const match = mapSportsDbMatch(
      {
        idEvent: '123',
        strLeague: 'Ligue 1',
        strStatus: 'Not Started',
        dateEvent: '2026-05-27',
        strTime: '20:00:00',
        strHomeTeam: 'PSG',
        strAwayTeam: 'Lyon',
      },
      { FL1: { name: 'Ligue 1', emblem: 'badge.png' } }
    );

    expect(match).toMatchObject({
      id: '123',
      competition: { code: 'FL1', name: 'Ligue 1', emblem: 'badge.png' },
      homeTeam: { name: 'PSG' },
      awayTeam: { name: 'Lyon' },
    });
  });
});
