# Lot court : enregistrement

PRD : conserver le verrou existant des trois formulaires. Un changement de champ pendant la requete ne doit pas reactiver le bouton. Confirmer le succes avec la reference renvoyee, echappee, et une duree lisible.

Plan : deux conditions de bouton, une confirmation, tests cibles, CI et procedure officielle, controle Chrome. Aucun changement de schema, de dependance ou de regle metier. Les reprises apres une reponse reseau perdue ne sont pas couvertes par ce verrou navigateur.

Rollback : version a1636988291190311ac0b130ed82b355b549e791 via le workflow officiel. Aucune sauvegarde fichier separee : rollback Git suffisant.

Complement demande pendant le lot : references 260 px, dates 170 px, montants 190 px, noms/recherche 340 px au maximum ; panneau de solde 540 px avec indicateurs a cote, cartes sans hauteur etiree, graphique limite a 340 px. Conserver les textes longs et la mise en page mobile. Apercu compare dans Chrome avant publication.
