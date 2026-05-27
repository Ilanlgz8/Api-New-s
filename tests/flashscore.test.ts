import { describe, it, expect } from 'vitest';
import { mapFlashscoreMatch } from '../lib/flashscoreLive';

describe('flashscoreLive', () => {
  it('maps flashscore match to normalized object', () => {
    const m = {
      id: 'm1',
      homeTeam: 'Team H',
      awayTeam: 'Team A',
      homeScore: 3,
      awayScore: 2,
      status: 'FINISHED',
      minute: null,
      timestamp: 1620000000000,
      league: 'Champions League',
    };

    const mapped = mapFlashscoreMatch(m as any, 'CL');
    expect(mapped.id).toBe('flashscore:m1');
    expect(mapped.score.fullTime.home).toBe(3);
    expect(mapped.score.fullTime.away).toBe(2);
    expect(mapped.competition.code).toBe('CL');
  });
});
