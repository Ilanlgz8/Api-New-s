# 🚀 Dashboard Temps Réel

Dashboard Next.js 14 avec météo, crypto, énergie, football et actualités.

## Stack technique

- **Next.js 14** App Router + TypeScript
- **SWR** pour le fetching optimisé (cache, revalidation, déduplication)
- **Recharts** pour les graphiques
- **Tailwind CSS** pour le style
- **Edge Runtime** sur les routes API (plus rapide, moins de RAM)

## Optimisations clés (vs ton ancien projet)

| Problème | Solution appliquée |
|---|---|
| Re-renders en cascade | `React.memo` sur tous les widgets |
| Polling trop agressif | Intervalles différenciés par source |
| Clés API exposées | Routes proxy côté serveur |
| Fetches séquentiels | `Promise.all` partout |
| Fuites mémoire | SWR gère le cleanup automatiquement |
| Bundle trop lourd | `dynamic()` + lazy loading par widget |

## Intervalles de rafraîchissement

| Source | Intervalle | Pourquoi |
|---|---|---|
| Météo | 10 min | Données lentes à changer |
| Crypto | 30 s | Volatile mais pas besoin de moins |
| Énergie RTE | 5 min | Fréquence de publication RTE |
| Football live | 20 s en live / 15 min hors live | Réactif quand il y a un match, économe sinon |
| Football programme | 1 h | Stable dans la journée |
| Actualités | 15 min | Raisonnable pour les news |

## Football live

- `SOFASCORE_ENABLED=true` active l'enrichissement live Sofascore pour les matchs en direct. C'est le comportement par défaut, sauf si tu mets `false` ou `0`.
- `FOOTBALL_POLLER_LIVE_INTERVAL` règle l'intervalle en secondes quand il y a du live.
- `FOOTBALL_POLLER_IDLE_INTERVAL` règle l'intervalle en secondes quand il n'y a pas de live.
- Si Sofascore ne répond pas ou renvoie zéro donnée exploitable, le poller se met en pause automatiquement pendant un moment et retombe sur les données football-data + consensus d'odds.

## Installation

```bash
# 1. Installer les dépendances
npm install

# 2. Copier et remplir les variables d'environnement
cp .env.local.example .env.local
# Édite .env.local avec tes clés

# 3. Lancer en développement
npm run dev
```

## Obtenir les clés API

### OpenWeatherMap (Météo) — Gratuit
→ https://openweathermap.org/api
→ Crée un compte, copie la clé dans "My API keys"

### CoinGecko (Crypto) — Gratuit sans clé
→ https://www.coingecko.com/api/documentation
→ Optionnel : crée un compte pour la clé Demo (limite plus haute)

### RTE Open Data (Énergie France) — Gratuit
→ https://data.rte-france.com
→ Crée une app, récupère Client ID + Client Secret
→ Active les APIs : "Consumption", "Actual Generation"

### API-Football via RapidAPI (Football) — 100 req/jour gratuit
→ https://rapidapi.com/api-sports/api/api-football
→ Subscribe au plan Free, copie la RapidAPI Key
→ Utilisee pour stats detaillees (possession, tirs, fautes, cartons) et compositions de match quand dispo

### NewsAPI (Actualités) — Gratuit pour dev
→ https://newsapi.org
→ Crée un compte, copie la clé

## Structure du projet

```
dashboard/
├── app/
│   ├── api/               # Routes proxy (clés côté serveur)
│   │   ├── weather/
│   │   ├── crypto/
│   │   ├── energy/
│   │   ├── football/
│   │   └── news/
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx           # Dashboard principal
├── components/
│   ├── ui/                # Card, Skeleton, ErrorCard
│   └── widgets/           # Un fichier par source de données
├── hooks/                 # Un hook SWR par source
├── lib/
│   ├── constants.ts       # Intervalles de refresh, config
│   └── fetcher.ts         # Fetcher SWR générique
└── .env.local.example
```
