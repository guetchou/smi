# Audit salaire et contrats - 2026-07-15

## Constat

- `employes` contient l'identite, l'affectation, les dates contractuelles et trois montants de remuneration.
- `entreprise` fournit l'identite employeur, le logo, le cachet et la signature avec historique.
- `contrats` gere surtout les contrats commerciaux, montants recurrents et echeances de facturation.
- `salaires.js` calcule les bulletins mais utilise des taux de repli et assimile le brut a l'assiette CNSS.
- Le calcul IRPP actuel n'utilise ni situation familiale, ni personnes a charge, ni parts fiscales.
- PDF est disponible via `wkhtmltopdf`; aucune generation DOCX n'est installee.
- RBAC, audit, parapheur et archivage de documents agents sont reutilisables.

## Modele MATOKO2

- 73 paragraphes, aucun header/footer OOXML et aucun media/logo embarque.
- Identite incoherente : `Valmaure` puis `Valmaura`, `Ne05/04/1989`, civilite masculine avec `Domiciliee`.
- Lien email errone vers `contact@topcenter.cgm`.
- Salaire de base 150 000 XAF et transport 20 000 XAF, sans brut explicite.
- CNSS 4 800 XAF et IRPP 2 400 XAF sont inscrits en dur.
- La clause CNSS annonce 4 % et 8 % du brut total sans preuve de l'assiette ni version de regle.
- La date de fin du CDD de six mois n'est pas affichee.
- References juridiques, visa ACPE et montants doivent etre valides humainement.

## Comparaison industrielle

- Odoo rattache le contrat a l'employe, aux structures de salaire, aux documents et a la signature.
- SAP SuccessFactors separe modele, placeholders, mapping RH et generation.
- Le SMI adopte ces invariants sans reproduire leurs interfaces : fiche agent canonique, modele versionne, snapshot de calcul, workflow et document archive.

## Limites d'audit

- Docker local indisponible : `JWT_SECRET` absent puis acces refuse a `/var/run/docker.sock`.
- Base MySQL locale non auditee; les migrations et tests statiques restent disponibles.
- Disque `C:` a 98 %; les artefacts seront conserves dans `/opt/projet-smi`.
