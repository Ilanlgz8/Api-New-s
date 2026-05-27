import type { EnergyApiResponse, EnergySource, OdreRecord } from './energyTypes';

export const ENERGY_SOURCES: Array<Pick<EnergySource, 'key' | 'label' | 'color'>> = [
  { key: 'nucleaire', label: 'Nucléaire', color: '#8b5cf6' },
  { key: 'eolien', label: 'Éolien', color: '#22c55e' },
  { key: 'solaire', label: 'Solaire', color: '#f59e0b' },
  { key: 'hydraulique', label: 'Hydraulique', color: '#3b82f6' },
  { key: 'thermique', label: 'Thermique', color: '#ef4444' },
  { key: 'bioenergies', label: 'Bioénergies', color: '#10b981' },
];

export function buildEnergyPayload(record: OdreRecord): EnergyApiResponse {
  const production = ENERGY_SOURCES
    .map((source) => ({
      ...source,
      value: Number(record[source.key] ?? 0),
    }))
    .filter((source) => source.value > 0);

  const totalProduction = production.reduce((sum, source) => sum + source.value, 0);
  const consumption = Number(record.consommation ?? 0);
  const exports = Number(record.ech_comm_exportations ?? 0);
  const imports = Number(record.ech_comm_importations ?? 0);

  return {
    production,
    totalProduction,
    consumption,
    exports,
    imports,
    balance: totalProduction - consumption,
    updatedAt: String(record.date_heure ?? ''),
  };
}
