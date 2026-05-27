import { describe, expect, it } from 'vitest';
import { normalizeEventCompetition, sameDay } from '../lib/footballRouteHelpers';

describe('footballRouteHelpers', () => {
  it('compares dates by day', () => {
    expect(sameDay('2026-05-27T10:00:00Z', '2026-05-27T23:59:00Z')).toBe(true);
    expect(sameDay('2026-05-27T10:00:00Z', '2026-05-28T00:00:00Z')).toBe(false);
  });

  it('infers european competition codes from labels', () => {
    const match = normalizeEventCompetition({
      competition: { name: 'UEFA Europa League' },
      competitionName: 'UEFA Europa League',
      leagueName: 'UEFA Europa League',
    }, {
      UEL: { name: 'Europa League' },
      UECL: { name: 'Conference League' },
      CL: { name: 'Champions League' },
    });

    expect(match.competition?.code).toBe('UEL');
    expect(match.competition?.name).toBe('Europa League');
  });
});