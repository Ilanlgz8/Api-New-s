import { describe, expect, it } from 'vitest';
import { mapOpenLigaDbMatch } from '../lib/footballOpenLiga';

describe('footballOpenLiga', () => {
  it('maps a basic OpenLiga match', () => {
    const raw = {
      MatchID: 'm123',
      MatchDateTimeUTC: '2026-05-27T20:00:00Z',
      MatchIsFinished: false,
      Team1: { TeamId: 1, TeamName: 'HomeFC', TeamIconUrl: null },
      Team2: { TeamId: 2, TeamName: 'AwayFC', TeamIconUrl: null },
      MatchResults: [],
    };

    const mapped = mapOpenLigaDbMatch(raw, 'FL1', { FL1: { name: 'Ligue 1' } });
    expect(mapped).toMatchObject({
      id: 'm123',
      competition: { code: 'FL1', name: 'Ligue 1' },
      homeTeam: { name: 'HomeFC' },
      awayTeam: { name: 'AwayFC' },
    });
  });
});
