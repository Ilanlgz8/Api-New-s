/**
 * Local Persistent Score Database
 * Stores scores with source confidence, never deletes (cumulative)
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface StoredScore {
  matchId: string; // "CL:HomeTeam:AwayTeam:YYYY-MM-DD"
  homeTeam: string;
  awayTeam: string;
  competition: string;
  utcDate: string;
  scores: Array<{
    home: number | null;
    away: number | null;
    source: string; // 'wikipedia', 'thesportsdb', 'rss', 'api-football', etc.
    confidence: number; // 0-100
    fetchedAt: number;
  }>;
  bestScore?: { home: number | null; away: number | null; source: string; confidence: number };
}

const DB_PATH = join(process.cwd(), '.cache', 'score-database.json');

function ensureDbDir() {
  const dir = join(process.cwd(), '.cache');
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) throw new Error('not dir');
  } catch (e) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (er) {
      /* ignore */
    }
  }
}

function readDb(): Map<string, StoredScore> {
  try {
    const data = readFileSync(DB_PATH, 'utf-8');
    const entries = JSON.parse(data) as Array<[string, StoredScore]>;
    return new Map(entries);
  } catch {
    return new Map();
  }
}

function writeDb(db: Map<string, StoredScore>) {
  try {
    ensureDbDir();
    const entries = Array.from(db.entries());
    writeFileSync(DB_PATH, JSON.stringify(entries, null, 2));
  } catch (e) {
    console.warn('[ScoreDB] Write error:', (e as any)?.message?.slice(0, 50));
  }
}

/**
 * Compute confidence score for a source
 * Higher = more trusted
 */
function sourceConfidence(source: string): number {
  const scoreMap: Record<string, number> = {
    'wikipedia': 85, // High - human-edited, public
    'thesportsdb': 80, // High - official data
    'rss': 75, // Medium-high - official feeds
    'api-football': 70, // Medium - commercial API
    'football-data': 70,
    'sofascore': 65, // Medium - commercial
    'flashscore': 65,
    'manual': 95, // Highest - user input
  };
  return scoreMap[source] ?? 50;
}

/**
 * Pick best score from multiple sources
 * Prefer: manual > highest confidence > most recent
 */
function selectBestScore(scores: StoredScore['scores']): StoredScore['bestScore'] {
  if (!scores.length) return undefined;

  // Manual overrides always win
  const manual = scores.find((s) => s.source === 'manual' && s.home !== null && s.away !== null);
  if (manual) {
    return { home: manual.home, away: manual.away, source: 'manual', confidence: manual.confidence };
  }

  // Sort by: confidence desc, fetchedAt desc
  const sorted = [...scores].sort((a, b) => {
    if ((a.confidence ?? 0) !== (b.confidence ?? 0)) {
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    }
    return (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0);
  });

  const best = sorted.find((s) => s.home !== null && s.away !== null);
  if (best) {
    return { home: best.home, away: best.away, source: best.source, confidence: best.confidence };
  }

  return undefined;
}

/**
 * Add or update a score in the database
 * Never deletes scores (cumulative)
 */
export function storeScore(
  homeTeam: string,
  awayTeam: string,
  competition: string,
  utcDate: string,
  home: number | null,
  away: number | null,
  source: string
) {
  const db = readDb();

  const matchId = `${competition}:${homeTeam}:${awayTeam}:${utcDate.slice(0, 10)}`;

  let record = db.get(matchId) || {
    matchId,
    homeTeam,
    awayTeam,
    competition,
    utcDate,
    scores: [],
  };

  // Check if already stored from this source
  const existing = record.scores.find((s) => s.source === source);
  if (existing && existing.home === home && existing.away === away) {
    // Already stored, just refresh timestamp
    existing.fetchedAt = Date.now();
  } else if (home !== null && away !== null) {
    // Add new score
    record.scores.push({
      home,
      away,
      source,
      confidence: sourceConfidence(source),
      fetchedAt: Date.now(),
    });
  }

  // Recompute best score
  record.bestScore = selectBestScore(record.scores);

  db.set(matchId, record);
  writeDb(db);

  return record;
}

/**
 * Get stored score for a match
 */
export function getStoredScore(
  homeTeam: string,
  awayTeam: string,
  competition: string,
  utcDate: string
): StoredScore | null {
  const db = readDb();
  const matchId = `${competition}:${homeTeam}:${awayTeam}:${utcDate.slice(0, 10)}`;
  return db.get(matchId) ?? null;
}

/**
 * Get all stored scores for a competition
 */
export function getAllStoredScores(competition: string): StoredScore[] {
  const db = readDb();
  return Array.from(db.values()).filter((s) => s.competition === competition);
}

/**
 * Enrich a match object with stored score + badge
 */
export function enrichWithStoredScore(match: any): any {
  if (!match.homeTeam?.name || !match.awayTeam?.name) return match;

  const stored = getStoredScore(
    match.homeTeam.name,
    match.awayTeam.name,
    match.competition?.code ?? 'CL',
    match.utcDate ?? ''
  );

  if (!stored?.bestScore) return match;

  return {
    ...match,
    score: {
      ...match.score,
      fullTime: {
        home: stored.bestScore.home,
        away: stored.bestScore.away,
      },
    },
    scoreSource: stored.bestScore.source,
    scoreConfidence: stored.bestScore.confidence,
    // For UI: badge like "[Wikipedia]"
    scoreBadge: `[${stored.bestScore.source}]`,
  };
}

/**
 * Batch store scores from API/source
 */
export function batchStoreScores(
  matches: Array<{
    homeTeam: string;
    awayTeam: string;
    competition: string;
    utcDate: string;
    score?: { fullTime?: { home?: number | null; away?: number | null } };
  }>,
  source: string
) {
  for (const m of matches) {
    if (m.score?.fullTime?.home !== undefined && m.score?.fullTime?.away !== undefined) {
      storeScore(
        m.homeTeam,
        m.awayTeam,
        m.competition,
        m.utcDate,
        m.score.fullTime.home ?? null,
        m.score.fullTime.away ?? null,
        source
      );
    }
  }
  console.log(`[ScoreDB] Stored ${matches.length} scores from ${source}`);
}

export default {};
