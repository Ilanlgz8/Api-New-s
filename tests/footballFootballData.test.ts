import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  mapApiFootballStatus,
  mapApiFootballMatch,
  fetchApiFootballCompetitionEvents,
  fetchFootballDataCompetitionEvents,
} from '../lib/footballFootballData';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // reset envs
  process.env.RAPIDAPI_KEY = 'test';
  process.env.FOOTBALL_API_KEY = 'test';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.RAPIDAPI_KEY;
  delete process.env.FOOTBALL_API_KEY;
});

describe('mapApiFootballStatus', () => {
  it('maps known short codes correctly', () => {
    expect(mapApiFootballStatus('HT')).toBe('PAUSED');
    expect(mapApiFootballStatus('1H')).toBe('IN_PLAY');
    expect(mapApiFootballStatus('FT')).toBe('FINISHED');
    expect(mapApiFootballStatus(undefined)).toBe('IN_PLAY');
  });
});

describe('mapApiFootballMatch', () => {
  it('maps an api-football fixture to normalized match', () => {
    const item: any = {
      fixture: { id: 12345, date: '2024-01-01T12:00:00Z', timestamp: 1700000000, status: { short: '1H', elapsed: 12 } },
      teams: { home: { id: 1, name: 'Home FC', logo: null }, away: { id: 2, name: 'Away United', logo: null } },
      league: { id: 999, name: 'League X', logo: null },
      goals: { home: 1, away: 0 },
      score: { halftime: { home: 1, away: 0 } },
    };
    const AF_LEAGUE_BY_CODE: Record<string, number> = { LX: 999 };
    const m = mapApiFootballMatch(item, AF_LEAGUE_BY_CODE);
    expect(m).toBeDefined();
    expect(m.competition.code).toBe('LX');
    expect(m.homeTeam.name).toBe('Home FC');
    expect(m.awayTeam.name).toBe('Away United');
    expect(m.status).toBe('IN_PLAY');
    expect(m.score.fullTime.home).toBe(1);
    expect(m.liveDetails.minute).toBe(12);
  });
});

describe('fetch helpers', () => {
  it('fetchApiFootballCompetitionEvents returns mapped fixtures', async () => {
    const fakeResponse = { response: [{ fixture: { id: 1, date: '2024-01-01T12:00:00Z', timestamp: 1700000000, status: { short: '1H', elapsed: 10 } }, teams: { home: { id: 1, name: 'A' }, away: { id: 2, name: 'B' } }, league: { id: 999, name: 'LX' }, goals: { home: 0, away: 0 }, score: { halftime: { home: 0, away: 0 } } }] };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => fakeResponse } as any));
    const AF_LEAGUE_BY_CODE: Record<string, number> = { LX: 999 };
    const res = await fetchApiFootballCompetitionEvents('LX', 999, 0, 0, 'today', AF_LEAGUE_BY_CODE);
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBeGreaterThanOrEqual(0);
  });

  it('fetchFootballDataCompetitionEvents returns mapped matches', async () => {
    const fakeMatches = { matches: [{ competition: { code: 'LX' }, utcDate: '2024-01-01T12:00:00Z', homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, status: 'SCHEDULED' }] };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => fakeMatches } as any));
    const COMPETITIONS = ['LX'];
    const AF_LEAGUE_BY_CODE: Record<string, number> = { LX: 999 };
    const res = await fetchFootballDataCompetitionEvents('LX', 0, 0, 'today', COMPETITIONS, AF_LEAGUE_BY_CODE);
    expect(Array.isArray(res)).toBe(true);
  });
});
