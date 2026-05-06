import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { REFRESH, SWR_DEFAULTS } from '@/lib/constants';

export function useFootball() {
  // Matchs en direct
  const live = useSWR('/api/football?type=live', fetcher, {
    ...SWR_DEFAULTS,
    keepPreviousData: true,
    refreshInterval: REFRESH.FOOTBALL_LIVE,
  });

  // Programme du jour
  const today = useSWR('/api/football?type=today', fetcher, {
    ...SWR_DEFAULTS,
    keepPreviousData: true,
    refreshInterval: REFRESH.FOOTBALL_SCHEDULE,
  });

  // Résultats du jour
  const results = useSWR('/api/football?type=results', fetcher, {
    ...SWR_DEFAULTS,
    keepPreviousData: true,
    refreshInterval: REFRESH.FOOTBALL_SCHEDULE,
  });

  return { live, today, results };
}
