# Keycloak — identité centralisée

Ce dossier versionne ce qui vivait jusqu'ici hors dépôt, sur le serveur :
une réinstallation aurait tout perdu.

## Ce qu'il contient

| Fichier | Rôle |
|---|---|
| `compose.yml` | l'instance et sa base |
| `realm-topcenter.json` | realm, rôles, client, SMTP — **sans les secrets** |
| `themes/topcenter/` | l'écran de connexion aux couleurs du produit |

Les secrets vivent dans `/opt/keycloak/.env`, qui n'est pas versionné :
`KC_DB_PASSWORD`, `KC_ADMIN_USER`, `KC_ADMIN_PASSWORD`, `KC_SMTP_PASSWORD`,
`KC_CLIENT_SECRET_SMI`. Le realm y renvoie par `${env.…}`.

## Remonter l'instance

```sh
mkdir -p /opt/keycloak/import
cp compose.yml /opt/keycloak/
cp realm-topcenter.json /opt/keycloak/import/
cp -r themes /opt/keycloak/
# créer /opt/keycloak/.env avec les cinq secrets, puis :
cd /opt/keycloak && docker compose up -d
```

Le realm s'importe au démarrage. Pour **réimporter** un realm existant, il
faut la commande explicite — `--import-realm` ignore ce qui existe déjà :

```sh
docker compose stop keycloak
docker compose run --rm --no-deps keycloak import \
  --file /opt/keycloak/data/import/realm-topcenter.json --override true
docker compose up -d
```

Attention : `--override` **supprime le realm avant de le réimporter**. Les
mots de passe des comptes sont perdus ; chacun doit le redéfinir.

## Ce qui se règle ailleurs

- **nginx** : `auth.topcenter.cg` proxie vers `127.0.0.1:8180`. Les en-têtes
  `X-Forwarded-*` ne sont pas décoratifs — sans eux Keycloak fabrique ses URL
  de redirection en `http` avec le port interne, et la connexion échoue.
  La console d'administration est fermée côté web : elle ne s'ouvre que par
  tunnel SSH sur 8180.
- **SMI** : quatre variables `OIDC_*` dans son `.env`, **et** quatre lignes
  dans son `docker-compose.yml`. Le compose déclare chaque variable
  explicitement : sans ces lignes, celles du `.env` n'atteignent jamais
  l'application et les routes restent fermées en 503 sans rien expliquer.

## Le thème

`themes/topcenter/` reprend les couleurs, la typographie et les libellés de
l'écran de connexion du produit : bleu `#0F2A96`, accent `#1A50D9`, orange
`#F47C17`, police Inter. Les libellés viennent de `frontend/index.html` ;
aucun n'a été inventé.

La mise en page à deux volets de l'écran d'origine **n'est pas reproduite** :
elle demanderait de surcharger le gabarit de Keycloak, donc d'en figer une
copie à resynchroniser à chaque mise à jour. Tenté le 11/09/2026, écarté —
surcharger le gabarit du thème `base` casse le chargement des feuilles de
style, et le bon parent est `keycloak.v2`.
