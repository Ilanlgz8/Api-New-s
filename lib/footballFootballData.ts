import { withCache, CACHE_TTL } from './cache';
import { enrichMatch } from './footballOdds';

export const FD_BASE = 'https://api.football-data.org/v4';
export const AF_BASE = 'https://api-football-v1.p.rapidapi.com/v3';

function dateStr(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
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

async function fetchJsonWithTimeout(url: string, init: RequestInit | undefined, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...(init ?? {}), signal: controller.signal }).catch(() => null);
    if (!res || !res.ok) {
      const txt = res ? await res.text().catch(() => '') : '';
      throw new Error(`fetch failed${res ? ` (${res.status})` : ''}${txt ? `: ${txt}` : ''}`);
    }
    return res.json().catch(() => ({}));
  } finally {
    clearTimeout(timer);
  }
}

export function mapApiFootballStatus(short?: string) {
  const status = String(short ?? '').toUpperCase();
  if (['HT', 'PAUSE', 'BREAK'].includes(status)) return 'PAUSED';
  if (['1H', '2H', 'ET', 'BT', 'LIVE'].includes(status)) return 'IN_PLAY';
  if (['FT', 'AET', 'PEN'].includes(status)) return 'FINISHED';
  return 'IN_PLAY';
}

export function mapApiFootballMatch(item: any, AF_LEAGUE_BY_CODE: Record<string, number>) {
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

export async function fetchFootballDataCompetitionEvents(code: string, startOffset: number, endOffset: number, type: 'today' | 'results', COMPETITIONS: string[], AF_LEAGUE_BY_CODE: Record<string, number>) {
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
    ).catch(() => ({}));

    return (json.matches ?? [])
      .filter((m: any) => COMPETITIONS.includes(m.competition?.code))
      .filter((m: any) => type === 'today' ? !['FINISHED', 'CANCELLED', 'POSTPONED'].includes(m.status) : true)
      .map((m: any) => enrichMatch(m));
  });

  return data as any[];
}

export async function fetchApiFootballCompetitionEvents(code: string, leagueId: number, startOffset: number, endOffset: number, type: 'today' | 'results', AF_LEAGUE_BY_CODE: Record<string, number>) {
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
    ).catch(() => ({}));

    return (json.response ?? [])
      .filter((m: any) => {
        const status = mapApiFootballStatus(m.fixture?.status?.short);
        return type === 'today' ? !['FINISHED', 'CANCELLED', 'POSTPONED'].includes(status) : status === 'FINISHED';
      })
      .map((m: any) => enrichMatch(mapApiFootballMatch(m, AF_LEAGUE_BY_CODE)));
  });

  return data as any[];
}

export async function fetchApiFootballLiveMatches(AF_LEAGUE_BY_CODE: Record<string, number>) {
  const apiKey = process.env.RAPIDAPI_KEY ?? process.env.API_FOOTBALL_KEY;
  if (!apiKey) return [];

  const res = await fetch(`${AF_BASE}/fixtures?live=all`, { headers: afHeaders() }).catch(() => null);
  if (!res || !res.ok) return [];
  const json = await res.json().catch(() => null);
  const fixtures = json?.response ?? [];

  return fixtures.map((m: any) => mapApiFootballMatch(m, AF_LEAGUE_BY_CODE)).filter((match: any) => ['IN_PLAY', 'PAUSED'].includes(match.status));
}

export async function fetchMatchesForStatus(status: string) {
  if (!process.env.FOOTBALL_API_KEY) return [];
  const res = await fetch(`${FD_BASE}/matches?status=${status}`, { headers: fdHeaders() }).catch(() => null);
  if (!res || !res.ok) return [];
  const json = await res.json().catch(() => ({}));
  return json.matches ?? [];
}
