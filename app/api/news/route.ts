import { NextResponse } from 'next/server';
import { withCache, CACHE_TTL } from '@/lib/cache';
import { errorMessage } from '@/lib/apiRouteError';
import type { NewsArticle, NewsApiResponse, NewsCountry } from '@/lib/newsTypes';

export const runtime = 'nodejs';

const RSS_SOURCES: Record<string, { url: string; name: string }[]> = {
  fr: [
    { url: 'https://www.lemonde.fr/rss/une.xml',          name: 'Le Monde'    },
    { url: 'https://www.lefigaro.fr/rss/figaro_actualites.xml', name: 'Le Figaro' },
    { url: 'https://feeds.leparisien.fr/leparisien/rss',  name: 'Le Parisien' },
  ],
  us: [
    { url: 'https://feeds.bbci.co.uk/news/rss.xml',       name: 'BBC News'    },
    { url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', name: 'NY Times' },
  ],
};

async function fetchRss(url: string, sourceName: string): Promise<NewsArticle[]> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Dashboard/1.0)' },
  }).catch(() => null);
  if (!res?.ok) return [];

  const xml = await res.text();

  // Parse XML à la main — pas de lib nécessaire
  const items = Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/g), m => m[1]);

  return items.slice(0, 5).map(item => {
    const get = (tag: string) => {
      const m = item.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return m?.[1]?.trim() ?? '';
    };
    const imgMatch = item.match(/url="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i)
      ?? item.match(/<media:thumbnail[^>]+url="([^"]+)"/i)
      ?? item.match(/<enclosure[^>]+url="([^"]+\.(?:jpg|jpeg|png))"/i);

    return {
      title:       get('title').replace(/<[^>]+>/g, ''),
      url:         get('link') || get('guid'),
      urlToImage:  imgMatch?.[1] ?? null,
      publishedAt: get('pubDate'),
      source:      { name: sourceName },
    };
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const country = (searchParams.get('country') ?? 'fr') as NewsCountry;

  try {
    const { data, fromCache, age } = await withCache<NewsApiResponse>(`news:${country}`, CACHE_TTL.news, async () => {
      // Si clé NewsAPI dispo on l'utilise en priorité
      if (process.env.NEWS_API_KEY) {
        const res = await fetch(
          `https://newsapi.org/v2/top-headlines?country=${country}&pageSize=12&apiKey=${process.env.NEWS_API_KEY}`
        );
        if (res.ok) return res.json();
      }

      // Sinon : RSS direct, sans clé, sans intermédiaire
      const sources = RSS_SOURCES[country] ?? RSS_SOURCES.fr;
      const allArticles = await Promise.all(
        sources.map(s => fetchRss(s.url, s.name))
      );

      const articles = allArticles.flat()
        .sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime())
        .slice(0, 12);

      console.log(`📰 News RSS: ${articles.length} articles (${country})`);
      return { articles };
    });

    return NextResponse.json(data, {
      headers: { 'X-Cache': fromCache ? `HIT age=${age}s` : 'MISS' },
    });
  } catch (error: unknown) {
    console.error('News error:', errorMessage(error));
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
