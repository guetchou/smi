# ⛔ DANGER — LIRE AVANT TOUTE INTERVENTION SUR CE PROJET

## 🚨 INTERDICTIONS ABSOLUES — SUPPRESSION DE DONNÉES

> **Ces commandes DÉTRUISENT irrémédiablement toutes les données de production.**
> **Il n'existe AUCUN moyen de les récupérer sans backup.**

### COMMANDES INTERDITES EN PRODUCTION

```bash
# ❌ INTERDIT — Supprime le volume Docker et toute la base de données
docker compose down -v
docker compose down --volumes

# ❌ INTERDIT — Supprime manuellement le volume nommé
docker volume rm caisse-topcenter_caisse_data

# ❌ INTERDIT — Supprime tous les volumes non utilisés (dangereux en prod)
docker volume prune

# ❌ INTERDIT — Supprime tous les conteneurs + volumes
docker system prune -a --volumes
```

---

## ✅ COMMANDES AUTORISÉES

```bash
# ✅ Redémarrer le conteneur sans toucher aux données
docker-compose restart

# ✅ Rebuilder l'image ET redéployer SANS supprimer les données
docker-compose up -d --build

# ✅ Arrêter les conteneurs SANS supprimer les volumes
docker compose down
# (sans le flag -v)

# ✅ Voir les logs
docker-compose logs -f caisse
docker logs caisse-topcenter -f
```

---

## 🗄️ OÙ SONT LES DONNÉES ?

La base de données SQLite est persistée dans un **volume Docker nommé** :

| Volume Docker            | Chemin sur l'hôte                                              |
|--------------------------|----------------------------------------------------------------|
| `caisse-topcenter_caisse_data` | `/var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/` |

**Fichiers critiques :**
- `caisse.db` — base de données principale
- `caisse.db-wal` — journal de transactions (WAL)
- `caisse.db-shm` — mémoire partagée SQLite
- `uploads/` — pièces justificatives et photos

---

## 💾 PROCÉDURE DE BACKUP AVANT TOUTE INTERVENTION

```bash
# Backup manuel OBLIGATOIRE avant toute intervention risquée
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p /opt/backups/caisse-topcenter
cp /var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/caisse.db \
   /opt/backups/caisse-topcenter/caisse_${DATE}.db
echo "Backup créé : /opt/backups/caisse-topcenter/caisse_${DATE}.db"
```

---

## 🔄 DÉPLOIEMENT EN PRODUCTION

Le déploiement se fait **automatiquement via GitHub Actions** à chaque push sur `main`.

**NE PAS déployer manuellement**, sauf en cas de panne du CI/CD.
Si vous devez déployer manuellement :

```bash
cd /opt/caisse-topcenter
git pull origin main
docker compose up -d --build   # ← JAMAIS de -v ici !
```

---

## 📞 CONTACTS EN CAS DE DOUTE

Avant toute intervention sur la production, contactez le responsable technique.

**En cas de perte de données accidentelle :**
1. Arrêtez immédiatement tout (`docker-compose stop`)
2. Ne relancez PAS le conteneur
3. Consultez les backups dans `/opt/backups/caisse-topcenter/`
4. Contactez immédiatement l'équipe

---

*Ce fichier fait partie intégrante du projet. Ne pas supprimer.*
