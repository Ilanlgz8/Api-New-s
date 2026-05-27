import { describe, expect, test } from 'vitest';
import { mapPulseliveMatch, fetchPulseliveCompetitionEvents } from '../lib/footballPulselive';

describe('footballPulselive', () => {
  test('mapPulseliveMatch maps minimal payload', () => {
    const raw = {
      id: 'm1',
      kickoff: { millis: String(Date.now()) },
      home: { team: { id: 1, name: 'Home' }, score: 2 },
      away: { team: { id: 2, name: 'Away' }, score: 1 },
    };
    const mapped = mapPulseliveMatch(raw, 'PL');
    expect(mapped).toBeTruthy();
    expect(mapped.homeTeam.name).toBe('Home');
    expect(mapped.awayTeam.name).toBe('Away');
    expect(mapped.score.fullTime.home).toBe(2);
    expect(mapped.score.fullTime.away).toBe(1);
  });

  test('fetchPulseliveCompetitionEvents returns array (network may be mocked)', async () => {
    // We don't assert on external data shape; just ensure function resolves
    const res = await fetchPulseliveCompetitionEvents(-1, 1, 'today');
    expect(Array.isArray(res)).toBe(true);
  });
});
