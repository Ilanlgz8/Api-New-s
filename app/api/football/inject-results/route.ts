import { NextResponse } from 'next/server';
import { writeLastResultsSnapshot, readLastResultsSnapshot, mergeResultsSnapshot } from '../route';

export const runtime = 'nodejs';

/**
 * POST /api/football/inject-results
 * 
 * Injecte des matches manuellement dans le snapshot des résultats.
 * Fusion avec les données existantes (pas de suppression).
 * 
 * Body: {
 *   "events": [...array of match objects...],
 *   "replace": false  // Si true, remplace entièrement le snapshot
 * }
 * 
 * Match object minimum:
 * {
 *   "id": "unique-id",
 *   "utcDate": "2026-05-18T20:00:00Z",
 *   "status": "FINISHED",
 *   "homeTeam": { "name": "PSG" },
 *   "awayTeam": { "name": "Monaco" },
 *   "score": { "fullTime": { "home": 3, "away":1 } },
 *   "competition": { "code": "FL1", "name": "Ligue 1" }
 * }
 */
export async function POST(request: Request) {
  try {
    const secret = process.env.ADMIN_REFRESH_SECRET;
    if (secret) {
      const hdr = request.headers.get('x-admin-secret');
      if (!hdr || hdr !== secret) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const body = await request.json().catch(() => null);
    if (!body || !Array.isArray(body.events)) {
      return NextResponse.json(
        { error: 'Missing or invalid "events" array in body' },
        { status: 400 }
      );
    }

    const incomingEvents = body.events as any[];
    const replace = body.replace === true;

    // Validate incoming events have minimum required fields
    const validated = incomingEvents.filter((e: any) => {
      return (
        e.id &&
        e.utcDate &&
        e.status &&
        e.homeTeam &&
        e.awayTeam &&
        e.competition?.code
      );
    }).map((e: any) => ({
      provenance: 'injected',
      ...e,
    }));

    if (validated.length === 0) {
      return NextResponse.json(
        { error: 'No valid events to inject (require: id, utcDate, status, homeTeam, awayTeam, competition.code)' },
        { status: 400 }
      );
    }

    let finalEvents: any[];
    if (replace) {
      // Replace entire snapshot
      finalEvents = validated;
    } else {
      // Merge with existing
      const existing = readLastResultsSnapshot();
      finalEvents = mergeResultsSnapshot([...validated, ...(existing?.events ?? [])]);
    }

    // Write to snapshot
    writeLastResultsSnapshot({ events: finalEvents, fetchedAt: Date.now() });

    // Prepare diagnostic
    const fl1Count = finalEvents.filter((e: any) => e.competition?.code === 'FL1').length;
    const compCounts: Record<string, number> = {};
    finalEvents.forEach((e: any) => {
      const code = e.competition?.code ?? 'unknown';
      compCounts[code] = (compCounts[code] ?? 0) + 1;
    });

    return NextResponse.json({
      ok: true,
      result: {
        injected: validated.length,
        totalEvents: finalEvents.length,
        fl1Count,
        competitions: compCounts,
        mode: replace ? 'replace' : 'merge',
        fetchedAt: Date.now(),
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? String(e) },
      { status: 500 }
    );
  }
}
