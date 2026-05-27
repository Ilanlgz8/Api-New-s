import { CACHE_TTL, setCacheEntry, withCache } from './cache';
import { normalizeName } from './footballHelpers';
import { enrichMatch, normalizeOddsEvent } from './footballOdds';

const FD_BASE = 'https://api.football-data.org/v4';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_SPORT_KEYS: Record<string, string> = {
  CL:  'soccer_uefa_champs_league',
  PL:  'soccer_epl',
  PD:  'soccer_spain_la_liga',
  SA:  'soccer_italy_serie_a',
  BL1: 'soccer_germany_bundesliga',
};

function fdHeaders() {
  return { 'X-Auth-Token': process.env.FOOTBALL_API_KEY ?? '' };
}

async function getOddsByCompetition(codes: string[]) {
  const apiKey = process.env.THE_ODDS_API_KEY ?? process.env.ODDS_API_KEY;
  if (!apiKey) return {};

  const uniqueCodes = Array.from(new Set(codes.filter((code) => ODDS_SPORT_KEYS[code])));
  const entries = await Promise.all(uniqueCodes.map(async (code) => {
    const cacheKey = `football:odds:${code}`;
    const { data } = await withCache(cacheKey, 10 * 60, async () => {
      const sport = ODDS_SPORT_KEYS[code];
      const url = `${ODDS_BASE}/sports/${sport}/odds?regions=eu,uk&markets=h2h&oddsFormat=decimal&bookmakers=betclic,pinnacle,betfair_ex_uk,williamhill,unibet&apiKey=${apiKey}`;
      const res = await fetch(url, { next: { revalidate: 600 } }).catch(() => null);
      if (!res || !res.ok) return [];
      const json = await res.json().catch(() => []);
      return (json ?? []).map(normalizeOddsEvent);
    });
    return [code, data] as const;
  }));

  return Object.fromEntries(entries);
}

let liveStore: { matches: any[]; fetchedAt: number } = { matches: [], fetchedAt: 0 };
let pollerStarted = false;
const SOFASCORE_ENABLED = !['0', 'false'].includes(String(process.env.SOFASCORE_ENABLED ?? 'true').toLowerCase());
let sofascoreDisabledUntil = 0;
let sofascoreFailureCount = 0;

// Basic in-memory metrics for observability (exported via `getPollerMetrics`)
const metrics = {
  sofascore_requests: 0,
  sofascore_failures: 0,
  sofascore_successes: 0,
  sofascore_latency_ms_total: 0,
  odds_requests: 0,
  poller_runs: 0,
};

function canUseSofascore() {
  return SOFASCORE_ENABLED && Date.now() >= sofascoreDisabledUntil;
}

function disableSofascoreFor(minutes = 30) {
  sofascoreDisabledUntil = Date.now() + minutes * 60 * 1000;
  sofascoreFailureCount = 0;
}

function recordSofascoreFailure() {
  sofascoreFailureCount += 1;
  metrics.sofascore_failures += 1;
  if (sofascoreFailureCount >= 2) disableSofascoreFor(30);
}

function recordSofascoreSuccess() {
  sofascoreFailureCount = 0;
  sofascoreDisabledUntil = 0;
  metrics.sofascore_successes += 1;
}

async function fetchMatchesForStatus(status: string) {
  const res = await fetch(`${FD_BASE}/matches?status=${status}`, { headers: fdHeaders() }).catch(() => null);
  if (!res || !res.ok) return [];
  const json = await res.json().catch(() => ({}));
  return json.matches ?? [];
}

async function pollOnce() {
  if (!process.env.FOOTBALL_API_KEY) {
    liveStore = { matches: [], fetchedAt: Date.now() };
    return;
  }

  try {
    metrics.poller_runs += 1;
    const statusBuckets = await Promise.all([
      fetchMatchesForStatus('IN_PLAY'),
      fetchMatchesForStatus('PAUSED'),
      fetchMatchesForStatus('SUSPENDED'),
    ]);

    const seen = new Set<number>();
    const raw = statusBuckets.flat().filter((m: any) => {
      if (!m?.id || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    const oddsByCompetition = await getOddsByCompetition(raw.map((m: any) => m.competition?.code));
    metrics.odds_requests += 1;
    const matches = raw.map((m: any) => enrichMatch(m, oddsByCompetition));
    // Try to enrich live matches with a faster live source (Sofascore) when available.
    const enrichedMatches = await Promise.all(matches.map(async (m: any) => {
      try {
        if (canUseSofascore() && ['IN_PLAY', 'PAUSED', 'SUSPENDED'].includes(m.status)) {
          const live = await fetchSofascoreLive(m);
          if (live) {
            recordSofascoreSuccess();
            console.info('Sofascore: enriched match', { matchId: m.id, minute: live.minute, score: live.score });
            return { ...m, liveDetails: live };
          }
          recordSofascoreFailure();
        }
      } catch (e) {
        recordSofascoreFailure();
      }
      return m;
    }));

    liveStore = { matches: enrichedMatches, fetchedAt: Date.now() };
    setCacheEntry('football:live', liveStore, CACHE_TTL.football_live, liveStore.fetchedAt);
  } catch (e) {
    // don't crash poller
    console.warn('Football poller error', (e as any)?.message ?? e);
    liveStore = { matches: liveStore.matches ?? [], fetchedAt: liveStore.fetchedAt ?? Date.now() };
  }
}

export function getPollerMetrics() {
  return { ...metrics, sofascore_disabled_until: sofascoreDisabledUntil };
}

export function getLiveData() {
  return liveStore;
}

export function startFootballPoller(options?: { idleIntervalSec?: number; liveIntervalSec?: number }) {
  if (pollerStarted) return;
  pollerStarted = true;

  const idleIntervalSec = options?.idleIntervalSec ?? Number(process.env.FOOTBALL_POLLER_IDLE_INTERVAL ?? 60 * 15); // 15min
  const liveIntervalSec = options?.liveIntervalSec ?? Number(process.env.FOOTBALL_POLLER_LIVE_INTERVAL ?? 20); // 20s

  // adaptive loop using setTimeout so we can vary interval depending on presence of live matches
  const loop = async () => {
    try {
      await pollOnce();
    } catch (e) {
      // already handled in pollOnce
    }

    const hasLive = (liveStore.matches ?? []).some((m: any) => ['IN_PLAY', 'PAUSED', 'SUSPENDED'].includes(m.status));
    const next = hasLive ? liveIntervalSec : idleIntervalSec;
    setTimeout(loop, Math.max(5, next) * 1000);
  };

  // start loop
  void loop();
}

// A small, best-effort function to enrich a match using Sofascore public endpoints.
// This is experimental and will fail silently if the remote doesn't respond or the shape differs.
async function fetchSofascoreLive(match: any) {
  try {
    const home = normalizeName(match.homeTeam?.name ?? match.homeTeam?.shortName ?? '');
    const away = normalizeName(match.awayTeam?.name ?? match.awayTeam?.shortName ?? '');
    // Attempt a search by team names — Sofascore has internal APIs but endpoints may change.
    const query = encodeURIComponent(`${match.homeTeam?.name ?? ''} vs ${match.awayTeam?.name ?? ''}`);
    const url = `https://api.sofascore.com/api/v1/search/multi?query=${query}`;
    const res = await fetch(url).catch(() => null);
    if (!res || !res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json) return null;

    // Try to find an event that matches the date
    const found = (json.events ?? []).find((e: any) => {
      const eHome = normalizeName(e.homeTeam?.name ?? '');
      const eAway = normalizeName(e.awayTeam?.name ?? '');
      return (eHome.includes(home) || home.includes(eHome)) && (eAway.includes(away) || away.includes(eAway));
    });
    if (!found) return null;

    // fetch event details
    const eventUrl = `https://api.sofascore.com/api/v1/event/${found.id}`;
    const detailRes = await fetch(eventUrl).catch(() => null);
    if (!detailRes || !detailRes.ok) return null;
    const detailJson = await detailRes.json().catch(() => null);
    if (!detailJson) return null;

    // normalize minimal live details
    return {
      minute: detailJson.event?.time?.minute ?? detailJson?.time?.minute ?? null,
      score: {
        home: detailJson.homeScore?.current ?? detailJson.event?.homeScore ?? null,
        away: detailJson.awayScore?.current ?? detailJson.event?.awayScore ?? null,
      },
      status: detailJson.event?.status ?? null,
      source: 'sofascore',
    };
  } catch (e) {
    return null;
  }
}

// auto-start when imported
startFootballPoller();

export default { getLiveData, startFootballPoller };
