import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_TTL, getCacheEntry, setCacheEntry, withCache, withStaleCache } from '@/lib/cache';
import { fetchRssFeed, fetchWikipediaCompetition } from '@/lib/fallbackSources';
import { getLiveData, startFootballPoller } from '@/lib/footballPoller';
import { fetchSofascoreLiveMatches, fetchSofascoreFinishedMatches, mapSofascoreMatch } from '@/lib/sofascoreLive';
import { startFlashscoreLive, getFlashscoreLiveMatches, mapFlashscoreMatch } from '@/lib/flashscoreLive';
import { storeScore, enrichWithStoredScore } from '@/lib/scoreDatabase';

export const runtime = 'nodejs';

const FD_BASE = 'https://api.football-data.org/v4';
const AF_BASE = 'https://api-football-v1.p.rapidapi.com/v3';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/3';
const L1_OFFICIAL_BASE = 'https://ma-api.ligue1.fr/championships-daily-calendars';
const PULSELIVE_BASE = 'https://sdp-prem-prod.premier-league-prod.pulselive.com/api/v1';
const OL_BASE = 'https://api.openligadb.de';
const OL_LEAGUE_BY_CODE: Record<string, string> = {
  FL1: 'FR1',
  BL1: 'BL1',
  CL: 'CL',
};
// Only major accessible championships via Football-Data free tier
const COMPETITIONS = ['FL1', 'CL', 'PL', 'PD', 'SA', 'BL1'];
const AF_LEAGUE_BY_CODE: Record<string, number> = {
  FL1: 61,
  PL: 39,
  PD: 140,
  SA: 135,
  BL1: 78,
  CL: 2,
};
const COMP_INFO: Record<string, { name: string; emblem?: string | null }> = {
  FL1: { name: 'Ligue 1', emblem: 'https://r2.thesportsdb.com/images/media/league/badge/9f7z9d1742983155.png' },
  CL: { name: 'Champions League', emblem: 'https://r2.thesportsdb.com/images/media/league/badge/uefa_champions_league.png' },
  PL: { name: 'Premier League', emblem: 'https://r2.thesportsdb.com/images/media/league/badge/gasy9d1737743125.png' },
  PD: { name: 'La Liga', emblem: 'https://r2.thesportsdb.com/images/media/league/badge/ja4it51687628717.png' },
  SA: { name: 'Serie A', emblem: 'https://r2.thesportsdb.com/images/media/league/badge/67q3q21679951383.png' },
  BL1: { name: 'Bundesliga', emblem: 'https://r2.thesportsdb.com/images/media/league/badge/teqh1b1679952008.png' },
};
const ODDS_SPORT_KEYS: Record<string, string> = {
  FL1: 'soccer_france_ligue_one',
  CL: 'soccer_uefa_champs_league',
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  SA: 'soccer_italy_serie_a',
  BL1: 'soccer_germany_bundesliga',
};

const WIDGET_RETENTION_DAYS = 5;

// Per-competition source priority (try in order)
// Source monitoring (track successes/failures per source)
type SourceStats = { successes: number; failures: number; lastFetch?: number };
const SOURCE_STATS: Record<string, SourceStats> = {
  'football-data': { successes: 0, failures: 0 },
  'api-football': { successes: 0, failures: 0 },
  'thesportsdb': { successes: 0, failures: 0 },
  'openligadb': { successes: 0, failures: 0 },
  'official-ligue1': { successes: 0, failures: 0 },
  'pulselive': { successes: 0, failures: 0 },
  'rss': { successes: 0, failures: 0 },
  'wikipedia': { successes: 0, failures: 0 },
};

function recordSourceAttempt(source: string, success: boolean) {
  const stats = SOURCE_STATS[source];
  if (stats) {
    if (success) stats.successes++;
    else stats.failures++;
    stats.lastFetch = Date.now();
  }
}

function logSourceStats() {
  const summary = Object.entries(SOURCE_STATS).map(([src, stats]) => {
    const ratio = stats.successes + stats.failures > 0 
      ? `${(100 * stats.successes / (stats.successes + stats.failures)).toFixed(0)}%`
      : 'N/A';
    return `${src}: ${stats.successes} ok / ${stats.failures} err (${ratio})`;
  }).join(', ');
  console.log(`[Football API] Source stats: ${summary}`);
}

const COMP_SOURCES: Record<string, string[]> = {
  FL1: ['official-ligue1', 'football-data', 'thesportsdb', 'rss', 'wikipedia', 'openligadb', 'api-football'],
  BL1: ['openligadb', 'football-data', 'api-football', 'thesportsdb'],
  CL:  ['football-data', 'openligadb', 'thesportsdb', 'rss', 'wikipedia', 'api-football'],
  PL:  ['pulselive', 'football-data', 'api-football', 'thesportsdb', 'rss', 'wikipedia'],
  PD:  ['football-data', 'api-football', 'thesportsdb', 'rss', 'wikipedia'],
  SA:  ['football-data', 'api-football', 'thesportsdb', 'rss', 'wikipedia'],
};

// **DAILY PREFETCH SYSTEM** - Reduce API calls to once per day
let lastDailyPrefetch = { date: '', timestamp: 0 };
function getTodayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function isDailyPrefetchNeeded(): boolean {
  const today = getTodayDateStr();
  return today !== lastDailyPrefetch.date;
}

// Simple per-source rate limiting (milliseconds)
const SOURCE_MIN_INTERVAL_MS: Record<string, number> = {
  'football-data': 500,
  'api-football': 500,
  'openligadb': 500,
  'thesportsdb': 500,
  'pulselive': 500,
};
const lastRequestAt = new Map<string, number>();

async function throttleFor(source: string) {
  const min = SOURCE_MIN_INTERVAL_MS[source] ?? 500;
  const last = lastRequestAt.get(source) ?? 0;
  const now = Date.now();
  const diff = now - last;
  if (diff < min) {
    await new Promise((res) => setTimeout(res, min - diff));
  }
  lastRequestAt.set(source, Date.now());
}

async function fetchCompetitionEventsByPriority(code: string, startOffset: number, endOffset: number, type: 'today' | 'results') {
  let fallbackWithoutScore: any[] | null = null;
  let mergedTodayCandidates: any[] = [];
  const addTodayCandidate = (items: any[] | null | undefined) => {
    if (!items || items.length === 0) return;
    mergedTodayCandidates = dedupeEvents([...mergedTodayCandidates, ...items]);
  };
  const pickCandidate = (items: any[] | null | undefined, source: keyof typeof SOURCE_STATS) => {
    if (!items || items.length === 0) {
      recordSourceAttempt(source, false);
      return null;
    }

    if (type !== 'results') {
      recordSourceAttempt(source, true);
      return items;
    }

    const scoredFinishedCount = items.filter((e: any) => {
      const isFinished = e.status === 'FINISHED';
      const hasScore = e.score?.fullTime?.home !== null && e.score?.fullTime?.away !== null;
      return isFinished && hasScore;
    }).length;

    if (scoredFinishedCount > 0) {
      recordSourceAttempt(source, true);
      return items;
    }

    // Keep a best-effort fallback if no source provides scored results.
    if (!fallbackWithoutScore || items.length > fallbackWithoutScore.length) {
      fallbackWithoutScore = items;
    }
    recordSourceAttempt(source, false);
    return null;
  };

  const sources = COMP_SOURCES[code] ?? ['football-data', 'api-football', 'thesportsdb'];
  for (const src of sources) {
    try {
      await throttleFor(src);
      if (src === 'football-data') {
        const res = await fetchFootballDataCompetitionEvents(code, startOffset, endOffset, type);
        const picked = pickCandidate(res, 'football-data');
        if (picked) {
          if (type === 'today') {
            addTodayCandidate(picked);
            if (mergedTodayCandidates.length >= TSDB_LOOK_AHEAD_MIN_MATCHES) return mergedTodayCandidates;
          } else {
            return picked;
          }
        }
      }
      if (src === 'api-football') {
        const leagueId = AF_LEAGUE_BY_CODE[code];
        if (leagueId) {
          const res = await fetchApiFootballCompetitionEvents(code, leagueId, startOffset, endOffset, type);
          const picked = pickCandidate(res, 'api-football');
          if (picked) {
            if (type === 'today') {
              addTodayCandidate(picked);
              if (mergedTodayCandidates.length >= TSDB_LOOK_AHEAD_MIN_MATCHES) return mergedTodayCandidates;
            } else {
              return picked;
            }
          }
        }
      }
      if (src === 'openligadb') {
        if (OL_LEAGUE_BY_CODE[code]) {
          const res = await fetchOpenLigaDbCompetitionEvents(code, startOffset, endOffset, type);
          const picked = pickCandidate(res, 'openligadb');
          if (picked) {
            if (type === 'today') {
              addTodayCandidate(picked);
              if (mergedTodayCandidates.length >= TSDB_LOOK_AHEAD_MIN_MATCHES) return mergedTodayCandidates;
            } else {
              return picked;
            }
          }
        }
      }
      if (src === 'pulselive') {
        if (code === 'PL') {
          const res = await fetchPulseliveCompetitionEvents(startOffset, endOffset, type);
          const picked = pickCandidate(res, 'pulselive');
          if (picked) {
            if (type === 'today') {
              addTodayCandidate(picked);
              if (mergedTodayCandidates.length >= TSDB_LOOK_AHEAD_MIN_MATCHES) return mergedTodayCandidates;
            } else {
              return picked;
            }
          }
        }
      }
      if (src === 'official-ligue1') {
        if (code === 'FL1') {
          const res = await fetchLigue1OfficialCalendarEvents(type, startOffset, endOffset);
          const picked = pickCandidate(res, 'official-ligue1');
          if (picked) {
            if (type === 'today') {
              addTodayCandidate(picked);
              if (mergedTodayCandidates.length >= TSDB_LOOK_AHEAD_MIN_MATCHES) return mergedTodayCandidates;
            } else {
              return picked;
            }
          }
        }
      }
      if (src === 'thesportsdb') {
        const nextEvents = await fetchSportsDbCompetitionNextEvents(code, startOffset, endOffset, type);
        const pickedNext = pickCandidate(nextEvents, 'thesportsdb');
        if (pickedNext) {
          if (type === 'today') {
            addTodayCandidate(pickedNext);
            if (mergedTodayCandidates.length >= TSDB_LOOK_AHEAD_MIN_MATCHES) return mergedTodayCandidates;
          } else {
            return pickedNext;
          }
        }

        const seasonal = await fetchSportsDbCompetitionSeasonEvents(code, startOffset, endOffset, type);
        const pickedSeasonal = pickCandidate(seasonal, 'thesportsdb');
        if (pickedSeasonal) {
          if (type === 'today') {
            addTodayCandidate(pickedSeasonal);
            if (mergedTodayCandidates.length >= TSDB_LOOK_AHEAD_MIN_MATCHES) return mergedTodayCandidates;
          } else {
            return pickedSeasonal;
          }
        }

        const all = await fetchSportsDbWindow(startOffset, endOffset);
        const filtered = (all ?? []).filter((m: any) => m.competition?.code === code);
        const pickedAll = pickCandidate(filtered, 'thesportsdb');
        if (pickedAll) {
          if (type === 'today') {
            addTodayCandidate(pickedAll);
            if (mergedTodayCandidates.length >= TSDB_LOOK_AHEAD_MIN_MATCHES) return mergedTodayCandidates;
          } else {
            return pickedAll;
          }
        }
      }
      if (src === 'rss') {
        // try known RSS feeds (best-effort)
        const feeds: Record<string, string[]> = {
          FL1: ['https://www.ligue1.com/rss'],
          PL: ['https://www.premierleague.com/feeds/rss'],
          PD: ['https://www.laliga.com/en-GB/rss'],
          SA: ['https://www.legaseriea.it/en/rss'],
          BL1: [],
          CL: ['https://www.uefa.com/rssfeed/']
        };
        const urls = feeds[code] ?? [];
        let rssSuccess = false;
        for (const u of urls) {
          try {
            const items = await fetchRssFeed(u);
            if (items && items.length) {
              recordSourceAttempt('rss', true);
              rssSuccess = true;
              const mapped = items.map((it: any) => ({ id: `rss:${u}:${it.date}:${it.title}`, utcDate: it.date, homeTeam: { name: it.title.split(' - ')[0] ?? it.title }, awayTeam: { name: it.title.split(' - ')[1] ?? '' }, competition: { code }, status: 'SCHEDULED' }));
              if (type === 'today') {
                addTodayCandidate(mapped);
                if (mergedTodayCandidates.length >= TSDB_LOOK_AHEAD_MIN_MATCHES) return mergedTodayCandidates;
                continue;
              }
              return mapped;
            }
          } catch (e) {
            // continue
          }
        }
        if (!rssSuccess) recordSourceAttempt('rss', false);
      }
      if (src === 'wikipedia') {
        try {
          const wiki = await fetchWikipediaCompetition(code, startOffset, endOffset);
          if (wiki && wiki.length) {
            recordSourceAttempt('wikipedia', true);
            if (type === 'today') {
              addTodayCandidate(wiki);
              if (mergedTodayCandidates.length >= TSDB_LOOK_AHEAD_MIN_MATCHES) return mergedTodayCandidates;
              continue;
            }
            return wiki;
          }
          recordSourceAttempt('wikipedia', false);
        } catch (e) {
          recordSourceAttempt('wikipedia', false);
        }
      }
    } catch (e) {
      console.warn(`Source ${src} for ${code} failed`, (e as any)?.message ?? e);
      recordSourceAttempt(src, false);
    }
  }

  if (code === 'FL1') {
    try {
      const rssEvents = await fetchRssFeed('https://www.ligue1.com/rss');
      if (rssEvents?.length) {
        recordSourceAttempt('rss', true);
        const mapped = rssEvents.map((it: any) => ({
          id: `rss:ligue1:${it.date ?? Date.now()}:${it.title}`,
          utcDate: it.date ?? `${dateStr(startOffset)}T00:00:00Z`,
          homeTeam: { name: it.title.split(' - ')[0] ?? it.title },
          awayTeam: { name: it.title.split(' - ')[1] ?? '' },
          competition: { code: 'FL1', name: 'Ligue 1', emblem: null },
          status: 'SCHEDULED',
        }));
        if (type === 'today') {
          addTodayCandidate(mapped);
        } else {
          return mapped;
        }
      }
    } catch {
      // ignore and continue to local archive fallback
    }

    try {
      const wikiEvents = await fetchWikipediaCompetition('FL1', startOffset, endOffset);
      if (wikiEvents?.length) {
        recordSourceAttempt('wikipedia', true);
        const mapped = wikiEvents.map((event: any) => ({
          ...event,
          competition: { ...(event.competition ?? {}), code: 'FL1', name: 'Ligue 1', emblem: event.competition?.emblem ?? null },
        }));
        if (type === 'today') {
          addTodayCandidate(mapped);
        } else {
          return mapped;
        }
      }
    } catch {
      // ignore and continue
    }
  }

  if (type === 'today' && mergedTodayCandidates.length) {
    return mergedTodayCandidates;
  }

  return fallbackWithoutScore ?? [];
}

function fdHeaders() {
  return { 'X-Auth-Token': process.env.FOOTBALL_API_KEY ?? '' };
}

function afHeaders() {
  const key = process.env.RAPIDAPI_KEY ?? process.env.API_FOOTBALL_KEY ?? '';
  return {
    'X-RapidAPI-Key': key,
    'X-RapidAPI-Host': 'api-football-v1.p.rapidapi.com',
  };
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs = 5000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!res || !res.ok) {
    const txt = res ? await res.text().catch(() => '') : '';
    throw new Error(`fetch failed${res ? ` (${res.status})` : ''}${txt ? `: ${txt}` : ''}`);
  }
  return res.json().catch(() => ({}));
}

async function fetchJsonWithCurl(url: string, timeoutMs = 5000) {
  return new Promise<any>((resolve, reject) => {
    execFile(
      'curl',
      ['-sL', '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))), url],
      { timeout: timeoutMs + 1000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        try {
          resolve(JSON.parse(stdout || '{}'));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

// Retry with exponential backoff for resilience against transient errors
// Respects free tier limits: max 3 attempts, increasing delays (500ms, 1s, 2s)
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 500
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const errMsg = (err as Error)?.message ?? '';
      const isTransient = errMsg.includes('429') || 
                          errMsg.includes('timeout') ||
                          errMsg.includes('ECONNRESET') ||
                          errMsg.includes('ETIMEDOUT');
      if (!isTransient || attempt === maxAttempts - 1) {
        throw err; // Don't retry non-transient errors or on last attempt
      }
      // Exponential backoff: 500ms, 1s, 2s
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      console.log(`[Retry] Attempt ${attempt + 1}/${maxAttempts}, backoff ${delayMs}ms`, (err as Error)?.message?.slice(0, 80));
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw lastError;
}

function dateStr(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

const TSDB_LEAGUE_MATCHERS: Record<string, string[]> = {
  FL1: ['frenchligue1', 'ligue1'],
  CL: ['uefachampionsleague', 'championsleague'],
  PL: ['englishpremierleague', 'premierleague'],
  PD: ['spanishlaliga', 'laliga'],
  SA: ['italianseriea', 'seriea'],
  BL1: ['germanbundesliga', 'bundesliga'],
};

const TSDB_LEAGUE_ID_BY_CODE: Record<string, number> = {
  FL1: 4334,
  CL: 4480,
  PL: 4328,
  PD: 4335,
  SA: 4332,
  BL1: 4331,
};

function normalizeLeagueName(value = '') {
  return normalizeName(value).replace(/league$/g, '');
}

function matchSportsDbCompetition(leagueName = '') {
  const normalized = normalizeLeagueName(leagueName);
  return (Object.entries(TSDB_LEAGUE_MATCHERS).find(([, matchers]) => matchers.some((matcher) => normalized.includes(matcher) || matcher.includes(normalized))) ?? [null])[0] as string | null;
}

function mapSportsDbStatus(value = '') {
  const status = value.toLowerCase();
  if (status.includes('finished') || status === 'ft' || status === 'aet' || status.includes('pen')) return 'FINISHED';
  if (status === 'ht' || status.includes('half time') || status.includes('pause') || status.includes('break')) return 'PAUSED';
  if (
    status === '1h' ||
    status === '2h' ||
    status === '3h' ||
    status === 'live' ||
    status.includes('in progress') ||
    status.includes('in play') ||
    status.includes('1st half') ||
    status.includes('2nd half')
  ) {
    return 'IN_PLAY';
  }
  return 'SCHEDULED';
}

function mapSportsDbMatch(event: any) {
  // Filter out women's leagues, reserves, second teams, youth divisions, etc.
  const leagueName = (event.strLeague ?? '').toLowerCase();
  const excludedPatterns = ['women', "women's", 'female', 'reserve', 'second', 'youth', 'u-', 'u20', 'u19', 'u18', 'u17', 'elite'];
  if (excludedPatterns.some((pattern) => leagueName.includes(pattern))) {
    return null;
  }

  const competitionCode = matchSportsDbCompetition(event.strLeague ?? '') ?? `tsdb:${event.idLeague ?? normalizeName(event.strLeague ?? 'league')}`;

  const status = mapSportsDbStatus(event.strStatus ?? '');
  const homeScore = event.intHomeScore == null || event.intHomeScore === '' ? null : Number(event.intHomeScore);
  const awayScore = event.intAwayScore == null || event.intAwayScore === '' ? null : Number(event.intAwayScore);

  // Normalize timestamp: prefer `strTimestamp` (which is UTC) and ensure it is parsed as UTC
  let utcDateRaw = event.strTimestamp ?? (event.dateEvent && (event.strTimeLocal ?? event.strTime) ? `${event.dateEvent}T${event.strTimeLocal ?? event.strTime}` : `${event.dateEvent ?? dateStr()}T00:00:00`);
  // If timestamp looks like 'YYYY-MM-DDTHH:MM:SS' without timezone, append 'Z' to mark UTC
  if (typeof utcDateRaw === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(utcDateRaw)) {
    utcDateRaw = `${utcDateRaw}Z`;
  }

  return {
    id: event.idEvent ?? `${competitionCode}:${utcDateRaw ?? Date.now()}`,
    status,
    utcDate: utcDateRaw,
    homeTeam: {
      id: event.idHomeTeam ?? null,
      name: event.strHomeTeam ?? 'Home',
      shortName: event.strHomeTeam ?? 'Home',
      crest: event.strHomeTeamBadge ?? null,
    },
    awayTeam: {
      id: event.idAwayTeam ?? null,
      name: event.strAwayTeam ?? 'Away',
      shortName: event.strAwayTeam ?? 'Away',
      crest: event.strAwayTeamBadge ?? null,
    },
    competition: {
      code: competitionCode,
      name: event.strLeague ?? competitionCode,
      emblem: event.strLeagueBadge ?? null,
    },
    score: {
      fullTime: {
        home: homeScore,
        away: awayScore,
      },
      halfTime: {
        home: null,
        away: null,
      },
    },
    liveDetails: status === 'IN_PLAY' || status === 'PAUSED'
      ? {
          minute: null,
          source: 'thesportsdb',
          score: {
            home: homeScore,
            away: awayScore,
          },
        }
      : null,
    liveSource: status === 'IN_PLAY' || status === 'PAUSED' ? 'thesportsdb' : undefined,
    competitionName: event.strLeague ?? competitionCode,
    leagueName: event.strLeague ?? competitionCode,
  };
}

async function fetchSportsDbEventsForDate(date: string) {
  const { data } = await withCache(`tsdb:soccer:${date}`, 10 * 60, async () => {
    // Retry on transient errors (429, timeout) with exponential backoff (max 2 attempts for this endpoint)
    const res = await retryWithBackoff(
      () => fetch(`${TSDB_BASE}/eventsday.php?d=${date}&s=Soccer&_=${Date.now()}`, { cache: 'no-store' }),
      2, // Lower attempt count for this less critical endpoint
      500
    ).catch(() => null);
    if (!res || !res.ok) return [];
    const json = await res.json().catch(() => ({}));
    return (json.events ?? [])
      .map(mapSportsDbMatch)
      .filter((match: any) => match !== null && match !== undefined)
      .filter((match: any) => Boolean(match.utcDate));
  });

  return data as any[];
}

function getTsdbSeasonCandidates() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const currentSeasonStart = month >= 7 ? year : year - 1;
  return [currentSeasonStart - 1, currentSeasonStart, currentSeasonStart + 1]
    .map((start) => `${start}-${start + 1}`);
}

async function fetchSportsDbCompetitionSeasonEvents(code: string, startOffset: number, endOffset: number, type: 'today' | 'results') {
  const leagueId = TSDB_LEAGUE_ID_BY_CODE[code];
  if (!leagueId) return [];

  const dateFrom = dateStr(startOffset);
  const dateTo = dateStr(endOffset);
  const seasons = getTsdbSeasonCandidates();

  const seasonPages = await Promise.all(
    seasons.map(async (season) => {
      const { data } = await withCache(`tsdb:season:${leagueId}:${season}`, 30 * 60, async () => {
        // Retry with backoff for season events (important for CL/FL1 if nextleague returns empty)
        const res = await retryWithBackoff(
          async () => {
            const r = await fetch(`${TSDB_BASE}/eventsseason.php?id=${leagueId}&s=${season}&_=${Date.now()}`, { cache: 'no-store' });
            if (!r || !r.ok) throw new Error(`fetch failed: ${r?.status}`);
            return r;
          },
          2,
          500
        ).catch(() => null);
        if (!res || !res.ok) return [];
        const json = await res.json().catch(() => ({}));
        return (json.events ?? [])
          .map(mapSportsDbMatch)
          .filter((match: any) => match !== null && match !== undefined)
          .filter((match: any) => match.competition?.code === code);
      });
      return data as any[];
    })
  );

  let filtered = seasonPages
    .flat()
    .filter((m: any) => {
      const matchDate = String(m?.utcDate ?? '').slice(0, 10);
      return matchDate && matchDate >= dateFrom && matchDate <= dateTo;
    });

  if (!filtered.length && type === 'today') {
    const expandedTo = dateStr(endOffset + 14);
    filtered = seasonPages
      .flat()
      .filter((m: any) => {
        const matchDate = String(m?.utcDate ?? '').slice(0, 10);
        return matchDate && matchDate >= dateFrom && matchDate <= expandedTo;
      })
      .slice(0, 20);
  }

  return filtered.filter((m: any) => {
    const status = String(m?.status ?? 'SCHEDULED');
    return type === 'today' ? status !== 'FINISHED' : status === 'FINISHED';
  });
}

async function fetchSportsDbCompetitionNextEvents(code: string, startOffset: number, endOffset: number, type: 'today' | 'results') {
  if (type !== 'today') return [];

  const leagueId = TSDB_LEAGUE_ID_BY_CODE[code];
  if (!leagueId) return [];

  const dateFrom = dateStr(startOffset);
  const expandedTo = dateStr(endOffset + 14);

  const { data } = await withCache(`tsdb:nextleague:${leagueId}`, 10 * 60, async () => {
    // Retry with backoff for resilience (max 3 attempts for critical CL/FL1 endpoint)
    const json = await retryWithBackoff(
      async () => {
        const result = await fetchJsonWithCurl(`${TSDB_BASE}/eventsnextleague.php?id=${leagueId}`, 5000);
        // If no events returned, treat as transient error and trigger retry
        if (!result || !result.events || result.events.length === 0) {
          throw new Error('429-empty-response');
        }
        return result;
      },
      3, // More attempts for high-value endpoint
      500
    ).catch(() => ({}));
    return (json.events ?? [])
      .map(mapSportsDbMatch)
      .filter((match: any) => match !== null && match !== undefined)
      .map((match: any) => ({
        ...match,
        competition: {
          ...(match.competition ?? {}),
          code,
          name: COMP_INFO[code]?.name ?? match.competition?.name ?? code,
        },
      }))
      .filter((match: any) => {
        const matchDate = String(match?.utcDate ?? '').slice(0, 10);
        return matchDate && matchDate >= dateFrom && matchDate <= expandedTo;
      })
      .filter((match: any) => String(match?.status ?? 'SCHEDULED') !== 'FINISHED');
  });

  return data as any[];
}

async function fetchSportsDbCompetitionNextEventsFresh(code: string, startOffset: number, endOffset: number, type: 'today' | 'results') {
  if (type !== 'today') return [];

  const leagueId = TSDB_LEAGUE_ID_BY_CODE[code];
  if (!leagueId) return [];

  const dateFrom = dateStr(startOffset);
  const expandedTo = dateStr(endOffset + 14);
  const json = await fetchJsonWithCurl(`${TSDB_BASE}/eventsnextleague.php?id=${leagueId}`, 5000).catch(() => ({}));
  const mapped = (json.events ?? [])
    .map((event: any) => {
      const match = mapSportsDbMatch(event);
      return match;
    })
    .filter((match: any) => match !== null && match !== undefined)
    .map((match: any) => ({
      ...match,
      competition: {
        ...(match.competition ?? {}),
        code,
        name: COMP_INFO[code]?.name ?? match.competition?.name ?? code,
      },
    }))
    .filter((match: any) => {
      const matchDate = String(match?.utcDate ?? '').slice(0, 10);
      return matchDate && matchDate >= dateFrom && matchDate <= expandedTo;
    })
    .filter((match: any) => String(match?.status ?? 'SCHEDULED') !== 'FINISHED');

  return mapped;
}

function mapLigue1OfficialMatch(match: any) {
  if (!match?.home?.clubIdentity || !match?.away?.clubIdentity) return null;

  const home = match.home.clubIdentity;
  const away = match.away.clubIdentity;
  const utcDate = match.date ?? null;
  if (!utcDate) return null;

  const period = String(match.period ?? '').toLowerCase();
  const status = match.isLive || period === 'live' || period === 'inprogress' || period === 'in_play'
    ? 'IN_PLAY'
    : period === 'finished' || period === 'postmatch' || period === 'final'
      ? 'FINISHED'
      : 'SCHEDULED';

  return {
    id: match.matchId,
    status,
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
    score: {
      fullTime: {
        home: typeof match.home?.score === 'number' ? match.home.score : null,
        away: typeof match.away?.score === 'number' ? match.away.score : null,
      },
      halfTime: { home: null, away: null },
    },
    liveDetails: null,
    competitionName: 'Ligue 1 McDonald\'s',
    leagueName: 'Ligue 1 McDonald\'s',
  };
}

async function fetchLigue1OfficialCalendarEvents(type: 'today' | 'results', startOffset: number, endOffset: number) {
  if (type !== 'today') return [];

  const dateKey = dateStr(startOffset);
  const json = await fetchJsonWithCurl(
    `${L1_OFFICIAL_BASE}/matches?timezone=Europe%2FParis&daysLimit=1&lookAfter=true`,
    5000
  ).catch(() => ({}));

  const official = json?.results ?? json;
  const dayBuckets = official?.byDate?.[dateKey];
  if (dayBuckets) {
    const debugMatchIds: string[] = [];
    for (const championshipBucket of Object.values(dayBuckets as Record<string, any>)) {
      for (const gameweekBucket of Object.values(championshipBucket as Record<string, any>)) {
        for (const id of (gameweekBucket as any)?.matchesIds ?? []) {
          if (typeof id === 'string') debugMatchIds.push(id);
        }
      }
    }
    console.log(`[official-ligue1] ${dateKey}: ${debugMatchIds.length} matches`);
  }
  if (!dayBuckets || typeof dayBuckets !== 'object') return [];

  const matchIds = new Set<string>();
  for (const championshipBucket of Object.values(dayBuckets as Record<string, any>)) {
    for (const gameweekBucket of Object.values(championshipBucket as Record<string, any>)) {
      for (const id of (gameweekBucket as any)?.matchesIds ?? []) {
        if (typeof id === 'string') matchIds.add(id);
      }
    }
  }

  const mapped = Array.from(matchIds)
    .map((id) => mapLigue1OfficialMatch(official?.matches?.[id]))
    .filter((match): match is NonNullable<ReturnType<typeof mapLigue1OfficialMatch>> => Boolean(match));

  return mapped.sort((a: any, b: any) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());
}

function mapPulseliveMatch(match: any) {
  if (!match) return null;

  // kickoff timestamp may be in millis or ISO string
  let utcDate: string | null = null;
  if (match.kickoff) {
    if (typeof match.kickoff === 'string') utcDate = match.kickoff;
    else if (match.kickoff.label) utcDate = match.kickoff.label;
    else if (match.kickoff.date) utcDate = match.kickoff.date;
    else if (match.kickoff.millis) utcDate = new Date(Number(match.kickoff.millis)).toISOString();
  }
  utcDate = utcDate ?? match.utcDate ?? match.date ?? null;

  const homeObj = match.homeTeam ?? match.home ?? match.home_team ?? match.homeSide ?? {};
  const awayObj = match.awayTeam ?? match.away ?? match.away_team ?? match.awaySide ?? {};

  const home = homeObj.team ?? homeObj.club ?? homeObj;
  const away = awayObj.team ?? awayObj.club ?? awayObj;

  const homeScore = match.score?.home ?? match.homeScore ?? (homeObj.score ?? null);
  const awayScore = match.score?.away ?? match.awayScore ?? (awayObj.score ?? null);

  // status mapping (best-effort)
  const rawStatus = (match.matchStatus ?? match.status ?? match.gameState ?? '').toString().toLowerCase();
  let status = 'SCHEDULED';
  if (rawStatus.includes('in') || rawStatus.includes('live') || rawStatus.includes('playing')) status = 'IN_PLAY';
  else if (rawStatus.includes('ft') || rawStatus.includes('finished') || rawStatus.includes('final')) status = 'FINISHED';
  else if (rawStatus.includes('ht') || rawStatus.includes('half')) status = 'PAUSED';

  return {
    id: match.id ?? match.matchId ?? `${home?.id ?? home?.name}:${away?.id ?? away?.name}:${utcDate ?? Date.now()}`,
    status,
    utcDate,
    homeTeam: {
      id: String(home?.id ?? home?.teamId ?? home?.shortId ?? home?.name ?? '') || null,
      name: home?.name ?? home?.teamName ?? homeObj?.name ?? 'Home',
      shortName: home?.shortName ?? home?.name ?? homeObj?.shortName ?? homeObj?.name ?? 'Home',
      crest: home?.crest ?? home?.logo ?? home?.badge ?? null,
    },
    awayTeam: {
      id: String(away?.id ?? away?.teamId ?? away?.shortId ?? away?.name ?? '') || null,
      name: away?.name ?? away?.teamName ?? awayObj?.name ?? 'Away',
      shortName: away?.shortName ?? away?.name ?? awayObj?.shortName ?? awayObj?.name ?? 'Away',
      crest: away?.crest ?? away?.logo ?? away?.badge ?? null,
    },
    competition: {
      code: 'PL',
      name: COMP_INFO.PL.name,
      emblem: COMP_INFO.PL.emblem,
    },
    score: {
      fullTime: {
        home: typeof homeScore === 'number' ? homeScore : (homeScore == null ? null : Number(homeScore)),
        away: typeof awayScore === 'number' ? awayScore : (awayScore == null ? null : Number(awayScore)),
      },
      halfTime: { home: null, away: null },
    },
    liveDetails: null,
    competitionName: 'Premier League',
    leagueName: 'Premier League',
  };
}

async function fetchPulseliveCompetitionEvents(startOffset: number, endOffset: number, type: 'today' | 'results') {
  if (type !== 'today') return [];

  const from = dateStr(startOffset);
  const to = dateStr(endOffset);

  const url = `${PULSELIVE_BASE}/competitions/8/matches?fromDate=${from}&toDate=${to}`;
  const json = await fetchJsonWithCurl(url, 5000).catch(() => ({}));
  const payload = json?.content ?? json?.matches ?? json ?? {};

  const items = Array.isArray(payload) ? payload : (payload?.content ?? payload?.matches ?? []);
  const mapped = (items ?? []).map((m: any) => mapPulseliveMatch(m)).filter(Boolean);

  return mapped.sort((a: any, b: any) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());
}

function tryParseJsonLdSportsEvent(html: string) {
  const scripts = Array.from(html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)).map((m) => m[1]);
  for (const s of scripts) {
    try {
      const j = JSON.parse(s);
      if (j && (j['@type'] === 'SportsEvent' || (Array.isArray(j['@type']) && j['@type'].includes('SportsEvent')))) {
        return j;
      }
      // Some pages wrap objects in arrays
      if (Array.isArray(j)) {
        const found = j.find((x: any) => x && x['@type'] === 'SportsEvent');
        if (found) return found;
      }
    } catch (e) {
      // ignore parse errors
    }
  }
  return null;
}

function extractIsoDatetime(html: string) {
  const m = html.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:Z|[+\-][0-9:]+)?/);
  return m ? m[0] : null;
}

function mapUefaMatchFromPage(html: string, slug: string, fallbackDate: string) {
  try {
    const jsonld = tryParseJsonLdSportsEvent(html);
    if (jsonld) {
      const start = jsonld.startDate ?? jsonld.datePublished ?? null;
      const home = (jsonld.homeTeam && (jsonld.homeTeam.name || jsonld.homeTeam)) || null;
      const away = (jsonld.awayTeam && (jsonld.awayTeam.name || jsonld.awayTeam)) || null;
      const utc = start ?? extractIsoDatetime(html) ?? `${fallbackDate}T00:00:00Z`;
      return {
        id: `uefa:${slug}`,
        status: 'SCHEDULED',
        utcDate: utc,
        homeTeam: { id: null, name: String(home ?? 'Home') },
        awayTeam: { id: null, name: String(away ?? 'Away') },
        competition: { code: 'CL', name: COMP_INFO.CL?.name ?? 'Champions League', emblem: COMP_INFO.CL?.emblem ?? null },
      };
    }

    // Fallback: try meta title or og:title
    const titleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : null;
    let home = 'Home';
    let away = 'Away';
    if (title) {
      const parts = title.split(/\s+v[sS]?\s+|\s+vs\s+|\s+-\s+/i);
      if (parts.length >= 2) {
        home = parts[0].trim();
        away = parts[1].trim();
      } else if (title.includes('-')) {
        const p = title.split('-'); home = p[0].trim(); away = p[1].trim();
      }
    }
    const iso = extractIsoDatetime(html) || `${fallbackDate}T00:00:00Z`;
    return {
      id: `uefa:${slug}`,
      status: 'SCHEDULED',
      utcDate: iso,
      homeTeam: { id: null, name: home },
      awayTeam: { id: null, name: away },
      competition: { code: 'CL', name: COMP_INFO.CL?.name ?? 'Champions League', emblem: COMP_INFO.CL?.emblem ?? null },
    };
  } catch (e) {
    return null;
  }
}


async function fetchSportsDbWindow(startOffset: number, endOffset: number) {
  const dates: string[] = [];
  // Expand date range to catch more events (especially for under-covered leagues like FL1, CL)
  const expandedStart = Math.min(startOffset, -14);
  const expandedEnd = Math.max(endOffset, 21);
  for (let offset = expandedStart; offset <= expandedEnd; offset += 1) {
    dates.push(dateStr(offset));
  }

  const pages = await Promise.all(dates.map((date) => fetchSportsDbEventsForDate(date)));
  return pages.flat();
}

function mapOpenLigaDbMatch(match: any, competitionCode: string) {
  const isFinished = match.MatchIsFinished ?? match.matchIsFinished ?? false;
  const utc = match.MatchDateTimeUTC ?? match.matchDateTimeUTC ?? match.matchDateTime ?? dateStr();
  const status = isFinished ? 'FINISHED' : (utc && new Date(utc) < new Date() ? 'FINISHED' : 'SCHEDULED');

  const homeGoals = match.MatchResults?.find((r: any) => r.ResultOrderID === 2)?.PointsTeam1 ?? null;
  const awayGoals = match.MatchResults?.find((r: any) => r.ResultOrderID === 2)?.PointsTeam2 ?? null;

  const home = match.Team1 ?? match.team1 ?? {};
  const away = match.Team2 ?? match.team2 ?? {};

  return {
    id: match.MatchID ?? match.matchID ?? `ol:${competitionCode}:${utc}`,
    status,
    utcDate: utc,
    homeTeam: {
      id: home.TeamId ?? home.teamId ?? null,
      name: home.TeamName ?? home.teamName ?? 'Home',
      shortName: home.TeamName ?? home.teamName ?? 'Home',
      crest: home.TeamIconUrl ?? home.teamIconUrl ?? null,
    },
    awayTeam: {
      id: away.TeamId ?? away.teamId ?? null,
      name: away.TeamName ?? away.teamName ?? 'Away',
      shortName: away.TeamName ?? away.teamName ?? 'Away',
      crest: away.TeamIconUrl ?? away.teamIconUrl ?? null,
    },
    competition: {
      code: competitionCode,
      name: COMP_INFO[competitionCode]?.name ?? competitionCode,
      emblem: null,
    },
    score: {
      fullTime: { home: homeGoals ?? null, away: awayGoals ?? null },
      halfTime: { home: null, away: null },
    },
    competitionName: COMP_INFO[competitionCode]?.name ?? competitionCode,
    leagueName: COMP_INFO[competitionCode]?.name ?? competitionCode,
  };
}

async function fetchOpenLigaDbCompetitionEvents(code: string, startOffset: number, endOffset: number, type: 'today' | 'results') {
  const olCode = OL_LEAGUE_BY_CODE[code];
  if (!olCode) return [];

  const cacheKey = `football:ol:${code}:${startOffset}:${endOffset}:${type}`;
  const { data } = await withCache(cacheKey, type === 'today' ? CACHE_TTL.football_today : CACHE_TTL.football_results, async () => {
    let dateFrom = dateStr(startOffset);
    let dateTo = dateStr(endOffset);

    try {
      const seasons = [new Date().getFullYear(), new Date().getFullYear() + 1, new Date().getFullYear() - 1];
      const candidates: string[] = [];
      candidates.push(`${OL_BASE}/getmatchdata/${olCode}`);
      for (const s of seasons) {
        candidates.push(`${OL_BASE}/getmatchdata/${olCode}/${s}`);
        candidates.push(`${OL_BASE}/getmatchesbyleagueandseason?leagueShortcut=${olCode}&season=${s}`);
      }

      for (const url of candidates) {
        const json = await fetchJsonWithTimeout(url, {}, 3500).catch(() => null);
        if (!json || !Array.isArray(json) || !json.length) continue;

        let filtered = (json ?? [])
          .filter((m: any) => {
            const matchDate = (m.MatchDateTimeUTC ?? m.matchDateTimeUTC ?? m.matchDateTime ?? '').slice(0, 10);
            return matchDate && matchDate >= dateFrom && matchDate <= dateTo;
          });

            const nextEvents = await fetchSportsDbCompetitionNextEvents(code, startOffset, endOffset, type);
            if (nextEvents && nextEvents.length) {
              recordSourceAttempt('thesportsdb', true);
              return nextEvents;
            }

        // If empty for this week, expand search to 3 weeks ahead
        if (!filtered.length && type === 'today') {
          const expandedTo = dateStr(endOffset + 14);
          filtered = (json ?? [])
            .filter((m: any) => {
              const matchDate = (m.MatchDateTimeUTC ?? m.matchDateTimeUTC ?? m.matchDateTime ?? '').slice(0, 10);
              return matchDate && matchDate >= dateFrom && matchDate <= expandedTo;
            })
            .slice(0, 10); // Limit to first 10 matches in expanded window
        }

        if (filtered.length) {
          filtered = filtered
            .filter((m: any) => {
              const matchStatus = (m.MatchIsFinished ?? m.matchIsFinished) ? 'FINISHED' : 'SCHEDULED';
              return type === 'today' ? !['FINISHED'].includes(matchStatus) : matchStatus === 'FINISHED';
            })
            .map((m: any) => mapOpenLigaDbMatch(m, code));

          if (filtered.length) return filtered;
        }
      }
      return [];
    } catch (error) {
      console.warn(`OpenLigaDB ${code} fetch error`, (error as any)?.message ?? error);
      return [];
    }
  });

  return data as any[];
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
  if (!process.env.FOOTBALL_API_KEY) return [];

  const cacheKey = `football:fd:${code}:${startOffset}:${endOffset}:${type}`;
  const { data } = await withCache(cacheKey, type === 'today' ? CACHE_TTL.football_today : CACHE_TTL.football_results, async () => {
    const dateFrom = dateStr(startOffset);
    const dateTo = dateStr(endOffset);
    const statusSuffix = type === 'results' ? '&status=FINISHED' : '';

    const json = await fetchJsonWithTimeout(
      `${FD_BASE}/competitions/${code}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}${statusSuffix}`,
      { headers: fdHeaders() },
      3500
    );

    return (json.matches ?? [])
      .filter((m: any) => COMPETITIONS.includes(m.competition?.code))
      .filter((m: any) => type === 'today' ? !['FINISHED', 'CANCELLED', 'POSTPONED'].includes(m.status) : true)
      .map((m: any) => enrichMatch(m));
  });

  return data as any[];
}

async function fetchApiFootballCompetitionEvents(code: string, leagueId: number, startOffset: number, endOffset: number, type: 'today' | 'results') {
  const apiKey = process.env.RAPIDAPI_KEY ?? process.env.API_FOOTBALL_KEY;
  if (!apiKey) return [];

  const cacheKey = `football:af:${code}:${startOffset}:${endOffset}:${type}`;
  const { data } = await withCache(cacheKey, type === 'today' ? CACHE_TTL.football_today : CACHE_TTL.football_results, async () => {
    const dateFrom = dateStr(startOffset);
    const dateTo = dateStr(endOffset);

    const json = await fetchJsonWithTimeout(
      `${AF_BASE}/fixtures?league=${leagueId}&season=2025&from=${dateFrom}&to=${dateTo}`,
      { headers: afHeaders() },
      3500
    );

    return (json.response ?? [])
      .filter((m: any) => {
        const status = mapApiFootballStatus(m.fixture?.status?.short);
        return type === 'today' ? !['FINISHED', 'CANCELLED', 'POSTPONED'].includes(status) : status === 'FINISHED';
      })
      .map((m: any) => enrichMatch(mapApiFootballMatch(m)));
  });

  return data as any[];
}

async function fetchFootballEventsWindow(type: 'today' | 'results', startOffset: number, endOffset: number) {
  const perCompetition = await Promise.all(COMPETITIONS.map(async (code) => fetchCompetitionEventsByPriority(code, startOffset, endOffset, type)));
  // per-competition sizes (diagnostic removed)

  const footballDataEvents = perCompetition.flat();
  const fallback = await fetchSportsDbWindow(startOffset, endOffset);

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
          ? await fetchSportsDbCompetitionNextEvents(code, startOffset, endOffset, type)
          : await fetchSportsDbCompetitionSeasonEvents(code, startOffset, endOffset, type);
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

const TSDB_LOOK_AHEAD_MIN_MATCHES = 4;
const TSDB_LOOK_AHEAD_EXTENSION_DAYS = 7;
const TSDB_LOOK_AHEAD_MAX_CODES_PER_RUN = 4;
let lastSparseTsdbLookAheadDate = '';

async function fetchSportsDbCompetitionNextEventsStrict(code: string, startOffset: number, endOffset: number, type: 'today' | 'results') {
  if (type !== 'today') return [];

  const leagueId = TSDB_LEAGUE_ID_BY_CODE[code];
  if (!leagueId) return [];

  const dateFrom = dateStr(startOffset);
  const dateTo = dateStr(endOffset);

  const { data } = await withCache(`tsdb:nextleague:strict:${leagueId}:${dateFrom}:${dateTo}`, 12 * 60 * 60, async () => {
    const json = await retryWithBackoff(
      async () => {
        const result = await fetchJsonWithCurl(`${TSDB_BASE}/eventsnextleague.php?id=${leagueId}`, 5000);
        if (!result || !result.events || result.events.length === 0) {
          throw new Error('429-empty-response');
        }
        return result;
      },
      3,
      500
    ).catch(() => ({}));

    return (json.events ?? [])
      .map(mapSportsDbMatch)
      .filter((match: any) => match !== null && match !== undefined)
      .map((match: any) => ({
        ...match,
        competition: {
          ...(match.competition ?? {}),
          code,
          name: COMP_INFO[code]?.name ?? match.competition?.name ?? code,
        },
      }))
      .filter((match: any) => {
        const matchDate = String(match?.utcDate ?? '').slice(0, 10);
        return matchDate && matchDate >= dateFrom && matchDate <= dateTo;
      })
      .filter((match: any) => String(match?.status ?? 'SCHEDULED') !== 'FINISHED');
  });

  return data as any[];
}

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
      const extendedEvents = await fetchSportsDbCompetitionNextEventsStrict(code, 0, TSDB_LOOK_AHEAD_EXTENSION_DAYS, 'today');

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

function sameDay(a?: string, b?: string) {
  if (!a || !b) return false;
  return a.slice(0, 10) === b.slice(0, 10);
}

function outcomePrice(outcomes: any[], teamName: string) {
  const target = normalizeName(teamName);
  return outcomes.find((o: any) => {
    const name = normalizeName(o.name);
    return name === target || name.includes(target) || target.includes(name);
  })?.price ?? null;
}

function normalizeOddsEvent(event: any) {
  const bookmaker =
    event.bookmakers?.find((b: any) => b.key === 'betclic') ??
    event.bookmakers?.find((b: any) => b.key === 'pinnacle') ??
    event.bookmakers?.find((b: any) => b.key === 'betfair_ex_uk') ??
    event.bookmakers?.[0];
  const market = bookmaker?.markets?.find((m: any) => m.key === 'h2h');
  const outcomes = market?.outcomes ?? [];

  return {
    home: event.home_team,
    away: event.away_team,
    commenceTime: event.commence_time,
    bookmaker: bookmaker?.title ?? null,
    lastUpdate: market?.last_update ?? bookmaker?.last_update ?? null,
    prices: {
      home: outcomePrice(outcomes, event.home_team),
      draw: outcomes.find((o: any) => normalizeName(o.name) === 'draw')?.price ?? null,
      away: outcomePrice(outcomes, event.away_team),
    },
  };
}

async function getOddsByCompetition(codes: string[]) {
  const apiKey = process.env.THE_ODDS_API_KEY ?? process.env.ODDS_API_KEY;
  if (!apiKey) return {};

  const uniqueCodes = Array.from(new Set(codes.filter((code) => ODDS_SPORT_KEYS[code])));

  const entries = await Promise.all(uniqueCodes.map(async (code) => {
    const sport = ODDS_SPORT_KEYS[code];
    const cacheKey = `odds:${sport}`;

    const { data } = await withCache(cacheKey, 24 * 60 * 60, async () => {
      const url = `${ODDS_BASE}/sports/${sport}/odds?regions=eu,uk&markets=h2h&oddsFormat=decimal&apiKey=${apiKey}`;
      const res = await fetch(url).catch(() => null);
      if (!res || !res.ok) {
        console.warn(`Odds ${sport} ${res ? res.status : 'no-response'}`);
        return [];
      }

      const json = await res.json().catch(() => []);
      const normalizedEvents = (json ?? []).map((ev: any) => {
        const commenceTime = ev.commence_time ?? ev.commenceTime ?? ev.commence_time;
        const bookmakers = Array.isArray(ev.bookmakers) ? ev.bookmakers : [];

        const bookProbs: Array<{ home?: number; draw?: number; away?: number; lastUpdate?: string; bookmaker?: string }> = [];
        for (const b of bookmakers) {
          const market = Array.isArray(b.markets) ? b.markets.find((m: any) => m.key === 'h2h') : null;
          const outcomes = market?.outcomes ?? [];
          const homeOdd = outcomes.find((o: any) => normalizeName(o.name) === normalizeName(ev.home_team ?? ev.home))?.price ?? outcomes[0]?.price ?? null;
          const awayOdd = outcomes.find((o: any) => normalizeName(o.name) === normalizeName(ev.away_team ?? ev.away))?.price ?? outcomes[1]?.price ?? null;
          const drawOdd = outcomes.find((o: any) => normalizeName(o.name) === 'draw')?.price ?? outcomes.find((o: any) => normalizeName(o.name).includes('draw'))?.price ?? null;

          if (homeOdd || awayOdd || drawOdd) {
            const pHome = homeOdd ? 1 / Number(homeOdd) : 0;
            const pDraw = drawOdd ? 1 / Number(drawOdd) : 0;
            const pAway = awayOdd ? 1 / Number(awayOdd) : 0;
            const s = pHome + pDraw + pAway;
            if (s > 0) {
              bookProbs.push({
                home: pHome / s,
                draw: pDraw / s,
                away: pAway / s,
                lastUpdate: market?.last_update ?? b?.last_update ?? null,
                bookmaker: b?.title ?? b?.key ?? null,
              });
            }
          }
        }

        if (!bookProbs.length) return null;

        const sum = bookProbs.reduce((acc: { home: number; draw: number; away: number }, p) => {
          acc.home += p.home ?? 0;
          acc.draw += p.draw ?? 0;
          acc.away += p.away ?? 0;
          return acc;
        }, { home: 0, draw: 0, away: 0 });

        const avg = {
          home: sum.home / bookProbs.length,
          draw: sum.draw / bookProbs.length,
          away: sum.away / bookProbs.length,
          lastUpdate: bookProbs[0]?.lastUpdate ?? null,
        };

        const prices: any = {};
        if (avg.home && avg.home > 0) prices.home = +(1 / avg.home).toFixed(3);
        if (avg.draw && avg.draw > 0) prices.draw = +(1 / avg.draw).toFixed(3);
        if (avg.away && avg.away > 0) prices.away = +(1 / avg.away).toFixed(3);

        return {
          home: ev.home_team ?? ev.home ?? ev.teams?.home ?? null,
          away: ev.away_team ?? ev.away ?? ev.teams?.away ?? null,
          commenceTime,
          lastUpdate: avg.lastUpdate ?? null,
          prices,
          source: 'the-odds-api-aggregated',
        };
      }).filter(Boolean);

      return normalizedEvents;
    });

    return [code, data ?? []] as const;
  }));

  return Object.fromEntries(entries);
}

function findOddsForMatch(match: any, oddsByCompetition: Record<string, any[]>) {
  const events = oddsByCompetition[match.competition?.code] ?? [];
  const home = normalizeName(match.homeTeam?.name ?? match.homeTeam?.shortName ?? '');
  const away = normalizeName(match.awayTeam?.name ?? match.awayTeam?.shortName ?? '');

  return events.find((event) => {
    const eventHome = normalizeName(event.home);
    const eventAway = normalizeName(event.away);
    const namesMatch =
      (eventHome.includes(home) || home.includes(eventHome)) &&
      (eventAway.includes(away) || away.includes(eventAway));
    return namesMatch && sameDay(event.commenceTime, match.utcDate);
  }) ?? null;
}

function enrichMatch(m: any, oddsByCompetition: Record<string, any[]> = {}) {
  const publicOdds = findOddsForMatch(m, oddsByCompetition);
  return {
    ...m,
    competitionName: COMP_INFO[m.competition?.code]?.name ?? m.competition?.name ?? '',
    leagueName: COMP_INFO[m.competition?.code]?.name ?? m.competition?.name ?? '',
    publicOdds,
  };
}

function mapApiFootballStatus(short?: string) {
  const status = String(short ?? '').toUpperCase();
  if (['HT', 'PAUSE', 'BREAK'].includes(status)) return 'PAUSED';
  if (['1H', '2H', 'ET', 'BT', 'LIVE'].includes(status)) return 'IN_PLAY';
  if (['FT', 'AET', 'PEN'].includes(status)) return 'FINISHED';
  return 'IN_PLAY';
}

function mapApiFootballMatch(item: any) {
  const leagueId = item?.league?.id;
  const competitionCode = Object.entries(AF_LEAGUE_BY_CODE).find(([, id]) => id === leagueId)?.[0] ?? String(leagueId ?? 'AF');
  return {
    id: item?.fixture?.id ?? `${competitionCode}:${item?.fixture?.timestamp ?? Date.now()}`,
    status: mapApiFootballStatus(item?.fixture?.status?.short),
    utcDate: item?.fixture?.date ?? new Date((item?.fixture?.timestamp ?? Date.now()) * 1000).toISOString(),
    homeTeam: {
      id: item?.teams?.home?.id ?? null,
      name: item?.teams?.home?.name ?? 'Home',
      shortName: item?.teams?.home?.name ?? 'Home',
      crest: item?.teams?.home?.logo ?? null,
    },
    awayTeam: {
      id: item?.teams?.away?.id ?? null,
      name: item?.teams?.away?.name ?? 'Away',
      shortName: item?.teams?.away?.name ?? 'Away',
      crest: item?.teams?.away?.logo ?? null,
    },
    competition: {
      code: competitionCode,
      name: item?.league?.name ?? competitionCode,
      emblem: item?.league?.logo ?? null,
    },
    score: {
      fullTime: {
        home: item?.goals?.home ?? null,
        away: item?.goals?.away ?? null,
      },
      halfTime: {
        home: item?.score?.halftime?.home ?? null,
        away: item?.score?.halftime?.away ?? null,
      },
    },
    liveDetails: {
      minute: item?.fixture?.status?.elapsed ?? null,
      source: 'api-football',
      score: {
        home: item?.goals?.home ?? null,
        away: item?.goals?.away ?? null,
      },
    },
  };
}

async function fetchApiFootballLiveMatches() {
  const apiKey = process.env.RAPIDAPI_KEY ?? process.env.API_FOOTBALL_KEY;
  if (!apiKey) return [];

  const res = await fetch(`${AF_BASE}/fixtures?live=all`, { headers: afHeaders() }).catch(() => null);
  if (!res || !res.ok) return [];
  const json = await res.json().catch(() => null);
  const fixtures = json?.response ?? [];

  return fixtures.map(mapApiFootballMatch).filter((match: any) => ['IN_PLAY', 'PAUSED'].includes(match.status));
}

async function fetchMatchesForStatus(status: 'IN_PLAY' | 'PAUSED' | 'SUSPENDED') {
  const res = await fetch(`${FD_BASE}/matches?status=${status}`, { headers: fdHeaders() });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`FD live ${status} ${res.status}${txt ? `: ${txt}` : ''}`);
  }
  const json = await res.json();
  return json.matches ?? [];
}

function readLastLiveSnapshot() {
  return readArchiveMerged('live');
}

function writeLastLiveSnapshot(payload: any) {
  writeArchiveSnapshot('live', payload);
}

function readLastTodaySnapshot() {
  return readArchiveMerged('today');
}

function writeLastTodaySnapshot(payload: any) {
  writeArchiveSnapshot('today', payload);
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

function readLastResultsSnapshot() {
  return readArchiveMerged('results');
}

function writeLastResultsSnapshot(payload: any) {
  writeArchiveSnapshot('results', payload);
}

function getArchivedCompetitionEvents(code: string, type: 'today' | 'results') {
  const snapshot = type === 'today' ? readLastTodaySnapshot() : readLastResultsSnapshot();
  return (snapshot?.events ?? []).filter((event: any) => event?.competition?.code === code);
}

function mergeResultsSnapshot(events: any[]) {
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
          ...(await fetchSportsDbWindow(0, 0)),
          ...(await Promise.all(
            COMPETITIONS.map(async (code) => fetchSportsDbCompetitionNextEventsFresh(code, 0, 0, 'today'))
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
                fetchSportsDbCompetitionNextEventsFresh(code, 0, 21, 'today'),
                fetchSportsDbCompetitionSeasonEvents(code, 0, 21, 'today'),
              ]).then((parts) => parts.flat());
            }

            return fetchSportsDbCompetitionSeasonEvents(code, -21, 0, 'results');
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
        // Save updated events back to snapshot so FL1 top-up persists
        writeLastTodaySnapshot({ events, fetchedAt: snapshot.fetchedAt });
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
              fetchSportsDbCompetitionNextEventsFresh(code, 0, 21, 'today'),
              fetchSportsDbCompetitionSeasonEvents(code, 0, 21, 'today'),
            ]).then((parts) => parts.flat());
          }

          return fetchSportsDbCompetitionSeasonEvents(code, -21, 0, 'results');
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

    // Persist a fresh snapshot for `today` so we can serve it when upstream fails later
    if (type === 'today' && events && events.length) {
      try {
        const existing = readLastTodaySnapshot();
        const mergedToday = mergeTodaySnapshot(events);
        if (shouldPersistTodaySnapshot(existing?.events, mergedToday)) {
          writeLastTodaySnapshot({ events: mergedToday, fetchedAt: Date.now() });
        }
      } catch (e) {
        // ignore write failures
      }
    }

    // Persist merged snapshot for results to avoid league dropouts on partial source failures
    if (type === 'results' && events && events.length) {
      try {
        const mergedResults = mergeResultsSnapshot(events);
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