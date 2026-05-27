export type FootballTab = 'live' | 'today' | 'results';

export type TeamRef = {
  id?: string | number;
  name?: string;
  shortName?: string;
  tla?: string;
  crest?: string;
};

export type CompetitionRef = {
  code?: string;
  name?: string;
  emblem?: string | null;
};

export type OddsPrices = {
  home?: number | string;
  draw?: number | string;
  away?: number | string;
};

export type PublicOdds = {
  prices?: OddsPrices;
  bookmaker?: string | null;
  lastUpdate?: string | null;
};

export type ScoreRef = {
  fullTime?: { home?: number | null; away?: number | null };
  halfTime?: { home?: number | null; away?: number | null };
};

export type LiveScoreRef = {
  home?: number | null;
  away?: number | null;
};

export type FootballEvent = {
  id?: string | number;
  matchId?: string | number;
  fixture?: { id?: string | number };
  utcDate?: string;
  status?: string;
  minute?: string | number;
  homeTeam?: TeamRef;
  awayTeam?: TeamRef;
  competition?: CompetitionRef;
  publicOdds?: PublicOdds;
  score?: ScoreRef;
  liveDetails?: { minute?: string | number; score?: LiveScoreRef; stats?: unknown[] };
  goals?: Array<{ team?: { id?: string | number } }>;
  provenance?: string;
  venue?: string | null;
  liveSource?: string;
  liveOdds?: unknown;
  stats?: unknown[];
  statistics?: unknown[];
  // legacy convenience fields used by some mappers
  competitionName?: string;
  leagueName?: string;
};
