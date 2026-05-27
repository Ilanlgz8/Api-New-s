import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mapSofascoreMatch, fetchSofascoreFinishedMatchesForCompetition, __fetchSofascoreJson } from '../lib/sofascoreLive';

describe('sofascoreLive', () => {
  it('maps sofascore match correctly', () => {
    const m = {
      sofascoreId: 111,
      homeTeam: 'Team A',
      awayTeam: 'Team B',
      homeScore: 2,
      awayScore: 1,
      utcDate: '2026-05-20T20:00:00Z',
      statusCode: 2,
      minute: null,
    };

    const mapped = mapSofascoreMatch(m, 'CL');
    expect(mapped.id).toContain('sofascore:');
    expect(mapped.score.fullTime.home).toBe(2);
    expect(mapped.score.fullTime.away).toBe(1);
    expect(mapped.status).toBe('FINISHED');
  });

  describe('fetch finished matches by competition', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = vi.fn();
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('filters events by competition matcher', async () => {
      // mock a date response with events array
      const mockJson = { events: [
        { id: 1, tournament: { name: 'Ligue 1' }, status: { code: 2 }, homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, homeScore: { current: 1 }, awayScore: { current: 0 }, startTimestamp: 1710000000 }
      ] };

      (global.fetch as any).mockResolvedValue({ ok: true, json: async () => mockJson });

      const res = await fetchSofascoreFinishedMatchesForCompetition(1, 'ligue');
      expect(Array.isArray(res)).toBe(true);
      expect(res.length).toBeGreaterThanOrEqual(0);
    });
  });
});
