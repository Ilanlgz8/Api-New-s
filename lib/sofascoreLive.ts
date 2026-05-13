/**
 * Sofascore Live API - Fetch live match data with real-time minute and score
 * Uses undocumented but public Sofascore endpoints
 */

import { withCache } from './cache';

const SOFASCORE_BASE = 'https://api.sofascore.com/api/v1';

interface SofascoreMatch {
  id: number;
  slug: string;
  status: {
    code: number; // 0=scheduled, 1=in_play, 2=finished, 3=postponed, 4=cancelled
    description: string;
  };
  homeTeam: {
    id: number;
    name: string;
    slug: string;
  };
  awayTeam: {
    id: number;
    name: string;
    slug: string;
  };
  homeScore: {
    current: number;
    display: number;
  };
  awayScore: {
    current: number;
    display: number;
  };
  currentPeriodStartTimestamp?: number;
  changed?: boolean;
}

interface SofascoreMatchDetail {
  match: SofascoreMatch;
  liveOdds?: any;
}

async function fetchSofascoreJson(path: string, timeoutMs = 5000) {
  try {
    const url = `${SOFASCORE_BASE}${path}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; Dashboard/1.0)',
      },
    });

    if (!res.ok) {
      console.warn(`[Sofascore] ${path} returned ${res.status}`);
      return null;
    }

    return res.json().catch(() => null);
  } catch (e) {
    console.warn(`[Sofascore] Fetch error for ${path}:`, (e as any)?.message?.slice(0, 50));
    return null;
  }
}

/**
 * Fetch live matches from Sofascore (Champions League specific)
 * Returns matches with real-time minute and score
 */
export async function fetchSofascoreLiveMatches() {
  const cacheKey = 'sofascore:live:cl';
  const { data } = await withCache(cacheKey, 30, async () => {
    try {
      // Sofascore endpoint for live matches - uses undocumented but public API
      const liveRes = await fetchSofascoreJson('/sport/football/live');
      if (!liveRes?.events) return [];

      // Filter for Champions League (Sofascore ID: 679 for CL)
      const clMatches = (liveRes.events ?? []).filter((m: any) => {
        const leagueId = m.tournament?.id;
        // Champions League = 679, but also check name
        return leagueId === 679 || 
               m.tournament?.name?.includes('Champions League') ||
               m.tournament?.name?.includes('UEFA');
      });

      return clMatches.map((m: any) => ({
        sofascoreId: m.id,
        homeTeam: m.homeTeam?.name ?? 'Home',
        awayTeam: m.awayTeam?.name ?? 'Away',
        homeScore: m.homeScore?.current ?? m.homeScore?.display ?? null,
        awayScore: m.awayScore?.current ?? m.awayScore?.display ?? null,
        statusCode: m.status?.code, // 1 = in_play, 2 = finished
        minute: m.currentPeriodStartTimestamp ? 
          Math.floor((Date.now() - m.currentPeriodStartTimestamp * 1000) / 60000) : 
          null,
        utcDate: m.startTimestamp ? new Date(m.startTimestamp * 1000).toISOString() : null,
        tournament: m.tournament?.name ?? 'CL',
      }));
    } catch (e) {
      console.warn('[Sofascore] Live fetch error:', (e as any)?.message?.slice(0, 50));
      return [];
    }
  });

  return data as any[];
}

/**
 * Fetch finished matches from Sofascore (last 2-3 days)
 * Used to populate Results snapshot with CL scores
 */
export async function fetchSofascoreFinishedMatches(daysBack = 3) {
  const matches: any[] = [];

  // Try to fetch multiple pages of finished matches
  for (let day = 0; day <= daysBack; day++) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() - day);
    const dateStr = targetDate.toISOString().slice(0, 10);

    const cacheKey = `sofascore:finished:${dateStr}`;
    const { data } = await withCache(cacheKey, 60 * 60, async () => {
      try {
        // Sofascore endpoint for matches by date
        const dateRes = await fetchSofascoreJson(`/sport/football/events/${dateStr}`);
        if (!dateRes?.events) return [];

        // Filter for Champions League finished matches
        const clFinished = (dateRes.events ?? [])
          .filter((m: any) => {
            const leagueId = m.tournament?.id;
            const isFinished = m.status?.code === 2; // 2 = finished
            return isFinished && (leagueId === 679 || m.tournament?.name?.includes('Champions League'));
          })
          .map((m: any) => ({
            sofascoreId: m.id,
            homeTeam: m.homeTeam?.name ?? 'Home',
            awayTeam: m.awayTeam?.name ?? 'Away',
            homeScore: m.homeScore?.current ?? m.homeScore?.display ?? null,
            awayScore: m.awayScore?.current ?? m.awayScore?.display ?? null,
            utcDate: m.startTimestamp ? new Date(m.startTimestamp * 1000).toISOString() : `${dateStr}T20:00:00Z`,
            tournament: 'Champions League',
            source: 'sofascore',
          }));

        return clFinished;
      } catch (e) {
        return [];
      }
    });

    if (data && data.length) {
      matches.push(...data);
    }
  }

  // Dedupe by id
  const seen = new Set<number>();
  return matches.filter((m) => {
    if (seen.has(m.sofascoreId)) return false;
    seen.add(m.sofascoreId);
    return true;
  });
}

/**
 * Convert Sofascore match to standard match object
 */
export function mapSofascoreMatch(m: any, competition = 'CL') {
  const statusMap: Record<number, string> = {
    0: 'SCHEDULED',
    1: 'IN_PLAY',
    2: 'FINISHED',
    3: 'POSTPONED',
    4: 'CANCELLED',
  };

  const status = statusMap[m.statusCode] || 'SCHEDULED';

  return {
    id: `sofascore:${m.sofascoreId}`,
    status,
    utcDate: m.utcDate || new Date().toISOString(),
    homeTeam: {
      name: m.homeTeam,
    },
    awayTeam: {
      name: m.awayTeam,
    },
    competition: {
      code: competition,
      name: 'Champions League',
    },
    score: {
      fullTime: {
        home: m.homeScore,
        away: m.awayScore,
      },
    },
    liveDetails:
      status === 'IN_PLAY' || status === 'PAUSED'
        ? {
            minute: m.minute ?? null,
            source: 'sofascore',
            score: {
              home: m.homeScore,
              away: m.awayScore,
            },
          }
        : null,
    liveSource: status === 'IN_PLAY' || status === 'PAUSED' ? 'sofascore' : undefined,
    source: 'sofascore',
  };
}

export default {};
