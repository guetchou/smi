# Lot court : enregistrement

PRD : conserver le verrou existant des trois formulaires. Un changement de champ pendant la requete ne doit pas reactiver le bouton. Confirmer le succes avec la reference renvoyee, echappee, et une duree lisible.

Plan : deux conditions de bouton, une confirmation, tests cibles, CI et procedure officielle, controle Chrome. Aucun changement de schema, de dependance ou de regle metier. Les reprises apres une reponse reseau perdue ne sont pas couvertes par ce verrou navigateur.

Rollback : version a1636988291190311ac0b130ed82b355b549e791 via le workflow officiel. Aucune sauvegarde fichier separee : rollback Git suffisant.

Complement demande pendant le lot : references 260 px, dates 170 px, montants 190 px, noms/recherche 340 px au maximum ; panneau de solde 450 px avec indicateurs a cote, cartes sans hauteur etiree, graphique limite a 220 px. Conserver les textes longs et la mise en page mobile. Apercu compare dans Chrome avant publication.

Accueil : actions de 78 a 88 px et 30 px de haut sur ordinateur (36 px sur mobile), montant principal 26 px, cartes de 320 px environ, hauteurs ajustees au contenu.
