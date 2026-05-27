import { normalizeName } from './footballHelpers';
import { withCache } from './cache';

export type OddsEvent = {
  home_team?: string;
  away_team?: string;
  commence_time?: string;
  bookmakers?: Array<{
    key?: string;
    title?: string;
    last_update?: string | null;
    markets?: Array<{
      key?: string;
      outcomes?: Array<{ name?: string; price?: number | null }>;
    }>;
  }>;
};

export type NormalizedOddsEvent = {
  home: string | undefined;
  away: string | undefined;
  commenceTime: string | undefined;
  bookmaker: string | null;
  lastUpdate: string | null;
  prices: {
    home: number | null;
    draw: number | null;
    away: number | null;
  };
};

export const ODDS_BASE = 'https://api.the-odds-api.com/v4';

export const ODDS_SPORT_KEYS: Record<string, string> = {
  CL: 'soccer_uefa_champs_league',
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  SA: 'soccer_italy_serie_a',
  BL1: 'soccer_germany_bundesliga',
};

const AF_BASE = 'https://api-football-v1.p.rapidapi.com/v3';

type CompetitionMetaMap = Record<string, { name: string; emblem?: string | null }>;

export function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function outcomePrice(outcomes: Array<{ name?: string; price?: number | null }>, teamName: string | undefined) {
  const target = normalizeName(teamName ?? '');
  return outcomes.find((outcome) => {
    const name = normalizeName(outcome.name ?? '');
    return name === target || name.includes(target) || target.includes(name);
  })?.price ?? null;
}

function bookmakerPrices(bookmaker: any, event: OddsEvent) {
  const market = bookmaker?.markets?.find((entry: any) => entry.key === 'h2h');
  const outcomes = market?.outcomes ?? [];

  return {
    home: outcomePrice(outcomes, event.home_team),
    draw: outcomes.find((outcome: any) => normalizeName(outcome.name ?? '') === 'draw')?.price ?? null,
    away: outcomePrice(outcomes, event.away_team),
  };
}

export function normalizeOddsEvent(event: OddsEvent): NormalizedOddsEvent {
  const bookmakers = event.bookmakers ?? [];
  const pricesByBookmaker = bookmakers.map((bookmaker) => bookmakerPrices(bookmaker, event));
  const homePrices = pricesByBookmaker.map((prices) => prices.home).filter((value): value is number => typeof value === 'number');
  const drawPrices = pricesByBookmaker.map((prices) => prices.draw).filter((value): value is number => typeof value === 'number');
  const awayPrices = pricesByBookmaker.map((prices) => prices.away).filter((value): value is number => typeof value === 'number');

  const consensusPrices = {
    home: median(homePrices),
    draw: median(drawPrices),
    away: median(awayPrices),
  };

  const bookmaker = bookmakers.find((entry) => entry.key === 'betclic') ?? bookmakers.find((entry) => entry.key === 'pinnacle') ?? bookmakers[0];
  const sourceLabel = bookmakers.length > 1 ? 'Consensus' : bookmaker?.title ?? null;

  return {
    home: event.home_team,
    away: event.away_team,
    commenceTime: event.commence_time,
    bookmaker: sourceLabel,
    lastUpdate: bookmakers[0]?.last_update ?? null,
    prices: consensusPrices,
  };
}

export function findOddsForMatch(
  match: {
    competition?: { code?: string };
    homeTeam?: { name?: string; shortName?: string };
    awayTeam?: { name?: string; shortName?: string };
    utcDate?: string;
  },
  oddsByCompetition: Record<string, NormalizedOddsEvent[]>
) {
  const events = oddsByCompetition[match.competition?.code ?? ''] ?? [];
  const home = normalizeName(match.homeTeam?.name ?? match.homeTeam?.shortName ?? '');
  const away = normalizeName(match.awayTeam?.name ?? match.awayTeam?.shortName ?? '');

  return events.find((event) => {
    const eventHome = normalizeName(event.home ?? '');
    const eventAway = normalizeName(event.away ?? '');
    const namesMatch =
      (eventHome.includes(home) || home.includes(eventHome)) &&
      (eventAway.includes(away) || away.includes(eventAway));
    return namesMatch && (event.commenceTime?.slice(0, 10) === match.utcDate?.slice(0, 10));
  }) ?? null;
}

export function enrichMatch<T extends { competition?: { code?: string; name?: string } }>(match: T, oddsByCompetition: Record<string, NormalizedOddsEvent[]> = {}) {
  const publicOdds = findOddsForMatch(match, oddsByCompetition);
  return {
    ...match,
    competitionName: match.competition?.name ?? '',
    leagueName: match.competition?.name ?? '',
    publicOdds,
  };
}

function normalizeApiFootballOddsEvent(event: any) {
  const bookmakers = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
  const bookmaker = bookmakers[0] ?? null;
  const bets = Array.isArray(bookmaker?.bets) ? bookmaker.bets : [];
  const market = bets.find((bet: any) => {
    const name = normalizeName(bet?.name ?? '');
    return name.includes('matchwinner') || name.includes('1x2') || name.includes('winner') || name.includes('homeaway');
  }) ?? bets[0] ?? null;
  const values = Array.isArray(market?.values) ? market.values : [];

  const homeName = event?.fixture?.teams?.home?.name ?? event?.home_team ?? event?.home ?? null;
  const awayName = event?.fixture?.teams?.away?.name ?? event?.away_team ?? event?.away ?? null;

  const findOdd = (label: string) => {
    const normalizedLabel = normalizeName(label);
    return values.find((value: any) => {
      const candidate = normalizeName(value?.value ?? value?.name ?? '');
      return candidate === normalizedLabel || candidate.includes(normalizedLabel) || normalizedLabel.includes(candidate);
    })?.odd ?? null;
  };

  const homeOdd = findOdd(String(homeName ?? 'home'));
  const awayOdd = findOdd(String(awayName ?? 'away'));
  const drawOdd = values.find((value: any) => normalizeName(value?.value ?? value?.name ?? '') === 'draw')?.odd ?? null;

  if (!homeOdd && !awayOdd && !drawOdd) return null;

  const bookmakerLabel = bookmaker?.name ?? bookmaker?.title ?? bookmaker?.id ?? 'api-football';

  return {
    home: homeName,
    away: awayName,
    commenceTime: event?.fixture?.date ?? event?.date ?? event?.commence_time ?? null,
    bookmaker: bookmakerLabel,
    lastUpdate: event?.update ?? bookmaker?.update ?? null,
    prices: {
      home: homeOdd ? Number(homeOdd) : null,
      draw: drawOdd ? Number(drawOdd) : null,
      away: awayOdd ? Number(awayOdd) : null,
    },
    source: 'api-football-odds',
  };
}

import { fetchApiFootballOddsFL1, fetchTheOddsApiForSport } from './footballOddsProviders';

export async function getOddsByCompetition(codes: string[]) {
  const uniqueCodes = Array.from(new Set(codes.filter((code) => ODDS_SPORT_KEYS[code] || code === 'FL1')));

  const entries = await Promise.all(uniqueCodes.map(async (code) => {
    if (code === 'FL1') {
      const apiKey = process.env.RAPIDAPI_KEY ?? process.env.API_FOOTBALL_KEY;
      if (!apiKey) return [code, []] as const;

      const response = await fetchApiFootballOddsFL1(apiKey);
      const mapped = (response ?? []).map((event: any) => normalizeApiFootballOddsEvent(event)).filter(Boolean);
      return [code, mapped ?? []] as const;
    }

    const apiKey = process.env.THE_ODDS_API_KEY ?? process.env.ODDS_API_KEY;
    if (!apiKey) return [code, []] as const;

    const sport = ODDS_SPORT_KEYS[code];
    const response = await fetchTheOddsApiForSport(apiKey, sport);

    // Map The Odds API response to normalized events
    const normalizedEvents = (response ?? []).map((ev: any) => {
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

    return [code, normalizedEvents ?? []] as const;
  }));

  return Object.fromEntries(entries) as Record<string, NormalizedOddsEvent[]>;
}
