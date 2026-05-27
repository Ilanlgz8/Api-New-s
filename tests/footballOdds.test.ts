import { describe, expect, it } from 'vitest';
import { enrichMatch, findOddsForMatch, normalizeOddsEvent } from '../lib/footballOdds';

describe('footballOdds helpers', () => {
  it('builds consensus odds from bookmaker prices', () => {
    const normalized = normalizeOddsEvent({
      home_team: 'Paris Saint-Germain',
      away_team: 'Marseille',
      commence_time: '2026-05-27T18:00:00Z',
      bookmakers: [
        {
          key: 'betclic',
          title: 'Betclic',
          last_update: '2026-05-27T10:00:00Z',
          markets: [
            {
              key: 'h2h',
              outcomes: [
                { name: 'Paris Saint-Germain', price: 1.5 },
                { name: 'Draw', price: 3.4 },
                { name: 'Marseille', price: 6.1 },
              ],
            },
          ],
        },
        {
          key: 'pinnacle',
          title: 'Pinnacle',
          last_update: '2026-05-27T10:05:00Z',
          markets: [
            {
              key: 'h2h',
              outcomes: [
                { name: 'Paris Saint-Germain', price: 1.7 },
                { name: 'Draw', price: 3.2 },
                { name: 'Marseille', price: 5.9 },
              ],
            },
          ],
        },
      ],
    });

    expect(normalized.bookmaker).toBe('Consensus');
    expect(normalized.prices.home).toBe(1.6);
    expect(normalized.prices.draw).toBe(3.3);
    expect(normalized.prices.away).toBe(6.0);
  });

  it('matches odds to a match by competition and team names', () => {
    const oddsByCompetition = {
      PL: [
        {
          home: 'Manchester City',
          away: 'Arsenal',
          commenceTime: '2026-05-27T18:00:00Z',
          bookmaker: 'Consensus',
          lastUpdate: null,
          prices: { home: 1.8, draw: 3.7, away: 4.1 },
        },
      ],
    };

    const publicOdds = findOddsForMatch(
      {
        competition: { code: 'PL' },
        homeTeam: { name: 'Manchester City' },
        awayTeam: { shortName: 'Arsenal' },
        utcDate: '2026-05-27T20:00:00Z',
      },
      oddsByCompetition
    );

    expect(publicOdds?.prices.home).toBe(1.8);
    expect(publicOdds?.prices.away).toBe(4.1);
  });

  it('enriches a match with derived competition labels and odds', () => {
    const match = enrichMatch(
      {
        competition: { code: 'PL', name: 'Premier League' },
        homeTeam: { name: 'Manchester City' },
        awayTeam: { name: 'Arsenal' },
        utcDate: '2026-05-27T18:00:00Z',
      },
      {
        PL: [
          {
            home: 'Manchester City',
            away: 'Arsenal',
            commenceTime: '2026-05-27T18:00:00Z',
            bookmaker: 'Consensus',
            lastUpdate: null,
            prices: { home: 1.8, draw: 3.7, away: 4.1 },
          },
        ],
      }
    );

    expect(match.competitionName).toBe('Premier League');
    expect(match.leagueName).toBe('Premier League');
    expect(match.publicOdds?.prices.home).toBe(1.8);
  });
});
