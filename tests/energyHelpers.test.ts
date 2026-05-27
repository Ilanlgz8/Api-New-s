import { describe, expect, it } from 'vitest';
import { buildEnergyPayload } from '../lib/energyHelpers';

describe('buildEnergyPayload', () => {
  it('normalizes ODRE records into the widget payload', () => {
    const payload = buildEnergyPayload({
      nucleaire: 30000,
      eolien: 6000,
      solaire: 2000,
      consommation: 35000,
      ech_comm_exportations: 1200,
      ech_comm_importations: 900,
      date_heure: '2026-05-27T12:00:00Z',
    });

    expect(payload.totalProduction).toBe(38000);
    expect(payload.balance).toBe(3000);
    expect(payload.consumption).toBe(35000);
    expect(payload.updatedAt).toBe('2026-05-27T12:00:00Z');
    expect(payload.production).toHaveLength(3);
    expect(payload.production[0]).toMatchObject({ key: 'nucleaire', value: 30000 });
  });
});