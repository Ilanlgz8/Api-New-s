import useSWR from 'swr';
import { fetcher } from '@/lib/fetcher';
import { REFRESH, SWR_DEFAULTS } from '@/lib/constants';

export function useWeather(lat?: number, lon?: number, city?: string) {
  const params = city
    ? `city=${encodeURIComponent(city)}`
    : `lat=${lat ?? process.env.NEXT_PUBLIC_DEFAULT_LAT}&lon=${lon ?? process.env.NEXT_PUBLIC_DEFAULT_LON}`;

  return useSWR(`/api/weather?${params}`, fetcher, {
    ...SWR_DEFAULTS,
    refreshInterval: REFRESH.WEATHER,
    revalidateOnMount: true,
  });
}