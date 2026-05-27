# FL1 Results Auto-Refresh

Automatise la pré-récupération des résultats Ligue 1 et la persistance dans le snapshot.

## Script

Fichier: `scripts/refresh-fl1-results.sh`

Le script appelle l'endpoint `POST /api/football/refresh-results/targeted` toutes les X minutes et enregistre les résultats dans `fl1-refresh.log`.

## Installation

### 1. Configuration (optionnel)

Définir des variables d'environnement (facultatif, sinon les défauts s'appliquent) :

```bash
export API_BASE="http://localhost:3001"           # Base URL (défaut: localhost:3001)
export ADMIN_REFRESH_SECRET="your-secret-here"    # Si protection activée
export DAYS_BACK=30                                # Fenêtre (défaut: 30 jours)
export LOG_FILE="/path/to/fl1-refresh.log"         # Log file (défaut: ./fl1-refresh.log)
```

### 2. Test unique

```bash
/path/to/scripts/refresh-fl1-results.sh
```

Vérifier le log :
```bash
tail -f fl1-refresh.log
```

### 3. Setup crontab (automatique toutes les 30 min)

Éditer la crontab :
```bash
crontab -e
```

Ajouter la ligne (remplacer `/path/to` par le chemin absolu du projet) :

```bash
*/30 * * * * /path/to/Api-New-s-master/scripts/refresh-fl1-results.sh
```

Variantes courantes :
- `*/15 * * * *` — toutes les 15 minutes
- `0 */6 * * *` — toutes les 6 heures
- `0 3 * * *` — chaque jour à 3h du matin

Vérifier les crons actifs :
```bash
crontab -l
```

### 4. Logs

Le script enregistre chaque exécution dans `fl1-refresh.log` (relatif au projet).

Exemple de log réussi :
```
[2026-05-18 09:52:40] Starting FL1 refresh (window: -30→0)...
[2026-05-18 09:52:42] ✓ FL1 refresh complete: 0 FL1 matches, 24 total (merged snapshot)
```

Exemple d'erreur :
```
[2026-05-18 10:00:00] Starting FL1 refresh (window: -30→0)...
[2026-05-18 10:00:01] ERROR: API returned failure
[2026-05-18 10:00:01] Response: {...}
```

## Comportement

- **Succès** : Appelle l'API ciblée, fusionne les résultats FL1, écrit le snapshot.
- **Échec** : Enregistre l'erreur dans le log. Aucun snapshot n'est modifié (sûr).
- **Fenêtre par défaut** : 30 jours (cherche les matchs FINISHED entre -30 et maintenant).
- **Sécurité** : Si `ADMIN_REFRESH_SECRET` est défini, l'en-tête `x-admin-secret` est envoyé automatiquement.

## Désactiver / Supprimer

Pour arrêter les exécutions automatiques :

```bash
crontab -e
# Commenter ou supprimer la ligne du script
```

## Troubleshooting

**Log empty / endpoint non réactif**
- Vérifier que le dev server est actif : `curl -s http://localhost:3001/api/football?type=results | jq '.competitions | length'`
- Vérifier les logs du serveur : `tail /tmp/next-dev.log`

**Curl timeout**
- Augmenter le timeout (modérer dans le script si besoin)
- Vérifier la connectivité réseau / firewall

**Aucun match FL1 même après plusieurs exécutions**
- Les sources en amont (TSDB, football-data, etc.) n'ont pas de matches FINISHED pour la fenêtre.
- Élargir la fenêtre : `DAYS_BACK=60 /path/to/scripts/refresh-fl1-results.sh`
- Vérifier les logs du serveur pour voir quelles sources ont été tentées.
