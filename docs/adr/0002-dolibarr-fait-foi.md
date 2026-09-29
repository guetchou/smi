# ADR 0002 — Dolibarr fait foi pour les tiers, les factures et la comptabilité

Date : 29 septembre 2026
Statut : **accepté** — décision de l'utilisateur du 29/09/2026, complétée le
même jour par la contrainte d'interface (§2) ; les modalités d'intégration (§5)
restent à trancher
Contexte : jalon 14 du PRD `.claude/prds/exploitation-quotidienne.prd.md`
(« L'intégration Dolibarr ») et sa question ouverte « quel système fait foi pour
les tiers, les factures et les écritures ? »

## 1. Le problème

Deux logiciels du serveur savent tenir les mêmes données :

- **Dolibarr 22.0.5** (`dolibarr-prod`, `dolibarr-sandbox`) : tiers, factures
  clients et fournisseurs, paiements, banque, comptabilité générale ;
- **Tala SMI** : un module de factures clients (vide au 29/09/2026 : 0 facture,
  1 client) et un module comptable (plan de comptes, règles de ventilation,
  brouillons d'écritures, journal).

Le PRD nomme le risque : sans système désigné, l'intégration crée **deux maîtres
pour la même donnée**, pire que la double saisie. Le 29/09/2026, une livraison
de Tala SMI (rattachement des encaissements aux factures, avec écriture 411/706 à
l'émission) allait précisément créer ce second maître. Elle a été arrêtée avant
toute ligne de code.

## 2. La décision

| Domaine | Fait foi |
|---|---|
| Tiers — clients, fournisseurs | **Dolibarr** |
| Factures clients et fournisseurs, paiements de factures | **Dolibarr** |
| Comptabilité générale — grand livre, plan de comptes, écritures | **Dolibarr** |
| Caisse physique, encaissements et décaissements, approbations, parapheur | **Tala SMI** |
| Paie, RH, pointeuse, déclarations CNSS et DGI | **Tala SMI** |
| Prévisions budgétaires | **Tala SMI** |

Une donnée n'est saisie que dans le système qui en fait foi. L'autre la reçoit,
la lit ou la référence ; il ne la recrée pas.

### Contrainte d'interface — ajoutée le 29/09/2026

**L'écran est Tala SMI. Dolibarr reste en arrière-plan et n'est jamais montré
aux utilisateurs.** « Faire foi » désigne où la donnée est tenue, pas où l'on
travaille : aucun geste utilisateur ne se fait dans Dolibarr — ni la saisie, ni
la ventilation, ni l'écriture au grand livre, ni la consultation. Tout passe
par des écrans de Tala SMI qui appellent Dolibarr.

## 3. Ce que cela change dans Tala SMI

- **Pas de nouvelle fonction de facturation ni de comptabilité générale** dans
  Tala SMI. Le rattachement encaissement ↔ facture devient une **passerelle** :
  la facture reste celle de Dolibarr, Tala SMI y enregistre le règlement.
- **Le module de factures clients de Tala SMI** est un doublon ; il a vocation à
  être masqué (il est vide, rien n'est à migrer). À faire par une PR distincte,
  après maquette si l'écran change.
- **Le module comptable de Tala SMI** cesse d'être le grand livre. Le grand
  livre est celui de Dolibarr ; les écrans comptables de Tala SMI le lisent et y
  font écrire. La validation d'une écriture est un geste fait **dans Tala SMI**,
  qui déclenche l'écriture dans Dolibarr.
- **Un module Dolibarr « smi »**, installé dans `custom/` et sans écran, ajoute à
  l'API de Dolibarr ce qui ne s'y trouve pas : l'écriture d'une pièce comptable
  (paie), la lecture du grand livre, et le passage au grand livre des pièces
  (voir §5, point 6). C'est le mécanisme d'extension prévu par Dolibarr ; il ne
  modifie pas Dolibarr et survit à ses mises à jour.
- **Les brouillons existants** (13 au 29/09/2026, dont la ventilation a été
  corrigée par la migration 060) ne doivent pas être validés dans Tala SMI tant
  que leur sort n'est pas tranché (§5), sinon la même écriture existerait deux
  fois.

## 4. Ce qui ne change pas

- Le circuit d'approbation des décaissements, le parapheur, la double
  approbation, la clôture de caisse.
- Les prévisions budgétaires (PR #241) : le budget n'est pas dans le cœur de
  Dolibarr, et le réalisé se lit dans la caisse de Tala SMI.
- Les reclassements du 29/09/2026 (migrations 059, 060) : ils décrivent la nature
  réelle des mouvements de caisse, quel que soit le système qui tient le grand
  livre.

## 5. À trancher avant la première passerelle

1. **Usage réel de Dolibarr production** : nombre de tiers, factures, paiements,
   écritures ; module comptable activé ou non. Non mesuré — la lecture de la base
   de production a été refusée par le garde-fou de l'agent le 29/09/2026.
2. **Sens et forme des flux** : un encaissement de caisse validé devient-il un
   paiement sur facture Dolibarr, une ligne de banque Dolibarr, ou les deux ?
   Les positions de Tala SMI (Caisse principale, Banque BCH, chèques) doivent
   correspondre chacune à un compte bancaire Dolibarr.
3. **Sort des 13 brouillons** de Tala SMI : transmis à Dolibarr, ou ressaisis
   dans Dolibarr à partir des opérations.
4. **Accès** : API REST Dolibarr activée, clé d'API dédiée, stockée hors dépôt.
5. **Terrain d'essai** : toute passerelle est mise au point sur
   `dolibarr-sandbox` avant la production (règle du PRD).
6. **Passage au grand livre sans écran Dolibarr.** Vérifié le 29/09/2026
   (`docs/verifications/dolibarr-surcouche/`) : l'API crée factures, paiements
   et virements avec des écritures SYSCOHADA justes, mais la ventilation et
   l'écriture des journaux ventes, achats et banque n'existent que dans le code
   des écrans de Dolibarr (370 lignes pour le seul bloc d'écriture du journal
   de banque), sans fonction réutilisable ni automatisme. Le PHP web de
   Dolibarr interdit de lancer un processus (`proc_open`, `system`… désactivés).
   Voies possibles : exécuter ces écrans en ligne de commande par une tâche
   planifiée sur le serveur ; ou faire calculer les écritures par Tala SMI et
   les écrire par le module ; ou recopier leur logique dans le module.
   **Tranché le 29/09/2026 : la tâche planifiée (voie A).** La logique
   comptable reste celle de Dolibarr. Une tâche du serveur exécute en ligne de
   commande la ventilation automatique puis l'écriture des journaux ventes,
   achats et banque, comme les écrans le feraient. Conséquences : un décalage
   de quelques minutes entre le mouvement et le grand livre ; une dépendance
   aux paramètres de ces écrans, surveillée par le banc
   `docs/verifications/dolibarr-surcouche/` ; la paie et les OD restent
   écrites directement par `POST /smi/pieces`.
