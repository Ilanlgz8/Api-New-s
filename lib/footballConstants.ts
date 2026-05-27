export type SourceStats = { successes: number; failures: number; lastFetch?: number };

export const COMPETITIONS = ['CL', 'FL1', 'PL', 'PD', 'SA', 'BL1', 'UEL', 'UECL'];

export const COMP_INFO: Record<string, { name: string; emblem?: string | null }> = {
  FL1: { name: "Ligue 1", emblem: null },
  PL: { name: 'Premier League', emblem: null },
  PD: { name: 'LaLiga', emblem: null },
  SA: { name: 'Serie A', emblem: null },
  BL1: { name: 'Bundesliga', emblem: null },
  CL: { name: "UEFA Champions League", emblem: null },
  UEL: { name: "UEFA Europa League", emblem: null },
  UECL: { name: "UEFA Conference League", emblem: null },
};

export const AF_LEAGUE_BY_CODE: Record<string, number> = {
  FL1: 61,
  PL: 39,
  PD: 140,
  SA: 135,
  BL1: 78,
  CL: 2,
};

export const WIDGET_RETENTION_DAYS = 14;
export const L1_OFFICIAL_BASE = process.env.L1_OFFICIAL_BASE ?? 'https://api.ligue1.fr';

export const COMP_SOURCES: Record<string, string[]> = {
  FL1: ['official-ligue1', 'football-data', 'thesportsdb', 'openligadb', 'api-football'],
  BL1: ['openligadb', 'football-data', 'api-football', 'thesportsdb'],
  CL:  ['football-data', 'openligadb', 'thesportsdb', 'api-football'],
  UEL: ['football-data', 'thesportsdb', 'api-football'],
  UECL:['football-data', 'thesportsdb', 'api-football'],
  PL:  ['pulselive', 'football-data', 'api-football', 'thesportsdb'],
  PD:  ['football-data', 'api-football', 'thesportsdb'],
  SA:  ['football-data', 'api-football', 'thesportsdb'],
};

export const SOURCE_STATS: Record<string, SourceStats> = {
  'football-data': { successes: 0, failures: 0 },
  'api-football': { successes: 0, failures: 0 },
  'thesportsdb': { successes: 0, failures: 0 },
  'openligadb': { successes: 0, failures: 0 },
  'official-ligue1': { successes: 0, failures: 0 },
  'pulselive': { successes: 0, failures: 0 },
};

export const SOURCE_MIN_INTERVAL_MS: Record<string, number> = {
  'football-data': 500,
  'api-football': 500,
  'openligadb': 500,
  'thesportsdb': 500,
  'pulselive': 500,
};
