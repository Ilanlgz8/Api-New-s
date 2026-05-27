import type { FootballEvent } from './footballTypes';

export type LineupPlayer = {
  id: string | number | null;
  name: string;
  shirtNumber: string | number;
  position: string;
  grid: string | null;
  captain: boolean;
};

export type LineupBlock = {
  formation: string | null;
  starters: LineupPlayer[];
  bench: LineupPlayer[];
  teamName: string;
  official: boolean;
};

export type TableRow = {
  position?: number | string;
  team?: { name?: string; shortName?: string; crest?: string | null };
  playedGames?: number;
  won?: number;
  draw?: number;
  lost?: number;
  goalsFor?: number;
  goalsAgainst?: number;
  goalDifference?: number;
  points?: number;
};

export type RecentMatchLike = FootballEvent & {
  id?: string | number;
};

export function normalizeName(value = '') {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|afc|as|ac|de|the|club|sporting)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function getOutcome(match: Pick<FootballEvent, 'score' | 'homeTeam' | 'awayTeam'>, teamId: number) {
  const home = match.score?.fullTime?.home;
  const away = match.score?.fullTime?.away;
  if (home == null || away == null) return 'D';
  const isHome = match.homeTeam?.id === teamId;
  if (home === away) return 'D';
  if (isHome) return home > away ? 'W' : 'L';
  return away > home ? 'W' : 'L';
}

export function normalizeLineupPlayer(playerEntry: unknown): LineupPlayer {
  const entry = (playerEntry ?? {}) as Record<string, any>;
  const player = (entry.player ?? entry) as Record<string, any>;
  return {
    id: player.id ?? entry.id ?? null,
    name: player.name ?? entry.name ?? 'Joueur',
    shirtNumber: player.number ?? entry.number ?? entry.shirtNumber ?? '-',
    position: player.pos ?? entry.position ?? entry.role ?? 'N/A',
    grid: player.grid ?? entry.grid ?? null,
    captain: player.captain ?? entry.captain ?? false,
  };
}

export function normalizeLineupBlock(teamBlock: unknown, fallbackName: string): LineupBlock {
  if (!teamBlock) {
    return {
      formation: null,
      starters: [],
      bench: [],
      teamName: fallbackName,
      official: false,
    };
  }

  const block = teamBlock as Record<string, any>;
  const starters = (block.startXI ?? block.lineup ?? block.startingXI ?? block.starting11 ?? []).map(normalizeLineupPlayer);
  const bench = (block.substitutes ?? block.bench ?? []).map(normalizeLineupPlayer);

  return {
    formation: block.formation ?? null,
    starters,
    bench,
    teamName: block.team?.name ?? fallbackName,
    official: Array.isArray(starters) && starters.length > 0,
  };
}

export function classifyRow(row: TableRow) {
  const pos = Number(row.position);
  if (pos <= 4) return 'champions';
  if (pos <= 6) return 'europa';
  if (pos <= 7) return 'conference';
  if (pos >= 18) return 'relegation';
  if (pos >= 16) return 'playoff';
  return 'none';
}

function countByKey<T>(items: T[], keyFn: (item: T) => string) {
  const map = new Map<string, { count: number; item: T }>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const entry = map.get(key);
    if (entry) entry.count += 1;
    else map.set(key, { count: 1, item });
  }
  return map;
}

export function buildProbableLineup(teamName: string, recentLineups: unknown[][]): LineupBlock {
  const starterPool = recentLineups.flatMap((fixture) => {
    const teams = fixture as unknown[];
    const teamBlock = teams.find((lineup) => {
      const item = lineup as Record<string, any>;
      return normalizeName(item.team?.name ?? '').includes(normalizeName(teamName))
        || normalizeName(teamName).includes(normalizeName(item.team?.name ?? ''));
    }) as Record<string, any> | undefined;
    return (teamBlock?.startXI ?? teamBlock?.lineup ?? []).map(normalizeLineupPlayer);
  });

  if (!starterPool.length) {
    return {
      formation: null,
      starters: [],
      bench: [],
      teamName,
      official: false,
    };
  }

  const playerCounts = countByKey(starterPool, (p) => `${normalizeName(p.name)}:${p.shirtNumber ?? ''}`);
  const formationCounts = countByKey(recentLineups.flatMap((fixture) => {
    const teams = fixture as unknown[];
    const teamBlock = teams.find((lineup) => {
      const item = lineup as Record<string, any>;
      return normalizeName(item.team?.name ?? '').includes(normalizeName(teamName))
        || normalizeName(teamName).includes(normalizeName(item.team?.name ?? ''));
    }) as Record<string, any> | undefined;
    return teamBlock?.formation ? [String(teamBlock.formation)] : [];
  }), (v) => v);

  const starters = Array.from(playerCounts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 11)
    .map(({ item }) => item);

  const probableFormation = Array.from(formationCounts.values()).sort((a, b) => b.count - a.count)[0]?.item ?? null;

  return {
    formation: probableFormation,
    starters,
    bench: [],
    teamName,
    official: false,
  };
}
