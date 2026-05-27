import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { REFRESH, SWR_DEFAULTS } from '@/lib/constants';
import type { NewsApiResponse, NewsCountry } from '@/lib/newsTypes';

export function useNews(country: NewsCountry = 'fr') {
  return useSWR<NewsApiResponse>(`/api/news?country=${country}`, fetcher, {
    ...SWR_DEFAULTS,
    refreshInterval: REFRESH.NEWS,
  });
}
