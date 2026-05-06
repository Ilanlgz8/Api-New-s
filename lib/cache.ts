// ─── Cache serveur en mémoire ────────────────────────────────────────────────
// Next.js tourne en Node.js persistant → ce cache survit entre les requêtes
// Le client peut appeler /api/crypto toutes les 30s, le serveur lui
// ne contacte CoinGecko qu'une fois toutes les TTL secondes max.

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  fetchedAt: number;
}

const store = new Map<string, CacheEntry<any>>();

export function getCacheEntry<T>(key: string): CacheEntry<T> | undefined {
  return store.get(key) as CacheEntry<T> | undefined;
}

export function deleteCacheEntry(key: string) {
  return store.delete(key);
}

export function setCacheEntry<T>(
  key: string,
  data: T,
  ttl: number,
  fetchedAt = Date.now()
) {
  store.set(key, {
    data,
    expiresAt: fetchedAt + ttl * 1000,
    fetchedAt,
  });
}

// TTL par source (en secondes) — ajuste selon ta limite gratuite
export const CACHE_TTL = {
  weather:          10 * 60,   // 10 min  → OpenWeather free = 1000 req/jour → largement ok
  crypto:           60,        // 1 min   → CoinGecko free = 30 req/min
  energy:           5 * 60,    // 5 min   → RTE publie toutes les 5min de toute façon
  football_live:    45,        // 45s     → API-Football free = 100 req/jour (économise !)
  football_today:   60 * 60,   // 1h      → programme stable
  football_results: 5 * 60,    // 5 min
  football_week:    8 * 24 * 60 * 60, // 8 jours → couvre toute la semaine suivante
  news:             15 * 60,   // 15 min  → NewsAPI free = 100 req/jour
} as const;

/**
 * Récupère depuis le cache ou appelle `fetcher` si expiré.
 * @param key      Clé unique du cache
 * @param ttl      Durée de vie en secondes
 * @param fetcher  Fonction async qui fait l'appel API réel
 */
export async function withCache<T>(
  key: string,
  ttl: number,
  fetcher: () => Promise<T>
): Promise<{ data: T; fromCache: boolean; age: number }> {
  const now = Date.now();
  const entry = store.get(key);

  // Cache hit valide
  if (entry && entry.expiresAt > now) {
    return {
      data: entry.data,
      fromCache: true,
      age: Math.round((now - entry.fetchedAt) / 1000),
    };
  }

  // Cache miss ou expiré → appel réel
  const data = await fetcher();
  setCacheEntry(key, data, ttl, now);

  return { data, fromCache: false, age: 0 };
}

export async function withStaleCache<T>(
  key: string,
  ttl: number,
  fetcher: () => Promise<T>,
  fallback: T
): Promise<{ data: T; fromCache: boolean; age: number; stale: boolean }> {
  const now = Date.now();
  const entry = store.get(key);

  if (entry && entry.expiresAt > now) {
    return {
      data: entry.data,
      fromCache: true,
      age: Math.round((now - entry.fetchedAt) / 1000),
      stale: false,
    };
  }

  try {
    const data = await fetcher();
    setCacheEntry(key, data, ttl, now);
    return { data, fromCache: false, age: 0, stale: false };
  } catch {
    if (entry) {
      return {
        data: entry.data,
        fromCache: true,
        age: Math.round((now - entry.fetchedAt) / 1000),
        stale: true,
      };
    }

    return {
      data: fallback,
      fromCache: false,
      age: 0,
      stale: true,
    };
  }
}

// Nettoyage périodique pour éviter les fuites mémoire
// (toutes les heures, supprime les entrées expirées)
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    Array.from(store.entries()).forEach(([key, entry]) => {
      if (entry.expiresAt < now) store.delete(key);
    });
  }, 60 * 60 * 1000);
}
