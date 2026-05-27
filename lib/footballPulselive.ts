import { withCache, CACHE_TTL } from './cache';

export const PULSELIVE_BASE = 'https://sdp-prem-prod.premier-league-prod.pulselive.com/api/v1';

function dateStr(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function parseKickoff(kickoff: any) {
  if (!kickoff) return null;
  if (typeof kickoff === 'string') return kickoff;
  if (kickoff.label) return kickoff.label;
  if (kickoff.date) return kickoff.date;
  if (kickoff.millis) return new Date(Number(kickoff.millis)).toISOString();
  return null;
}

export function mapPulseliveMatch(match: any, compCode = 'PL') {
  if (!match) return null;
  const utc = parseKickoff(match.kickoff) ?? match.kickoff ?? null;

  const homeScore = match.home?.score ?? match.homeScore ?? null;
  const awayScore = match.away?.score ?? match.awayScore ?? null;

  return {
    id: match.id ?? `${compCode}:${match.kickoff ?? Date.now()}`,
    status: (match.status && String(match.status).toUpperCase()) || (utc && new Date(utc) < new Date() ? 'FINISHED' : 'SCHEDULED'),
    utcDate: utc,
    homeTeam: {
      id: match.home?.team?.id ?? match.home?.id ?? null,
      name: match.home?.team?.name ?? match.home?.name ?? 'Home',
      shortName: match.home?.team?.shortName ?? match.home?.name ?? 'Home',
      crest: match.home?.team?.logo ?? null,
    },
    awayTeam: {
      id: match.away?.team?.id ?? match.away?.id ?? null,
      name: match.away?.team?.name ?? match.away?.name ?? 'Away',
      shortName: match.away?.team?.shortName ?? match.away?.name ?? 'Away',
      crest: match.away?.team?.logo ?? null,
    },
    competition: { code: compCode, name: 'Premier League', emblem: null },
    score: { fullTime: { home: homeScore ?? null, away: awayScore ?? null }, halfTime: { home: null, away: null } },
    competitionName: 'Premier League',
    leagueName: 'Premier League',
  };
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' }).catch(() => null);
    if (!res || !res.ok) return null;
    return await res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPulseliveCompetitionEvents(startOffset: number, endOffset: number, type: 'today' | 'results') {
  if (type !== 'today') return [];
  const from = dateStr(startOffset);
  const to = dateStr(endOffset);
  const cacheKey = `football:pulse:${from}:${to}:${type}`;

  const { data } = await withCache(cacheKey, CACHE_TTL.football_today, async () => {
    const url = `${PULSELIVE_BASE}/competitions/8/matches?fromDate=${from}&toDate=${to}`;
    const json = await fetchJsonWithTimeout(url, 5000).catch(() => ({}));
    const payload = json?.content ?? json?.matches ?? json ?? {};
    const items = Array.isArray(payload) ? payload : payload?.content ?? payload?.matches ?? [];
    const mapped = (items ?? []).map((m: any) => mapPulseliveMatch(m)).filter(Boolean);
    return mapped.sort((a: any, b: any) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());
  });

  return data as any[];
}
