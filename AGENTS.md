# Regles obligatoires pour agents IA
Aucune tache, action, travail ne doit s'exécuter sans /PRD && /plan

Obligations Avant de commencer il faut faire le scénario complet du fonctionnement en comparant avec les fonctionnalités, fonctions, fonctionnement des sites ou applications industrielles similaires &&  toujours vérifier après chaque que rien n'a été oublié, omis, se rassurer que tous les branchements sont effectués, il n y a pas de dettes de flux, workflow, synchonisation, intéractions, PAS d'incomplet

Un scinetifiique démontre par la preuve tu dois démontré par la preuve que rien n'a été oublié, omis, se rassurer que tous les branchements sont effectués, il n y a pas de dettes de flux, workflow, synchonisation, intéractions

Ces regles s'appliquent a tous les projets et serveurs utilises avec Codex ou Claude.
L'environnement est partage : plusieurs applications, conteneurs, bases de donnees,
reverse proxies et services systeme peuvent coexister. Agir avec prudence par defaut.

## Priorisation des regles

Les regles sont ordonnees par priorite absolue :
1. **Audit passif** — collecter l'etat sans modification
2. **Permissions et droits** (obligatoire) — verifier accès avant action
3. **Sauvegarde utile et rollback** — securiser uniquement ce qui est restaurable et pertinent
4. **Actions non-destructives** (permis immediatement) — modifications mineures et reversibles
5. **Actions potentiellement destructives** (requièrent validation explicite) — deletion, reset, drop, format
6. **Incertitude et escalade** (politique par defaut) — /grille-me

## 1. Audit indispensable avant toute modification

Avant de modifier un fichier, une configuration, une base de donnees, un conteneur,
un service ou un port, etablir une vision claire de l'existant :
- ports en ecoute et processus associes (`ss -ltnp`) ;
- services systeme pertinents (`systemctl status/is-active`) ;
- Docker : contexte actif, conteneurs, compose, volumes et ports publies ;
- Nginx, Apache/httpd, Traefik ou autre reverse proxy ;
- Git : branche, `git status`, fichiers modifies/non suivis, derniers commits si utile ;
- base de donnees : moteur, conteneur/service, schema/migrations, donnees critiques ;
- fichiers de configuration et `.env` sans exposer les secrets ;
- logs applicatifs, systeme, Docker/PM2/supervisor pertinents ;
- structure du projet, scripts disponibles, documentation locale.

Ne pas commencer par une hypothese. Lire l'environnement, puis diagnostiquer.

## 1.5 Permissions et droits d'acces (avant audit detaille)

**Si vous n'avez pas les droits requis** (lecture/ecriture/sudo sur fichiers, accès DB, permissions conteneur) :
- Lister precisement les permissions manquantes (fichier/chemin, type d'acces manquant) ;
- Demander au proprietaire du systeme/DB/conteneur d'obtenir ces droits ;
- NE JAMAIS entreprendre action necessitant privileges absents ;
- Documenter dans le rapport : "Audit interrompu—permissions manquantes : [liste]."

**Si l'espace disque est insuffisant** pour sauvegarde ou si la sauvegarde echoue :
- Arreter immediatement l'operation ;
- Documenter l'erreur exacte ;
- Proposer emplacements alternatifs (object storage, volume externe, autre partition) ;
- Obtenir validation utilisateur avant de poursuivre ;
- Ne jamais utiliser racine FS ou supprimer fichiers sans sauvegarde fonctionnelle.

## 2. Regles de securite non negociables — Actions permises vs interdites

### Actions INTERDITES sans validation explicite de l'utilisateur

- `rm -rf`, suppression de fichier ou dossier existant ;
- `git reset --hard`, `git clean`, checkout/revert destructif ;
- `docker prune`, suppression de volumes/images/reseaux ;
- `docker compose down` global ou sur un projet non clairement cible ;
- restart global de Nginx, Apache, Docker, PostgreSQL, MySQL/MariaDB, Redis, PM2 ou systemd critique ;
- migration destructive, truncate/drop/alter irreversibles, reinitialisation de donnees ;
- modification de firewall, DNS, certificats, cron, sauvegardes ou secrets.

### Regressions mesurables — Definition de "ne pas casser l'existant"

Toute modification **doit conserver** :
- Passage des tests CI existants (ou justifier echec mineur + plan correctif) ;
- Pas plus de 5 minutes d'indisponibilite non planifiee ;
- Stabilite des contrats API (versioning oblige si break) ;
- Integrité des donnees : aucune donnee modifiee/supprimee sans consentement explicite.

Si une regression est inevitably, proposer une fenetre de maintenance planifiee et notifier utilisateur.

### Actions non-destructives — Permises immediatement

- Rearrangement du code respectant patterns existants ;
- Ajout de tests supplementaires ;
- Ajout de documentation ou commentaires ;
- Correction de bugs sans modification API ;
- Refactor interne si tous les tests passent ;
- Ajout de logs/monitoring.

### En cas d'incertitude sur l'impact ou d'actions risquees

Produire un plan d'action hiérarchisé avec pour chaque action :
- (1) **Necessaire validation?** — oui/non + qui ;
- (2) **Est non-destructive?** — oui/non ;
- (3) **Peut executer immediatement?** — oui/non + conditions ;
- (4) **Alternative non-invasive** — si action risquee ;
- (5) **Liste des validations requises**.



## 3. Sauvegarde utile avant modification et rollback verifiable

### Sauvegarde de fichiers

La sauvegarde n'est pas un rituel automatique. Elle sert a proteger un etat
utile, restaurable et mieux connu que l'etat cible.

Avant toute modification, classer l'element concerne :
- **Fichier suivi par Git** : ne pas creer de copie `.bak`, `backup_*` ou
  dossier temporaire de sauvegarde. Le rollback officiel est le diff Git, le
  commit inverse (`git revert <hash>`) ou le patch inverse. Les copies
  temporaires occupent l'espace, vieillissent mal et creent de la confusion ;
- **Etat sain ou partiellement sain non suivi par Git** : faire une sauvegarde
  horodatee dans un emplacement clair (`backup_YYYYMMDD_HHMMSS_filename`) ;
- **Etat casse, incomplet, manquant, genere par erreur, doublon inutile ou non
  restaurable** : ne pas creer une fausse sauvegarde de reference ; documenter
  plutot le diagnostic, la correction et le rollback par Git ou patch inverse ;
- **Etat incertain** : arreter, auditer davantage, puis decider si la sauvegarde
  a une valeur de restauration.

Quand une sauvegarde est pertinente :
- Conserver permissions/proprietaire si pertinent ;
- Ne jamais ecraser une sauvegarde existante ;
- Noter le chemin de sauvegarde dans le rapport final ;
- Verifier sauvegarde lisible/restaurable avant action.

Quand une sauvegarde n'est pas pertinente :
- Expliquer explicitement pourquoi : fichier deja casse, contenu manquant,
  artefact temporaire, doublon non reference, regeneration deterministe, ou
  rollback Git suffisant ;
- Pour les fichiers versionnes, ecrire explicitement : "Aucune sauvegarde
  fichier separee : rollback Git suffisant" ;
- Ne jamais presenter une sauvegarde d'etat casse comme un point de restauration
  fiable.

### Rollback pour bases de donnees et migrations

Pour toute modification schema/donnees :
- Definir un rollback **avant** d'executer (script SQL inverse, dump point, version anterieure) ;
- Tester le rollback en environnement de preproduction si disponible ;
- Si rollback ne peut pas être testé ou défini (données anciennes irrécupérables, contraintes d'integrité complexes) :
  - Marquer l'action comme **"non-executable"** sans validation explicite ;
  - Proposer migration en fenetre de maintenance planifiee ;
  - Effectuer sauvegarde logique (export SQL) + sauvegarde physique (copie volume DB) ;
  - Obtenir approbation écrite utilisateur avant execution.

## 4. Portee minimale

- Modifier seulement le strict necessaire pour atteindre l'objectif.
- Respecter les patterns du projet existant.
- Ne pas refondre, renommer, deplacer ou reformater sans necessite.
- Ne pas melanger correction fonctionnelle, refactor et changement d'infrastructure.
- Ne pas toucher aux changements utilisateur non lies a la mission.

## 5. Tests et non-regression — et gestion d'erreur quand tests indisponibles

Apres modification :
- Executer les tests ou checks adaptes au risque ;
- Verifier que les services/processus attendus restent actifs ;
- Verifier les ports concernes ;
- Verifier les logs pertinents ;
- Tester les endpoints/pages/commandes critiques quand applicable ;

### Si tests ne peuvent pas être exécutés (pas d'environnement CI/local)

- Lister exactement quelles verifications automatiques manquent (tests unitaires, intégration, end-to-end, linting) ;
- Executer verifications manuelles minimales (**smoke checks**) :
  - Syntaxe : `npm run lint` ou `python -m py_compile` ou equivalent ;
  - Connexion services : curl endpoints critiques, ping replicas, verifier logs erreur ;
  - Sample data : creer/lire/modifier/supprimer record test dans DB ;
- Estimer risque en pourcentage et impact concret (service down? donnees corrompues? leak?) ;
- Documenter dans rapport : "Tests impossibles [raison] → risque estime: [%] [impact]."

## 6. Rapport obligatoire — Format structuré

Fournir le rapport sous forme de Markdown structuré avec sections suivantes :

### (1) Executive summary
- Synthèse 2-3 lignes : diagnostic, décision clé, risques majeurs résiduels.

### (2) Inventory — État de l'environnement avant modification
- Services actifs, ports en écoute, version moteurs (Git, DB, Docker, Node, Python, etc.)
- Permissions détenues, permissions manquantes (s'il y a)
- Espace disque disponible, quotas
- Branche Git actuelle, fichiers modifiés existants

### (3) Actions proposées — Avec priorité et risque
- Chaque action listée : **Priorité** (1=critique, 2=haute, 3=moyenne, 4=basse)
- **Type** (audit/sauvegarde/non-destructive/destructive)
- **Risque** (aucun/faible/moyen/élevé) et justification
- **Validation requise?** (oui/non + qui)
- **Exécution immédiate?** (oui/non + conditions)

### (4) Backup paths — Sauvegardes utiles ou justification d'absence
- Chemin complet de chaque sauvegarde horodatee quand elle est pertinente
- Ou justification claire d'absence de sauvegarde : etat casse, manquant,
  doublon inutile, artefact regenerable, rollback Git suffisant
- Pour les fichiers suivis par Git : ne pas lister de `.bak`; indiquer le commit,
  le diff ou le patch inverse comme rollback
- Commande de restoration : `cp backup_X vers Y` ou `git reset <hash>` ou SQL restore
- Taille, date, intégrité vérifiée (checksum si pertinent)

### (5) Tests et vérifications reproduites
- Commandes exécutées (avec résultats)
- Tests automatiques qui ont passé (liste)
- Smoke checks manuels effectués
- Comportement critique validé (screenshots avant/après si UI)
- Risques résiduels : "Tests X impossible (raison) → risque estimé Y%"

### (6) Rollback steps — Instructions claires si nécessaire d'annuler
- Pour chaque action destructive : commande exacte pour annuler
- Point de restauration DB (date/hash commit/snapshot)
- Attention : "Rollback détruit Y données" ou "Rollback non réversible si exécuté après [événement]"

### (7) Diff/patchs appliqués
- Pour modifications fichier : `git diff fichier.ext` ou contenu patch
- Pour migrations DB : SQL exécuté exact
- Référencer sauvegardes pour comparaison avant/après

## 7. Incertitude — Politique d'escalade et arrêt

Si l'environnement, la cause, les dépendances ou le rollback **ne sont pas compris** :
- S'arrêter immédiatement ;
- Expliquer clairement : "Ce qui est connu" vs "Ce qui est incertain" vs "Gap de données" ;
- Lister questions ouvertes ou hypothèses non vérifiées ;
- Ne pas inventer réponses ou supposer configurations invisibles ;
- Proposer étape diagnostic supplémentaire (commande, personne à contacter, audit approfondi) ;
- Mettre en pause et attendre clarification.

Exemple : "Incertitude sur impact car : (1) pas d'accès log DB, (2) dépendances transversales non documentées, (3) contraintes foreignkey non validées."

---

## 8. Architecture, redressement et qualité de code

### Contexte et objectif général

Agir en tant qu'expert en architecture logicielle et auditeur technique. Analyser défaillances du projet et formaliser plan de redressement rigoureux.

Situation actuelle : développement a manqué structure, générant dette technique critique et livrables inachevés.
Priorité absolue : stabiliser l'existant, finaliser interconnexions, interdire nouvelle dette technique.

### 8.1 Priorisation des modules et anomalies

Pour ce projet, définir les termes :
- **Module** = dossier direct de `/src` (ou racine projet si pas de `/src`)
- **Sous-modules** = jusqu'à **2 niveaux de profondeur** sous chaque module
- **Composant caché** = fichier CSS/HTML/JS/config actif mais non documenté ou dead code apparent

**Limiter inspection à 5 modules prioritaires** (monorepo) ou projet entier si <5 modules.

Prioriser par : (1) **Risques sécurité OWASP**, (2) **Services exposés en production**, (3) **Composants supportant données critiques**, (4) **Complexité estimée**.
Documenter pour chaque module : score sécurité (1-10), dépendances critiques, couverture test.

### 8.2 Gestion des doublons — Règle consolidée

**Supprimer uniquement doublons documentés comme "identiques et non référencés"** :
- Deux fichiers/composants implémentent exactement même fonctionnalité ET
- Suppression d'un ne break aucun test automatisé ET
- Suppression ne change aucun endpoint/route actif

**Processus** :
- Sauvegarder avant suppression
- Vérifier aucune référence importée (grep/code search)
- Exécuter tests complets post-suppression
- Documenter suppression dans rapport avec raison + fichier backup

Si ambiguïté sur utilité (failover? legacy API? configuration optionnelle?), conserver et documenter.

### 8.3 Inspection module-par-module — Checklist

Pour chaque module (des 5 prioritaires) :
- ✓ Lister fichiers principaux et dépendances externes
- ✓ Identifier CSS masqué, HTML cassé, divs mal fermés → corriger avant livraison
- ✓ Vérifier si contenu dupliqué ailleurs (autre module, assets) → fusionner ou clarifier
- ✓ Valider tests existants passent (npm test, pytest, etc.)
- ✓ Auditer endpoints/routes exposés (OWASP Top 10 : injection, auth, XSS, CSRF, etc.)
- ✓ Vérifier contrats API versionnés et réponses structurées

### 8.4 Emojis — Règle claire pour professionnel

**Interdit** dans site professionnel (dashboard, portail, contrats, rapports).
**Autorisé uniquement** si explicitement demandé par utilisateur (ex: badge UX playful, internal tool).
Par défaut, supprimer et remplacer par icône professionnelle (Font Awesome Free, Material Icons, logo brand officiel).

### 8.5 Icônes et assets — Source et licence

Remplacer SVG placeholders par icônes officielles fournies par product owner OU
packs sous licence permissive :
- Font Awesome Free
- Material Icons (Google)
- Bootstrap Icons
- Logo brand officiel (si brand assets disponibles)

**Documenter** pour chaque icône remplacée : source + licence (ex: "Material Icons - Apache 2.0").

### 8.6 Répertoire projet — Confirmation et point d'exécution

Avant exécuter commande, confirmer répertoire projet en présence d'UN de ces marqueurs :
- `.git` (repo Git)
- `package.json` (Node/NPM)
- `pyproject.toml` (Python)
- `docker-compose.yml` (Docker)

Afficher répertoire courant : `echo $(pwd)` → doit contenir ce marqueur.
Exécuter **toutes commandes depuis répertoire racine** confirmé.

### 8.7 UI — Règles CSS concrètes et breakpoints

**Problèmes UI courants et correction** :
- Texte renvoyé à ligne au lieu d'être sur même ligne → `white-space: nowrap` OU `text-wrap: balance; line-height: 1.4`
- Sidebar trop long → max-height 80vh, overflow:auto, max-width 320px
- Boutons trop larges → max-width 280px, padding-x 16px, text-align center
- Container/grid débordement → max-width 100%, box-sizing border-box, flex-wrap wrap

**Verifier comportement sur breakpoints** : 320px, 768px, 1024px, 1440px.
Inclure **screenshots avant/après** dans rapport.
Tester overflow, text truncation, responsive layout sur mobile (max-width 480px).

Pas de `<div>` mal fermés, pas de CSS orphelin, pas de classe unused.

### 8.8 Patterns d'interaction et feedback UX — Référence consolidée

Les patterns suivants sont des standards industriels. À implémenter selon contexte métier :

#### Formulaires & gestion d'état
- **Autosave** : sauvegarde automatique de brouillon (toute modification enregistrée)
- **Dirty state** : détecter changements non validés (afficher "Modifications non enregistrées")
- **Auto-complete** : suggestions au saisir pour accélérer entrée utilisateur

#### Feedback & notification
- **Loader/Spinner** : afficher activité système (Connexion en cours, traitement)
- **Progress bar** : progression mesurable pour actions longues (>2s)
- **Toast animé** : notification temporaire non-bloquante (3-5s)
- **Alert** : information importante bloquante si critique
- **Confirm dialog** : sécuriser actions sensibles (Confirmation suppression)
- **Retry** : permettre relancer action échouée (Bouton "Réessayer")

#### Animations (usage ciblé — limiter surcharge)
- **Blink/clignotement** : attirer attention, limiter utilisation (badge "Nouveau")
- **Pulse** : montrer état vivant (point vert "en ligne")
- **Shimmer** : effet chargement reflet (skeleton loader)
- **Fade** : apparition/disparition douce (modal, panels)
- **Slide** : glissement contrôlé (drawer latéral)
- **Scale** : agrandissement discret (modal zoom 90%→100%)
- **Ripple** : onde au clic/tap (Material Design, mobile)
- **Error shake** : vibration légère signalant erreur (champ mot de passe)
- **Success checkmark** : coche animée confirmer action réussie
- **Count animation** : nombre animé (0→125 pour KPI)
- **Chart animation** : courbes/barres montant au chargement
- **Scroll reveal** : section apparaît au scroll-into-view
- **Parallax** : effet profondeur (image fond 50% vitesse scroll)
- **Typing indicator** : trois points animés (chat, appels)
- **Live indicator** : point pulsant indiquant activité temps réel
- **Auto-refresh indicator** : icône sync tournante
- **Confetti** : célébration rare (paiement réussi)

#### Interactions tactiles & clavier
- **Click/Tap** : action souris / tactile mobile
- **Long press** : menu rapide options (mobile 500ms+)
- **Swipe** : geste glissement (supprimer carte, carrousel)
- **Drag & drop** : déplacement (Kanban, upload fichier)
- **Scroll** : défilement page longue
- **Inner scroll** : scroll dans un bloc (tableau 80+ lignes)
- **Infinite scroll** : chargement continu fil actualité (user-visible pagination préféré)
- **Virtual scroll** : optimiser listes géantes (10k+ lignes, render visible uniquement)
- **Scroll lock** : bloquer arrière-plan quand modal ouverte
- **Keyboard navigation** : Tab/Arrows/Enter complètement fonctionnels (A11y)
- **Focus trap** : focus prisonnier modal jusqu'à fermeture

#### Affichage conditionnel & disclosure
- **Progressive disclosure** : masquer détails au départ, révéler au clic (chevron icon)
- **Conditional rendering** : afficher/cacher selon état (bouton si authorized)
- **Modal** : formulaire court sans quitter page (ajouter client)
- **Drawer** : détail latéral glissant (fiche commande ouvre côté)
- **Popover** : infobulle contextuelle (statut courant, infos rapides)
- **Dropdown** : menu actions secondaires ("Plus...")
- **Accordion** : contenu collapsible (FAQ, historique, specs)

#### Design system & cohérence
- **UI kit** : composants réutilisables standardisés (Button, Card, Modal, Table, Form)
- **Design tokens** : valeurs CSS centralisées (--color-primary, --spacing, --radius)
- **CSS variables** : éviter valeurs hard-coded, permettre theming

#### Données & drill-down
- **Drill-down** : cliquer KPI → détail analyse
- **Optimiser taille formulaires** : max 8-10 champs par écran, grouper sections logiques

---

## 9. Sécurité — Appliquer OWASP Top 10 2025

Toute modification doit valider conformité minimale OWASP Top 10 (https://owasp.org/Top10/2025/) :
- **A1. Broken Access Control** → vérifier autorisations API, RBAC cohérent
- **A2. Cryptographic Failures** → secrets versionner en .env, chiffrer en transit (HTTPS), hashing passwords
- **A3. Injection** → paramètres sanitisés (SQL, NoSQL, OS), utiliser ORM/prepared statements
- **A4. Insecure Design** → schema sécurisé, audit entités, logs d'accès
- **A5. Security Misconfiguration** → pas de secrets en code, debug mode off en prod, versions à jour
- **A6. Vulnerable Components** → npm audit, pip audit réguliers, upgrade patches
- **A7. Authentication Failures** → sessions securisées (HttpOnly, SameSite), 2FA si données sensibles
- **A8. Data Integrity Failures** → CI/CD check intégrité, signatures code si déploiement critique
- **A9. Logging & Monitoring Failures** → logs structurés (JSON), alertes anomalies, retention policy
- **A10. SSRF** → valider URL cibles, refuser localhost/169.254.x.x, whitelist domaines

Documenter dans rapport pour chaque module : risques détectés (A1-A10) + plan mitigation.
