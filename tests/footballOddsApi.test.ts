import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOddsByCompetition } from '../lib/footballOdds';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('footballOdds api helpers', () => {
  it('fetches and normalizes api-football odds for FL1', async () => {
    vi.stubEnv('RAPIDAPI_KEY', 'test-key');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        response: [{
          fixture: { date: '2026-05-27T20:00:00Z', teams: { home: { name: 'PSG' }, away: { name: 'Lyon' } } },
          bookmakers: [{
            name: 'Book',
            bets: [{
              name: 'Match Winner',
              values: [
                { value: 'PSG', odd: '1.50' },
                { value: 'Draw', odd: '4.10' },
                { value: 'Lyon', odd: '6.25' },
              ],
            }],
          }],
        }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const odds = await getOddsByCompetition(['FL1']);

    expect(fetchMock).toHaveBeenCalled();
    expect(odds['FL1']).toHaveLength(1);
    expect(odds['FL1'][0]).toMatchObject({
      home: 'PSG',
      away: 'Lyon',
      source: 'api-football-odds',
    });
  });
});