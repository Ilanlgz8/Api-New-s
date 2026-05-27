import { withCache, CACHE_TTL } from './cache';
import { fetchSportsDbCompetitionNextEvents } from './footballSportsDb';

export const OL_BASE = 'https://api.openligadb.de';
export const OL_LEAGUE_BY_CODE: Record<string, string> = {
  FL1: 'FR1',
  BL1: 'BL1',
  CL: 'CL',
};

function dateStr(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!res || !res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function mapOpenLigaDbMatch(match: any, competitionCode: string, compInfo: Record<string, any> = {}) {
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
      name: compInfo[competitionCode]?.name ?? competitionCode,
      emblem: null,
    },
    score: {
      fullTime: { home: homeGoals ?? null, away: awayGoals ?? null },
      halfTime: { home: null, away: null },
    },
    competitionName: compInfo[competitionCode]?.name ?? competitionCode,
    leagueName: compInfo[competitionCode]?.name ?? competitionCode,
  };
}

export async function fetchOpenLigaDbCompetitionEvents(code: string, startOffset: number, endOffset: number, type: 'today' | 'results', compInfo: Record<string, any> = {}) {
  const olCode = OL_LEAGUE_BY_CODE[code];
  if (!olCode) return [];

  const cacheKey = `football:ol:${code}:${startOffset}:${endOffset}:${type}`;
  const { data } = await withCache(cacheKey, type === 'today' ? CACHE_TTL.football_today : CACHE_TTL.football_results, async () => {
    const dateFrom = dateStr(startOffset);
    const dateTo = dateStr(endOffset);

    try {
      const seasons = [new Date().getFullYear(), new Date().getFullYear() + 1, new Date().getFullYear() - 1];
      const candidates: string[] = [];
      candidates.push(`${OL_BASE}/getmatchdata/${olCode}`);
      for (const s of seasons) {
        candidates.push(`${OL_BASE}/getmatchdata/${olCode}/${s}`);
        candidates.push(`${OL_BASE}/getmatchesbyleagueandseason?leagueShortcut=${olCode}&season=${s}`);
      }

      for (const url of candidates) {
        const json = await fetchJsonWithTimeout(url, 3500).catch(() => null);
        if (!json || !Array.isArray(json) || !json.length) continue;

        let filtered = (json ?? []).filter((m: any) => {
          const matchDate = (m.MatchDateTimeUTC ?? m.matchDateTimeUTC ?? m.matchDateTime ?? '').slice(0, 10);
          return matchDate && matchDate >= dateFrom && matchDate <= dateTo;
        });

        // If empty for this window, try SportsDB next-events as a possible better source
        const nextEvents = await fetchSportsDbCompetitionNextEvents(code, startOffset, endOffset, type, compInfo);
        if (nextEvents && nextEvents.length) {
          return nextEvents;
        }

        if (!filtered.length && type === 'today') {
          const expandedTo = dateStr(endOffset + 14);
          filtered = (json ?? []).filter((m: any) => {
            const matchDate = (m.MatchDateTimeUTC ?? m.matchDateTimeUTC ?? m.matchDateTime ?? '').slice(0, 10);
            return matchDate && matchDate >= dateFrom && matchDate <= expandedTo;
          }).slice(0, 10);
        }

        if (filtered.length) {
          filtered = filtered
            .filter((m: any) => {
              const matchStatus = (m.MatchIsFinished ?? m.matchIsFinished) ? 'FINISHED' : 'SCHEDULED';
              return type === 'today' ? !['FINISHED'].includes(matchStatus) : matchStatus === 'FINISHED';
            })
            .map((m: any) => mapOpenLigaDbMatch(m, code, compInfo));

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
