import { withCache } from './cache';

async function fetchText(url: string, timeout = 5000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) }).catch(() => null);
  if (!res || !res.ok) return null;
  return res.text().catch(() => null);
}

async function fetchRobotsTxtAllows(url: string) {
  try {
    const u = new URL(url);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    const txt = await withCache(`robots:${u.host}`, 60 * 60, async () => {
      const t = await fetchText(robotsUrl, 3000);
      return t ?? '';
    });
    const content = typeof txt === 'string' ? txt : (txt as any).data ?? '';
    const lines = content.split('\n').map((l: string) => l.trim());
    let inBlock = false;
    const disallows: string[] = [];
    for (const l of lines) {
      if (!l) continue;
      const low = l.toLowerCase();
      if (low.startsWith('user-agent:')) {
        inBlock = low.includes('*');
        continue;
      }
      if (!inBlock) continue;
      if (low.startsWith('disallow:')) {
        const path = l.split(':').slice(1).join(':').trim();
        if (path) disallows.push(path);
      }
    }
    const path = new URL(url).pathname;
    for (const d of disallows) {
      if (d === '/') return false;
      if (d && path.startsWith(d)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

function parseRssItems(xml: string) {
  const items: any[] = [];
  const itemRegex = /<item[\s\S]*?<\/item>/gi;
  const matches = xml.match(itemRegex) || [];
  for (const m of matches) {
    const title = (m.match(/<title>([\s\S]*?)<\/title>/i) || [null, ''])[1].replace(/<[^>]+>/g, '').trim();
    const date = (m.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [null, ''])[1];
    const desc = (m.match(/<description>([\s\S]*?)<\/description>/i) || [null, ''])[1] || '';
    items.push({ title, date, desc });
  }
  return items;
}

export async function fetchRssFeed(url: string) {
  const allowed = await fetchRobotsTxtAllows(url);
  if (!allowed) return [];
  const cacheKey = `rss:${url}`;
  const { data } = await withCache(cacheKey, 10 * 60, async () => {
    const txt = await fetchText(url, 4000);
    if (!txt) return [];
    const items = parseRssItems(txt);
    return items;
  });
  return data as any[];
}

const COMP_WIKI_SLUG: Record<string, string> = {
  FL1: '2025%E2%80%9326_Ligue_1',
  PL: '2025%E2%80%9326_Premier_League',
  PD: '2025%E2%80%9326_La_Liga',
  SA: '2025%E2%80%9326_Serie_A',
  BL1: '2025%E2%80%9326_Bundesliga',
  CL: '2025%E2%80%9326_UEFA_Champions_League',
};

export async function fetchWikipediaCompetition(code: string, startOffset: number, endOffset: number) {
  const slug = COMP_WIKI_SLUG[code];
  if (!slug) return [];
  const url = `https://en.wikipedia.org/wiki/${slug}`;
  const allowed = await fetchRobotsTxtAllows(url);
  if (!allowed) return [];
  const cacheKey = `wiki:${code}:${startOffset}:${endOffset}`;
  const { data } = await withCache(cacheKey, 60 * 60, async () => {
    const html = await fetchText(url, 5000);
    if (!html) return [];
    const events: any[] = [];

    // Look for table rows that contain two cells (date/teams or teams/score)
    const rows = Array.from(html.matchAll(/<tr[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?(?:<td[^>]*>([\s\S]*?)<\/td>)?/gi)).slice(0, 500);
    for (const r of rows) {
      const leftRaw = (r[1] || '').replace(/<sup[\s\S]*?<\/sup>/gi, '');
      const rightRaw = (r[2] || '').replace(/<sup[\s\S]*?<\/sup>/gi, '');
      const extraRaw = (r[3] || '').replace(/<sup[\s\S]*?<\/sup>/gi, '');
      const left = leftRaw.replace(/<[^>]+>/g, '').trim();
      const right = rightRaw.replace(/<[^>]+>/g, '').trim();
      const extra = extraRaw.replace(/<[^>]+>/g, '').trim();

      // Try to find an ISO date in the row (some Wikipedia tables include machine-readable dates)
      const dateMatchISO = (left.match(/([0-9]{4}-[0-9]{2}-[0-9]{2})/) || right.match(/([0-9]{4}-[0-9]{2}-[0-9]{2})/) || extra.match(/([0-9]{4}-[0-9]{2}-[0-9]{2})/)) || [];
      const dateMatch = dateMatchISO[0] ?? null;

      // Fallback: look for a yyyy or month names pattern (best-effort); if none, skip row
      if (!dateMatch) continue;

      const combined = `${left} ${right} ${extra}`.replace(/\s+/g, ' ').trim();

      // Try to extract score like '2–1' or '2-1' or HTML entity variants
      const scoreRegex = /(\d{1,2})\s*(?:–|-|—|&#8211;|&ndash;|−)\s*(\d{1,2})/;
      const scoreMatch = combined.match(scoreRegex);
      const homeScore = scoreMatch ? Number(scoreMatch[1]) : null;
      const awayScore = scoreMatch ? Number(scoreMatch[2]) : null;

      // Try to split teams by common separators
      let teams = combined;
      const vsSplit = combined.split(/\s+v[s]?\.?\s+|\s+vs\.?\s+|\s+–\s+|\s+-\s+/i);
      let home = teams;
      let away = '';
      if (vsSplit.length >= 2) {
        home = vsSplit[0].trim();
        away = vsSplit[1].trim();
      }

      const utcDate = `${dateMatch}T00:00:00Z`;
      const status = homeScore !== null && awayScore !== null ? 'FINISHED' : 'SCHEDULED';

      events.push({
        id: `wiki:${code}:${dateMatch}:${home}::${away}`,
        utcDate,
        homeTeam: { name: home },
        awayTeam: { name: away },
        competition: { code },
        status,
        score: {
          fullTime: { home: homeScore, away: awayScore },
        },
      });
    }
    
    return events;
  });
  return data as any[];
}

export default {};
