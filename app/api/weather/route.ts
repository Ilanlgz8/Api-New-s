import { NextResponse } from 'next/server';
import { withCache, CACHE_TTL } from '@/lib/cache';
import { errorMessage } from '@/lib/apiRouteError';
import type { WeatherApiResponse } from '@/lib/weatherTypes';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = searchParams.get('lat') ?? process.env.NEXT_PUBLIC_DEFAULT_LAT;
  const lon = searchParams.get('lon') ?? process.env.NEXT_PUBLIC_DEFAULT_LON;
  const city = searchParams.get('city');

  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'Clé API manquante' }, { status: 500 });

  const cacheKey = `weather:${city ?? `${lat},${lon}`}`;

  try {
    const { data, fromCache, age } = await withCache<WeatherApiResponse>(cacheKey, CACHE_TTL.weather, async () => {
      const baseUrl = 'https://api.openweathermap.org/data/2.5';
      const params = city ? `q=${city}` : `lat=${lat}&lon=${lon}`;
      const common = `${params}&appid=${apiKey}&units=metric&lang=fr`;

      const [currentRes, forecastRes] = await Promise.all([
        fetch(`${baseUrl}/weather?${common}`),
        fetch(`${baseUrl}/forecast?${common}&cnt=8`),
      ]);

      if (!currentRes.ok) throw new Error(`OpenWeather ${currentRes.status}`);

      const [current, forecast] = await Promise.all([
        currentRes.json(),
        forecastRes.ok ? forecastRes.json() : null,
      ]);

      return { current, forecast };
    });

    return NextResponse.json(data, {
      headers: { 'X-Cache': fromCache ? `HIT age=${age}s` : 'MISS' },
    });
  } catch (error: unknown) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
