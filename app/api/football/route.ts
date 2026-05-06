import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_TTL, getCacheEntry, setCacheEntry, withCache, withStaleCache } from '@/lib/cache';
import { fetchRssFeed, fetchWikipediaCompetition } from '@/lib/fallbackSources';
import { getLiveData, startFootballPoller } from '@/lib/footballPoller';

export const runtime = 'nodejs';

const FD_BASE = 'https://api.football-data.org/v4';
const AF_BASE = 'https://api-football-v1.p.rapidapi.com/v3';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/3';
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
const COMP_INFO: Record<string, { name: string }> = {
  FL1: { name: 'Ligue 1' },
  CL: { name: 'Champions League' },
  PL: { name: 'Premier League' },
  PD: { name: 'La Liga' },
  SA: { name: 'Serie A' },
  BL1: { name: 'Bundesliga' },
};
const ODDS_SPORT_KEYS: Record<string, string> = {
  FL1: 'soccer_france_ligue_one',
  CL: 'soccer_uefa_champs_league',
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  SA: 'soccer_italy_serie_a',
  BL1: 'soccer_germany_bundesliga',
};

// Per-competition source priority (try in order)
// Source monitoring (track successes/failures per source)
type SourceStats = { successes: number; failures: number; lastFetch?: number };
const SOURCE_STATS: Record<string, SourceStats> = {
  'football-data': { successes: 0, failures: 0 },
  'api-football': { successes: 0, failures: 0 },
  'thesportsdb': { successes: 0, failures: 0 },
  'openligadb': { successes: 0, failures: 0 },
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
  FL1: ['football-data', 'openligadb', 'api-football', 'thesportsdb', 'rss', 'wikipedia'],
  BL1: ['openligadb', 'football-data', 'api-football', 'thesportsdb'],
  CL:  ['football-data', 'openligadb', 'thesportsdb', 'rss', 'wikipedia'],
  PL:  ['football-data', 'api-football', 'thesportsdb', 'rss', 'wikipedia'],
  PD:  ['football-data', 'api-football', 'thesportsdb', 'rss', 'wikipedia'],
  SA:  ['football-data', 'api-football', 'thesportsdb', 'rss', 'wikipedia'],
};

// Simple per-source rate limiting (milliseconds)
const SOURCE_MIN_INTERVAL_MS: Record<string, number> = {
  'football-data': 500,
  'api-football': 500,
  'openligadb': 500,
  'thesportsdb': 500,
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
  const sources = COMP_SOURCES[code] ?? ['football-data', 'api-football', 'thesportsdb'];
  for (const src of sources) {
    try {
      await throttleFor(src);
      if (src === 'football-data') {
        const res = await fetchFootballDataCompetitionEvents(code, startOffset, endOffset, type);
        if (res && res.length) {
          recordSourceAttempt('football-data', true);
          return res;
        }
        recordSourceAttempt('football-data', false);
      }
      if (src === 'api-football') {
        const leagueId = AF_LEAGUE_BY_CODE[code];
        if (leagueId) {
          const res = await fetchApiFootballCompetitionEvents(code, leagueId, startOffset, endOffset, type);
          if (res && res.length) {
            recordSourceAttempt('api-football', true);
            return res;
          }
          recordSourceAttempt('api-football', false);
        }
      }
      if (src === 'openligadb') {
        if (OL_LEAGUE_BY_CODE[code]) {
          const res = await fetchOpenLigaDbCompetitionEvents(code, startOffset, endOffset, type);
          if (res && res.length) {
            recordSourceAttempt('openligadb', true);
            return res;
          }
          recordSourceAttempt('openligadb', false);
        }
      }
      if (src === 'thesportsdb') {
        const nextEvents = await fetchSportsDbCompetitionNextEvents(code, startOffset, endOffset, type);
        if (nextEvents && nextEvents.length) {
          recordSourceAttempt('thesportsdb', true);
          return nextEvents;
        }

        const seasonal = await fetchSportsDbCompetitionSeasonEvents(code, startOffset, endOffset, type);
        if (seasonal && seasonal.length) {
          recordSourceAttempt('thesportsdb', true);
          return seasonal;
        }

        const all = await fetchSportsDbWindow(startOffset, endOffset);
        const filtered = (all ?? []).filter((m: any) => m.competition?.code === code);
        if (filtered && filtered.length) {
          recordSourceAttempt('thesportsdb', true);
          return filtered;
        }
        recordSourceAttempt('thesportsdb', false);
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
              return items.map((it: any) => ({ id: `rss:${u}:${it.date}:${it.title}`, utcDate: it.date, homeTeam: { name: it.title.split(' - ')[0] ?? it.title }, awayTeam: { name: it.title.split(' - ')[1] ?? '' }, competition: { code }, status: 'SCHEDULED' }));
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
  return [];
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
    const res = await fetch(`${TSDB_BASE}/eventsday.php?d=${date}&s=Soccer&_=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
    if (!res || !res.ok) return [];
    const json = await res.json().catch(() => ({}));
    return (json.events ?? [])
      .map(mapSportsDbMatch)
      .filter((match: any) => match !== null && match !== undefined)
      .filter((match: any) => COMPETITIONS.includes(match.competition?.code));
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
        const res = await fetch(`${TSDB_BASE}/eventsseason.php?id=${leagueId}&s=${season}&_=${Date.now()}`, { cache: 'no-store' }).catch(() => null);
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
    const json = await fetchJsonWithCurl(`${TSDB_BASE}/eventsnextleague.php?id=${leagueId}`, 5000).catch(() => ({}));
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
    if (status === 'SCHEDULED') return 2;
    if (status === 'FINISHED') return 1;
    return 0;
  };

  for (const event of events) {
    const comp = String(event?.competition?.code ?? '');
    const id = String(event?.id ?? '');
    const key = `${comp}:${id || `${event?.homeTeam?.name ?? ''}:${event?.awayTeam?.name ?? ''}:${event?.utcDate ?? ''}`}`;
    if (!key) continue;

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
        return await fetchSportsDbCompetitionNextEvents(code, startOffset, endOffset, type);
      } catch {
        return [];
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
      const leagueIds = Object.entries(TSDB_LEAGUE_ID_BY_CODE).map(([, id]) => Number(id));
      for (const id of leagueIds) {
        const code = (Object.entries(TSDB_LEAGUE_ID_BY_CODE).find(([, v]) => v === id) ?? [])[0];
        if (!code) continue;
        try {
          await fetchSportsDbCompetitionNextEvents(code, 0, 14, 'today');
        } catch (e) {
          // ignore individual failures
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
  try {
    const path = join(process.cwd(), '.cache', 'football-last-live.json');
    const data = readFileSync(path, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function writeLastLiveSnapshot(payload: any) {
  try {
    const path = join(process.cwd(), '.cache', 'football-last-live.json');
    writeFileSync(path, JSON.stringify(payload, null, 2));
  } catch {
    // silent fail - don't crash if we can't write to cache file
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
    let finalMatches = 
      cached?.data?.matches?.length 
        ? cached.data.matches
        : live.matches?.length
          ? live.matches
          : sportsDbLive.length
            ? sportsDbLive
            : (readLastLiveSnapshot()?.matches ?? []);
    
    return NextResponse.json(
      { matches: finalMatches, fetchedAt: Date.now() },
      { headers: { 'X-Cache': cached?.data?.matches?.length ? 'HIT' : 'STORE' } }
    );
  }

  if (type === 'today' || type === 'results') {
    startFootballWeeklyPrefetch();
    startDailyTsdbNextLeaguePrefetch(2);
    startDailyOddsPrefetch(3);
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

    // Fetch and enrich with odds
    let events: any[] = data.events ?? [];
    const uniqueCompetitions = Array.from(new Set(events.map((e: any) => e.competition?.code).filter(Boolean)));
    const oddsByCompetition = await getOddsByCompetition(uniqueCompetitions);
    events = events.map((e: any) => enrichMatch(e, oddsByCompetition));

    // Final safety net: if CL or FL1 is still missing, pull it straight from TSDB.
    const missingSafetyCodes = ['CL', 'FL1'].filter((code) => !events.some((event: any) => event.competition?.code === code));
    if (missingSafetyCodes.length) {
      const safetyEvents = await Promise.all(
        missingSafetyCodes.map((code) => fetchSportsDbCompetitionNextEventsFresh(code, type === 'today' ? 0 : -21, type === 'today' ? 21 : 0, type))
      );
      const safetyFlat = safetyEvents.flat();
      if (safetyFlat.length) {
        events = dedupeEvents([...events, ...safetyFlat]).map((event: any) => enrichMatch(event, oddsByCompetition));
      }
    }

    // provide competition counts so frontend can render empty competitions
    const compsList = COMPETITIONS.map((code) => ({ code, name: COMP_INFO[code]?.name ?? code, count: events.filter((e: any) => e.competition?.code === code).length }));

    return NextResponse.json(
      { ...data, events, competitions: compsList, fetchedAt: Date.now() - (fromCache ? age * 1000 : 0), stale },
      { headers: { 'X-Cache': fromCache ? `${stale ? 'STALE' : 'HIT'} age=${age}s` : 'MISS' } }
    );
  }

  return NextResponse.json({ error: 'Type invalide' }, { status: 400 });
}