export type EnergySourceKey =
  | 'nucleaire'
  | 'eolien'
  | 'solaire'
  | 'hydraulique'
  | 'thermique'
  | 'bioenergies';

export type EnergySource = {
  key: EnergySourceKey;
  label: string;
  color: string;
  value: number;
};

export type EnergyApiResponse = {
  production: EnergySource[];
  totalProduction: number;
  consumption: number;
  exports: number;
  imports: number;
  balance: number;
  updatedAt: string;
};

export type OdreRecord = Partial<Record<EnergySourceKey | 'consommation' | 'ech_comm_exportations' | 'ech_comm_importations' | 'date_heure', number | string | null | undefined>>;
