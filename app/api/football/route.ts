import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_TTL, getCacheEntry, setCacheEntry, withCache, withStaleCache } from '@/lib/cache';
import { getLiveData, startFootballPoller } from '@/lib/footballPoller';
import { fetchSofascoreLiveMatches, fetchSofascoreFinishedMatches, fetchSofascoreFinishedMatchesForCompetition, fetchSofascoreCompetitionWindow, mapSofascoreMatch } from '@/lib/sofascoreLive';
import { startFlashscoreLive, getFlashscoreLiveMatches, mapFlashscoreMatch } from '@/lib/flashscoreLive';
import { storeScore, enrichWithStoredScore } from '@/lib/scoreDatabase';
import { normalizeEventCompetition } from '@/lib/footballRouteHelpers';
import { ODDS_BASE, ODDS_SPORT_KEYS, enrichMatch, getOddsByCompetition } from '@/lib/footballOdds';
import { mapPulseliveMatch, fetchPulseliveCompetitionEvents } from '@/lib/footballPulselive';
import * as FFD from '@/lib/footballFootballData';
import { COMPETITIONS, COMP_INFO, AF_LEAGUE_BY_CODE, WIDGET_RETENTION_DAYS, L1_OFFICIAL_BASE, COMP_SOURCES, SOURCE_STATS, SOURCE_MIN_INTERVAL_MS } from '@/lib/footballConstants';

async function throttleFor(source: string) {
  const min = SOURCE_MIN_INTERVAL_MS[source] ?? 0;
  const stats = SOURCE_STATS[source];
  const last = stats?.lastFetch ?? 0;
  const elapsed = Date.now() - last;
  if (elapsed < min) {
    await new Promise((resolve) => setTimeout(resolve, min - elapsed));
  }
  try {
    if (stats) stats.lastFetch = Date.now();
  } catch {}
}

function recordSourceAttempt(source: string, success: boolean) {
  try {
    const stats = SOURCE_STATS[source];
    if (!stats) return;
    if (success) stats.successes = (stats.successes ?? 0) + 1;
    else stats.failures = (stats.failures ?? 0) + 1;
    stats.lastFetch = Date.now();
  } catch {}
}
import {
  TSDB_LEAGUE_ID_BY_CODE,
  fetchSportsDbCompetitionNextEvents,
  fetchSportsDbCompetitionNextEventsFresh,
  fetchSportsDbCompetitionNextEventsStrict,
  fetchSportsDbCompetitionSeasonEvents,
  fetchSportsDbWindow,
  mapSportsDbMatch,
} from '@/lib/footballSportsDb';
import { fetchOpenLigaDbCompetitionEvents } from '@/lib/footballOpenLiga';

async function fetchJsonWithCurl(url: string, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (response.ok) return await response.json();
    const text = await response.text().catch(() => '');
    throw new Error(`fetch failed: ${response.status}${text ? ` ${text}` : ''}`);
  } finally {
    clearTimeout(timer);
  }
}

function dateStr(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function getTodayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function mapLigue1OfficialMatch(match: any) {
  if (!match?.home?.clubIdentity || !match?.away?.clubIdentity) return null;
  const home = match.home.clubIdentity;
  const away = match.away.clubIdentity;
  const utcDate = match.date ?? null;
  if (!utcDate) return null;
  return {
    id: `fl1:${match.id ?? utcDate}`,
    status: 'SCHEDULED',
    utcDate,
    homeTeam: {
      id: String(home.shortId ?? home.id ?? home.clubId ?? home.name),
      name: home.shortName ?? home.officialName ?? home.name,
      shortName: home.shortName ?? home.officialName ?? home.name,
      crest: home.assets?.logo?.medium ?? home.assets?.logo?.small ?? null,
    },
    awayTeam: {
      id: String(away.shortId ?? away.id ?? away.clubId ?? away.name),
      name: away.shortName ?? away.officialName ?? away.name,
      shortName: away.shortName ?? away.officialName ?? away.name,
      crest: away.assets?.logo?.medium ?? away.assets?.logo?.small ?? null,
    },
    competition: {
      code: 'FL1',
      name: COMP_INFO.FL1.name,
      emblem: COMP_INFO.FL1.emblem,
    },
    score: { fullTime: { home: null, away: null }, halfTime: { home: null, away: null } },
    liveDetails: null,
    competitionName: "Ligue 1 McDonald's",
    leagueName: "Ligue 1 McDonald's",
  };
}

async function fetchLigue1OfficialCalendarEvents(type: 'today' | 'results', startOffset: number, endOffset: number) {
  // Official API only provides daily buckets; request a broader window and extract matching days
  // official API enforces a max daysLimit of 14
  const days = Math.max(1, Math.min(14, Math.abs(endOffset - startOffset) + 1));
  const json = await fetchJsonWithCurl(
    `${L1_OFFICIAL_BASE}/matches?timezone=Europe%2FParis&daysLimit=${days}&lookAfter=true`,
    7000
  ).catch(() => ({}));

  const official = json?.results ?? json;
  if (!official || !official.byDate || typeof official.byDate !== 'object') return [];

  const matchIds = new Set<string>();
  for (let d = startOffset; d <= endOffset; d++) {
    const key = dateStr(d);
    const dayBuckets = official.byDate?.[key];
    if (!dayBuckets || typeof dayBuckets !== 'object') continue;
    for (const championshipBucket of Object.values(dayBuckets as Record<string, any>)) {
      for (const gameweekBucket of Object.values(championshipBucket as Record<string, any>)) {
        for (const id of (gameweekBucket as any)?.matchesIds ?? []) {
          if (typeof id === 'string') matchIds.add(id);
        }
      }
    }
  }

  const mapped = Array.from(matchIds)
    .map((id) => {
      const raw = official?.matches?.[id];
      // Only include matches where both clubs belong to the French championship
      const homeIsFrench = Boolean(raw?.home?.clubIdentity?.isInFrenchChampionship);
      const awayIsFrench = Boolean(raw?.away?.clubIdentity?.isInFrenchChampionship);
      if (!homeIsFrench || !awayIsFrench) return null;
      return mapLigue1OfficialMatch(raw);
    })
    .filter((match): match is NonNullable<ReturnType<typeof mapLigue1OfficialMatch>> => Boolean(match));

  return mapped.sort((a: any, b: any) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());
}






function dedupeEvents(events: any[]) {
  const seen = new Map<string, any>();

  const rankStatus = (event: any) => {
    const status = String(event?.status ?? '').toUpperCase();
    if (status === 'IN_PLAY' || status === 'PAUSED') return 3;
    if (status === 'FINISHED') return 2;
    if (status === 'SCHEDULED') return 1;
    return 0;
  };

  for (const event of events) {
    const comp = String(event?.competition?.code ?? '');
    const home = String(event?.homeTeam?.name ?? '').toLowerCase().trim();
    const away = String(event?.awayTeam?.name ?? '').toLowerCase().trim();
    const date = String(event?.utcDate ?? '').slice(0, 10); // YYYY-MM-DD only
    const id = String(event?.id ?? '');
    
    // Primary key: competition + match (home/away/date) - this catches duplicates with different IDs
    const matchKey = `${comp}:${home}:${away}:${date}`;
    // Secondary key: use ID if no match match found
    const key = matchKey && home && away && date ? matchKey : `${comp}:${id}`;
    
    if (!key || key === ':::::' || key === ':') continue;

    const existing = seen.get(key);
    if (!existing || rankStatus(event) >= rankStatus(existing)) {
      seen.set(key, event);
    }
  }

  return Array.from(seen.values());
}

async function fetchFootballDataCompetitionEvents(code: string, startOffset: number, endOffset: number, type: 'today' | 'results') {
  return FFD.fetchFootballDataCompetitionEvents(code, startOffset, endOffset, type, COMPETITIONS, AF_LEAGUE_BY_CODE);
}

async function fetchApiFootballCompetitionEvents(code: string, leagueId: number, startOffset: number, endOffset: number, type: 'today' | 'results') {
  return FFD.fetchApiFootballCompetitionEvents(code, leagueId, startOffset, endOffset, type, AF_LEAGUE_BY_CODE);
}

async function fetchFootballEventsWindow(type: 'today' | 'results', startOffset: number, endOffset: number) {
  const perCompetition = await Promise.all(COMPETITIONS.map(async (code) => {
    // Prefer Pulselive for Premier League to reduce other API calls
    if (code === 'PL') {
      try {
        await throttleFor('pulselive');
        const pulse = await fetchPulseliveCompetitionEvents(startOffset, endOffset, type).catch(() => []);
        if (pulse && pulse.length) {
          try { recordSourceAttempt('pulselive', true); } catch {}
          return pulse;
        }
        try { recordSourceAttempt('pulselive', false); } catch {}
      } catch (e) {
        try { recordSourceAttempt('pulselive', false); } catch {}
      }
    }
    return fetchCompetitionEventsByPriority(code, startOffset, endOffset, type);
  }));
  // per-competition sizes (diagnostic removed)

  const footballDataEvents = perCompetition.flat();
  const fallback = await fetchSportsDbWindow(startOffset, endOffset, COMP_INFO);

  const merged = dedupeEvents([...footballDataEvents, ...fallback]);

  // Safety net: if a tier-1 league is still missing, pull it directly from TSDB.
  // This avoids blank CL/FL1 blocks when a previous source returns an empty or stale snapshot.
  const presentCodes = new Set(merged.map((m: any) => m?.competition?.code).filter(Boolean));
  const topUpCodes = ['CL', 'FL1'].filter((code) => !presentCodes.has(code));
  if (topUpCodes.length) {
    const topUps = await Promise.all(topUpCodes.map(async (code) => {
      try {
        if (code === 'FL1' && type === 'today') {
          const officialEvents = await fetchLigue1OfficialCalendarEvents('today', startOffset, endOffset);
          if (officialEvents?.length) return officialEvents;
        }
        const networkEvents = type === 'today'
          ? await fetchSportsDbCompetitionNextEvents(code, startOffset, endOffset, type, COMP_INFO)
          : await fetchSportsDbCompetitionSeasonEvents(code, startOffset, endOffset, type, COMP_INFO);
        if (networkEvents?.length) return networkEvents;
        return getArchivedCompetitionEvents(code, type);
      } catch {
        return getArchivedCompetitionEvents(code, type);
      }
    }));
    merged.push(...topUps.flat());
  }

  const filtered = merged.filter((m: any) => type === 'today'
    ? ['SCHEDULED', 'IN_PLAY', 'PAUSED'].includes(m.status)
    : m.status === 'FINISHED');

  return filtered.sort((a: any, b: any) => type === 'today'
    ? new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime()
    : new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime());
}

async function fetchCompetitionEventsByPriority(code: string, startOffset: number, endOffset: number, type: 'today' | 'results') {
  const sources = COMP_SOURCES[code] ?? ['football-data', 'thesportsdb', 'api-football'];
  for (const s of sources) {
    try {
      await throttleFor(s);
      let res: any[] = [];
      switch (s) {
        case 'pulselive':
          res = await fetchPulseliveCompetitionEvents(startOffset, endOffset, type).catch(() => []);
          break;
        case 'football-data':
          res = await fetchFootballDataCompetitionEvents(code, startOffset, endOffset, type).catch(() => []);
          break;
        case 'api-football':
          res = await fetchApiFootballCompetitionEvents(code, AF_LEAGUE_BY_CODE[code] ?? 0, startOffset, endOffset, type).catch(() => []);
          break;
        case 'thesportsdb':
          res = await fetchSportsDbCompetitionNextEvents(code, startOffset, endOffset, type, COMP_INFO).catch(() => []);
          break;
        case 'openligadb':
          res = await fetchOpenLigaDbCompetitionEvents(code, startOffset, endOffset, type, COMP_INFO).catch(() => []);
          break;
        case 'official-ligue1':
          res = await fetchLigue1OfficialCalendarEvents(type, startOffset, endOffset).catch(() => []);
          break;
        default:
          res = [];
      }
      if (res && res.length) {
        try { recordSourceAttempt(s, true); } catch {}
        return res;
      }
      try { recordSourceAttempt(s, false); } catch {}
    } catch (e) {
      try { recordSourceAttempt(s, false); } catch {}
    }
  }

  // final fallback: sportsdb
  try {
    const fallback = type === 'today'
      ? await fetchSportsDbCompetitionNextEvents(code, startOffset, endOffset, type, COMP_INFO)
      : await fetchSportsDbCompetitionSeasonEvents(code, startOffset, endOffset, type, COMP_INFO);
    return fallback || [];
  } catch {
    return [];
  }
}

function nextSunday2359DelayMs(now = new Date()) {
  const target = new Date(now);
  const daysUntilSunday = (7 - target.getDay()) % 7;
  target.setDate(target.getDate() + daysUntilSunday);
  target.setHours(23, 59, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 7);
  }
  return target.getTime() - now.getTime();
}

let weeklyPrefetchStarted = false;
let dailyTsdbPrefetchStarted = false;

async function warmNextWeekSchedule() {
  const start = dateStr(1);
  const end = dateStr(14);
  const events = await fetchFootballEventsWindow('today', 1, 14);
  setCacheEntry(`football:nextweek:${start}`, { events, fetchedAt: Date.now() }, CACHE_TTL.football_week, Date.now());
  // prewarm completed (diagnostic removed)
}

function startFootballWeeklyPrefetch() {
  if (weeklyPrefetchStarted) return;
  weeklyPrefetchStarted = true;

  const loop = async () => {
    try {
      await warmNextWeekSchedule();
    } catch (error) {
      console.warn('Football weekly prefetch error', (error as any)?.message ?? error);
    }

    setTimeout(loop, Math.max(60, nextSunday2359DelayMs()));
  };

  void loop();
}

// Preload TSDB eventsnextleague once per day at the configured hour (UTC)
function startDailyTsdbNextLeaguePrefetch(hourUTC = 2) {
  if (dailyTsdbPrefetchStarted) return;
  dailyTsdbPrefetchStarted = true;

  const runOnce = async () => {
    try {
      await runSparseTsdbLookAheadPrefetch('TSDB Prefetch');
    } catch (e) {
      // ignore
    }
  };

  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  const initialDelay = next.getTime() - now.getTime();

  setTimeout(() => {
    void runOnce();
    setInterval(() => void runOnce(), 24 * 60 * 60 * 1000);
  }, initialDelay);
}

let dailyOddsPrefetchStarted = false;

function startDailyOddsPrefetch(hourUTC = 3) {
  if (dailyOddsPrefetchStarted) return;
  dailyOddsPrefetchStarted = true;

  const runOnce = async () => {
    try {
      const sports = Object.values(ODDS_SPORT_KEYS);
      for (const sport of sports) {
        try {
          // Trigger withCache to fetch and store odds for 24h
          await withCache(`odds:${sport}`, 24 * 60 * 60, async () => {
            const apiKey = process.env.THE_ODDS_API_KEY ?? process.env.ODDS_API_KEY;
            if (!apiKey) return [];
            const url = `${ODDS_BASE}/sports/${sport}/odds?regions=eu,uk&markets=h2h&oddsFormat=decimal&apiKey=${apiKey}`;
            const res = await fetch(url).catch(() => null);
            if (!res || !res.ok) return [];
            const json = await res.json().catch(() => []);
            return (json ?? []) as any[];
          });
        } catch (e) {
          // ignore individual sport failures
        }
      }
    } catch (e) {
      // ignore
    }
  };

  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  const initialDelay = next.getTime() - now.getTime();

  setTimeout(() => {
    void runOnce();
    setInterval(() => void runOnce(), 24 * 60 * 60 * 1000);
  }, initialDelay);
}

let clPrefetchStarted = false;
function startFrequentClPrefetch(timesPerDay = 4) {
  if (clPrefetchStarted) return;
  clPrefetchStarted = true;

  // Start Flashscore WebSocket for real-time updates
  void startFlashscoreLive().catch((e) => {
    console.warn('[Flashscore] Failed to connect:', (e as any)?.message?.slice(0, 50));
  });

  const runOnce = async () => {
    try {
      // Fetch from multiple sources: Sofascore (finished), Flashscore (live), and fallback APIs
      const clResults: any[] = [];

      // 1. Sofascore finished matches (most reliable for historical results)
      try {
        const sofascoreFinished = await fetchSofascoreFinishedMatches(7); // Expand to 7 days for CL
        if (sofascoreFinished && sofascoreFinished.length) {
          const clMatches = sofascoreFinished.map((m: any) => mapSofascoreMatch(m, 'CL'));
          clResults.push(...clMatches);
          console.log(`[CL Prefetch] Sofascore: ${clMatches.length} finished matches`);
        }
      } catch (e) {
        console.warn('[CL Prefetch] Sofascore fetch failed:', (e as any)?.message?.slice(0, 50));
      }

      // 2. Flashscore live matches (real-time)
      try {
        const flashscoreLive = getFlashscoreLiveMatches();
        if (flashscoreLive && flashscoreLive.length) {
          const clMatches = flashscoreLive.map((m: any) => mapFlashscoreMatch(m, 'CL'));
          clResults.push(...clMatches);
          console.log(`[CL Prefetch] Flashscore: ${clMatches.length} live matches`);
        }
      } catch (e) {
        console.warn('[CL Prefetch] Flashscore live failed:', (e as any)?.message?.slice(0, 50));
      }

      // 3. Try direct CL fetch from Sofascore if still no CL data
      if (!clResults.some((e: any) => e.competition?.code === 'CL')) {
        try {
          const sofascoreAll = await fetchSofascoreFinishedMatches(14); // Even wider for CL
          const clFromSofascore = sofascoreAll
            .filter((m: any) => m.tournament?.type === 'international_club' || m.tournament?.name?.includes('Champions'))
            .map((m: any) => mapSofascoreMatch(m, 'CL'));
          if (clFromSofascore.length) {
            clResults.push(...clFromSofascore);
            console.log(`[CL Prefetch] Sofascore (direct CL): ${clFromSofascore.length} matches`);
          }
        } catch (e) {
          console.warn('[CL Prefetch] Direct Sofascore fetch failed:', (e as any)?.message?.slice(0, 50));
        }
      }

      // 4. Fallback to API sources with retry logic
      if (!clResults.some((e: any) => e.competition?.code === 'CL')) {
        try {
          // Try compact request first (less rate-limit impact)
          const clEvents = await fetchCompetitionEventsByPriority('CL', -7, 1, 'results').catch(() => []);
          if (clEvents && clEvents.length) {
            clResults.push(...clEvents);
            console.log(`[CL Prefetch] API: ${clEvents.length} CL matches`);
          }
        } catch (e) {
          console.warn('[CL Prefetch] API fetch failed:', (e as any)?.message?.slice(0, 50));
        }
      }

      // 4b. Also include scheduled/upcoming CL matches (lookahead) so finals aren't missed before kickoff
      try {
        const upcoming = await fetchCompetitionEventsByPriority('CL', -7, 28, 'today').catch(() => []);
        if (upcoming && upcoming.length) {
          clResults.push(...upcoming);
          console.log(`[CL Prefetch] Upcoming: ${upcoming.length} scheduled CL matches included`);
        }
      } catch (e) {
        // ignore
      }

      // Store scores in local database (cumulative, never deleted)
      for (const match of clResults) {
        if (match.score?.fullTime?.home !== null && match.score?.fullTime?.away !== null) {
          storeScore(
            match.homeTeam?.name ?? 'Home',
            match.awayTeam?.name ?? 'Away',
            match.competition?.code ?? 'CL',
            match.utcDate ?? new Date().toISOString(),
            match.score.fullTime.home,
            match.score.fullTime.away,
            match.source ?? 'sofascore'
          );
        }
      }

      // 5. Always merge CL results with existing, prioritizing newer data
      const existing = readArchiveMerged('results') || { events: [] };
      const allResults = dedupeEvents([...clResults, ...(existing.events ?? [])]);
      
      if (allResults.length > 0) {
        writeArchiveSnapshot('results', { events: allResults, fetchedAt: Date.now() });
        const clCount = allResults.filter((e: any) => e.competition?.code === 'CL').length;
        console.log(`[CL Prefetch] ✓ Archived ${allResults.length} total matches (${clCount} CL)`);
      }
    } catch (e) {
      console.warn('[CL Prefetch] Error', (e as any)?.message);
    }
  };

  // Run immediately and then schedule - more frequently for CL to compensate for rate limits
  void runOnce();
  const ms = Math.floor((24 * 60 * 60 * 1000) / Math.max(1, timesPerDay));
  setInterval(() => void runOnce(), ms);
}

// One-time attempt to fetch Europa / Conference results (useful to populate finals)
async function startOneTimeEuropaPrefetch() {
  try {
    const [uelResults, uelToday, ueclResults, ueclToday] = await Promise.all([
      fetchCompetitionEventsByPriority('UEL', -365, 0, 'results').catch(() => []),
      fetchCompetitionEventsByPriority('UEL', -7, 28, 'today').catch(() => []),
      fetchCompetitionEventsByPriority('UECL', -365, 0, 'results').catch(() => []),
      fetchCompetitionEventsByPriority('UECL', -7, 28, 'today').catch(() => []),
    ]);
    const candidates = dedupeEvents([...uelResults, ...uelToday, ...ueclResults, ...ueclToday].map((event) => normalizeEventCompetition(event, COMP_INFO)));

    // Store scored matches in local DB
    for (const match of candidates) {
      if (match.score?.fullTime?.home !== null && match.score?.fullTime?.away !== null) {
        storeScore(
          match.homeTeam?.name ?? 'Home',
          match.awayTeam?.name ?? 'Away',
          match.competition?.code ?? 'UEL',
          match.utcDate ?? new Date().toISOString(),
          match.score.fullTime.home,
          match.score.fullTime.away,
          match.source ?? 'api'
        );
      }
    }

    const existing = readArchiveMerged('results') || { events: [] };
    const allResults = dedupeEvents([...(candidates ?? []), ...(existing.events ?? [])]);
    if (allResults.length) {
      writeArchiveSnapshot('results', { events: allResults, fetchedAt: Date.now() });
      console.log(`[Europa Prefetch] ✓ Archived ${allResults.length} total matches (UEL/UECL mixed)`);
    }
  } catch (e) {
    console.warn('[Europa Prefetch] Error', (e as any)?.message ?? e);
  }
}

// Run once on startup to help populate continental finals if available
void startOneTimeEuropaPrefetch();

const TSDB_LOOK_AHEAD_MIN_MATCHES = 6;
const TSDB_LOOK_AHEAD_EXTENSION_DAYS = 30;
const TSDB_LOOK_AHEAD_MAX_CODES_PER_RUN = 6;
let lastSparseTsdbLookAheadDate = '';

async function runSparseTsdbLookAheadPrefetch(label = 'TSDB Prefetch') {
  const todayKey = getTodayDateStr();
  if (lastSparseTsdbLookAheadDate === todayKey) return;

  const snapshot = readLastTodaySnapshot();
  const currentEvents = snapshot?.events ?? [];
  if (!currentEvents.length) return;

  const counts = new Map<string, number>();
  for (const event of currentEvents) {
    const code = event?.competition?.code;
    if (!code || !TSDB_LEAGUE_ID_BY_CODE[code]) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }

  const preferredOrder = Object.keys(TSDB_LEAGUE_ID_BY_CODE);
  const candidates = Array.from(counts.entries())
    .map(([code, count]) => ({ code, count }))
    .filter(({ count }) => count > 0 && count < TSDB_LOOK_AHEAD_MIN_MATCHES)
    .sort((a, b) => a.count - b.count || preferredOrder.indexOf(a.code) - preferredOrder.indexOf(b.code))
    .slice(0, TSDB_LOOK_AHEAD_MAX_CODES_PER_RUN);

  if (!candidates.length) return;

  let merged = [...currentEvents];
  for (const { code } of candidates) {
    try {
      const extendedEvents = await fetchSportsDbCompetitionNextEventsStrict(code, 0, TSDB_LOOK_AHEAD_EXTENSION_DAYS, 'today', COMP_INFO);

      if (!extendedEvents?.length) continue;

      const beforeCount = merged.filter((event: any) => event?.competition?.code === code).length;
      merged = dedupeEvents([...merged, ...extendedEvents]);
      const afterCount = merged.filter((event: any) => event?.competition?.code === code).length;

      if (afterCount > beforeCount) {
        console.log(`[${label}][LookAhead] ${code}: ${beforeCount} -> ${afterCount} matches`);
      } else {
        console.log(`[${label}][LookAhead] ${code}: no extra matches found`);
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (error) {
      console.warn(`[${label}][LookAhead] ${code} failed`, (error as any)?.message ?? error);
    }
  }

  const mergedEvents = merged.map((event: any) => enrichWithStoredScore(event));
  if (mergedEvents.length > currentEvents.length) {
    writeLastTodaySnapshot({ events: mergedEvents, fetchedAt: Date.now() });
    const stats = snapshotCoverageStats(mergedEvents);
    console.log(`[${label}][LookAhead] ✓ Today updated: ${stats.count} matches (${stats.leagues} leagues)`);
  }

  lastSparseTsdbLookAheadDate = todayKey;
}

function normalizeName(value = '') {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|afc|as|ac|calcio|club|de|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function detectCompetitionCodeFromText(text = ''): string | null {
  const k = normalizeName(String(text ?? ''));
  if (!k) return null;
  if (k.includes('europaleague') || k.includes('uefaeuropaleague') || k.includes('uel') || k.includes('europa')) return 'UEL';
  if (k.includes('conferenceleague') || k.includes('uefaeuropaconferenceleague') || k.includes('uecl') || k.includes('conference')) return 'UECL';
  if (k.includes('championsleague') || k.includes('liguedeschampions') || k.includes('ucl') || k.includes('champions')) return 'CL';
  return null;
}

// Football-Data / API-Football helpers moved to lib/footballFootballData

async function fetchMatchesForStatus(status: 'IN_PLAY' | 'PAUSED' | 'SUSPENDED') {
  return FFD.fetchMatchesForStatus(status);
}

function readLastLiveSnapshot() {
  return readArchiveMerged('live');
}

function writeLastLiveSnapshot(payload: any) {
  if (payload?.matches) payload.matches = sanitizeEvents(payload.matches || []);
  writeArchiveSnapshot('live', payload);
}

function readLastTodaySnapshot() {
  return readArchiveMerged('today');
}

function writeLastTodaySnapshot(payload: any) {
  if (payload?.events) payload.events = sanitizeEvents(payload.events || []);
  writeArchiveSnapshot('today', payload);
}

async function sanitizeTodayFL1Events(events: any[]) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const fl1Events = events.filter((e: any) => e?.competition?.code === 'FL1');
  if (fl1Events.length === 0) return events;

  try {
    const seasonMatches = await fetchSportsDbCompetitionSeasonEvents('FL1', -7, 21, 'today', COMP_INFO).catch(() => []);
    const frenchTeams = new Set((seasonMatches ?? []).flatMap((m: any) => [normalizeName(String(m.homeTeam?.name ?? '')), normalizeName(String(m.awayTeam?.name ?? ''))]));

    const filtered = events.filter((e: any) => {
      if (e?.competition?.code !== 'FL1') return true;
      const h = normalizeName(String(e.homeTeam?.name ?? ''));
      const a = normalizeName(String(e.awayTeam?.name ?? ''));
      // keep only if both teams are known French teams from season list
      return frenchTeams.has(h) && frenchTeams.has(a);
    });

    const removed = events.length - filtered.length;
    if (removed > 0) console.log(`[Sanitize] Removed ${removed} non-FL1 events from today snapshot`);
    return filtered;
  } catch (e) {
    return events;
  }
}

function snapshotCoverageStats(events: any[] = []) {
  const leagues = new Set((events ?? []).map((e: any) => e?.competition?.code).filter(Boolean)).size;
  const scored = (events ?? []).filter((e: any) => e?.score?.fullTime?.home !== null && e?.score?.fullTime?.away !== null).length;
  return { count: events?.length ?? 0, leagues, scored };
}

function mergeTodaySnapshot(events: any[]) {
  const existing = readLastTodaySnapshot();
  const merged = dedupeEvents([...(existing?.events ?? []), ...(events ?? [])]);
  const cutoff = Date.now() - WIDGET_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return merged.filter((e: any) => {
    const t = new Date(e.utcDate ?? 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

function shouldPersistTodaySnapshot(currentEvents: any[] | undefined, nextEvents: any[]) {
  const current = snapshotCoverageStats(currentEvents ?? []);
  const next = snapshotCoverageStats(nextEvents ?? []);
  if (!current.count) return true;
  if (next.leagues > current.leagues) return true;
  if (next.leagues === current.leagues && next.count >= current.count) return true;
  if (next.scored > current.scored) return true;
  return false;
}

export function readLastResultsSnapshot() {
  return readArchiveMerged('results');
}

export function writeLastResultsSnapshot(payload: any) {
  if (payload?.events) payload.events = sanitizeEvents(payload.events || []);
  writeArchiveSnapshot('results', payload);
}

function getArchivedCompetitionEvents(code: string, type: 'today' | 'results') {
  const snapshot = type === 'today' ? readLastTodaySnapshot() : readLastResultsSnapshot();
  return (snapshot?.events ?? []).filter((event: any) => event?.competition?.code === code);
}

export function mergeResultsSnapshot(events: any[]) {
  const existing = readLastResultsSnapshot();
  const merged = dedupeEvents([...(events ?? []), ...(existing?.events ?? [])]).map((event: any) => {
    const match = (existing?.events ?? []).find((e: any) => e?.id === event?.id && e?.competition?.code === event?.competition?.code);
    if (!match) return event;
    const hasNewScore = event?.score?.fullTime?.home !== null && event?.score?.fullTime?.away !== null;
    const hasExistingScore = match?.score?.fullTime?.home !== null && match?.score?.fullTime?.away !== null;
    if (!hasNewScore && hasExistingScore) {
      return { ...event, score: match.score, status: match.status === 'FINISHED' ? 'FINISHED' : event.status };
    }
    return event;
  });
  const cutoff = Date.now() - WIDGET_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const recent = merged.filter((e: any) => {
    const t = new Date(e.utcDate ?? 0).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
  return recent;
}

export async function runImmediateResultsPrefetch() {
  try {
    const resultsEvents = await fetchFootballEventsWindow('results', -21, 0);
    const mergedResults = mergeResultsSnapshot(resultsEvents);
    writeLastResultsSnapshot({ events: mergedResults, fetchedAt: Date.now() });
    const compsList = COMPETITIONS.map((code) => ({ code, name: COMP_INFO[code]?.name ?? code, emblem: COMP_INFO[code]?.emblem ?? null, count: mergedResults.filter((e: any) => e.competition?.code === code).length }));
    return { count: mergedResults.length, competitions: compsList, fetchedAt: Date.now() };
  } catch (e) {
    throw e;
  }
}

export async function runTargetedCompetitionPrefetch(code: string, startOffset = -7, endOffset = 0, debug = false) {
  try {
    // 1) Try archived snapshot for this competition
    let events: any[] = getArchivedCompetitionEvents(code, 'results') || [];
    // 2) If archive empty, try TSDB seasonal fetch
    if (!events || events.length === 0) {
      try {
        const tsdb = await fetchSportsDbCompetitionSeasonEvents(code, startOffset, endOffset, 'results', COMP_INFO).catch(() => []);
        if (tsdb && tsdb.length) events = tsdb;
      } catch {
        // ignore
      }
    }
    // 3) If still empty, try competition-priority fetch
    if (!events || events.length === 0) {
      events = await fetchCompetitionEventsByPriority(code, startOffset, endOffset, 'results').catch(() => []);
    }
    // 4) Try Sofascore finished matches for Ligue 1 specifically
    const SOFASCORE_ALLOW_RESULTS = !['0', 'false'].includes(String(process.env.SOFASCORE_ALLOW_RESULTS ?? 'false').toLowerCase());
    if (SOFASCORE_ALLOW_RESULTS && (code === 'FL1') && (!events || events.length === 0)) {
      try {
        const sofas = await fetchSofascoreFinishedMatchesForCompetition(Math.max(3, Math.abs(startOffset)), 'ligue');
        if (sofas && sofas.length) {
          // Map sofascore to standard match objects
          events = sofas.map((m: any) => mapSofascoreMatch(m, 'FL1'));
        }
      } catch {
        // ignore
      }
    }
    // 4) Final fallback to broad window then filter
    if (!events || events.length === 0) {
      const all = await fetchFootballEventsWindow('results', startOffset, endOffset).catch(() => []);
      events = (all || []).filter((e: any) => e.competition?.code === code);
    }
    // 4b) For UEFA competitions, also look ahead for scheduled matches so finals are not missed before kickoff.
    if ((!events || events.length === 0) && ['CL', 'UEL', 'UECL'].includes(code)) {
      try {
        const scheduled = await fetchCompetitionEventsByPriority(code, Math.min(startOffset, -7), Math.max(endOffset, 28), 'today').catch(() => []);
        if (scheduled && scheduled.length) {
          events = scheduled;
        }
      } catch {
        // ignore
      }
    }
    // 5) If still empty, try Sofascore window fetch (both results and upcoming)
    if (SOFASCORE_ALLOW_RESULTS && (code === 'FL1') && (!events || events.length === 0)) {
      try {
        const sofasWindow = await fetchSofascoreCompetitionWindow(code, startOffset, endOffset, 'results').catch(() => []);
        if (sofasWindow && sofasWindow.length) events = sofasWindow;
      } catch {
        // ignore
      }
    }
    let merged = mergeResultsSnapshot(events);
    // Sanitize: remove events wrongly tagged as FL1 when teams are not in French championship
    try {
      if (code === 'FL1') {
        const seasonMatches = await fetchSportsDbCompetitionSeasonEvents('FL1', startOffset - 7, endOffset + 7, 'results', COMP_INFO).catch(() => []);
        const frenchTeams = new Set((seasonMatches ?? []).flatMap((m: any) => [String(m.homeTeam?.name ?? '').toLowerCase(), String(m.awayTeam?.name ?? '').toLowerCase()]));
        const before = merged.length;
        merged = merged.filter((e: any) => {
          if (e?.competition?.code !== 'FL1') return true;
          const h = String(e.homeTeam?.name ?? '').toLowerCase();
          const a = String(e.awayTeam?.name ?? '').toLowerCase();
          // keep only if both teams are known French teams
          return frenchTeams.has(h) && frenchTeams.has(a);
        });
        if (merged.length !== before) {
          console.log(`[Prefetch] Sanitized FL1: removed ${before - merged.length} non-FL1 events`);
        }
      }
    } catch (e) {
      // ignore sanitation failures
    }

    writeLastResultsSnapshot({ events: merged, fetchedAt: Date.now() });
    const count = merged.filter((e: any) => e.competition?.code === code).length;
    const result: any = { code, count, mergedCount: merged.length, fetchedAt: Date.now() };
    if (debug) {
      result.candidates = events;
      try {
        result.sourceStats = Object.fromEntries(Object.entries(SOURCE_STATS).map(([k, v]) => [k, { successes: v.successes, failures: v.failures, lastFetch: v.lastFetch }]));
      } catch {}
    }
    return result;
  } catch (e) {
    throw e;
  }
}

function selectResultsForDisplay(inputEvents: any[], now = new Date()) {
  const cutoffMs = now.getTime() - WIDGET_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const finished = (inputEvents ?? [])
    .filter((e: any) => {
      const isFinished = e.status === 'FINISHED';
      const ts = new Date(e.utcDate ?? 0).getTime();
      const withinRetention = Number.isFinite(ts) && ts >= cutoffMs;
      return isFinished && withinRetention;
    })
    .sort((a: any, b: any) => new Date(b.utcDate ?? 0).getTime() - new Date(a.utcDate ?? 0).getTime());

  const scored = finished.filter((e: any) => {
    const hasScore = e.score?.fullTime?.home !== null && e.score?.fullTime?.away !== null;
    return hasScore;
  });

  const windows = [WIDGET_RETENTION_DAYS];
  for (const days of windows) {
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const candidate = scored.filter((e: any) => new Date(e.utcDate ?? 0) >= cutoff);
    const compCount = new Set(candidate.map((e: any) => e.competition?.code).filter(Boolean)).size;
    if (candidate.length >= 8 || compCount >= 3) {
      return candidate.slice(0, 150);
    }
  }

  if (scored.length > 0) {
    return scored.slice(0, 150);
  }

  return finished.slice(0, 150);
}

// Archive helpers: write daily snapshots and prune older ones
function ensureCacheDir() {
  const dir = join(process.cwd(), '.cache');
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) throw new Error('not dir');
  } catch (e) {
    try { mkdirSync(dir, { recursive: true }); } catch (er) { /* ignore */ }
  }
}

function listArchiveFiles(prefix: string) {
  try {
    const dir = join(process.cwd(), '.cache');
    return readdirSync(dir).filter((f) => f.startsWith(prefix)).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function pruneArchive(prefix: string, keepDays: number) {
  try {
    const files = listArchiveFiles(prefix);
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    for (const f of files) {
      try {
        const st = statSync(f);
        if (st.mtimeMs < cutoff) unlinkSync(f);
      } catch {}
    }
  } catch {}
}

// On import, attempt a one-time cleanup of the last snapshots to remove placeholder events
try {
  (async () => {
    try {
      const kinds: Array<'live' | 'today' | 'results'> = ['live', 'today', 'results'];
      for (const k of kinds) {
        const snap = readArchiveMerged(k) as any;
        if (snap && (snap.events || snap.matches)) {
          const arr = snap.events ?? snap.matches ?? [];
          const sanitized = sanitizeEvents(arr);
          if (sanitized.length !== (arr?.length ?? 0)) {
            console.log(`[SanitizeInit] cleaned ${k}: ${arr.length} -> ${sanitized.length}`);
            if (k === 'live') writeArchiveSnapshot(k, { matches: sanitized, fetchedAt: snap.fetchedAt ?? Date.now() });
            else writeArchiveSnapshot(k, { events: sanitized, fetchedAt: snap.fetchedAt ?? Date.now() });
          }
        }
      }
    } catch (e) {
      // don't fail startup on cleanup errors
    }
  })();
} catch {}

function writeArchiveSnapshot(kind: 'live' | 'today' | 'results', payload: any) {
  try {
    ensureCacheDir();
    const date = new Date().toISOString().slice(0, 10);
    const baseName = kind === 'live' ? 'football-live' : kind === 'today' ? 'football-today' : 'football-results';
    const dailyPath = join(process.cwd(), '.cache', `${baseName}-${date}.json`);
    const lastPath = join(process.cwd(), '.cache', `football-last-${kind}.json`);
    writeFileSync(dailyPath, JSON.stringify(payload, null, 2));
    writeFileSync(lastPath, JSON.stringify(payload, null, 2));
    // prune older files
    pruneArchive(baseName, kind === 'live' ? 7 : kind === 'today' ? 7 : 14);
  } catch (e) {
    // ignore write errors
  }
}

function readArchiveMerged(kind: 'live' | 'results' | 'today') {
  try {
    // prefer the single-file last snapshot for quick reads
    const lastPath = join(process.cwd(), '.cache', `football-last-${kind}.json`);
    let lastSnapshot: any = null;
    try {
      const data = readFileSync(lastPath, 'utf-8');
      lastSnapshot = JSON.parse(data);
    } catch {
      // fallthrough to aggregated daily files
    }

    const baseName = kind === 'live' ? 'football-live' : kind === 'today' ? 'football-today' : 'football-results';
    const dir = join(process.cwd(), '.cache');
    const files = readdirSync(dir).filter((f) => f.startsWith(baseName)).sort().reverse();
    const events: any[] = [];
    if (lastSnapshot?.events) events.push(...lastSnapshot.events);
    else if (lastSnapshot?.matches) events.push(...lastSnapshot.matches);
    else if (Array.isArray(lastSnapshot)) events.push(...lastSnapshot);
    for (const f of files) {
      try {
        const d = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        if (d?.events) events.push(...d.events);
        else if (d?.matches) events.push(...d.matches);
        else if (Array.isArray(d)) events.push(...d);
      } catch {}
    }
    // dedupe by id
    const seen = new Map();
    for (const e of events) {
      const id = e.id || `${e.competition?.code}:${e.homeTeam?.name}:${e.awayTeam?.name}:${String(e.utcDate ?? '')}`;
      if (!seen.has(id)) seen.set(id, e);
    }
    return { events: Array.from(seen.values()), fetchedAt: Date.now() };
  } catch {
    return null;
  }
}

function isValidEventForWidget(e: any) {
  if (!e) return false;
  // provenance/injected guard
  if (String(e.provenance ?? '').toLowerCase() === 'injected') return false;

  const id = String(e.id ?? '');
  if (id.includes('test') || id.includes('injected') || id.includes('fl1-test')) return false;

  const home = String(e.homeTeam?.name ?? e.homeTeam?.shortName ?? '').trim();
  const away = String(e.awayTeam?.name ?? e.awayTeam?.shortName ?? '').trim();
  if (!home || !away) return false;

  // reject placeholder lines like "Final 30 May 2026 at Stadium"
  if (/^final\b/i.test(home) || /^final\b/i.test(away) || /^finale\b/i.test(home) || /^finale\b/i.test(away)) return false;

  return true;
}

function sanitizeEvents(events: any[]) {
  if (!Array.isArray(events) || events.length === 0) return [];
  try {
    const filtered = events.filter((e: any) => isValidEventForWidget(e));
    return dedupeEvents(filtered);
  } catch (e) {
    return events;
  }
}

let lastDailyPrefetch: { date: string; timestamp: number } | null = null;

function isDailyPrefetchNeeded() {
  const today = getTodayDateStr();
  if (!lastDailyPrefetch) return true;
  return lastDailyPrefetch.date !== today;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') ?? 'live';
  const hasFootballDataKey = Boolean(process.env.FOOTBALL_API_KEY);
  if (type === 'live') {
    startFootballPoller();
    startFootballWeeklyPrefetch();
    const cached = getCacheEntry<{ matches: any[]; fetchedAt: number }>('football:live');
    const live = getLiveData();
    
    // Always try sportsDbLive for fresh data
    let sportsDbLive: any[] = [];
    if (!live.matches?.length) {
      try {
        const combined = dedupeEvents([
          ...(await fetchSportsDbWindow(0, 0, COMP_INFO)),
          ...(await Promise.all(
            COMPETITIONS.map(async (code) => fetchSportsDbCompetitionNextEventsFresh(code, 0, 0, 'today', COMP_INFO))
          )).flat(),
        ]).filter((match: any) => ['IN_PLAY', 'PAUSED'].includes(match.status));
        sportsDbLive = combined;
        
        // If we got live matches, persist them as fallback
        if (combined.length) {
          writeLastLiveSnapshot({ matches: combined, fetchedAt: Date.now() });
        }
      } catch (e) {
        // silent - will use fallback below
      }
    }
    
    // Fallback to last known live snapshot if both sources are empty
    // But filter out finished matches and old matches (older than today)
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const filterLiveMatches = (matches: any[]) => 
      matches.filter((m: any) => {
        // Only show IN_PLAY or PAUSED matches
        if (!['IN_PLAY', 'PAUSED', 'SUSPENDED'].includes(m.status)) return false;
        // Only show today's matches or future
        const matchDate = String(m.utcDate ?? '').slice(0, 10);
        return matchDate >= todayStr;
      });

    let finalMatches = 
      cached?.data?.matches?.length 
        ? filterLiveMatches(cached.data.matches)
        : live.matches?.length
          ? filterLiveMatches(live.matches)
          : sportsDbLive.length
            ? filterLiveMatches(sportsDbLive)
            : filterLiveMatches((readLastLiveSnapshot()?.events ?? []) as any[]);
    
    return NextResponse.json(
      { matches: finalMatches, fetchedAt: Date.now() },
      { headers: { 'X-Cache': cached?.data?.matches?.length ? 'HIT' : 'STORE' } }
    );
  }

  if (type === 'today' || type === 'results') {
    startFootballWeeklyPrefetch();
    startDailyTsdbNextLeaguePrefetch(2);
    startDailyOddsPrefetch(3);
    // More frequent CL prefetch to ensure Champions League results availability
    startFrequentClPrefetch(4);

    // **TRIGGER DAILY PREFETCH IN BACKGROUND**
    // Only do heavy API work once per day, then serve from snapshots
    if (isDailyPrefetchNeeded()) {
      lastDailyPrefetch = { date: getTodayDateStr(), timestamp: Date.now() };
      console.log('[Prefetch] Starting daily match prefetch (background)...');
      // Run in background - don't wait for it
      (async () => {
        try {
          const todayEvents = await fetchFootballEventsWindow('today', 0, 21);
          const resultsEvents = await fetchFootballEventsWindow('results', -21, 0);
          
          if (todayEvents?.length) {
            const existing = readLastTodaySnapshot();
            const mergedToday = mergeTodaySnapshot(todayEvents);
            if (shouldPersistTodaySnapshot(existing?.events, mergedToday)) {
              writeLastTodaySnapshot({ events: mergedToday, fetchedAt: Date.now() });
              const stats = snapshotCoverageStats(mergedToday);
              console.log(`[Prefetch] ✓ Today: ${stats.count} matches saved (${stats.leagues} leagues)`);
              await runSparseTsdbLookAheadPrefetch('Prefetch');
            } else {
              const current = snapshotCoverageStats(existing?.events ?? []);
              const next = snapshotCoverageStats(mergedToday);
              console.log(`[Prefetch] Skipped Today: existing ${current.count}/${current.leagues} vs new ${next.count}/${next.leagues}`);
            }
          }
          if (resultsEvents?.length) {
            const mergedResults = mergeResultsSnapshot(resultsEvents);
            writeLastResultsSnapshot({ events: mergedResults, fetchedAt: Date.now() });
            console.log(`[Prefetch] ✓ Results: ${mergedResults.length} matches saved`);
          }
        } catch (e) {
          console.warn('[Prefetch] Error:', (e as any)?.message);
        }
      })();
    }

    // **SERVE FROM SNAPSHOTS FIRST** - Instant load, stable display
    let snapshot = type === 'today' ? readLastTodaySnapshot() : readLastResultsSnapshot();
    if (snapshot?.events && snapshot.events.length > 0) {
      const now = new Date();
      let events = snapshot.events;
      if (type === 'today') {
        const cutoffMs = now.getTime() - WIDGET_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        events = [...events]
          .filter((e: any) => {
            const ts = new Date(e.utcDate ?? 0).getTime();
            if (!Number.isFinite(ts) || ts < cutoffMs) return false;
            if (['FINISHED', 'IN_PLAY', 'LIVE', 'PAUSED', 'SUSPENDED'].includes(e.status)) return false;
            return ts >= now.getTime();
          })
          .sort((a: any, b: any) => {
            const dateA = new Date(a.utcDate ?? 0).getTime();
            const dateB = new Date(b.utcDate ?? 0).getTime();
            return dateA - dateB;
          });
      } else if (type === 'results') {
        events = selectResultsForDisplay(events, now);
      }

      events = events.map((e: any) => enrichWithStoredScore(e));

      const fl1Count = events.filter((event: any) => event?.competition?.code === 'FL1').length;
      const presentCodes = new Set(events.map((event: any) => event?.competition?.code).filter(Boolean));
      const missingSafetyCodes = ['CL'].filter((code) => !presentCodes.has(code));
      if (missingSafetyCodes.length || fl1Count < TSDB_LOOK_AHEAD_MIN_MATCHES) {
        const safetyEvents = await Promise.all(
          [...missingSafetyCodes, ...(fl1Count < TSDB_LOOK_AHEAD_MIN_MATCHES ? ['FL1'] : [])].map((code) => {
            if (type === 'today') {
              if (code === 'FL1') {
                return fetchLigue1OfficialCalendarEvents('today', 0, 21);
              }
              return Promise.all([
                fetchSportsDbCompetitionNextEventsFresh(code, 0, 21, 'today', COMP_INFO),
                fetchSportsDbCompetitionSeasonEvents(code, 0, 21, 'today', COMP_INFO),
              ]).then((parts) => parts.flat());
            }

            return fetchSportsDbCompetitionSeasonEvents(code, -21, 0, 'results', COMP_INFO);
          })
        );
        const safetyFlat = safetyEvents.flat();
        if (safetyFlat.length) {
          events = dedupeEvents([...events, ...safetyFlat]).map((event: any) => enrichWithStoredScore(event));
        }
      }

      // Always serve today from snapshot; for results only bypass if severely sparse
      if (type === 'today') {
      const compsList = COMPETITIONS.map((code) => ({ code, name: COMP_INFO[code]?.name ?? code, emblem: COMP_INFO[code]?.emblem ?? null, count: events.filter((e: any) => e.competition?.code === code).length }));
      // Sanitize FL1 events before persisting
      const sanitized = await sanitizeTodayFL1Events(events);
      // Save updated events back to snapshot so FL1 top-up persists
      writeLastTodaySnapshot({ events: sanitized, fetchedAt: snapshot.fetchedAt });
        return NextResponse.json(
          { events, competitions: compsList, fetchedAt: snapshot.fetchedAt, stale: false },
          { headers: { 
            'X-Cache': 'SNAPSHOT', 
            'X-Snapshot-Age': `${Math.round((Date.now() - snapshot.fetchedAt) / 1000)}s`,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          } }
        );
      }

      // For results: serve if we have decent scored coverage or multi-league minimum
      const compCount = new Set(events.map((e: any) => e.competition?.code).filter(Boolean)).size;
      const scoredCount = events.filter((e: any) => e.score?.fullTime?.home !== null && e.score?.fullTime?.away !== null).length;
      // If a top-tier league is missing from the snapshot, try a targeted top-up
      const importantLeagues = ['FL1', 'PL', 'PD', 'SA'];
      const snapshotPresentCodes = new Set(events.map((e: any) => e.competition?.code).filter(Boolean));
      const missingImportant = importantLeagues.filter((c) => !snapshotPresentCodes.has(c));
      if (missingImportant.length) {
        try {
          const topups = await Promise.all(missingImportant.map(async (code) => {
            // Prefer archived snapshot first (fast, local)
            const archived = getArchivedCompetitionEvents(code, 'results') || [];
            if (archived.length) return archived;
            // Otherwise try network seasonal fetch as fallback, then broader priority fetch
            try {
              const fromTsdb = await fetchSportsDbCompetitionSeasonEvents(code, -21, 0, 'results', COMP_INFO).catch(() => []);
              if (fromTsdb && fromTsdb.length) return fromTsdb;
            } catch {
              // fall through
            }
            try {
              const byPriority = await fetchCompetitionEventsByPriority(code, -21, 0, 'results').catch(() => []);
              return byPriority ?? [];
            } catch {
              return [];
            }
          }));
          const flat = topups.flat();
          if (flat.length) {
            events = dedupeEvents([...events, ...flat]).map((event: any) => enrichWithStoredScore(event));
          }
        } catch (e) {
          // ignore top-up failures, we'll fall back to existing heuristic
        }
      }
      if (scoredCount >= 8 || (events.length >= 12 && compCount >= 2)) {
        console.log(`[Snapshot] Serving ${snapshot.events.length} ${type} matches from cache`);
        const compsList = COMPETITIONS.map((code) => ({ code, name: COMP_INFO[code]?.name ?? code, emblem: COMP_INFO[code]?.emblem ?? null, count: events.filter((e: any) => e.competition?.code === code).length }));
        // Save updated events back to snapshot for results
        writeLastResultsSnapshot({ events, fetchedAt: snapshot.fetchedAt });
        return NextResponse.json(
          { events, competitions: compsList, fetchedAt: snapshot.fetchedAt, stale: false },
          { headers: { 
            'X-Cache': 'SNAPSHOT', 
            'X-Snapshot-Age': `${Math.round((Date.now() - snapshot.fetchedAt) / 1000)}s`,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          } }
        );
      }

      console.log('[Snapshot] Results snapshot insufficient, attempting fresh fetch');
    }

    // **FALLBACK: Fetch from API** (only if snapshot missing)
      // Expand window to 21 days to catch CL and other irregular-schedule leagues
      const cacheKey = `football:${type}:window:${type === 'today' ? '0:21' : '-21:0'}`;
    const ttl = type === 'today' ? CACHE_TTL.football_today : CACHE_TTL.football_results;

    const { data, fromCache, age, stale } = await withStaleCache(
      cacheKey,
      ttl,
      async () => ({
          events: await fetchFootballEventsWindow(type, type === 'today' ? 0 : -21, type === 'today' ? 21 : 0),
      }),
      { events: [] }
    );

    // Fetch and enrich with odds + stored scores
    let events: any[] = data.events ?? [];
    let usedFallback = false;
    const uniqueCompetitions = Array.from(new Set(events.map((e: any) => e.competition?.code).filter(Boolean)));
    const oddsByCompetition = await getOddsByCompetition(uniqueCompetitions);
    events = events
      .map((e: any) => enrichMatch(e, oddsByCompetition))
      .map((e: any) => enrichWithStoredScore(e)); // Add best stored scores from local DB

    // Final safety net: if CL or FL1 is still missing, pull it straight from TSDB.
    const fl1Count = events.filter((event: any) => event?.competition?.code === 'FL1').length;
    const missingSafetyCodes = ['CL'].filter((code) => !events.some((event: any) => event.competition?.code === code));
    if (missingSafetyCodes.length || fl1Count < TSDB_LOOK_AHEAD_MIN_MATCHES) {
      const safetyEvents = await Promise.all(
        [...missingSafetyCodes, ...(fl1Count < TSDB_LOOK_AHEAD_MIN_MATCHES ? ['FL1'] : [])].map((code) => {
          if (type === 'today') {
            if (code === 'FL1') {
              return fetchLigue1OfficialCalendarEvents('today', 0, 21);
            }
            return Promise.all([
              fetchSportsDbCompetitionNextEventsFresh(code, 0, 21, 'today', COMP_INFO),
              fetchSportsDbCompetitionSeasonEvents(code, 0, 21, 'today', COMP_INFO),
            ]).then((parts) => parts.flat());
          }

          return fetchSportsDbCompetitionSeasonEvents(code, -21, 0, 'results', COMP_INFO);
        })
      );
      const safetyFlat = safetyEvents.flat();
      if (safetyFlat.length) {
        events = dedupeEvents([...events, ...safetyFlat]).map((event: any) => enrichMatch(event, oddsByCompetition));
      }
    }

    const archivedFl1Events = getArchivedCompetitionEvents('FL1', type);
    if (archivedFl1Events.length && !events.some((event: any) => event.competition?.code === 'FL1')) {
      events = dedupeEvents([...events, ...archivedFl1Events]);
    }

      // If still missing FL1 for `today`, attempt a free Sofascore window fetch to top-up display only.
      if (type === 'today' && !events.some((event: any) => event.competition?.code === 'FL1')) {
        try {
          const sofasWindow = await fetchSofascoreCompetitionWindow('FL1', 0, 21, 'today').catch(() => []);
          if (sofasWindow && sofasWindow.length) {
            events = dedupeEvents([...events, ...sofasWindow.map((m: any) => mapSofascoreMatch(m, 'FL1'))]);
          }
        } catch {
          // ignore sofascore failures for display
        }
      }

    // If upstream returns empty, serve last known snapshot to avoid blank UI
    if (type === 'today' && (!events || events.length === 0)) {
      const snap = readLastTodaySnapshot();
      if (snap?.events && snap.events.length) {
        events = snap.events;
        usedFallback = true;
      }
    }
    if (type === 'results' && (!events || events.length === 0)) {
      const snap = readLastResultsSnapshot();
      if (snap?.events && snap.events.length) {
        events = snap.events;
        usedFallback = true;
      }
    }

    // Persist a fresh snapshot for `today` so we can serve it when upstream fails later.
    // NOTE: we intentionally avoid persisting events that originate only from Sofascore/Flashscore
    // or injected test data to prevent fabricated matches from becoming the durable snapshot.
    if (type === 'today' && events && events.length) {
      try {
        const existing = readLastTodaySnapshot();
        const mergedToday = mergeTodaySnapshot(events);

        // Filter snapshot candidates: drop sofascore/flashscore-only and injected events
        const snapshotCandidates = (mergedToday ?? []).filter((e: any) => {
          if (!e) return false;
          if (e.provenance === 'injected') return false;
          const src = String(e.source ?? e.liveSource ?? '').toLowerCase();
          if (src === 'sofascore' || src === 'flashscore') return false;
          return true;
        });

        if (shouldPersistTodaySnapshot(existing?.events, snapshotCandidates)) {
          // First normalize competition codes (CL/UEL/UECL) to avoid misclassification
          const normalized = snapshotCandidates.map((event) => normalizeEventCompetition(event, COMP_INFO));
          const sanitizedCandidates = await sanitizeTodayFL1Events(normalized);
          writeLastTodaySnapshot({ events: sanitizedCandidates, fetchedAt: Date.now() });
        }
      } catch (e) {
        // ignore write failures
      }
    }

    // Persist merged snapshot for results to avoid league dropouts on partial source failures
    if (type === 'results' && events && events.length) {
      try {
        // Normalize competition codes before merging/persisting results
        const normalizedForResults = events.map((event) => normalizeEventCompetition(event, COMP_INFO));
        const mergedResults = mergeResultsSnapshot(normalizedForResults);
        writeLastResultsSnapshot({ events: mergedResults, fetchedAt: Date.now() });
      } catch (e) {
        // ignore write failures
      }
    }

    // **SORT and LIMIT matches**
    const now = new Date();
    if (type === 'today') {
      // Sort by date/time ascending (closest to now first)
      const cutoffMs = now.getTime() - WIDGET_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      events = events
        .filter((e: any) => {
          const ts = new Date(e.utcDate ?? 0).getTime();
          if (!Number.isFinite(ts) || ts < cutoffMs) return false;
          if (['FINISHED', 'IN_PLAY', 'LIVE', 'PAUSED', 'SUSPENDED'].includes(e.status)) return false;
          return ts >= now.getTime();
        })
        .sort((a: any, b: any) => {
          const dateA = new Date(a.utcDate ?? 0).getTime();
          const dateB = new Date(b.utcDate ?? 0).getTime();
          return dateA - dateB;
        });
      } else if (type === 'results') {
        events = selectResultsForDisplay(events, now);
    }

    // provide competition counts so frontend can render empty competitions
    const compsList = COMPETITIONS.map((code) => ({ code, name: COMP_INFO[code]?.name ?? code, emblem: COMP_INFO[code]?.emblem ?? null, count: events.filter((e: any) => e.competition?.code === code).length }));

    return NextResponse.json(
      { ...data, events, competitions: compsList, fetchedAt: Date.now() - (fromCache ? age * 1000 : 0), stale: stale || usedFallback },
      { headers: { 'X-Cache': fromCache ? `${stale ? 'STALE' : 'HIT'} age=${age}s` : usedFallback ? 'FALLBACK' : 'MISS' } }
    );
  }

  return NextResponse.json({ error: 'Type invalide' }, { status: 400 });
}