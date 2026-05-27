**Résumé des changements**
- **Contexte**: Décomposition de l'orchestrateur `app/api/football/route.ts` en modules source-spécifiques, amélioration des tests et consolidation des constantes.
- **Objectif**: Rendre le code plus testable, réduire la surface des effets de bord et faciliter l'ajout/retrait de fournisseurs de données.

**Fichiers modifiés / ajoutés**
- **Libs extraites / créées**: [lib/footballFootballData.ts](lib/footballFootballData.ts), [lib/footballSportsDb.ts](lib/footballSportsDb.ts), [lib/footballOddsProviders.ts](lib/footballOddsProviders.ts), [lib/footballOdds.ts](lib/footballOdds.ts), [lib/footballConstants.ts](lib/footballConstants.ts)
- **Sofascore / Flashscore**: [lib/sofascoreLive.ts](lib/sofascoreLive.ts), [lib/flashscoreLive.ts](lib/flashscoreLive.ts)
- **API orchestrateur**: [app/api/football/route.ts](app/api/football/route.ts)
- **Tests ajoutés / modifiés**: `tests/sofascore.test.ts`, `tests/flashscore.test.ts`, `tests/footballSportsDb.test.ts`, `tests/footballOdds.test.ts`, etc.

**Principales fonctions / exports extraits**
- TheSportsDB: `fetchSportsDbCompetitionSeasonEvents`, `mapSportsDbMatch`, `fetchSportsDbWindow`
- Football-Data / API-Football: `fetchFootballDataCompetitionEvents`, `fetchApiFootballLiveMatches`, `mapApiFootballMatch`
- Odds: `fetchApiFootballOddsFL1`, `fetchTheOddsApiForSport`, `getOddsByCompetition`
- Sofascore: `fetchSofascoreLiveMatches`, `fetchSofascoreFinishedMatches`, `fetchSofascoreFinishedMatchesForCompetition`, `fetchSofascoreCompetitionWindow`, `mapSofascoreMatch`, plus test helper `__fetchSofascoreJson`
- Flashscore: `mapFlashscoreMatch` and live helpers

**Pourquoi ces changements**
- Isolation des appels réseau et des mappers pour permettre des tests unitaires simples.
- Centralisation des constantes (`lib/footballConstants.ts`) pour éviter références dispersées.
- Meilleure résilience du routeur principal via fallback et priorisation des sources.

**Comment tester localement**
```bash
# installer dépendances (si nécessaire)
npm install

# lancer les tests unitaires
npm test -- --run

# build production (vérifie types & build Next.js)
npm run build
```

**Checklist pour la revue de PR**
- **Types**: vérifier qu'aucun `any` inutile n'a été introduit.
- **Cache**: valider clés TTL / invalidation (`withCache` usages).
- **Secrets**: s'assurer que les clés RapidAPI / Odds API ne sont pas en dur.
- **Fallbacks**: tester scénarios offline (source indisponible) via mocks.
- **Performance**: vérifier appels parallèles et sur-sollicitations d'API externes.

**Prochaine étape proposée**
- Ouvrir une branche dédiée, engager les changements et créer la PR. Je peux ouvrir la branche, committer et pousser si vous voulez.

---
*Généré automatiquement — dites-moi si vous voulez un résumé de diff par fonction extraite.*
