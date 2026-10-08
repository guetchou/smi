# Formulaires SMI — lot du 8 octobre 2026

Encaissement et décaissement : cinq étapes. Transfert : quatre étapes. Libellés au-dessus, validations en ligne, choix courts de 78 à 142 px, radios de 16 px, résumé compact des comptes au pied du formulaire et actions explicites. Les autorisations et règles métier existantes sont conservées.

Brouillons par compte et formulaire en sessionStorage, pendant 24 heures. Conservation après échec et suppression après succès serveur.

Vérifications : 50 contrôles isolés réussis ; suite existante corrigée pour les nouveaux libellés. Encaissement et décaissement observés dans Chrome avec le compte clone ; les quatre étapes du transfert observées à 320 px. Les contrôles CI et la vérification après publication restent requis. Aucun changement de la fiche agent dans ce lot.

Retour arrière : rétablir les fichiers de présentation depuis le commit précédent, en conservant les correctifs de notifications et de dates. Ne pas supprimer les données métier.
