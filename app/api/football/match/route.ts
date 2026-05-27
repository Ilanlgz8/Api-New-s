import { NextResponse } from 'next/server';
import { withCache } from '@/lib/cache';
import { buildProbableLineup, classifyRow, getOutcome, normalizeLineupBlock, normalizeName } from '@/lib/footballMatchHelpers';
import { AF_LEAGUE_BY_CODE } from '@/lib/footballConstants';

export const runtime = 'nodejs';

const FD_BASE = 'https://api.football-data.org/v4';
const AF_BASE = 'https://api-football-v1.p.rapidapi.com/v3';

// AF_LEAGUE_BY_CODE imported from lib/footballConstants

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

function seasonFromDate(isoDate: string) {
  const d = new Date(isoDate);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return m >= 7 ? y : y - 1;
}

async function fetchTeamRecentMatches(teamId: number, limit = 10) {
  const key = `team:${teamId}:recent:${limit}`;
  const { data } = await withCache(key, 10 * 60, async () => {
    const res = await fetch(`${FD_BASE}/teams/${teamId}/matches?status=FINISHED&limit=${limit}`, {
      headers: fdHeaders(),
    }).catch(() => null);
    if (!res || !res.ok) return [];
    const json = await res.json().catch(() => ({}));
    return json.matches ?? [];
  });
  return data;
}


async function fetchApiFootballRecentLineups(teamId: number, league: number, season: number) {
  const apiKey = process.env.RAPIDAPI_KEY ?? process.env.API_FOOTBALL_KEY;
  if (!apiKey) return [];

  const cacheKey = `af:recent-lineups:${league}:${season}:${teamId}`;
  return withCache(cacheKey, 12 * 60 * 60, async () => {
    const fixturesRes = await fetch(`${AF_BASE}/fixtures?league=${league}&season=${season}&team=${teamId}&last=4`, {
      headers: afHeaders(),
    }).catch(() => null);
    if (!fixturesRes || !fixturesRes.ok) return [];
    const fixturesJson = await fixturesRes.json().catch(() => null);
    const fixtureIds = (fixturesJson?.response ?? [])
      .map((row: any) => row?.fixture?.id)
      .filter(Boolean)
      .slice(0, 3);

    const lineups = await Promise.all(fixtureIds.map(async (fixtureId: number) => {
      const res = await fetch(`${AF_BASE}/fixtures/lineups?fixture=${fixtureId}`, { headers: afHeaders() }).catch(() => null);
      if (!res || !res.ok) return null;
      const json = await res.json().catch(() => null);
      return json?.response ?? [];
    }));

    return lineups.flat().filter(Boolean);
  }).then((r) => r.data);
}

async function fetchAllSportsBundle(fdMatch: any) {
  const apiKey = process.env.ALLSPORTS_API_KEY;
  if (!apiKey || !fdMatch?.utcDate) return null;

  const date = fdMatch.utcDate.slice(0, 10);
  const leagueName = fdMatch.competition?.name ?? '';
  const cacheKey = `allsports:${fdMatch.competition?.code}:${date}:${fdMatch.homeTeam?.name}:${fdMatch.awayTeam?.name}`;

  return withCache(cacheKey, 5 * 60, async () => {
    const searchUrl = `https://allsportsapi.com/api/?met=Fixtures&APIkey=${apiKey}&from=${date}&to=${date}&leagueName=${encodeURIComponent(leagueName)}`;
    const res = await fetch(searchUrl).catch(() => null);
    if (!res || !res.ok) return null;
    const json = await res.json().catch(() => null);
    const fixture = json?.result?.find((f: any) => {
      const home = normalizeName(f.event_home_team ?? '');
      const away = normalizeName(f.event_away_team ?? '');
      const homeKey = normalizeName(fdMatch.homeTeam?.name ?? fdMatch.homeTeam?.shortName ?? '');
      const awayKey = normalizeName(fdMatch.awayTeam?.name ?? fdMatch.awayTeam?.shortName ?? '');
      return (home.includes(homeKey) || homeKey.includes(home)) && (away.includes(awayKey) || awayKey.includes(away));
    });
    if (!fixture) return null;

    return {
      source: 'allsports',
      stats: [
        {
          team: { name: fdMatch.homeTeam?.name ?? 'Home' },
          statistics: [
            { type: 'Ball Possession', value: fixture.statistics?.ball_possession_home ?? null },
            { type: 'Total Shots', value: fixture.statistics?.shots_total_home ?? null },
            { type: 'Shots on Goal', value: fixture.statistics?.shots_on_goal_home ?? null },
            { type: 'Fouls', value: fixture.statistics?.fouls_home ?? null },
            { type: 'Corner Kicks', value: fixture.statistics?.corners_home ?? null },
            { type: 'Yellow Cards', value: fixture.statistics?.yellow_cards_home ?? null },
            { type: 'Red Cards', value: fixture.statistics?.red_cards_home ?? null },
          ],
        },
        {
          team: { name: fdMatch.awayTeam?.name ?? 'Away' },
          statistics: [
            { type: 'Ball Possession', value: fixture.statistics?.ball_possession_away ?? null },
            { type: 'Total Shots', value: fixture.statistics?.shots_total_away ?? null },
            { type: 'Shots on Goal', value: fixture.statistics?.shots_on_goal_away ?? null },
            { type: 'Fouls', value: fixture.statistics?.fouls_away ?? null },
            { type: 'Corner Kicks', value: fixture.statistics?.corners_away ?? null },
            { type: 'Yellow Cards', value: fixture.statistics?.yellow_cards_away ?? null },
            { type: 'Red Cards', value: fixture.statistics?.red_cards_away ?? null },
          ],
        },
      ],
      lineups: fixture.lineups ?? null,
      goalscorers: fixture.goalscorer ?? [],
    };
  }).then((r) => r.data);
}

async function fetchApiFootballBundle(fdMatch: any) {
  const apiKey = process.env.RAPIDAPI_KEY ?? process.env.API_FOOTBALL_KEY;
  const code = fdMatch?.competition?.code;
  const league = AF_LEAGUE_BY_CODE[code];
  const isHalftimeOrFinished = ['PAUSED', 'FINISHED', 'FT', 'AET', 'PEN'].includes(fdMatch?.status);
  if (!apiKey || !league || !fdMatch?.utcDate || !isHalftimeOrFinished) return null;

  const date = fdMatch.utcDate.slice(0, 10);
  const season = seasonFromDate(fdMatch.utcDate);
  const fixtureCacheKey = `af:fixture:${league}:${season}:${date}:${fdMatch.homeTeam?.name}:${fdMatch.awayTeam?.name}`;

  const fixtureData = await withCache(fixtureCacheKey, 15 * 60, async () => {
    const url = `${AF_BASE}/fixtures?league=${league}&season=${season}&date=${date}`;
    const res = await fetch(url, { headers: afHeaders() }).catch(() => null);
    if (!res || !res.ok) return null;
    const json = await res.json().catch(() => null);
    return json?.response ?? [];
  }).then((r) => r.data);

  const homeKey = normalizeName(fdMatch.homeTeam?.name ?? fdMatch.homeTeam?.shortName ?? '');
  const awayKey = normalizeName(fdMatch.awayTeam?.name ?? fdMatch.awayTeam?.shortName ?? '');
  const fixture = (fixtureData ?? []).find((row: any) => {
    const h = normalizeName(row?.teams?.home?.name ?? '');
    const a = normalizeName(row?.teams?.away?.name ?? '');
    return (h.includes(homeKey) || homeKey.includes(h)) && (a.includes(awayKey) || awayKey.includes(a));
  });

  const fixtureId = fixture?.fixture?.id;
  if (!fixtureId) return null;
  const apiHomeTeamId = fixture?.teams?.home?.id;
  const apiAwayTeamId = fixture?.teams?.away?.id;

  const statsTTL = ['FINISHED', 'FT', 'AET', 'PEN'].includes(fdMatch.status) ? 12 * 60 * 60 : 5 * 60;
  const lineupTTL = ['FINISHED', 'FT', 'AET', 'PEN'].includes(fdMatch.status) ? 12 * 60 * 60 : 5 * 60;

  const [stats, lineups] = await Promise.all([
    withCache(`af:stats:${fixtureId}`, statsTTL, async () => {
      const res = await fetch(`${AF_BASE}/fixtures/statistics?fixture=${fixtureId}`, { headers: afHeaders() }).catch(() => null);
      if (!res || !res.ok) return [];
      const json = await res.json().catch(() => null);
      return json?.response ?? [];
    }).then((r) => r.data),
    withCache(`af:lineups:${fixtureId}`, lineupTTL, async () => {
      const res = await fetch(`${AF_BASE}/fixtures/lineups?fixture=${fixtureId}`, { headers: afHeaders() }).catch(() => null);
      if (!res || !res.ok) return [];
      const json = await res.json().catch(() => null);
      return json?.response ?? [];
    }).then((r) => r.data),
  ]);

  let homeLineup = (lineups ?? []).find((l: any) => normalizeName(l.team?.name ?? '').includes(homeKey) || homeKey.includes(normalizeName(l.team?.name ?? '')));
  let awayLineup = (lineups ?? []).find((l: any) => normalizeName(l.team?.name ?? '').includes(awayKey) || awayKey.includes(normalizeName(l.team?.name ?? '')));

  if (!isHalftimeOrFinished) {
    const homeRecentLineups = apiHomeTeamId ? await fetchApiFootballRecentLineups(apiHomeTeamId, league, season) : [];
    const awayRecentLineups = apiAwayTeamId ? await fetchApiFootballRecentLineups(apiAwayTeamId, league, season) : [];
    homeLineup = homeLineup ?? buildProbableLineup(fdMatch.homeTeam?.name ?? 'Equipe domicile', homeRecentLineups);
    awayLineup = awayLineup ?? buildProbableLineup(fdMatch.awayTeam?.name ?? 'Equipe exterieur', awayRecentLineups);
  }

  return {
    fixtureId,
    source: 'api-football',
    stats,
    lineups: {
      home: homeLineup ?? null,
      away: awayLineup ?? null,
    },
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const matchId = searchParams.get('id');
  if (!matchId) return NextResponse.json({ error: 'ID manquant' }, { status: 400 });

  try {
    const { data } = await withCache(`match:${matchId}:rich`, 90, async () => {
      const fdRes = await fetch(`${FD_BASE}/matches/${matchId}`, { headers: fdHeaders() }).catch(() => null);
      const fdData = fdRes?.ok ? await fdRes.json().catch(() => null) : null;
      if (!fdData) return { match: null, stats: null, preMatch: null };

      const homeId = fdData.homeTeam?.id;
      const awayId = fdData.awayTeam?.id;
      const competitionCode = fdData.competition?.code;

      const [homeRecent, awayRecent, standings, afBundle, allSportsBundle] = await Promise.all([
        homeId ? fetchTeamRecentMatches(homeId, 10) : Promise.resolve([]),
        awayId ? fetchTeamRecentMatches(awayId, 10) : Promise.resolve([]),
        competitionCode
          ? withCache(`standings:${competitionCode}`, 10 * 60, async () => {
              const res = await fetch(`${FD_BASE}/competitions/${competitionCode}/standings`, {
                headers: fdHeaders(),
              }).catch(() => null);
              if (!res || !res.ok) return null;
              return res.json().catch(() => null);
            }).then((r) => r.data)
          : Promise.resolve(null),
        fetchApiFootballBundle(fdData),
        fetchAllSportsBundle(fdData),
      ]);

      const homeForm = (homeRecent ?? []).slice(0, 10).map((m: any) => ({
        id: m.id,
        utcDate: m.utcDate,
        opponent: m.homeTeam?.id === homeId ? m.awayTeam?.name : m.homeTeam?.name,
        outcome: getOutcome(m, homeId),
        score: `${m.score?.fullTime?.home ?? '-'}-${m.score?.fullTime?.away ?? '-'}`,
      }));

      const awayForm = (awayRecent ?? []).slice(0, 10).map((m: any) => ({
        id: m.id,
        utcDate: m.utcDate,
        opponent: m.homeTeam?.id === awayId ? m.awayTeam?.name : m.homeTeam?.name,
        outcome: getOutcome(m, awayId),
        score: `${m.score?.fullTime?.home ?? '-'}-${m.score?.fullTime?.away ?? '-'}`,
      }));

      const h2hCandidates = (homeRecent ?? []).filter((m: any) => {
        return m.homeTeam?.id === awayId || m.awayTeam?.id === awayId;
      });
      const h2h = h2hCandidates.reduce(
        (acc: any, m: any) => {
          const home = m.score?.fullTime?.home;
          const away = m.score?.fullTime?.away;
          if (home == null || away == null) return acc;

          const mainTeamHome = m.homeTeam?.id === homeId;
          const mainGoals = mainTeamHome ? home : away;
          const oppGoals = mainTeamHome ? away : home;
          if (mainGoals === oppGoals) acc.draw += 1;
          else if (mainGoals > oppGoals) acc.homeWins += 1;
          else acc.awayWins += 1;
          return acc;
        },
        { homeWins: 0, awayWins: 0, draw: 0 }
      );

      const lineupBundle = afBundle?.lineups ?? allSportsBundle?.lineups ?? null;
      const homeTeamLine = normalizeLineupBlock(lineupBundle?.home ?? null, fdData.homeTeam?.name ?? 'Equipe domicile');
      const awayTeamLine = normalizeLineupBlock(lineupBundle?.away ?? null, fdData.awayTeam?.name ?? 'Equipe exterieur');

      const tableRaw = standings?.standings?.find((s: any) => s.type === 'TOTAL')?.table ?? standings?.standings?.[0]?.table ?? [];
      const table = tableRaw.map((row: any) => ({
        position: row.position,
        teamName: row.team?.name,
        shortName: row.team?.shortName,
        crest: row.team?.crest,
        playedGames: row.playedGames,
        won: row.won,
        draw: row.draw,
        lost: row.lost,
        goalsFor: row.goalsFor,
        goalsAgainst: row.goalsAgainst,
        goalDifference: row.goalDifference,
        points: row.points,
        zone: classifyRow(row),
      }));

      return {
        match: fdData,
        stats: afBundle?.stats ?? allSportsBundle?.stats ?? null,
        preMatch: {
          source: afBundle?.source ?? allSportsBundle?.source ?? 'football-data',
          lineups: {
            home: {
              formation: homeTeamLine.formation ?? null,
              starters: homeTeamLine.starters,
              bench: homeTeamLine.bench,
              teamName: homeTeamLine.teamName,
              official: homeTeamLine.official,
            },
            away: {
              formation: awayTeamLine.formation ?? null,
              starters: awayTeamLine.starters,
              bench: awayTeamLine.bench,
              teamName: awayTeamLine.teamName,
              official: awayTeamLine.official,
            },
          },
          form: {
            home: homeForm,
            away: awayForm,
          },
          h2h,
          standings: {
            competition: standings?.competition?.name ?? fdData.competition?.name ?? null,
            table,
          },
        },
      };
    });

    return NextResponse.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur match inconnue';
    console.error('Match stats error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}