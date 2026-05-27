import type { FootballEvent, TeamRef } from '@/lib/footballTypes';

export const COMP_ORDER = ['Champions League', 'Ligue 1', 'Premier League', 'La Liga', 'Serie A', 'Bundesliga'];

export const ALLOWED_COMPETITION_KEYWORDS = [
  'ligue 1',
  'la liga',
  'laliga',
  'premier league',
  'premiere ligue',
  'serie a',
  'bundesliga',
  'liga portugal',
  'primeira liga',
  'champions league',
  'ligue des champions',
  'europa league',
  'conference league',
  'cdm',
  'world cup',
].map((value) => normalizeName(value));

const TEAM_RATINGS: Array<[string, number]> = [
  ['realmadrid', 97], ['barca', 95], ['barcelona', 95], ['mancity', 96], ['manchestercity', 96],
  ['arsenal', 92], ['liverpool', 93], ['chelsea', 86], ['manunited', 84], ['manchesterunited', 84],
  ['psg', 94], ['parissaintgermain', 94], ['monaco', 82], ['marseille', 82], ['lille', 80], ['lyon', 78],
  ['bayern', 95], ['dortmund', 86], ['leverkusen', 89], ['leipzig', 85], ['stuttgart', 78],
  ['inter', 92], ['milan', 87], ['juventus', 86], ['napoli', 87], ['roma', 82], ['lazio', 79], ['atalanta', 84],
  ['atleti', 88], ['atleticomadrid', 88], ['villareal', 80], ['villarreal', 80], ['sevilla', 77],
  ['newcastle', 84], ['astonvilla', 82], ['tottenham', 84], ['brighton', 79], ['westham', 77],
];

const KNOWN_TEAM_ABBR: Record<string, string> = {
  manchestercity: 'Manchester City',
  manchesterunited: 'Manchester United',
  parissaintgermain: 'Paris Saint-Germain',
  atleticomadrid: 'Atletico Madrid',
  bayernmunich: 'Bayern Munich',
  fcbayernmunich: 'Bayern Munich',
  fcbayern: 'Bayern Munich',
  bayer04leverkusen: 'Bayer Leverkusen',
  olympiquedemarseille: 'Olympique Marseille',
  olympiquelyonnais: 'Olympique Lyonnais',
  borussiadortmund: 'Borussia Dortmund',
  bvb: 'Borussia Dortmund',
  tottenhamhotspur: 'Tottenham Hotspur',
  astonvilla: 'Aston Villa',
};

const TEAM_NAME_ALIASES: Record<string, string> = {
  bl: 'Bayer Leverkusen',
  b04: 'Bayer Leverkusen',
  bayer04: 'Bayer Leverkusen',
  bayer04leverkusen: 'Bayer Leverkusen',
  bayerleverkusen: 'Bayer Leverkusen',
  leverkusen: 'Bayer Leverkusen',
  'bayer 04': 'Bayer Leverkusen',
  'bayer 04 leverkusen': 'Bayer Leverkusen',
  hambug: 'Hamburger SV',
  hamburg: 'Hamburger SV',
  hsv: 'Hamburger SV',
  hamburgersv: 'Hamburger SV',
  mancity: 'Manchester City',
  'man city': 'Manchester City',
  manunited: 'Manchester United',
  manutd: 'Manchester United',
  'man utd': 'Manchester United',
  'man united': 'Manchester United',
  psg: 'Paris Saint-Germain',
  om: 'Olympique Marseille',
  ol: 'Olympique Lyonnais',
  bvb: 'Borussia Dortmund',
  dortmund: 'Borussia Dortmund',
  fcb: 'FC Barcelona',
  barca: 'FC Barcelona',
  realmadrid: 'Real Madrid',
  'real madrid': 'Real Madrid',
  atleti: 'Atletico Madrid',
  atm: 'Atletico Madrid',
  atalanta: 'Atalanta Bergamo',
};

const COMP_LABEL_FR: Record<string, string> = {
  ligue1: 'Ligue 1',
  laliga: 'LaLiga',
  'la liga': 'LaLiga',
  premierleague: 'Première ligue',
  premiereligue: 'Première ligue',
  seriea: 'Serie A',
  bundesliga: 'Bundesliga',
  ligaportugal: 'Liga Portugal',
  primeiraliga: 'Liga Portugal',
  championsleague: 'Ligue des champions',
  liguedeschampions: 'Ligue des champions',
  europaleague: 'Europa League',
  'europa league': 'Europa League',
  conferenceleague: 'Conference League',
  'uefaeuropaconferenceleague': 'Conference League',
  worldcup: 'Coupe du Monde',
  cdm: 'Coupe du Monde',
};

export function normalizeName(value = '') {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|afc|as|ac|calcio|club|de|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeTeamNameForDedup(teamName = '') {
  const lowercased = teamName.toLowerCase().trim();
  const expanded = TEAM_NAME_ALIASES[lowercased] || teamName;
  return normalizeName(expanded);
}

export function canonicalTeamName(team: TeamRef | undefined) {
  const candidates = [team?.name, team?.shortName, team?.tla].filter(Boolean).map((value) => String(value).trim());

  for (const candidate of candidates) {
    const aliasKey = candidate.toLowerCase();
    const normalizedKey = normalizeName(candidate);
    if (TEAM_NAME_ALIASES[aliasKey]) return TEAM_NAME_ALIASES[aliasKey];
    if (TEAM_NAME_ALIASES[normalizedKey]) return TEAM_NAME_ALIASES[normalizedKey];
    if (KNOWN_TEAM_ABBR[normalizedKey]) return KNOWN_TEAM_ABBR[normalizedKey];
  }

  return candidates[0] ?? 'Equipe';
}

function seededNoise(value = '') {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 997;
  return (hash % 17) - 8;
}

export function teamRating(team: TeamRef | undefined) {
  const name = normalizeName(`${team?.name ?? ''}${team?.shortName ?? ''}${team?.tla ?? ''}`);
  const direct = TEAM_RATINGS.find(([key]) => name.includes(key) || key.includes(name));
  return (direct?.[1] ?? 68) + seededNoise(name);
}

export function competitionKeyOf(match: FootballEvent) {
  return (
    match?.competition?.code ??
    match?.competitionName ??
    match?.leagueName ??
    match?.competition?.name ??
    'Autres'
  );
}

export function competitionLabelOf(match: FootballEvent) {
  return match?.leagueName ?? match?.competitionName ?? match?.competition?.name ?? match?.competition?.code ?? 'Autres';
}

export function competitionDisplayLabelOf(match: FootballEvent) {
  return translateCompetitionLabel(competitionLabelOf(match));
}

export function translateCompetitionLabel(name?: string) {
  if (!name) return name ?? 'Autres';
  const key = normalizeName(name);
  if (COMP_LABEL_FR[key]) return COMP_LABEL_FR[key];
  for (const [candidate, value] of Object.entries(COMP_LABEL_FR)) {
    if (key.includes(candidate) || candidate.includes(key)) return value;
  }
  return name;
}

export function isWorldCupLabel(value?: string) {
  const normalized = normalizeName(value ?? '');
  return (
    normalized.includes('worldcup') ||
    normalized.includes('coupedumonde') ||
    normalized === 'cdm' ||
    normalized === 'wc' ||
    normalized.includes('fifaworldcup')
  );
}

export function getEmblem(match: FootballEvent) {
  return match.competition?.emblem ?? null;
}

export function isAllowedCompetition(match: FootballEvent) {
  const key = normalizeName(competitionKeyOf(match));
  const label = normalizeName(competitionLabelOf(match));
  return ALLOWED_COMPETITION_KEYWORDS.some((allowed) => key.includes(allowed) || label.includes(allowed) || allowed.includes(key) || allowed.includes(label));
}

export function dedupeMatches(matches: FootballEvent[]) {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = [
      normalizeName(competitionKeyOf(match)),
      normalizeTeamNameForDedup(canonicalTeamName(match?.homeTeam)),
      normalizeTeamNameForDedup(canonicalTeamName(match?.awayTeam)),
      String(match?.utcDate ?? (match as any)?.fixture?.date ?? (match as any)?.date ?? ''),
    ].join(':');

    if (seen.has(String(key))) return false;
    seen.add(String(key));
    return true;
  });
}

export function groupByComp(matches: FootballEvent[]) {
  return matches.reduce((acc: Record<string, FootballEvent[]>, match: FootballEvent) => {
    const key = competitionKeyOf(match);
    if (!acc[key]) acc[key] = [];
    acc[key].push(match);
    return acc;
  }, {});
}

export function sortedGroups(grouped: Record<string, FootballEvent[]>) {
  return Object.entries(grouped).sort(([a], [b]) => {
    const ai = COMP_ORDER.indexOf(a);
    const bi = COMP_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

export function competitionMetaFromMatches(matches: FootballEvent[]) {
  const firstMatch = matches[0];
  return {
    name: translateCompetitionLabel(firstMatch ? competitionLabelOf(firstMatch) : 'Autres'),
    emblem: firstMatch ? getEmblem(firstMatch) : null,
  };
}

export function competitionMetaOf(match: FootballEvent) {
  return {
    name: translateCompetitionLabel(competitionLabelOf(match)),
    emblem: getEmblem(match),
  };
}
