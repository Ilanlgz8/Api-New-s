import { FootballEvent } from './footballTypes';
import { teamRating, extractLiveStatVector } from './footballHelpers';

export type Odds = {
  win: number;
  draw: number;
  loss: number;
  source: 'public' | 'model';
  bookmaker?: string | null;
  lastUpdate?: string | null;
};

// Simple sigmoid
function sigmoid(x: number) {
  return 1 / (1 + Math.exp(-x));
}

// Clamp and format
function clampOdd(value: number, min = 1.01, max = 100) {
  return Number(Math.max(min, Math.min(max, value)).toFixed(2));
}

// Convert probabilities to decimal odds, adding a margin
function probsToOdds(prob: { home: number; draw: number; away: number }, margin = 1.06) {
  return {
    win: clampOdd(margin / Math.max(1e-9, prob.home)),
    draw: clampOdd(margin / Math.max(1e-9, prob.draw)),
    loss: clampOdd(margin / Math.max(1e-9, prob.away)),
  };
}

// Compute pre-match probabilities using ratings and home advantage
export function computePreMatchProbs(match: FootballEvent) {
  const home = teamRating(match.homeTeam) || 1500;
  const away = teamRating(match.awayTeam) || 1500;

  // Home advantage (in rating points)
  const homeAdv = 55; // tuned constant; can be customized per league

  const diff = (home + homeAdv) - away;

  // base strength factor scaled to yield reasonable probabilities
  const k = 0.0045; // scaling factor
  const homeStrength = sigmoid(k * diff);

  // baseline draw probability decreases as absolute diff grows
  const baseDraw = Math.max(0.12, 0.32 - Math.abs(diff) * 0.0008);

  // allocate remaining mass by strength
  const remaining = Math.max(0.001, 1 - baseDraw);
  const homeProb = Math.max(0.001, Math.min(0.999, remaining * homeStrength));
  const awayProb = Math.max(0.001, Math.min(0.999, remaining * (1 - homeStrength)));

  // normalize (defensive safety)
  const s = homeProb + baseDraw + awayProb;
  return { home: homeProb / s, draw: baseDraw / s, away: awayProb / s };
}

// Compute live adjustments using live stats (xG, shots, possession) and minute
export function adjustLiveProbs(orig: { home: number; draw: number; away: number }, match: FootballEvent, nowTick?: number) {
  try {
    const liveStats = extractLiveStatVector(match as any);
    const minuteRaw = (match.liveDetails?.minute ?? match.minute) ?? null;
    const minute = typeof minuteRaw === 'number' ? minuteRaw : null;

    let home = orig.home;
    let draw = orig.draw;
    let away = orig.away;

    // If we have live stats, compute an edge
    if (liveStats) {
      const xgDelta = (liveStats.homeXg ?? 0) - (liveStats.awayXg ?? 0);
      const shotsOnDelta = (liveStats.homeShotsOn ?? 0) - (liveStats.awayShotsOn ?? 0);
      const possDelta = ((liveStats.homePoss ?? 50) - (liveStats.awayPoss ?? 50)) / 100;

      const statEdge = xgDelta * 0.5 + shotsOnDelta * 0.06 + possDelta * 0.18;

      // apply smaller adjustments earlier, larger late in game
      const timeFactor = minute ? Math.max(0.2, Math.min(1, minute / 80)) : 0.6;
      const boost = Math.max(-0.38, Math.min(0.38, statEdge * timeFactor));

      // reduce draw when one team dominates
      draw = Math.max(0.06, draw - Math.abs(boost) * 0.22);

      // favor home or away
      if (boost > 0) {
        home = Math.min(0.98, home + boost);
      } else {
        away = Math.min(0.98, away - boost);
      }
    }

    // If a goal exists, strongly reweight using score differential
    const scoreHome = Number((match.liveDetails?.score?.home ?? match.score?.home) ?? 0);
    const scoreAway = Number((match.liveDetails?.score?.away ?? match.score?.away) ?? 0);
    const gap = scoreHome - scoreAway;
    if (gap !== 0) {
      const gapFactor = Math.max(0.04, Math.min(0.6, Math.abs(gap) * 0.18));
      if (gap > 0) {
        home = Math.min(0.995, home + gapFactor);
        draw = Math.max(0.03, draw - gapFactor * 0.4);
      } else {
        away = Math.min(0.995, away + gapFactor);
        draw = Math.max(0.03, draw - gapFactor * 0.4);
      }
    }

    // renormalize
    const tot = home + draw + away || 1;
    return { home: home / tot, draw: draw / tot, away: away / tot };
  } catch (e) {
    return orig;
  }
}

// Main exported compute function
export function computeModelOdds(match: FootballEvent, opts?: { nowTick?: number; margin?: number }) : Odds {
  const margin = opts?.margin ?? 1.06;
  const prices = match.publicOdds?.prices;

  // pre-match probabilities
  const pre = computePreMatchProbs(match);

  // if live, adjust
  const isLive = match.status === 'IN_PLAY' || match.status === 'LIVE' || match.status === 'PAUSED';
  const probs = isLive ? adjustLiveProbs(pre, match, opts?.nowTick) : pre;

  const rawOdds = probsToOdds(probs, margin);

  return {
    win: rawOdds.win,
    draw: rawOdds.draw,
    loss: rawOdds.loss,
    source: 'model',
  };
}
