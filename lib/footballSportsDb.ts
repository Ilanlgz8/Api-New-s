import { withCache } from './cache';
import { normalizeName } from './footballHelpers';
import type { CompetitionInfoMap } from './footballRouteHelpers';

export const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/3';

export const TSDB_LEAGUE_MATCHERS: Record<string, string[]> = {
  FL1: ['frenchligue1', 'ligue1'],
  CL: ['uefachampionsleague', 'championsleague'],
  UEL: ['uefaeuropaleague', 'europaleague', 'europa league', 'europa_league'],
  UECL: ['uefaconferenceleague', 'conferenceleague', 'conference league', 'uefa_conference_league'],
  PL: ['englishpremierleague', 'premierleague'],
  PD: ['spanishlaliga', 'laliga'],
  SA: ['italianseriea', 'seriea'],
  BL1: ['germanbundesliga', 'bundesliga'],
};

export const TSDB_LEAGUE_ID_BY_CODE: Record<string, number> = {
  FL1: 4334,
  CL: 4480,
  UEL: 4486,
  UECL: 4698,
  PL: 4328,
  PD: 4335,
  SA: 4332,
  BL1: 4331,
};

function normalizeLeagueName(value = '') {
  return normalizeName(value).replace(/league$/g, '');
}

export function matchSportsDbCompetition(leagueName = '') {
  const normalized = normalizeLeagueName(leagueName);
  return (Object.entries(TSDB_LEAGUE_MATCHERS).find(([, matchers]) => matchers.some((matcher) => normalized.includes(matcher) || matcher.includes(normalized))) ?? [null])[0] as string | null;
}

export function mapSportsDbStatus(value = '') {
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

function dateStr(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function retryWithBackoff<T>(fn: () => Promise<T>, maxAttempts = 3, baseDelayMs = 500): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = (error as Error)?.message ?? '';
      const transient = message.includes('429') || message.includes('timeout') || message.includes('ECONNRESET') || message.includes('ETIMEDOUT');
      if (!transient || attempt === maxAttempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

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

export function mapSportsDbMatch(event: any, competitionInfo: CompetitionInfoMap = {}) {
  const leagueName = (event.strLeague ?? '').toLowerCase();
  const excludedPatterns = ['women', "women's", 'female', 'reserve', 'second', 'youth', 'u-', 'u20', 'u19', 'u18', 'u17', 'elite'];
  if (excludedPatterns.some((pattern) => leagueName.includes(pattern))) {
    return null;
  }

  const competitionCode = matchSportsDbCompetition(event.strLeague ?? '') ?? `tsdb:${event.idLeague ?? normalizeName(event.strLeague ?? 'league')}`;
  const status = mapSportsDbStatus(event.strStatus ?? '');
  const homeScore = event.intHomeScore == null || event.intHomeScore === '' ? null : Number(event.intHomeScore);
  const awayScore = event.intAwayScore == null || event.intAwayScore === '' ? null : Number(event.intAwayScore);

  let utcDateRaw = event.strTimestamp ?? (event.dateEvent && (event.strTimeLocal ?? event.strTime) ? `${event.dateEvent}T${event.strTimeLocal ?? event.strTime}` : `${event.dateEvent ?? dateStr()}T00:00:00`);
  if (typeof utcDateRaw === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(utcDateRaw)) {
    utcDateRaw = `${utcDateRaw}Z`;
  }

  const competitionName = competitionInfo[competitionCode]?.name ?? event.strLeague ?? competitionCode;
  const emblem = competitionInfo[competitionCode]?.emblem ?? event.strLeagueBadge ?? null;

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
      name: competitionName,
      emblem,
    },
    score: {
      fullTime: { home: homeScore, away: awayScore },
      halfTime: { home: null, away: null },
    },
    liveDetails: status === 'IN_PLAY' || status === 'PAUSED'
      ? {
          minute: null,
          source: 'thesportsdb',
          score: { home: homeScore, away: awayScore },
        }
      : null,
    liveSource: status === 'IN_PLAY' || status === 'PAUSED' ? 'thesportsdb' : undefined,
    competitionName,
    leagueName: competitionName,
  };
}

async function fetchSportsDbEventsForDate(date: string, competitionInfo: CompetitionInfoMap) {
  const { data } = await withCache(`tsdb:soccer:${date}`, 10 * 60, async () => {
    const res = await retryWithBackoff(() => fetch(`${TSDB_BASE}/eventsday.php?d=${date}&s=Soccer&_=${Date.now()}`, { cache: 'no-store' }), 2, 500).catch(() => null);
    if (!res || !res.ok) return [];
    const json = await res.json().catch(() => ({}));
    return (json.events ?? [])
      .map((event: any) => mapSportsDbMatch(event, competitionInfo))
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
  return [currentSeasonStart - 1, currentSeasonStart, currentSeasonStart + 1].map((start) => `${start}-${start + 1}`);
}

export async function fetchSportsDbCompetitionSeasonEvents(code: string, startOffset: number, endOffset: number, type: 'today' | 'results', competitionInfo: CompetitionInfoMap = {}) {
  const leagueId = TSDB_LEAGUE_ID_BY_CODE[code];
  if (!leagueId) return [];

  const dateFrom = dateStr(startOffset);
  const dateTo = dateStr(endOffset);
  const seasons = getTsdbSeasonCandidates();

  const seasonPages = await Promise.all(
    seasons.map(async (season) => {
      const { data } = await withCache(`tsdb:season:${leagueId}:${season}`, 30 * 60, async () => {
        const res = await retryWithBackoff(
          async () => {
            const response = await fetch(`${TSDB_BASE}/eventsseason.php?id=${leagueId}&s=${season}&_=${Date.now()}`, { cache: 'no-store' });
            if (!response || !response.ok) throw new Error(`fetch failed: ${response?.status}`);
            return response;
          },
          2,
          500
        ).catch(() => null);
        if (!res || !res.ok) return [];
        const json = await res.json().catch(() => ({}));
        return (json.events ?? [])
          .map((event: any) => mapSportsDbMatch(event, competitionInfo))
          .filter((match: any) => match !== null && match !== undefined)
          .filter((match: any) => match.competition?.code === code);
      });
      return data as any[];
    })
  );

  let filtered = seasonPages.flat().filter((match: any) => {
    const matchDate = String(match?.utcDate ?? '').slice(0, 10);
    return matchDate && matchDate >= dateFrom && matchDate <= dateTo;
  });

  if (!filtered.length && type === 'today') {
    const expandedTo = dateStr(endOffset + 14);
    filtered = seasonPages.flat().filter((match: any) => {
      const matchDate = String(match?.utcDate ?? '').slice(0, 10);
      return matchDate && matchDate >= dateFrom && matchDate <= expandedTo;
    }).slice(0, 20);
  }

  return filtered.filter((match: any) => {
    const status = String(match?.status ?? 'SCHEDULED');
    return type === 'today' ? status !== 'FINISHED' : status === 'FINISHED';
  });
}

export async function fetchSportsDbCompetitionNextEvents(code: string, startOffset: number, endOffset: number, type: 'today' | 'results', competitionInfo: CompetitionInfoMap = {}) {
  if (type !== 'today') return [];

  const leagueId = TSDB_LEAGUE_ID_BY_CODE[code];
  if (!leagueId) return [];

  const dateFrom = dateStr(startOffset);
  const expandedTo = dateStr(endOffset + 14);

  const { data } = await withCache(`tsdb:nextleague:${leagueId}`, 10 * 60, async () => {
    const json = await retryWithBackoff(async () => {
      const result = await fetchJsonWithCurl(`${TSDB_BASE}/eventsnextleague.php?id=${leagueId}`, 5000);
      if (!result || !result.events || result.events.length === 0) {
        throw new Error('429-empty-response');
      }
      return result;
    }, 3, 500).catch(() => ({}));

    return (json.events ?? [])
      .map((event: any) => mapSportsDbMatch(event, competitionInfo))
      .filter((match: any) => match !== null && match !== undefined)
      .filter((match: any) => {
        const matchDate = String(match?.utcDate ?? '').slice(0, 10);
        return matchDate && matchDate >= dateFrom && matchDate <= expandedTo;
      })
      .filter((match: any) => String(match?.status ?? 'SCHEDULED') !== 'FINISHED');
  });

  return data as any[];
}

export async function fetchSportsDbCompetitionNextEventsFresh(code: string, startOffset: number, endOffset: number, type: 'today' | 'results', competitionInfo: CompetitionInfoMap = {}) {
  if (type !== 'today') return [];

  const leagueId = TSDB_LEAGUE_ID_BY_CODE[code];
  if (!leagueId) return [];

  const dateFrom = dateStr(startOffset);
  const expandedTo = dateStr(endOffset + 14);
  const json = await fetchJsonWithCurl(`${TSDB_BASE}/eventsnextleague.php?id=${leagueId}`, 5000).catch(() => ({}));
  const mapped = (json.events ?? [])
    .map((event: any) => mapSportsDbMatch(event, competitionInfo))
    .filter((match: any) => match !== null && match !== undefined)
    .filter((match: any) => {
      const matchDate = String(match?.utcDate ?? '').slice(0, 10);
      return matchDate && matchDate >= dateFrom && matchDate <= expandedTo;
    })
    .filter((match: any) => String(match?.status ?? 'SCHEDULED') !== 'FINISHED');

  return mapped;
}

export async function fetchSportsDbWindow(startOffset: number, endOffset: number, competitionInfo: CompetitionInfoMap = {}) {
  const dates: string[] = [];
  const expandedStart = Math.min(startOffset, -60);
  const expandedEnd = Math.max(endOffset, 60);
  for (let offset = expandedStart; offset <= expandedEnd; offset += 1) {
    dates.push(dateStr(offset));
  }

  const pages = await Promise.all(dates.map((date) => fetchSportsDbEventsForDate(date, competitionInfo)));
  return pages.flat();
}

export async function fetchSportsDbCompetitionNextEventsStrict(code: string, startOffset: number, endOffset: number, type: 'today' | 'results', competitionInfo: CompetitionInfoMap = {}) {
  if (type !== 'today') return [];

  const leagueId = TSDB_LEAGUE_ID_BY_CODE[code];
  if (!leagueId) return [];

  const dateFrom = dateStr(startOffset);
  const dateTo = dateStr(endOffset);

  const { data } = await withCache(`tsdb:nextleague:strict:${leagueId}:${dateFrom}:${dateTo}`, 12 * 60 * 60, async () => {
    const json = await retryWithBackoff(async () => {
      const result = await fetchJsonWithCurl(`${TSDB_BASE}/eventsnextleague.php?id=${leagueId}`, 5000);
      if (!result || !result.events || result.events.length === 0) {
        throw new Error('429-empty-response');
      }
      return result;
    }, 3, 500).catch(() => ({}));

    return (json.events ?? [])
      .map((event: any) => mapSportsDbMatch(event, competitionInfo))
      .filter((match: any) => match !== null && match !== undefined)
      .filter((match: any) => {
        const matchDate = String(match?.utcDate ?? '').slice(0, 10);
        return matchDate && matchDate >= dateFrom && matchDate <= dateTo;
      })
      .filter((match: any) => String(match?.status ?? 'SCHEDULED') !== 'FINISHED');
  });

  return data as any[];
}
