'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  Activity,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  ArrowDownRight,
  ArrowUpRight,
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
import type { FootballEvent, FootballTab } from '@/lib/footballTypes';
import {
  canonicalTeamName,
  competitionDisplayLabelOf,
  competitionKeyOf,
  competitionLabelOf,
  competitionMetaFromMatches,
  competitionMetaOf,
  dedupeMatches,
  groupByComp,
  ALLOWED_COMPETITION_KEYWORDS,
  isAllowedCompetition,
  isWorldCupLabel,
  normalizeName,
  normalizeTeamNameForDedup,
  sortedGroups,
  teamRating,
  translateCompetitionLabel,
} from '@/lib/footballHelpers';

const MATCHES_PER_PAGE = 4;

type Odds = {
  win: number;
  draw: number;
  loss: number;
  source: 'public' | 'model';
  bookmaker?: string | null;
  lastUpdate?: string | null;
};

const TAB_CONFIG: Record<FootballTab, { label: string; eyebrow: string; icon: React.ElementType }> = {
  live: { label: 'Live', eyebrow: 'En direct', icon: Radio },
  today: { label: 'Matchs', eyebrow: 'A venir', icon: CalendarDays },
  results: { label: 'Scores', eyebrow: 'Termines', icon: Trophy },
};

function getBookOdds(match: FootballEvent): Odds {
  const prices = match.publicOdds?.prices;
  if (prices?.home && prices?.draw && prices?.away) {
    const publicOdds = match.publicOdds;
    return {
      win: Number(prices.home),
      draw: Number(prices.draw),
      loss: Number(prices.away),
      source: 'public',
      bookmaker: publicOdds?.bookmaker,
      lastUpdate: publicOdds?.lastUpdate,
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

function oddsToProbabilities(odds: Odds) {
  const home = odds.win > 0 ? 1 / odds.win : 0;
  const draw = odds.draw > 0 ? 1 / odds.draw : 0;
  const away = odds.loss > 0 ? 1 / odds.loss : 0;
  const total = home + draw + away || 1;

  return {
    home: home / total,
    draw: draw / total,
    away: away / total,
  };
}

// Module-level cache to smooth odds and detect recent score changes
type OddsCacheEntry = {
  probs: { home: number; draw: number; away: number };
  oddsDecimal: { win: number; draw: number; loss: number };
  lastScoreHome: number;
  lastScoreAway: number;
  lastChangeAt: number; // ms
  lastComputedAt: number; // ms
};

const oddsStateCache = new Map<string, OddsCacheEntry>();

function blend(a: number, b: number, alpha: number) {
  return a * (1 - alpha) + b * alpha;
}

function makeCacheKey(match: FootballEvent) {
  return (
    match.id || match.matchId || match.fixture?.id || `${match.utcDate}:${canonicalTeamName(match.homeTeam)}:${canonicalTeamName(match.awayTeam)}`
  );
}

function parseMinuteValue(value: string | number | null | undefined) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const raw = String(value).trim();
  const addedTime = raw.match(/^(\d+)\+(\d+)$/);
  if (addedTime) {
    return Number(addedTime[1]) + Number(addedTime[2]);
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveLiveMinuteNumber(match: FootballEvent, nowTick?: number) {
  const sourceMinute = parseMinuteValue(match.liveDetails?.minute ?? match.minute);
  if (sourceMinute != null) return sourceMinute;

  if (nowTick == null) return null;

  return parseMinuteValue(calculateLiveMinute(match, nowTick));
}

function parseStatNumber(value: any): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  const cleaned = raw.replace('%', '').replace(',', '.').replace(/[^0-9.\-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function statFromTeamBlock(team: any, labels: string[]) {
  const stats = team?.statistics;
  if (!Array.isArray(stats)) return null;

  for (const label of labels) {
    const entry = stats.find((s: any) => String(s?.type ?? '').toLowerCase() === label.toLowerCase());
    const value = parseStatNumber(entry?.value);
    if (value != null) return value;
  }

  return null;
}

function extractLiveStatVector(match: FootballEvent) {
  const candidates = [
    match?.stats,
    match?.liveDetails?.stats,
    match?.statistics,
  ];

  const statsArray = candidates.find((candidate) => Array.isArray(candidate) && candidate.length >= 2);
  if (!statsArray) return null;

  const home = statsArray[0];
  const away = statsArray[1];

  const homeXg = statFromTeamBlock(home, ['Expected Goals', 'xG', 'Expected Goals (xG)']);
  const awayXg = statFromTeamBlock(away, ['Expected Goals', 'xG', 'Expected Goals (xG)']);
  const homeShots = statFromTeamBlock(home, ['Total Shots', 'Shots']);
  const awayShots = statFromTeamBlock(away, ['Total Shots', 'Shots']);
  const homeShotsOn = statFromTeamBlock(home, ['Shots on Goal', 'Shots on Target']);
  const awayShotsOn = statFromTeamBlock(away, ['Shots on Goal', 'Shots on Target']);
  const homePoss = statFromTeamBlock(home, ['Ball Possession', 'Possession']);
  const awayPoss = statFromTeamBlock(away, ['Ball Possession', 'Possession']);

  const hasSignal = [homeXg, awayXg, homeShots, awayShots, homeShotsOn, awayShotsOn, homePoss, awayPoss].some((value) => value != null);
  if (!hasSignal) return null;

  return {
    homeXg,
    awayXg,
    homeShots,
    awayShots,
    homeShotsOn,
    awayShotsOn,
    homePoss,
    awayPoss,
  };
}

function getLiveOdds(match: FootballEvent, odds: Odds, nowTick?: number): Odds {
  const isLive = match.status === 'IN_PLAY' || match.status === 'LIVE' || match.status === 'PAUSED';
  if (!isLive) return odds;

  const minute = resolveLiveMinuteNumber(match, nowTick);
  if (minute == null) return odds;

  const scoreHome = Number(scoreOf(match, 'home') ?? 0);
  const scoreAway = Number(scoreOf(match, 'away') ?? 0);
  const goalDiff = scoreHome - scoreAway;
  const gap = Math.abs(goalDiff);
  const effectiveMinute = Math.max(0, Math.min(120, minute));
  const urgency = Math.max(0, Math.min(1, effectiveMinute / 90));
  const base = oddsToProbabilities(odds);

  const liveStats = extractLiveStatVector(match);
  const statEdgeHome = (() => {
    if (!liveStats) return 0;
    const xgDelta = (liveStats.homeXg ?? 0) - (liveStats.awayXg ?? 0);
    const shotsOnDelta = (liveStats.homeShotsOn ?? 0) - (liveStats.awayShotsOn ?? 0);
    const shotsDelta = (liveStats.homeShots ?? 0) - (liveStats.awayShots ?? 0);
    const possDelta = ((liveStats.homePoss ?? 50) - (liveStats.awayPoss ?? 50)) / 100;

    // Weighted stat edge: xG first, then shots on target, then shots and possession.
    const edge = xgDelta * 0.24 + shotsOnDelta * 0.04 + shotsDelta * 0.012 + possDelta * 0.16;
    return Math.max(-0.3, Math.min(0.3, edge));
  })();

  // Build a compact state-based probability estimate (draw + side shares)
  const neutralDraw = base.draw;
  const drawDecay = goalDiff === 0 ? 1 - urgency * 0.22 : Math.max(0.6, 1 - urgency * 0.36 - gap * 0.04);
  let stateDrawRaw = neutralDraw * drawDecay + (goalDiff === 0 ? 0.06 * (1 - Math.abs(base.home - base.away)) : -0.04 * gap);

  // Stats can reduce draw likelihood when one team clearly dominates chance creation,
  // even if the score is still level.
  if (liveStats) {
    const statImbalance = Math.abs(statEdgeHome);
    if (goalDiff === 0) {
      stateDrawRaw -= Math.min(0.08, statImbalance * 0.22);
    } else {
      stateDrawRaw -= Math.min(0.04, statImbalance * 0.1);
    }
  }
  stateDrawRaw = Math.max(0.08, Math.min(0.42, stateDrawRaw));

  // side strength (leader/trailer) derived from base split + goal gap + time pressure
  const sideBaseTotal = Math.max(1e-6, base.home + base.away);
  const homeShareBase = base.home / sideBaseTotal;
  const awayShareBase = base.away / sideBaseTotal;
  const gapEffect = Math.min(0.28, 0.06 + gap * 0.06 + urgency * 0.2);

  let leaderProb = 0.5;
  if (goalDiff === 0) {
    const bias = Math.max(-0.06, Math.min(0.06, (homeShareBase - awayShareBase) * 0.25));
    const statsBias = statEdgeHome * 0.33;
    leaderProb = 0.5 + bias + statsBias;
  } else {
    const leadBase = goalDiff > 0 ? homeShareBase : awayShareBase;
    const leaderStatsEdge = goalDiff > 0 ? statEdgeHome : -statEdgeHome;
    leaderProb = Math.max(0.06, Math.min(0.92, leadBase + gapEffect + leaderStatsEdge * 0.22));
  }

  // allocate remaining mass after draw
  const remainingMass = Math.max(0.18, 1 - stateDrawRaw);
  const leaderShare = leaderProb;
  const trailerShare = 1 - leaderShare;

  let protoHome = goalDiff >= 0 ? remainingMass * leaderShare : remainingMass * trailerShare;
  let protoAway = goalDiff <= 0 ? remainingMass * leaderShare : remainingMass * trailerShare;

  // normalize and apply small floor
  const floor = 0.02;
  protoHome = Math.max(floor, protoHome);
  protoAway = Math.max(floor, protoAway);
  let ren = protoHome + stateDrawRaw + protoAway;
  protoHome /= ren;
  const protoDraw = stateDrawRaw / ren;
  protoAway /= ren;

  const newProbs = { home: protoHome, draw: protoDraw, away: protoAway };

  // Convert to decimal odds with a small bookmaker margin (overround)
  const liveTension = Math.max(0, Math.min(1, gap * 0.08 + urgency * 0.34));
  const baseMargin = 1.03; // healthy bookmaker margin
  const margin = baseMargin + liveTension * 0.02; // slightly wider when tense

  const rawNewOdds = {
    win: clampOdd(margin / Math.max(1e-6, newProbs.home), 1.01, 40),
    draw: clampOdd(margin / Math.max(1e-6, newProbs.draw), 1.01, 40),
    loss: clampOdd(margin / Math.max(1e-6, newProbs.away), 1.01, 40),
  };

  // Smoothing: compare with cached previous odds to avoid large jumps and detect recent goals
  const key = makeCacheKey(match);
  const now = Date.now();
  const prev = oddsStateCache.get(String(key));

  const prevOddsDecimal = prev ? prev.oddsDecimal : { win: odds.win, draw: odds.draw, loss: odds.loss };
  const prevScoreHome = prev ? prev.lastScoreHome : scoreHome;
  const prevScoreAway = prev ? prev.lastScoreAway : scoreAway;
  const scoreChanged = prev && (prevScoreHome !== scoreHome || prevScoreAway !== scoreAway);
  const lastChangeAt = scoreChanged ? now : prev?.lastChangeAt ?? now;

  const timeSinceChangeSec = (now - (prev?.lastChangeAt ?? now)) / 1000;
  const recentGoalFactor = scoreChanged ? 1 : Math.max(0, 1 - Math.min(1, timeSinceChangeSec / 90));

  // alpha: how much to follow the new model immediately (more after a goal)
  const alpha = Math.min(0.7, 0.12 + recentGoalFactor * 0.56);

  // limit per-update relative swing to keep realistic. More allowed late and on recent goals.
  const maxRel = 0.18 + urgency * 0.14 + recentGoalFactor * 0.22; // ~18% base

  const clampRelative = (prevVal: number, candidate: number) => {
    const min = prevVal * (1 - maxRel);
    const max = prevVal * (1 + maxRel);
    return Math.max(min, Math.min(max, candidate));
  };

  const limitedNew = {
    win: clampRelative(prevOddsDecimal.win || rawNewOdds.win, rawNewOdds.win),
    draw: clampRelative(prevOddsDecimal.draw || rawNewOdds.draw, rawNewOdds.draw),
    loss: clampRelative(prevOddsDecimal.loss || rawNewOdds.loss, rawNewOdds.loss),
  };

  const finalOddsDecimal = {
    win: Number(blend(prevOddsDecimal.win || limitedNew.win, limitedNew.win, alpha).toFixed(2)),
    draw: Number(blend(prevOddsDecimal.draw || limitedNew.draw, limitedNew.draw, alpha).toFixed(2)),
    loss: Number(blend(prevOddsDecimal.loss || limitedNew.loss, limitedNew.loss, alpha).toFixed(2)),
  };

  // update cache
  oddsStateCache.set(String(key), {
    probs: newProbs,
    oddsDecimal: finalOddsDecimal,
    lastScoreHome: scoreHome,
    lastScoreAway: scoreAway,
    lastChangeAt: scoreChanged ? now : prev?.lastChangeAt ?? now,
    lastComputedAt: now,
  });

  return {
    win: clampOdd(finalOddsDecimal.win, 1.05, 40),
    draw: clampOdd(finalOddsDecimal.draw, 1.05, 40),
    loss: clampOdd(finalOddsDecimal.loss, 1.05, 40),
    source: odds.source,
    bookmaker: odds.bookmaker,
    lastUpdate: odds.lastUpdate,
  };
}


function clampOdd(value: number, min = 1.12, max = 18) {
  return Number(Math.max(min, Math.min(max, value)).toFixed(2));
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

    // 0-44: minute normale.
    if (elapsedMinutes < 45) {
      return `${elapsedMinutes}`;
    }

    // 45-59: temps additionnel de la 1re mi-temps.
    if (elapsedMinutes < 60) {
      return `45+${elapsedMinutes - 45}`;
    }

    // Après la mi-temps, on retire la coupure et on décale d'une minute pour
    // que la reprise s'affiche à 46' comme dans les broadcasts classiques.
    const footballMinutes = elapsedMinutes - 15;

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

function statusLabel(match: FootballEvent, nowTick?: number) {
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
  const dateValue = match.utcDate ?? '';
  return `${smartDate(dateValue)} ${formatTime(dateValue)}`;
}

function displayTeamName(team: FootballEvent['homeTeam'] | FootballEvent['awayTeam']) {
  return canonicalTeamName(team);
}

export const FootballWidget = React.memo(function FootballWidget() {
  const [tab, setTab] = useState<FootballTab>('today');
  const [activeLeague, setActiveLeague] = useState('TOUT');
  const [page, setPage] = useState(0);
  const [selectedMatch, setSelectedMatch] = useState<FootballEvent | null>(null);
  const { live, today, results, refetch } = useFootball();
  const [nowTick, setNowTick] = useState<number>(Date.now());

  const current = tab === 'live' ? live : tab === 'today' ? today : results;
  const rawItems = tab === 'live' ? current.data?.matches ?? [] : current.data?.events ?? [];

  // Filter out injected/test events by provenance or suspicious ids
  function isTrustedEvent(event: FootballEvent) {
    if (!event) return false;
    if (event.provenance === 'injected') return false;
    const id = String(event.id ?? '');
    if (id.includes('fl1-test') || id.includes('test-match') || id.includes('injected')) return false;

    const homeName = String(event?.homeTeam?.name ?? event?.homeTeam?.shortName ?? '').trim();
    const awayName = String(event?.awayTeam?.name ?? event?.awayTeam?.shortName ?? '').trim();

    // Drop malformed placeholders (e.g. "Final ... at Stadium") emitted by weak fallback parsing.
    if (!homeName || !awayName) return false;
    if (/^final\b/i.test(homeName) || /^final\b/i.test(awayName)) return false;

    return true;
  }

  const visibleItems = useMemo(() => dedupeMatches(rawItems.filter(isAllowedCompetition).filter(isTrustedEvent)), [rawItems]);
  const liveCount = useMemo(() => dedupeMatches((live.data?.matches ?? []).filter(isAllowedCompetition)).length, [live.data?.matches]);
  const todayCount = useMemo(() => dedupeMatches((today.data?.events ?? []).filter(isAllowedCompetition)).length, [today.data?.events]);
  const resultsCount = useMemo(() => dedupeMatches((results.data?.events ?? []).filter(isAllowedCompetition)).length, [results.data?.events]);
  const worldCupCount = useMemo(
    () => visibleItems.filter((e: FootballEvent) => isWorldCupLabel(competitionKeyOf(e)) || isWorldCupLabel(competitionLabelOf(e))).length,
    [visibleItems]
  );
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
    backendComps.forEach((comp: { code?: string; name?: string; count?: number; emblem?: string | null }) => {
      if (!comp.code) return;
      merged.set(comp.code, {
        key: comp.code,
        label: translateCompetitionLabel(comp.name ?? comp.code),
        count: comp.count ?? 0,
        emblem: comp.emblem ?? null,
      });
    });

    // merge leagues discovered from matches, keep emblem if present
    leagues.forEach((league) => {
      const existing = merged.get(league.key);
      const label = translateCompetitionLabel(league.label);
      if (existing) {
        if (!existing.emblem && league.emblem) existing.emblem = league.emblem;
        // Keep badge count aligned with currently visible/deduped matches from the widget data.
        existing.count = league.count;
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
      const worldCup = isWorldCupLabel(entry.label) || isWorldCupLabel(entry.key);
      return allowed && (Boolean(entry.emblem) || worldCup);
    });

    return final;
  }, [current.data?.competitions, groups, leagues, visibleItems.length]);
  const defaultLeague = useMemo(
    () => allCompetitions.find((league) => league.key === 'TOUT') ?? null,
    [allCompetitions]
  );
  const nonDefaultCompetitions = useMemo(
    () => allCompetitions.filter((league) => league.key !== 'TOUT' && !isWorldCupLabel(league.key) && !isWorldCupLabel(league.label)),
    [allCompetitions]
  );

  // Exclude only explicit Europa / Conference League entries (avoid overbroad substring matches)
  const nonDefaultCompetitionsFiltered = useMemo(() => {
    const exactPhrases = ['europa league', 'uefa europa league', 'conference league', 'uefa conference league'];
    const codes = ['uel', 'uecl'];

    return nonDefaultCompetitions.filter((league) => {
      const key = normalizeName(String(league.key ?? '')).replace(/[^a-z0-9]/g, '');
      const label = normalizeName(String(league.label ?? '')).replace(/[^a-z0-9]/g, '');

      // check codes (short identifiers)
      if (codes.includes(key)) return false;

      // check normalized full phrases
      for (const phrase of exactPhrases) {
        const p = phrase.replace(/[^a-z0-9]/g, '');
        if (label === p || label.includes(p) || key === p || key.includes(p)) return false;
      }

      return true;
    });
  }, [nonDefaultCompetitions]);

  useEffect(() => {
    if (activeLeague === 'TOUT') return;

    if (activeLeague === 'WORLD_CUP') {
      const hasWorldCupMatches = visibleItems.some((event: FootballEvent) => {
        const key = competitionKeyOf(event);
        const label = competitionLabelOf(event);
        return isWorldCupLabel(key) || isWorldCupLabel(label);
      });

      if (!hasWorldCupMatches) {
        setActiveLeague('TOUT');
        setPage(0);
      }
      return;
    }

    const hasCurrentLeague = allCompetitions.some((league) => league.key === activeLeague);
    const leagueHasMatches = visibleItems.some((event: FootballEvent) => {
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

      const compareByDate = (a: FootballEvent, b: FootballEvent) => {
        const dateA = new Date(a.utcDate ?? 0).getTime();
        const dateB = new Date(b.utcDate ?? 0).getTime();
        // For results tab we want newest first, otherwise keep ascending (closest/soonest first)
        return tab === 'results' ? dateB - dateA : dateA - dateB;
      };

      const sameCompetition = (event: FootballEvent) => {
        if (activeLeague === 'TOUT') return true;
        const key = competitionKeyOf(event);
        const label = competitionLabelOf(event);

        // Special championship filters (support both human keys and codes)
        if (activeLeague === 'CHAMPIONS_LEAGUE' || activeLeague === 'CL') {
          const k = normalizeName(key);
          const l = normalizeName(label);
          return k.includes('champions') || l.includes('champions') || k.includes('ucl') || l.includes('ucl') || k.includes('liguedeschampions');
        }
        if (activeLeague === 'EUROPA_LEAGUE' || activeLeague === 'UEL') {
          const k = normalizeName(key);
          const l = normalizeName(label);
          return k.includes('europa') || l.includes('europa') || k.includes('uel') || l.includes('uel') || k.includes('europaleague');
        }
        if (activeLeague === 'CONFERENCE_LEAGUE' || activeLeague === 'UECL') {
          const k = normalizeName(key);
          const l = normalizeName(label);
          return k.includes('conference') || l.includes('conference') || k.includes('uecl') || l.includes('uecl') || k.includes('conferenceleague');
        }

        if (activeLeague === 'WORLD_CUP' || activeLeague === 'COUPE_DU_MONDE' || activeLeague === 'worldcup' || activeLeague === 'cdm') {
          const k = normalizeName(key);
          const l = normalizeName(label);
          return k.includes('worldcup') || l.includes('worldcup') || k.includes('cdm') || l.includes('cdm') || l.includes('coupedumonde') || k.includes('coupedumonde');
        }

        return key === activeLeague || normalizeName(key) === normalizeName(activeLeague) || normalizeName(label) === normalizeName(activeLeague);
      };

      if (activeLeague === 'TOUT') {
        const sortedEvents = [...allEvents].sort(compareByDate);
        return [['', sortedEvents]] as [string, FootballEvent[]][];
      }

      // Filter events by code or displayed league name.
      const filtered = allEvents.filter((e: FootballEvent) => sameCompetition(e));
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
        return [name, selected] as [string, FootballEvent[]];
      })
      .filter(([, matches]) => matches.length > 0);
  }, [filteredGroups, page, shouldPaginate]);
  const totalMatches = filteredGroups.reduce((sum, [, matches]) => sum + matches.length, 0);
  const totalPages = shouldPaginate ? Math.max(1, Math.ceil(totalMatches / MATCHES_PER_PAGE)) : 1;
  const pageStart = shouldPaginate && totalMatches > 0 ? page * MATCHES_PER_PAGE + 1 : 1;
  const pageEnd = shouldPaginate ? Math.min(totalMatches, (page + 1) * MATCHES_PER_PAGE) : totalMatches;

  const changeTab = (next: FootballTab) => {
    setTab(next);
    setActiveLeague('TOUT');
    setPage(0);
  };

  return (
    <Card accent="red" className="border-l-0 bg-[#161616] from-[#242424] to-[#121212] text-white">
      <div className="relative overflow-visible rounded-xl border border-[#ff2a2a]/35 bg-[#202020]">
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
            {(Object.keys(TAB_CONFIG) as FootballTab[]).map((id) => {
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
          <div className="my-3 flex gap-2 flex-nowrap overflow-x-auto pb-1">
            {defaultLeague && (
              <button
                key={defaultLeague.key}
                onClick={() => {
                  setActiveLeague(defaultLeague.key);
                  setPage(0);
                }}
                className={clsx(
                  'flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-black uppercase transition-all',
                  activeLeague === defaultLeague.key
                    ? 'border-[#ff2a2a] bg-[#ff2a2a] text-white shadow-[0_0_18px_rgba(255,42,42,.30)]'
                    : 'border-[#ff2a2a]/35 bg-[#262626] text-zinc-400 hover:border-[#ff2a2a]/80 hover:bg-[#303030] hover:text-white'
                )}
              >
                {defaultLeague.emblem ? (
                  <img
                    src={defaultLeague.emblem}
                    alt={defaultLeague.label}
                    className="h-5 w-5 rounded object-contain"
                    onError={(e) => (e.currentTarget.style.display = 'none')}
                  />
                ) : (
                  <CircleDot size={13} />
                )}
                <span className="ml-1">{defaultLeague.label}</span>
                <span className={clsx(
                  'px-1.5 py-0.5 rounded text-[9px] font-bold',
                  defaultLeague.count === 0
                    ? 'bg-zinc-700/50 text-zinc-400'
                    : 'bg-white/10 text-white'
                )}>
                  {defaultLeague.count}
                </span>
              </button>
            )}

            <button
              onClick={() => {
                setActiveLeague('WORLD_CUP');
                setPage(0);
              }}
              className={clsx(
                'flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-black uppercase transition-all',
                activeLeague === 'WORLD_CUP'
                  ? 'border-[#ff2a2a] bg-[#ff2a2a] text-white shadow-[0_0_18px_rgba(255,42,42,.30)]'
                  : 'border-[#ff2a2a]/35 bg-[#262626] text-zinc-400 hover:border-[#ff2a2a]/80 hover:bg-[#303030] hover:text-white'
              )}
            >
              <Trophy size={14} />
              <span>Coupe du Monde</span>
              <span className={clsx(
                'px-1.5 py-0.5 rounded text-[9px] font-bold',
                worldCupCount === 0
                  ? 'bg-zinc-700/50 text-zinc-400'
                  : 'bg-white/10 text-white'
              )}>
                {worldCupCount}
              </span>
            </button>
            {nonDefaultCompetitionsFiltered.filter((l) => (l.count ?? 0) > 0).map((league) => (
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

function MatchCard({ match, selected, onSelect, mode, competitionName, competitionEmblem, showCompetitionHeader, nowTick }: {
  match: FootballEvent;
  selected: boolean;
  onSelect: (match: FootballEvent) => void;
  mode: FootballTab;
  competitionName: string;
  competitionEmblem?: string | null;
  showCompetitionHeader: boolean;
  nowTick?: number;
}) {
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
        <OddsDock match={match} odds={getBookOdds(match)} nowTick={nowTick} />
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

function MatchFaceoff({ match, mode, compact, nowTick }: { match: FootballEvent; mode: FootballTab; compact?: boolean; nowTick?: number }) {
  const homeScore = scoreOf(match, 'home');
  const awayScore = scoreOf(match, 'away');
  const center =
    mode === 'today'
      ? { top: smartDate(match.utcDate ?? ''), main: formatTime(match.utcDate ?? '') }
      : mode === 'live'
        ? { top: statusLabel(match, nowTick), main: `${homeScore ?? 0}-${awayScore ?? 0}` }
        : { top: smartDate(match.utcDate ?? ''), main: `${homeScore ?? '-'}-${awayScore ?? '-'}` };
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

function SideTeam({ team, side }: { team: FootballEvent['homeTeam']; side: 'home' | 'away' }) {
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

function OddsDock({ match, odds, compact, nowTick }: { match: FootballEvent; odds: Odds; compact?: boolean; nowTick?: number }) {
  const displayOdds = getLiveOdds(match, odds, nowTick);
  const lowSide = displayOdds.win <= displayOdds.loss ? 'home' : 'away';
  const highSide = lowSide === 'home' ? 'away' : 'home';
  const weights = [displayOdds.win, displayOdds.draw, displayOdds.loss].map((v) => (v > 0 ? 1 / v : 0));
  const weightTotal = weights.reduce((sum, v) => sum + v, 0) || 1;
  const strength = weights.map((v) => v / weightTotal);
  const barToneBySide = (() => {
    const ranked = [
      { side: 'home' as const, value: displayOdds.win },
      { side: 'draw' as const, value: displayOdds.draw },
      { side: 'away' as const, value: displayOdds.loss },
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
      <OddTile label={match.homeTeam?.shortName ?? 'Dom.'} value={displayOdds.win} baseValue={odds.win} isLow={lowSide === 'home'} isHigh={highSide === 'home'} strength={strength[0]} barTone={barToneBySide.home} />
      <OddTile label="Nul" value={displayOdds.draw} baseValue={odds.draw} draw strength={strength[1]} barTone={barToneBySide.draw} />
      <OddTile label={match.awayTeam?.shortName ?? 'Ext.'} value={displayOdds.loss} baseValue={odds.loss} isLow={lowSide === 'away'} isHigh={highSide === 'away'} strength={strength[2]} barTone={barToneBySide.away} />
    </div>
  );
}

function OddTile({
  label,
  value,
  baseValue,
  draw,
  isLow,
  isHigh,
  strength,
  barTone,
}: {
  label: string;
  value: number;
  baseValue: number;
  draw?: boolean;
  isLow?: boolean;
  isHigh?: boolean;
  strength: number;
  barTone?: 'low' | 'mid' | 'high';
}) {
  const [flashDirection, setFlashDirection] = useState<'up' | 'down' | null>(null);
  const previousValueRef = useRef(value);

  useEffect(() => {
    if (previousValueRef.current === value) return;

    const direction = value > previousValueRef.current ? 'up' : 'down';
    previousValueRef.current = value;
    setFlashDirection(direction);

    const timeout = window.setTimeout(() => setFlashDirection(null), 900);
    return () => window.clearTimeout(timeout);
  }, [value]);

  const barWidth = `${Math.max(18, Math.min(86, Math.round(18 + strength * 62)))}%`;
  const trendTone = flashDirection === 'up' ? 'text-emerald-300' : flashDirection === 'down' ? 'text-[#ff5b5b]' : 'text-transparent';
  const trendBg = flashDirection === 'up' ? 'bg-emerald-400/12 border-emerald-400/30' : flashDirection === 'down' ? 'bg-[#ff2a2a]/14 border-[#ff2a2a]/30' : 'bg-transparent border-transparent';
  const TrendIcon = flashDirection === 'up' ? ArrowUpRight : ArrowDownRight;

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
        flashDirection ? `${trendBg} shadow-[0_0_16px_rgba(255,255,255,.06)] ring-1 ring-inset` : '',
        'shadow-[0_6px_12px_rgba(0,0,0,.20)] hover:-translate-y-0.5 hover:border-white/12 hover:bg-[#2b2b2b]'
      )}
    >
      <span className={clsx('block truncate text-[7px] font-black uppercase tracking-wider', draw ? 'text-[#fde047]' : isLow ? 'text-black' : isHigh ? 'text-black' : 'text-zinc-500')}>{label}</span>
      <span className={clsx('mt-0.5 flex items-center justify-center gap-1 font-mono text-[13px] font-black leading-none', draw ? 'text-[#fde047]' : isLow ? 'text-black' : isHigh ? 'text-black' : 'text-zinc-200')}>
        {value.toFixed(2)}
        {flashDirection ? <TrendIcon size={10} className={clsx('shrink-0', trendTone)} /> : null}
      </span>
      <span className="mt-0.5 block text-[7px] font-black uppercase tracking-[0.14em] text-transparent">.</span>
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

function scoreOf(match: FootballEvent, side: 'home' | 'away') {
  // Prefer liveDetails score (from Sofascore) when available
  const liveScore = match.liveDetails?.score;
  if (liveScore && (liveScore.home != null || liveScore.away != null)) {
    return liveScore[side];
  }
  return match.score?.fullTime?.[side] ?? match.score?.halfTime?.[side] ?? null;
}
