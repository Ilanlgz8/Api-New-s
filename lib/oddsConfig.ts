export const DEFAULT_MARGIN = 1.06;

const LEAGUE_MARGINS: Record<string, number> = {
  // more competitive / liquid markets -> tighter margin
  'premierleague': 1.04,
  'laliga': 1.045,
  'seriea': 1.05,
  'bundesliga': 1.045,
  'ligue1': 1.05,
  'championsleague': 1.035,
  'europaleague': 1.06,
};

export function getLeagueMargin(leagueCodeOrName?: string) {
  if (!leagueCodeOrName) return DEFAULT_MARGIN;
  const key = String(leagueCodeOrName).toLowerCase().replace(/[^a-z0-9]/g, '');
  return LEAGUE_MARGINS[key] ?? DEFAULT_MARGIN;
}
