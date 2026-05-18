# PRD — Dashboard Multi-Vues par Rôle
**Version** : 1.0 | **Date** : 2026-05-18 | **Projet** : Tala SMI / TOP CENTER

---

## 1. Contexte & Objectif

Le dashboard actuel est générique. Les utilisateurs arrivent sur une page qui ne leur dit pas
quoi faire, ne met pas en avant leurs tâches urgentes, et ne filtre pas selon leur rôle.

**Objectif** : chaque rôle arrive sur une home personnalisée qui répond en 3 secondes à :
> "Qu'est-ce qui est urgent pour moi aujourd'hui ?"

---

## 2. Rôles & Vues

| Vue | Rôles concernés |
|-----|----------------|
| **Décideur** | `dg`, `manager` |
| **Opérationnel** | `caissier`, `assistante_direction` |
| **Finance** | `finance` |
| **RH** | `rh` |
| **Admin** | `admin` — voit tout, pas de vue spécifique |

---

## 3. Vue Décideur (DG / Manager)

### Priorité n°1 — Solde caisse en temps réel
- Montant brut affiché en grand (≥ 48px)
- Badge d'alerte si solde < seuil configurable (défaut : **100 000 XAF**)
- Seuil configurable par l'admin dans les paramètres (par caisse ou global)
- Pas de graphique sur cette carte — chiffre seul, clair, immédiat

### Zone 2 — Compteurs par catégorie (aujourd'hui / semaine / mois)
- 3 onglets de période : Aujourd'hui | Cette semaine | Ce mois
- Grille de tuiles cliquables : Encaissements | Décaissements | En attente validation
- Clic → filtre automatique sur la liste des opérations avec la catégorie pré-sélectionnée

### Zone 3 — Actions en attente (rôle Décideur)
- Décaissements soumis en attente d'approbation DG/manager
- Liste compacte : libellé, montant, demandeur, date soumission
- Bouton [Voir] par ligne → page opération concernée

### Zone 4 — KPIs récapitulatifs (lecture seule)
- Solde net (Recettes − Dépenses du mois)
- Nombre d'opérations du jour
- Tendance vs mois précédent (flèche + pourcentage)

### Périmètre de visibilité
- DG : toutes les caisses et tous les agents
- Manager : agents de son équipe (scope hiérarchique, à définir en V2 si plusieurs équipes)

---

## 4. Vue Opérationnel (Caissier / Assistante direction)

### Priorité n°1 — Actions du jour
- Encaissements et décaissements à traiter (statut "en attente")
- Bouton d'action rapide : [+ Encaissement] [+ Décaissement] en haut de page

### Zone 2 — Solde caisse en temps réel
- Même logique que Décideur mais secondaire (outil, pas décision)
- Alerte si solde bas

### Zone 3 — Mes opérations récentes
- Liste des 10 dernières opérations saisies par cet agent
- Statut (validé / en attente / rejeté) visible sur chaque ligne

### Zone 4 — Raccourcis
- Filtres rapides : Aujourd'hui / Cette semaine / Ce mois
- Lien direct vers la liste complète des opérations

---

## 5. Vue Finance

### Priorité n°1 — Flux de trésorerie
- Encaissements du jour | Décaissements du jour
- Encaissements de la semaine | Décaissements de la semaine
- Encaissements du mois | Décaissements du mois
- Affichage en 2 colonnes (recettes vs dépenses) avec solde net en bas

### Zone 2 — Décaissements à valider
- File de décaissements soumis en attente validation Finance
- Colonnes : libellé, montant, agent, date soumission
- Bouton [Valider] / [Rejeter] directement dans la liste (ou lien vers détail)

### Zone 3 — Rapprochements bancaires en attente
- Compteur : N opérations sans rapprochement bancaire
- Lien vers la page rapprochement (V1 : lien vers liste filtrée)

### Zone 4 — Statut période de paie en cours
- Nom de la période, statut (ouverte / en saisie / close)
- Progression : X% des bulletins générés

---

## 6. Vue RH

### Priorité n°1 — Actions immédiates (Top Chrono)
- Demandes de congés/absences en attente de validation (liste compacte)
- Checklists onboarding incomplètes avec date limite dépassée
- Bouton [Valider] par ligne pour les congés

### Zone 2 — Échéances contrats (30 / 60 / 90 jours)
- Fins de période d'essai imminentes
- Fins de CDD imminentes
- Alertes visuelles : rouge < 15j, orange < 30j, jaune < 60j

### Zone 3 — Statut paie du mois
- Période en cours, statut, progression (X% des bulletins)
- Lien vers module paie

### Zone 4 — KPIs capital humain
- Effectif total (actifs / inactifs)
- Taux d'absentéisme du mois
- Taux de turnover annuel
- Nouveaux arrivants / départs du mois (compteurs cliquables)

---

## 7. Comportements transverses

### Seuil d'alerte solde
- Paramètre global : `alerte_solde_minimum` (défaut 100 000 XAF)
- Configurable par admin dans Paramètres
- Stocké en base (table `parametres` clé/valeur)

### Navigation par clic
- Toutes les tuiles/compteurs sont cliquables et redirigent vers la liste filtrée correspondante
- Pas de modal intermédiaire — navigation directe

### Responsive
- Mobile : zones empilées verticalement, priorité n°1 reste en tête
- Desktop : layout 2 colonnes pour zones 2-3-4

### Pas de rechargement automatique (V1)
- Bouton "Actualiser" manuel sur le solde
- V2 : polling léger toutes les 60s

---

## 8. Implémentation technique

### Frontend
- Détection du rôle au chargement : `currentUser.role`
- Fonction `renderDashboardByRole(role)` — switch/case → appel du bon template
- Chaque vue = fonction JS isolée : `renderDecideurView()`, `renderOperationnelView()`, `renderFinanceView()`, `renderRHView()`
- HTML injecté dans `#dashboard-content` (div existante dans dashboard.html)

### Backend — nouveaux endpoints nécessaires
| Endpoint | Vue | Description |
|----------|-----|-------------|
| `GET /api/dashboard/solde` | Toutes | Solde + seuil alerte |
| `GET /api/dashboard/flux?periode=jour|semaine|mois` | Finance, Décideur | Encaissements/décaissements par période |
| `GET /api/dashboard/actions-en-attente` | Décideur, Finance | Opérations à valider par rôle |
| `GET /api/dashboard/conges-en-attente` | RH | Demandes congés à valider |
| `GET /api/dashboard/echeances-contrats` | RH | Contrats expirant dans 90j |
| `GET /api/dashboard/kpis-rh` | RH | Effectif, turnover, absentéisme |
| `GET /api/parametres/alerte-solde` | Admin | Lire/écrire le seuil |

### Paramètre seuil
- Table `parametres` (clé/valeur) — migration idempotente si absente
- Clé : `alerte_solde_minimum`, valeur par défaut : `100000`

---

## 9. Hors périmètre V1

- eNPS / sondages internes
- Graphiques temporels animés (sparklines, courbes)
- Polling automatique du solde
- Scope hiérarchique multi-équipes pour les managers
- Rapprochement bancaire complet (seulement le compteur en V1)

---

## 10. Critères d'acceptation

- [ ] Chaque rôle voit sa vue et uniquement les données de son périmètre
- [ ] Le solde est mis à jour à chaque ouverture de page
- [ ] Une alerte visuelle apparaît si solde < seuil
- [ ] Chaque compteur/tuile cliquable ouvre la liste filtrée correcte
- [ ] La vue RH affiche les congés en attente en priorité n°1
- [ ] La vue Finance affiche les flux du jour/semaine/mois
- [ ] La vue Décideur affiche le solde en grand avec badge d'alerte
- [ ] Le seuil d'alerte est configurable par l'admin
