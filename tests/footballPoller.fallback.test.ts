import { describe, it, expect, vi } from 'vitest';

// we import module dynamically so we can set global.fetch mocks before module logic
let poller: any;

describe('footballPoller Sofascore fallback', () => {
  it('falls back to football-data when Sofascore fails', async () => {
    vi.resetModules();
    process.env.FOOTBALL_API_KEY = 'test-key';
    process.env.SOFASCORE_ENABLED = 'true';
    // mock global.fetch to simulate football-data matches and failing sofascore
    (global as any).fetch = vi.fn((url: string) => {
      if (url.includes('football-data.org')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ matches: [{ id: 1, status: 'IN_PLAY', utcDate: new Date().toISOString(), homeTeam: { name: 'Team A' }, awayTeam: { name: 'Team B' }, competition: { code: 'PL', name: 'Premier League' } }] }) });
      }
      if (url.includes('the-odds-api.com')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      // Sofascore endpoints fail
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) });
    });

    poller = await import('../lib/footballPoller');

    // call pollOnce via exported function indirectly by calling startFootballPoller loop task
    // but pollOnce is internal; instead use startFootballPoller then wait a bit for one run
    poller.startFootballPoller({ idleIntervalSec: 60, liveIntervalSec: 1 });

    // wait for 1.5s to allow poll to run
    await new Promise((r) => setTimeout(r, 1500));

    const live = poller.getLiveData();
    expect(live.matches.length).toBeGreaterThan(0);
    const m = live.matches[0];
    // since Sofascore failed, match should not have liveDetails
    expect(m.liveDetails).toBeUndefined();
  }, 5000);
});
