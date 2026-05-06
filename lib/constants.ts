// ─── Intervalles de rafraîchissement (en ms) ───────────────────────────────
// Bien espacés pour éviter de surchauffer le CPU
export const REFRESH = {
  WEATHER: 10 * 60 * 1000,        // 10 min — météo change pas toutes les secondes
  CRYPTO: 30 * 1000,               // 30s — crypto est volatile
  ENERGY: 5 * 60 * 1000,          // 5 min — données RTE toutes les 5min
  FOOTBALL_LIVE: 60 * 1000,        // 60s — refresh client sur store serveur, sans spammer l'API
  FOOTBALL_SCHEDULE: 60 * 60 * 1000, // 1h — programme des matchs
  NEWS: 15 * 60 * 1000,           // 15 min — actu
} as const;

// ─── Cryptos à suivre ───────────────────────────────────────────────────────
export const CRYPTO_IDS = [
  'bitcoin',
  'ethereum',
  'solana',
  'binancecoin',
  'ripple',
] as const;

// ─── Ligues football ────────────────────────────────────────────────────────
export const FOOTBALL_LEAGUES = {
  LIGUE_1: 61,
  CHAMPIONS_LEAGUE: 2,
  EUROPA_LEAGUE: 3,
  WORLD_CUP: 1,
} as const;

// ─── SWR options partagées ──────────────────────────────────────────────────
export const SWR_DEFAULTS = {
  revalidateOnFocus: false,      // pas de refetch quand on revient sur l'onglet
  revalidateOnReconnect: true,   // refetch à la reconnexion réseau
  shouldRetryOnError: true,
  errorRetryCount: 3,
  errorRetryInterval: 5000,
} as const;
