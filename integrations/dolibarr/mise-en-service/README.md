# Mise en service de Dolibarr pour Tala SMI

ADR 0002 : Dolibarr fait foi pour la comptabilité et n'est jamais montré.
Décision du 29/09/2026 : Top Center a sa propre société (entité) dans le
Dolibarr de production, qu'il partage avec un autre projet. **L'entité 1
appartient à cet autre projet : aucun script d'ici ne l'accepte.**

Dolibarr sait tenir plusieurs sociétés sans le module externe MultiCompany :
colonne `entity` partout, `DOLENTITY` en ligne de commande, en-tête
`DOLAPIENTITY` dans l'API. Il faut seulement recopier les référentiels à la
création de l'entité ; `creer-entite.php` le fait.

## Ordre

```sh
# 1. Entité, référentiels, modules, plan SYSCOHADA-CG, CAISSE 5711, BCH 5211,
#    exercice de l'année. Compare l'empreinte de l'entité 1 avant et après.
CONTENEUR=dolibarr-prod ENTITE=2 sh integrations/dolibarr/mise-en-service/mettre-en-service.sh

# 2. Utilisateur d'API « tala-smi » et sa clé, écrits dans le .env de Tala SMI
#    sans être affichés. À lancer par une personne.
CONTENEUR=dolibarr-prod ENTITE=2 ENV=/opt/projet-smi/.env \
  sh integrations/dolibarr/mise-en-service/creer-utilisateur-api.sh

# 3. Tâche du grand livre de l'entité (voir ../grand-livre/README.md).
#    */5 * * * * root CONTENEUR=dolibarr-prod ENTITE=2 sh /opt/smi-dolibarr/grand-livre/grand-livre-auto.sh

# 4. Déployer Tala SMI : docker-compose.yml relie le conteneur au réseau
#    dolibarr-production_dolibarr_prod_net et transmet DOLIBARR_ENTITE.
```

## Ce que chaque script garantit

| Script | Garantie |
|---|---|
| `mettre-en-service.sh` | refuse `ENTITE` < 2 ; sort en erreur si l'empreinte de l'entité 1 change |
| `empreinte.php` | lecture seule : nombre de lignes et somme de contrôle par table, pour une entité et pour l'entité 0 |
| `creer-entite.php` | recopie journaux, modes et conditions de paiement, TVA, sous-types de facture depuis l'entité 1 ; ne l'écrit jamais |
| `configurer-entite.php` | mêmes réglages que le bac à sable, écrits dans l'entité visée seulement ; idempotent |
| `creer-utilisateur-api.php/.sh` | pas de mot de passe ; droits « mouvements comptables : lire, créer » seulement ; refuse si une clé existe déjà ; sauvegarde le `.env` avant de l'écrire |

## Répétition

Répété le 29/09/2026 sur `dolibarr-sandbox`, entité 3 : empreinte de
l'entité 1 identique, relance sans effet, clé acceptée dans l'entité 3
(`/smi/etat` 200) et refusée dans l'entité 1 (401).

## À savoir

- `custom/` de `dolibarr-prod` est un volume anonyme : il survit à un
  redémarrage et à une recréation par `docker compose up`, pas à un
  `docker compose down`. Relancer l'étape 1 réinstalle le module.
- Le réseau de Dolibarr contient aussi sa base de données : le conteneur de
  Tala SMI peut la joindre, sans en avoir les identifiants.
- Remplacer la clé coupe Tala SMI jusqu'au déploiement suivant : retirer
  `DOLIBARR_API_KEY` du `.env` et la clé de l'utilisateur, puis relancer
  l'étape 2.
