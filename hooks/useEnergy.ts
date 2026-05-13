import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { REFRESH, SWR_DEFAULTS } from '@/lib/constants';

export function useEnergy() {
  return useSWR('/api/energy', fetcher, {
    ...SWR_DEFAULTS,
    refreshInterval: REFRESH.ENERGY,
  });
}
