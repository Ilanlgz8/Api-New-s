import { NextResponse } from 'next/server';
import { withCache, CACHE_TTL } from '@/lib/cache';
import { buildEnergyPayload } from '@/lib/energyHelpers';
import type { OdreRecord } from '@/lib/energyTypes';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const { data, fromCache, age } = await withCache('energy:odre', CACHE_TTL.energy, async () => {
      const res = await fetch(
        'https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets/eco2mix-national-tr/records?limit=1&order_by=date_heure%20DESC',
        { headers: { 'Accept': 'application/json' } }
      );

      if (!res.ok) throw new Error(`ODRE ${res.status}: ${await res.text()}`);
      const json = await res.json();
      const r = json.results?.[0] as OdreRecord | undefined;
      if (!r) throw new Error('ODRE: aucune donnée');

      return buildEnergyPayload(r);
    });

    return NextResponse.json(data, {
      headers: { 'X-Cache': fromCache ? `HIT age=${age}s` : 'MISS' },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Erreur énergie inconnue';
    console.error('Energy error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}