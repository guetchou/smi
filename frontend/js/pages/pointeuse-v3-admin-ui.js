(function () {
  'use strict';

  // La configuration technique de la Pointeuse ne doit pas être injectée dans
  // l'écran métier /app/rh/pointeuse. Les fonctions d'administration restent
  // disponibles côté API et doivent être exposées, si nécessaire, dans une
  // console d'administration dédiée et explicitement conçue pour ce besoin.
  //
  // Ce module est volontairement neutre afin de conserver le chargement du
  // bundle existant sans réintroduire de vocabulaire de migration, de runtime
  // ou de rapprochement technique dans l'interface utilisateur.
})();
