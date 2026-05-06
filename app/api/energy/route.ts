import { NextResponse } from 'next/server';
import { withCache, CACHE_TTL } from '@/lib/cache';

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
      const r = json.results?.[0];
      if (!r) throw new Error('ODRE: aucune donnée');

      const sources = [
        { key: 'nucleaire',   label: 'Nucléaire',   color: '#8b5cf6' },
        { key: 'eolien',      label: 'Éolien',      color: '#22c55e' },
        { key: 'solaire',     label: 'Solaire',     color: '#f59e0b' },
        { key: 'hydraulique', label: 'Hydraulique', color: '#3b82f6' },
        { key: 'thermique',   label: 'Thermique',   color: '#ef4444' },
        { key: 'bioenergies', label: 'Bioénergies', color: '#10b981' },
      ];

      const production = sources
        .map(s => ({ ...s, value: Number(r[s.key] ?? 0) }))
        .filter(s => s.value > 0);

      const totalProduction = production.reduce((sum, s) => sum + s.value, 0);

      return {
        production,
        totalProduction,
        consumption: Number(r.consommation ?? 0),
        exports:     Number(r.ech_comm_exportations ?? 0),
        imports:     Number(r.ech_comm_importations ?? 0),
        balance:     totalProduction - Number(r.consommation ?? 0),
        updatedAt:   r.date_heure,
      };
    });

    return NextResponse.json(data, {
      headers: { 'X-Cache': fromCache ? `HIT age=${age}s` : 'MISS' },
    });
  } catch (error: any) {
    console.error('Energy error FULL:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}