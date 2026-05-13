import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { REFRESH, SWR_DEFAULTS } from '@/lib/constants';

export function useNews(country: 'fr' | 'us' | 'gb' = 'fr') {
  return useSWR(`/api/news?country=${country}`, fetcher, {
    ...SWR_DEFAULTS,
    refreshInterval: REFRESH.NEWS,
  });
}
