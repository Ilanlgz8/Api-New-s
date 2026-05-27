import { withCache } from './cache';

const AF_BASE = 'https://api-football-v1.p.rapidapi.com/v3';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

export async function fetchApiFootballOddsFL1(apiKey: string) {
  if (!apiKey) return [];
  const cacheKey = `odds:api-football:FL1`;
  const { data } = await withCache(cacheKey, 24 * 60 * 60, async () => {
    const season = new Date().getUTCMonth() >= 6 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
    const url = `${AF_BASE}/odds?league=61&season=${season}`;
    const res = await fetch(url, { headers: {
      'x-rapidapi-host': 'api-football-v1.p.rapidapi.com',
      'x-rapidapi-key': apiKey,
    } }).catch(() => null);
    if (!res || !res.ok) return [];

    const json = await res.json().catch(() => ({}));
    const response = Array.isArray(json?.response) ? json.response : [];
    return response;
  });

  return data ?? [];
}

export async function fetchTheOddsApiForSport(apiKey: string, sport: string) {
  if (!apiKey) return [];
  const cacheKey = `odds:${sport}`;
  const { data } = await withCache(cacheKey, 24 * 60 * 60, async () => {
    const url = `${ODDS_BASE}/sports/${sport}/odds?regions=eu,uk&markets=h2h&oddsFormat=decimal&apiKey=${apiKey}`;
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) {
      console.warn(`Odds ${sport} ${res ? res.status : 'no-response'}`);
      return [];
    }

    const json = await res.json().catch(() => []);
    return json ?? [];
  });

  return data ?? [];
}
