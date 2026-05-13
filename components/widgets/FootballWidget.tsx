'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import {
  Activity,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Radio,
  Shield,
  Sparkles,
  Trophy,
  Zap,
} from 'lucide-react';
import { useFootball } from '@/hooks/useFootball';
import { Card } from '@/components/ui/Card';
import { WidgetSkeleton, ErrorCard } from '@/components/ui/Skeleton';
import { MatchPanel } from '@/components/widgets/MatchPanel';

type Tab = 'live' | 'today' | 'results';
const MATCHES_PER_PAGE = 4;

type Odds = {
  win: number;
  draw: number;
  loss: number;
  source: 'public' | 'model';
  bookmaker?: string | null;
  lastUpdate?: string | null;
};

const COMP_ORDER = ['Champions League', 'Ligue 1', 'Premier League', 'La Liga', 'Serie A', 'Bundesliga'];

const ALLOWED_COMPETITION_KEYWORDS = [
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

const TAB_CONFIG: Record<Tab, { label: string; eyebrow: string; icon: React.ElementType }> = {
  live: { label: 'Live', eyebrow: 'En direct', icon: Radio },
  today: { label: 'Matchs', eyebrow: 'A venir', icon: CalendarDays },
  results: { label: 'Scores', eyebrow: 'Termines', icon: Trophy },
};

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

// Mapping d'aliases vers les noms complets utilisés dans l'interface.
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

function normalizeName(value = '') {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|cf|sc|afc|as|ac|calcio|club|de|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeTeamNameForDedup(teamName = '') {
  const lowercased = teamName.toLowerCase().trim();
  // Tenta expandir alias conhecidos
  const expanded = TEAM_NAME_ALIASES[lowercased] || teamName;
  // Aplica normalizacao
  return normalizeName(expanded);
}

function canonicalTeamName(team: any) {
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

function teamRating(team: any) {
  const name = normalizeName(`${team?.name ?? ''}${team?.shortName ?? ''}${team?.tla ?? ''}`);
  const direct = TEAM_RATINGS.find(([key]) => name.includes(key) || key.includes(name));
  return (direct?.[1] ?? 68) + seededNoise(name);
}

function getBookOdds(match: any): Odds {
  const prices = match.publicOdds?.prices;
  if (prices?.home && prices?.draw && prices?.away) {
    return {
      win: Number(prices.home),
      draw: Number(prices.draw),
      loss: Number(prices.away),
      source: 'public',
      bookmaker: match.publicOdds.bookmaker,
      lastUpdate: match.publicOdds.lastUpdate,
    };
  }

  const home = teamRating(match.homeTeam) + 3.5;
  const away = teamRating(match.awayTeam);
  const diff = home - away;
  const drawBase = Math.max(0.18, Math.min(0.31, 0.28 - Math.abs(diff) * 0.003));
  const homeRaw = 1 / (1 + Math.exp(-diff / 13));
  const homeProb = (1 - drawBase) * homeRaw;
  const awayProb = (1 - drawBase) * (1 - homeRaw);
  const margin = 1.07;

  return {
    win: clampOdd(margin / homeProb),
    draw: clampOdd(margin / drawBase),
    loss: clampOdd(margin / awayProb),
    source: 'model',
  };
}


function clampOdd(value: number) {
  return Number(Math.max(1.12, Math.min(18, value)).toFixed(2));
}

function groupByComp(matches: any[]) {
  return matches.reduce((acc: Record<string, any[]>, m: any) => {
    const key = competitionKeyOf(m);
    if (!acc[key]) acc[key] = [];
    acc[key].push(m);
    return acc;
  }, {});
}

function competitionKeyOf(match: any) {
  return (
    match?.competition?.code ??
    match?.competitionName ??
    match?.leagueName ??
    match?.competition?.name ??
    'Autres'
  );
}

function competitionLabelOf(match: any) {
  return match?.leagueName ?? match?.competitionName ?? match?.competition?.name ?? match?.competition?.code ?? 'Autres';
}

function competitionDisplayLabelOf(match: any) {
  return translateCompetitionLabel(competitionLabelOf(match));
}

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

function translateCompetitionLabel(name?: string) {
  if (!name) return name ?? 'Autres';
  const k = normalizeName(name);
  // direct match
  if (COMP_LABEL_FR[k]) return COMP_LABEL_FR[k];
  // fuzzy match: check if any known key is substring of the normalized name (handles variants like 'englishpremierleague')
  for (const [key, val] of Object.entries(COMP_LABEL_FR)) {
    if (k.includes(key) || key.includes(k)) return val;
  }
  return name;
}

function isAllowedCompetition(match: any) {
  const key = normalizeName(competitionKeyOf(match));
  const label = normalizeName(competitionLabelOf(match));
  return ALLOWED_COMPETITION_KEYWORDS.some((allowed) => key.includes(allowed) || label.includes(allowed) || allowed.includes(key) || allowed.includes(label));
}

function dedupeMatches(matches: any[]) {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = [
      normalizeName(competitionKeyOf(match)),
      normalizeTeamNameForDedup(canonicalTeamName(match?.homeTeam)),
      normalizeTeamNameForDedup(canonicalTeamName(match?.awayTeam)),
      String(match?.utcDate ?? match?.fixture?.date ?? match?.date ?? ''),
    ].join(':');

    if (seen.has(String(key))) return false;
    seen.add(String(key));
    return true;
  });
}

function sortedGroups(grouped: Record<string, any[]>) {
  return Object.entries(grouped).sort(([a], [b]) => {
    const ai = COMP_ORDER.indexOf(a);
    const bi = COMP_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function competitionMetaFromMatches(matches: any[]) {
  const firstMatch = matches[0];
  return {
    name: translateCompetitionLabel(firstMatch ? competitionLabelOf(firstMatch) : 'Autres'),
    emblem: firstMatch ? getEmblem(firstMatch) : null,
  };
}

function competitionMetaOf(match: any) {
  return {
    name: translateCompetitionLabel(competitionLabelOf(match)),
    emblem: getEmblem(match),
  };
}

function getEmblem(match: any) {
  return match.competition?.emblem ?? null;
}

function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function smartDate(dateStr: string) {
  const date = new Date(dateStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (key(date) === key(today)) return "Aujourd'hui";
  if (key(date) === key(tomorrow)) return 'Demain';
  return date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

function formatUpdateLabel(timestamp?: number) {
  if (!timestamp) return 'Mise à jour: --';
  return `Mise à jour: ${new Date(timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

function calculateLiveMinute(match: any, nowTick: number): string | null {
  // Calculer la minute écoulée depuis le début du match (utcDate)
  try {
    const startTime = new Date(match.utcDate).getTime();
    const elapsedSeconds = (nowTick - startTime) / 1000;
    
    // Si match pas commencé ou données manquantes
    if (elapsedSeconds < 0) return null;
    
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);

    // On enlève la pause de mi-temps pour que la 2e période reparte vers 45'
    // au lieu de 60'+ sur le chrono réel.
    const footballMinutes = elapsedMinutes >= 60 ? elapsedMinutes - 15 : elapsedMinutes;

    if (footballMinutes <= 90) {
      return `${footballMinutes}`;
    }

    return `90+${footballMinutes - 90}`;
  } catch (e) {
    return null;
  }
}

function formatLiveMinute(match: any) {
  const raw = match.liveDetails?.minute ?? match.minute;
  if (raw == null) return null;
  if (typeof raw === 'string') return raw; // already like "45+2"
  const m = Number(raw);
  if (Number.isNaN(m)) return String(raw);
  if (m > 90) return `90+${m - 90}`;
  return `${m}`;
}

function statusLabel(match: any, nowTick?: number) {
  if (match.status === 'PAUSED') return 'MT';

  // Si on a nowTick (client-side), calculer la minute depuis utcDate
  if (nowTick !== undefined) {
    const calculatedMinute = calculateLiveMinute(match, nowTick);
    if (match.status === 'IN_PLAY' || match.status === 'LIVE') {
      return calculatedMinute ? `${calculatedMinute}'` : 'LIVE';
    }
  }
  
  // Fallback à l'ancienne logique si pas de nowTick ou match pas en direct
  const liveMinute = formatLiveMinute(match);
  if (match.status === 'IN_PLAY' || match.status === 'LIVE') return liveMinute ? `${liveMinute}'` : 'LIVE';
  if (match.status === 'FINISHED') return 'FIN';
  return `${smartDate(match.utcDate)} ${formatTime(match.utcDate)}`;
}

function displayTeamName(team: any) {
  return canonicalTeamName(team);
}

export const FootballWidget = React.memo(function FootballWidget() {
  const [tab, setTab] = useState<Tab>('today');
  const [activeLeague, setActiveLeague] = useState('TOUT');
  const [page, setPage] = useState(0);
  const [selectedMatch, setSelectedMatch] = useState<any>(null);
  const { live, today, results, refetch } = useFootball();
  const [nowTick, setNowTick] = useState<number>(Date.now());

  const current = tab === 'live' ? live : tab === 'today' ? today : results;
  const rawItems = tab === 'live' ? current.data?.matches ?? [] : current.data?.events ?? [];
  const visibleItems = useMemo(() => dedupeMatches(rawItems.filter(isAllowedCompetition)), [rawItems]);
  const liveCount = useMemo(() => dedupeMatches((live.data?.matches ?? []).filter(isAllowedCompetition)).length, [live.data?.matches]);
  const todayCount = useMemo(() => dedupeMatches((today.data?.events ?? []).filter(isAllowedCompetition)).length, [today.data?.events]);
  const resultsCount = useMemo(() => dedupeMatches((results.data?.events ?? []).filter(isAllowedCompetition)).length, [results.data?.events]);
  const updatedAt = current.data?.fetchedAt;

  const groups = useMemo(() => sortedGroups(groupByComp(visibleItems)), [visibleItems]);
  const leagues = useMemo(
    () => [
      { key: 'TOUT', label: 'Tout', count: visibleItems.length, emblem: null },
      ...groups.map(([name, matches]) => {
        const meta = competitionMetaFromMatches(matches);
        return {
          key: name,
          label: meta.name,
          count: matches.length,
          emblem: meta.emblem,
        };
      }),
    ],
    [groups, visibleItems.length]
  );
  const allCompetitions = useMemo(() => {
    const backendComps = current.data?.competitions ?? [];
    const merged = new Map<string, { key: string; label: string; count: number; emblem: string | null }>();

    // seed 'TOUT'
    merged.set('TOUT', { key: 'TOUT', label: 'Tout', count: visibleItems.length, emblem: null });

    // add backend comps first
    backendComps.forEach((comp: any) => {
      merged.set(comp.code, {
        key: comp.code,
        label: translateCompetitionLabel(comp.name ?? comp.code),
        count: comp.count,
        emblem: comp.emblem ?? null,
      });
    });

    // merge leagues discovered from matches, keep emblem if present
    leagues.forEach((league) => {
      const existing = merged.get(league.key);
      const label = translateCompetitionLabel(league.label);
      if (existing) {
        if (!existing.emblem && league.emblem) existing.emblem = league.emblem;
        existing.count = Math.max(existing.count ?? 0, league.count);
        existing.label = existing.label || label;
        merged.set(league.key, existing);
      } else {
        merged.set(league.key, { ...league, label });
      }
    });

    // Filter: keep only allowed championships and those with an emblem
    const final = Array.from(merged.values()).filter((entry) => {
      if (entry.key === 'TOUT') return true;
      const allowed = ALLOWED_COMPETITION_KEYWORDS.some((allowed) => normalizeName(entry.label).includes(allowed) || normalizeName(entry.key).includes(allowed));
      return allowed && Boolean(entry.emblem);
    });

    return final;
  }, [current.data?.competitions, groups, leagues, visibleItems.length]);

  useEffect(() => {
    if (activeLeague === 'TOUT') return;

    const hasCurrentLeague = allCompetitions.some((league) => league.key === activeLeague);
    const leagueHasMatches = visibleItems.some((event: any) => {
      const key = competitionKeyOf(event);
      const label = competitionLabelOf(event);
      return key === activeLeague || normalizeName(key) === normalizeName(activeLeague) || normalizeName(label) === normalizeName(activeLeague);
    });

    if (!hasCurrentLeague || !leagueHasMatches) {
      setActiveLeague('TOUT');
      setPage(0);
    }
  }, [activeLeague, allCompetitions, visibleItems]);

  // Client-side tick to update computed live minutes and lightweight server polling
  useEffect(() => {
    let tickId: ReturnType<typeof setInterval> | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;

    if (tab === 'live') {
      // update computed minutes every 10s for smooth UI
      tickId = setInterval(() => setNowTick(Date.now()), 10_000);

      // if there are live matches, poll server for fresh live details (minute/score)
      if ((live.data?.matches?.length ?? 0) > 0) {
        pollId = setInterval(() => {
          try {
            refetch('live');
          } catch (e) {
            // ignore
          }
        }, 10_000);
      }
    }

    return () => {
      if (tickId) clearInterval(tickId);
      if (pollId) clearInterval(pollId);
    };
  }, [tab, live.data?.matches?.length, refetch]);

      const filteredGroups = useMemo(
    () => {
      const allEvents = visibleItems;

      const compareByDate = (a: any, b: any) => {
        const dateA = new Date(a.utcDate ?? 0).getTime();
        const dateB = new Date(b.utcDate ?? 0).getTime();
        // For results tab we want newest first, otherwise keep ascending (closest/soonest first)
        return tab === 'results' ? dateB - dateA : dateA - dateB;
      };

      const sameCompetition = (event: any) => {
        if (activeLeague === 'TOUT') return true;
        const key = competitionKeyOf(event);
        const label = competitionLabelOf(event);
        return key === activeLeague || normalizeName(key) === normalizeName(activeLeague) || normalizeName(label) === normalizeName(activeLeague);
      };

      if (activeLeague === 'TOUT') {
        const sortedEvents = [...allEvents].sort(compareByDate);
        return [['', sortedEvents]] as [string, any[]][];
      }

      // Filter events by code or displayed league name.
      const filtered = allEvents.filter((e: any) => sameCompetition(e));
      const grouped = groupByComp(filtered);

      // Ensure matches inside each competition follow the same ordering
      Object.keys(grouped).forEach((k) => {
        grouped[k] = grouped[k].sort(compareByDate);
      });

      return sortedGroups(grouped);
    },
    [activeLeague, groups, current.data?.competitions, visibleItems, tab]
  );
  const shouldPaginate = activeLeague === 'TOUT';
  const pagedGroups = useMemo(() => {
    if (!shouldPaginate) {
      return filteredGroups;
    }

    const start = page * MATCHES_PER_PAGE;
    const end = start + MATCHES_PER_PAGE;
    let cursor = 0;

    return filteredGroups
      .map(([name, matches]) => {
        const selected = matches.filter(() => {
          const inPage = cursor >= start && cursor < end;
          cursor += 1;
          return inPage;
        });
        return [name, selected] as [string, any[]];
      })
      .filter(([, matches]) => matches.length > 0);
  }, [filteredGroups, page, shouldPaginate]);
  const totalMatches = filteredGroups.reduce((sum, [, matches]) => sum + matches.length, 0);
  const totalPages = shouldPaginate ? Math.max(1, Math.ceil(totalMatches / MATCHES_PER_PAGE)) : 1;
  const pageStart = shouldPaginate && totalMatches > 0 ? page * MATCHES_PER_PAGE + 1 : 1;
  const pageEnd = shouldPaginate ? Math.min(totalMatches, (page + 1) * MATCHES_PER_PAGE) : totalMatches;

  const changeTab = (next: Tab) => {
    setTab(next);
    setActiveLeague('TOUT');
    setPage(0);
  };

  return (
    <Card accent="red" className="border-l-0 bg-[#161616] from-[#242424] to-[#121212] text-white">
      <div className="relative overflow-hidden rounded-xl border border-[#ff2a2a]/35 bg-[#202020]">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(255,42,42,.36),transparent_34%),radial-gradient(circle_at_92%_12%,rgba(255,42,42,.18),transparent_24%)]" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#ff2a2a] to-transparent" />

        <div className="relative p-3.5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#ff2a2a] text-white shadow-[0_0_20px_rgba(255,42,42,.42)]">
                <Zap size={19} fill="currentColor" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-[0.22em] text-[#ffb3b3]">
                  <Sparkles size={11} />
                  Bet room
                </div>
                <h2 className="truncate text-xl font-black uppercase leading-none text-white">Football</h2>
                <p className="mt-1 text-[9px] font-medium uppercase tracking-[0.18em] text-zinc-500">
                  {formatUpdateLabel(updatedAt)}
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {(Object.keys(TAB_CONFIG) as Tab[]).map((id) => {
              const count = id === 'live' ? liveCount : id === 'today' ? todayCount : resultsCount;
              return (
                <button
                  key={id}
                  onClick={() => changeTab(id)}
                  className={clsx(
                    'relative flex min-h-[52px] items-center justify-center rounded-lg border px-1.5 py-1 text-center transition-all',
                    tab === id
                      ? 'border-[#ff2a2a] bg-[#ff2a2a] text-white shadow-[0_0_20px_rgba(255,42,42,.30)]'
                      : 'border-[#ff2a2a]/35 bg-[#2a2a2a]/75 text-zinc-300 hover:border-[#ff2a2a]/80 hover:bg-[#303030]'
                  )}
                >
                  <p className="text-base font-black uppercase leading-tight inline-block relative">
                    {TAB_CONFIG[id].label}
                    {id === 'live' ? (
                      <span className="absolute -top-2 -right-4 bg-[#ff2a2a] min-w-[14px] h-3 flex items-center justify-center px-1 text-[12px] font-black text-white">{count}</span>
                    ) : null}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {current.isLoading && <div className="mt-4"><WidgetSkeleton /></div>}
      {current.error && <div className="mt-4"><ErrorCard message="Football indisponible" /></div>}

      {!current.isLoading && !current.error && (
        <>
          <div className="my-3 flex gap-2 overflow-x-auto pb-1">
            {allCompetitions.map((league) => (
              <button
                key={league.key}
                onClick={() => {
                  setActiveLeague(league.key);
                  setPage(0);
                }}
                className={clsx(
                  'flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-black uppercase transition-all',
                  activeLeague === league.key
                    ? 'border-[#ff2a2a] bg-[#ff2a2a] text-white shadow-[0_0_18px_rgba(255,42,42,.30)]'
                    : 'border-[#ff2a2a]/35 bg-[#262626] text-zinc-400 hover:border-[#ff2a2a]/80 hover:bg-[#303030] hover:text-white'
                )}
              >
                {league.emblem ? (
                  <img
                    src={league.emblem}
                    alt={league.label}
                    className="h-5 w-5 rounded object-contain"
                    onError={(e) => (e.currentTarget.style.display = 'none')}
                  />
                ) : (
                  <CircleDot size={13} />
                )}
                <span className="ml-1">{league.label}</span>
                <span className={clsx(
                  'px-1.5 py-0.5 rounded text-[9px] font-bold',
                  league.count === 0 
                    ? 'bg-zinc-700/50 text-zinc-400' 
                    : 'bg-white/10 text-white'
                )}>
                  {league.count}
                </span>
                {current.data?.stale && (
                  <span className="ml-1 inline-flex items-center gap-1 text-[8px] text-orange-400 font-bold">
                    ⚠ Ancien
                  </span>
                )}
              </button>
            ))}
          </div>

          {filteredGroups.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 bg-[#0d0d0d] py-12 text-center">
              <p className="text-sm font-black uppercase tracking-wider text-zinc-500">
                {tab === 'live' ? 'Aucun match en direct' : tab === 'today' ? 'Aucun match prevu' : 'Aucun resultat'}
              </p>
            </div>
          ) : (
            <>
              {shouldPaginate && totalMatches > MATCHES_PER_PAGE ? (
              <div className="mb-3 ml-auto flex w-fit items-center justify-end gap-1.5 rounded-lg border border-[#ff2a2a]/35 bg-[#232323] px-2 py-1">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-[#ff2a2a]/35 bg-[#303030] text-zinc-300 transition-colors hover:border-[#ff2a2a] hover:text-[#ff7a7a] disabled:cursor-not-allowed disabled:opacity-30"
                  aria-label="Page precedente"
                >
                  <ChevronLeft size={14} />
                </button>

                <div className="min-w-[46px] text-center leading-none">
                  <p className="text-[8px] font-black uppercase tracking-[0.16em] text-zinc-500">Page</p>
                  <p className="font-mono text-[12px] font-black text-white">
                    {page + 1}/{totalPages}
                  </p>
                </div>

                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="flex h-6.5 w-6.5 items-center justify-center rounded-md border border-[#ff2a2a]/35 bg-[#303030] text-zinc-300 transition-colors hover:border-[#ff2a2a] hover:text-[#ff7a7a] disabled:cursor-not-allowed disabled:opacity-30"
                  aria-label="Page suivante"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
              ) : null}

              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-2">
                {pagedGroups.flatMap(([, matches]) => {
                  const meta = competitionMetaFromMatches(matches);
                  return matches.map((match: any, idx: number) => (
                    <MatchCard
                      key={`${match.id}-${idx}`}
                      match={match}
                      competitionName={filteredGroups[0]?.[0] === '' ? competitionMetaOf(match).name : meta.name}
                      competitionEmblem={filteredGroups[0]?.[0] === '' ? competitionMetaOf(match).emblem : meta.emblem}
                      showCompetitionHeader
                      selected={selectedMatch?.id === match.id}
                      onSelect={setSelectedMatch}
                      mode={tab}
                      nowTick={nowTick}
                    />
                  ));
                })}
              </div>
            </>
          )}
        </>
      )}

      {selectedMatch && <MatchPanel match={selectedMatch} onClose={() => setSelectedMatch(null)} />}
    </Card>
  );
});

function MatchCard({ match, selected, onSelect, mode, competitionName, competitionEmblem, showCompetitionHeader, nowTick }: any) {
  const isResult = mode === 'results';

  return (
    <div
      className={clsx(
        'group flex min-h-[220px] flex-col overflow-hidden rounded-xl border transition-all',
        selected
          ? 'border-[#ff2a2a] bg-[#2f1c1c] shadow-[0_0_22px_rgba(255,42,42,.28)]'
          : 'border-[#ff2a2a]/35 bg-[#242424] hover:border-[#ff2a2a]/80 hover:bg-[#292929]'
      )}
    >
                {showCompetitionHeader !== false && competitionName && (
        <>
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            {competitionEmblem ? (
              <img src={competitionEmblem} alt={competitionName} className="h-4 w-4 object-contain" onError={(e) => (e.currentTarget.style.display = 'none')} />
            ) : (
              <Shield size={13} className="text-[#ff2a2a]" />
            )}
            <span className="text-[8px] font-black uppercase tracking-[0.16em] text-zinc-200">
              {translateCompetitionLabel(competitionName)}
            </span>
          </div>
          <div className="h-px bg-gradient-to-r from-[#ff2a2a]/30 via-[#ff2a2a]/10 to-transparent" />
        </>
      )}
      <button onClick={() => onSelect(match)} className="flex min-h-0 flex-1 flex-col text-left">
        <div className="flex min-h-0 flex-1 px-1.5 py-2">
          <MatchFaceoff match={match} mode={mode} nowTick={nowTick} />
        </div>
      </button>

      {!isResult ? (
        <OddsDock match={match} odds={getBookOdds(match)} />
      ) : (
        <button
          onClick={() => onSelect(match)}
          className="mx-1.5 mb-1 flex items-center justify-center gap-2 rounded-lg border border-[#ff2a2a]/35 bg-[#303030] px-1.5 py-1 text-[9px] font-black uppercase text-zinc-300 transition-colors hover:border-[#ff2a2a]/80 hover:text-white"
        >
          Details match <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}

function MatchFaceoff({ match, mode, compact, nowTick }: { match: any; mode: Tab; compact?: boolean; nowTick?: number }) {
  const homeScore = scoreOf(match, 'home');
  const awayScore = scoreOf(match, 'away');
  const center =
    mode === 'today'
      ? { top: smartDate(match.utcDate), main: formatTime(match.utcDate) }
      : mode === 'live'
        ? { top: statusLabel(match, nowTick), main: `${homeScore ?? 0}-${awayScore ?? 0}` }
        : { top: smartDate(match.utcDate), main: `${homeScore ?? '-'}-${awayScore ?? '-'}` };
  const liveSourceLabel = match.liveSource === 'sofascore'
    ? 'Sofascore live'
    : '';

  return (
    <div className={clsx('grid flex-1 grid-cols-[minmax(0,1fr)_72px_minmax(0,1fr)] items-center gap-2 overflow-hidden', !compact && 'gap-1.5')}>
      <SideTeam team={match.homeTeam} side="home" />

      <div
        className={clsx(
          'rounded-lg border px-1.5 text-center shadow-[inset_0_0_14px_rgba(0,0,0,.14)]',
          compact ? 'py-1.5' : 'py-2',
          mode === 'live'
            ? 'border-[#ff2a2a]/55 bg-[#ff2a2a]/15'
            : mode === 'results'
              ? 'border-[#ff2a2a]/25 bg-[#1a1a1a]'
              : 'border-[#ff2a2a]/35 bg-[#ff2a2a]/12'
        )}
      >
        <p className={clsx('truncate text-[7px] font-black uppercase tracking-widest', mode === 'live' ? 'text-[#ff8e8e]' : 'text-zinc-500')}>
          {center.top}
        </p>
        <p className={clsx('mt-0.5 font-mono font-black leading-none', compact ? 'text-[15px]' : 'text-lg', mode === 'today' ? 'text-white animate-pulse' : 'text-white')}>
          {center.main}
        </p>
        {mode === 'live' && liveSourceLabel ? (
          <div className="mt-1 flex justify-center">
            <span className={clsx(
              'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[7px] font-black uppercase tracking-[0.18em]',
              match.liveSource === 'sofascore'
                ? 'border-emerald-400/35 bg-emerald-400/12 text-emerald-200'
                : 'border-[#ff2a2a]/35 bg-[#ff2a2a]/12 text-[#ffb3b3]'
            )}>
              <span className={clsx('h-1.5 w-1.5 rounded-full', match.liveSource === 'sofascore' ? 'bg-emerald-300' : 'bg-[#ff7a7a]')} />
              {liveSourceLabel}
            </span>
          </div>
        ) : null}
      </div>

      <SideTeam team={match.awayTeam} side="away" />
    </div>
  );
}

function SideTeam({ team, side }: { team: any; side: 'home' | 'away' }) {
  return (
    <div className="flex min-w-0 flex-col items-center justify-center gap-0.5 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-white/10 bg-[#1f1f1f]">
        {team?.crest ? (
          <img
            src={team.crest}
            alt=""
            className="h-8 w-8 shrink-0 object-contain drop-shadow-[0_2px_5px_rgba(0,0,0,.45)]"
            onError={(e) => (e.currentTarget.style.display = 'none')}
          />
        ) : (
          <span className="text-[10px] font-black text-zinc-500">--</span>
        )}
      </div>
      <div className="min-w-0 max-w-[120px]">
        <p className="truncate text-[13px] font-black uppercase leading-tight text-white">{displayTeamName(team)}</p>
      </div>
    </div>
  );
}

function OddsDock({ match, odds, compact }: { match: any; odds: Odds; compact?: boolean }) {
  const lowSide = odds.win <= odds.loss ? 'home' : 'away';
  const highSide = lowSide === 'home' ? 'away' : 'home';
  const weights = [odds.win, odds.draw, odds.loss].map((v) => (v > 0 ? 1 / v : 0));
  const weightTotal = weights.reduce((sum, v) => sum + v, 0) || 1;
  const strength = weights.map((v) => v / weightTotal);
  const barToneBySide = (() => {
    const ranked = [
      { side: 'home' as const, value: odds.win },
      { side: 'draw' as const, value: odds.draw },
      { side: 'away' as const, value: odds.loss },
    ]
      .slice()
      .sort((a, b) => a.value - b.value);

    return {
      [ranked[0].side]: 'low' as const,
      [ranked[1].side]: 'mid' as const,
      [ranked[2].side]: 'high' as const,
    };
  })();

  return (
    <div
      className={clsx(
        'grid grid-cols-3 gap-1 border-t border-white/6 bg-[linear-gradient(180deg,rgba(255,255,255,.02),rgba(20,20,20,.72))]',
        compact ? 'px-1 py-1' : 'px-2 py-2'
      )}
    >
      <OddTile label={match.homeTeam?.shortName ?? 'Dom.'} value={odds.win} isLow={lowSide === 'home'} isHigh={highSide === 'home'} strength={strength[0]} barTone={barToneBySide.home} />
      <OddTile label="Nul" value={odds.draw} draw strength={strength[1]} barTone={barToneBySide.draw} />
      <OddTile label={match.awayTeam?.shortName ?? 'Ext.'} value={odds.loss} isLow={lowSide === 'away'} isHigh={highSide === 'away'} strength={strength[2]} barTone={barToneBySide.away} />
    </div>
  );
}

function OddTile({
  label,
  value,
  draw,
  isLow,
  isHigh,
  strength,
  barTone,
}: {
  label: string;
  value: number;
  draw?: boolean;
  isLow?: boolean;
  isHigh?: boolean;
  strength: number;
  barTone?: 'low' | 'mid' | 'high';
}) {
  const barWidth = `${Math.max(18, Math.min(86, Math.round(18 + strength * 62)))}%`;

  return (
    <button
      type="button"
      className={clsx(
        'group/odd relative min-w-0 overflow-hidden rounded-lg border px-1.5 py-1.5 text-center transition-all',
        draw
          ? 'border-[#fde047]/40 bg-[#fde047]/12 text-[#fde047] shadow-[0_0_12px_rgba(253,224,71,.25)]'
          : isLow
            ? 'border-[#fde047] bg-[#fde047] text-black shadow-[0_0_20px_rgba(253,224,71,.30)]'
            : isHigh
              ? 'border-[#fde047] bg-[#fde047] text-black shadow-[0_0_20px_rgba(253,224,71,.30)]'
              : 'border-white/8 bg-[#262626] text-white',
        'shadow-[0_6px_12px_rgba(0,0,0,.20)] hover:-translate-y-0.5 hover:border-white/12 hover:bg-[#2b2b2b]'
      )}
    >
      <span className={clsx('block truncate text-[7px] font-black uppercase tracking-wider', draw ? 'text-[#fde047]' : isLow ? 'text-black' : isHigh ? 'text-black' : 'text-zinc-500')}>{label}</span>
      <span className={clsx('mt-0.5 block font-mono text-[13px] font-black leading-none', draw ? 'text-[#fde047]' : isLow ? 'text-black' : isHigh ? 'text-black' : 'text-zinc-200')}>{value.toFixed(2)}</span>
      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-white/8">
        <span
          className={clsx(
            'block h-full rounded-full',
            barTone === 'low' ? 'bg-[#22c55e]' : barTone === 'mid' ? 'bg-[#f59e0b]' : barTone === 'high' ? 'bg-[#ff2a2a]' : 'bg-[#3f3f46]'
          )}
          style={{ width: barWidth }}
        />
      </span>
    </button>
  );
}

function scoreOf(match: any, side: 'home' | 'away') {
  // Prefer liveDetails score (from Sofascore) when available
  const liveScore = match.liveDetails?.score;
  if (liveScore && (liveScore.home != null || liveScore.away != null)) {
    return liveScore[side];
  }
  return match.score?.fullTime?.[side] ?? match.score?.halfTime?.[side] ?? null;
}
