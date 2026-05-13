import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { REFRESH, SWR_DEFAULTS } from '@/lib/constants';

export function useCrypto() {
  return useSWR('/api/crypto', fetcher, {
    ...SWR_DEFAULTS,
    refreshInterval: REFRESH.CRYPTO,
  });
}
