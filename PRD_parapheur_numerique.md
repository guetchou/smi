# PRD — Parapheur Numérique & Home DG
**Version** : 1.1 | **Date** : 2026-05-18 | **Projet** : Tala SMI / TOP CENTER

---

## 1. Problème résolu

Tout passe aujourd'hui par un parapheur papier géré par l'assistante de direction.
Pas de traçabilité, pas de notification, pas de priorité — le DG trie lui-même,
les demandes se perdent, les initiateurs relancent à la main.

---

## 2. Circuit numérique cible

```
Initiateur (n'importe quel rôle)
    │ soumet une demande dans l'app
    ▼
Assistante de direction (ou remplaçant) — PARAPHEUR ENTRANT
    │ vérifie complétude + pièces jointes
    │ ajoute note + priorité
    │ → Rejeter (ASSISTANTE TITULAIRE UNIQUEMENT)
    │     └─ notif initiateur + copie lecture DG en temps réel
    │ → Transmettre au DG
    ▼
DG — HOME PARAPHEUR
    │ Approuver
    │ Rejeter + motif
    │ Renvoyer pour éclaircissement → initiateur notifié
    │ Renvoyer pour correction → initiateur notifié
    │ Déléguer → destinataire notifié, DG garde copie lecture
    │ Demander avis → service/personne notifié
    ▼
Initiateur notifié à chaque étape (app + email)
```

---

## 3. Types de demandes couverts

| Catégorie | Type | Échéance légale |
|---|---|---|
| Finance | Décaissement / paiement fournisseur | — |
| Finance | Paiement CNSS | 15 du mois |
| Finance | Paiement DGI / IRPP | 20 du mois |
| Achats | Demande d'achat | — |
| Achats | Validation facture fournisseur | — |
| RH | Demande de congé | — |
| RH | Avance / quart de salaire | — |
| RH | Révision salariale | — |
| RH | Offboarding | — |
| Administratif | Contrat à signer | Date fin contrat |
| Administratif | Attestation stage / fin de stage | — |
| Administratif | Facture client à signer | Échéance client |
| Administratif | Correspondance entrante/sortante | — |
| Administratif | Réclamation agent | — |
| Administratif | Demande d'amélioration agent | — |

---

## 4. Rôle Assistante de direction — Parapheur entrant

### Actions disponibles

| Action | Assistante titulaire | Remplaçant |
|---|---|---|
| Vérifier la complétude | ✅ | ✅ |
| Ajouter une note | ✅ | ✅ |
| Ajouter une priorité | ✅ | ✅ |
| Transmettre au DG | ✅ | ✅ |
| Rejeter à la source | ✅ | ❌ interdit |
| Supprimer | ✅ | ❌ interdit |

### Vue home Assistante
- File d'attente des demandes entrantes non encore transmises
- Historique de ses décisions visible par le DG en temps réel

---

## 5. Gestion de l'intérim (règles métier critiques)

### 5.1 Déclenchement de l'absence

| Cas | Qui déclare | Action |
|---|---|---|
| Congé planifié | L'assistante elle-même | Saisit son absence + désigne son remplaçant |
| Absence imprévue | Le DG ou l'admin | Déclare l'absence + désigne le remplaçant |
| Absence détectée auto | Le système | Détecte via le module absences/congés existant |

### 5.2 Pendant l'absence — circuit tri-hybride

1. **Si un remplaçant est désigné** :
   - Le remplaçant reçoit les demandes entrantes avec droits limités (voir tableau §4)
   - Le DG reçoit **également** toutes les demandes en copie directe (sans filtre assistante)
   - Le DG peut agir directement sans attendre le remplaçant

2. **Si aucun remplaçant n'est désigné** :
   - Le DG reçoit directement toutes les demandes sans passer par l'assistante
   - Pas de filtre de complétude — le DG voit tout brut

### 5.3 Retour de l'assistante

- L'assistante voit l'**historique complet** de ce que le remplaçant a traité pendant son absence
- Elle **ne reprend pas la main automatiquement**
- Le **DG valide manuellement le retour** dans l'app → droits du remplaçant révoqués à ce moment
- Tant que le DG n'a pas validé le retour : le remplaçant garde ses droits, le DG continue de recevoir en direct

### 5.4 Traçabilité intérim

- Toute action du remplaçant est **taguée "intérim"** dans l'historique
- Le DG voit en temps réel : qui a fait quoi (assistante titulaire vs remplaçant)
- L'assistante ne peut pas modifier/annuler les actions du remplaçant (historique immuable)

---

## 6. Home DG — Parapheur numérique

### Zone principale : file d'approbation

Chaque item affiche :
- Type · Initiateur · Date soumission · Priorité (badge couleur)
- Montant si financier · Échéance légale si applicable
- Pièces jointes accessibles inline
- Note de l'assistante / remplaçant (taguée si intérim)
- Badge "VIA INTÉRIM" si transmis par le remplaçant

### Actions par item (inline, sans quitter la home)

| Action | Comportement |
|---|---|
| ✅ Approuver | Statut → approuvé · notif initiateur |
| ❌ Rejeter | Motif obligatoire · notif initiateur |
| 💬 Éclaircissement | Message → initiateur notifié · item en attente |
| ✏️ Correction | Item renvoyé à l'initiateur · statut "à corriger" |
| 👤 Déléguer | Choisir destinataire · les deux notifiés · DG garde copie |
| 👁️ Avis | Choisir service/personne · notif · réponse visible DG |

### Alertes automatiques par échéance légale

- **J-5** : badge orange sur l'item
- **J-2** : badge rouge + notification push DG
- **J-0** : alerte bloquante en haut de la home

---

## 7. Notifications

| Événement | Qui | Canal |
|---|---|---|
| Nouvelle demande soumise | Assistante (ou DG si absent) | App |
| Assistante/remplaçant transmet au DG | DG | App + Email |
| Assistante rejette | Initiateur + DG (lecture) | App + Email |
| DG approuve | Initiateur | App + Email |
| DG rejette | Initiateur | App + Email |
| DG demande éclaircissement/correction | Initiateur | App + Email |
| DG délègue | Délégué + Initiateur | App + Email |
| Remplaçant désigné | Remplaçant + DG | App |
| DG valide retour assistante | Assistante + Remplaçant | App |
| Échéance légale J-5 | DG | App |
| Échéance légale J-2 | DG | App + Email |
| WhatsApp | Tous | V2 |

---

## 8. Modèle de données

### Table `parapheur`
```sql
id, type, titre, initiateur_id, priorite (normal/urgent/confidentiel),
statut (brouillon/en_attente_assistante/transmis_dg/approuve/rejete/en_correction/delegue),
note_assistante, transmis_par_id, transmis_par_role (titulaire/interim),
echeance_legale, montant, pieces_jointes,
created_at, updated_at
```

### Table `parapheur_actions`
```sql
id, parapheur_id, acteur_id, acteur_role, action_type,
commentaire, destinataire_id, is_interim, created_at
```

### Table `parapheur_interim`
```sql
id, absent_id, remplacant_id, declare_par_id,
date_debut, date_fin_prevue, date_retour_effectif,
valide_retour_par_id, valide_retour_at, actif
```

---

## 9. Ce qui existe déjà (à connecter)

- `demandes_achat` → connecteur parapheur type "achat"
- `employes_conges` → connecteur type "conge"
- `operations` dec_statut → connecteur type "decaissement"
- `calendrier_fiscal` → échéances CNSS/DGI pour alertes J-5/J-2
- `offboarding` → connecteur type "offboarding"
- `bulletins_salaire` avances → connecteur type "avance_salaire"
- Système `notifs.js` → brancher les nouvelles notifications

---

## 10. Plan d'implémentation (ordre)

1. **Tables + migrations** (`parapheur`, `parapheur_actions`, `parapheur_interim`)
2. **API `/api/parapheur`** — CRUD + 6 actions DG + gestion intérim
3. **Home DG** — file d'approbation inline avec toutes les actions
4. **Home Assistante** — file entrante + gestion intérim
5. **Connecteurs** sur les types existants
6. **Alertes échéances légales** (brancher calendrier_fiscal)
7. **Notifications** email + app

---

## 11. Hors périmètre V1

- Signature électronique légale (OHADA)
- WhatsApp
- Appels téléphoniques
- Archivage GED long terme
- Multi-entreprise

---

## 12. Critères d'acceptation

- [ ] Demande soumise par n'importe quel rôle → arrive dans la file assistante
- [ ] Assistante vérifie, note, priorise, transmet ou rejette (rejet interdit au remplaçant)
- [ ] Rejet assistante → notif initiateur + copie lecture DG en temps réel
- [ ] Home DG : toutes les demandes avec priorité, échéance, note assistante
- [ ] DG approuve/rejette/délègue/renvoie inline depuis la home
- [ ] Chaque action → notification app + email à toutes les parties
- [ ] Absence assistante → remplaçant désigné + DG reçoit en direct simultanément
- [ ] Si pas de remplaçant → DG reçoit directement sans filtre
- [ ] Retour assistante = validation manuelle DG obligatoire
- [ ] Actions remplaçant taguées "intérim" dans l'historique
- [ ] Alertes CNSS J-5 (orange) et J-2 (rouge + notif) automatiques
