import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { REFRESH, SWR_DEFAULTS } from '@/lib/constants';
import type { CryptoApiResponse } from '@/lib/cryptoTypes';

export function useCrypto() {
  return useSWR<CryptoApiResponse>('/api/crypto', fetcher, {
    ...SWR_DEFAULTS,
    refreshInterval: REFRESH.CRYPTO,
  });
}
