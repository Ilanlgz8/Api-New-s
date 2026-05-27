import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { REFRESH, SWR_DEFAULTS } from '@/lib/constants';
import type { EnergyApiResponse } from '@/lib/energyTypes';

export function useEnergy() {
  return useSWR<EnergyApiResponse>('/api/energy', fetcher, {
    ...SWR_DEFAULTS,
    refreshInterval: REFRESH.ENERGY,
  });
}
