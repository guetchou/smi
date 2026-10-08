# Lot court : enregistrement

PRD : conserver le verrou existant des trois formulaires. Un changement de champ pendant la requete ne doit pas reactiver le bouton. Confirmer le succes avec la reference renvoyee, echappee, et une duree lisible.

Plan : deux conditions de bouton, une confirmation, tests cibles, CI et procedure officielle, controle Chrome. Aucun changement de schema, de dependance ou de regle metier. Les reprises apres une reponse reseau perdue ne sont pas couvertes par ce verrou navigateur.

Rollback : version a1636988291190311ac0b130ed82b355b549e791 via le workflow officiel. Aucune sauvegarde fichier separee : rollback Git suffisant.
