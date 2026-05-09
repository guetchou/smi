1. Principe général
Une entreprise ne doit pas gérer séparément :


la vente ;


l’achat ;


l’encaissement ;


le décaissement ;


le stock ;


la caisse ;


la banque ;


les contrats ;


les factures ;


les relances ;


la comptabilité.


Sinon, on obtient vite :


factures payées mais non comptabilisées ;


produits livrés mais non facturés ;


dépenses payées sans pièce justificative ;


achats reçus mais non entrés en stock ;


ventes enregistrées sans encaissement ;


contrats actifs sans facturation automatique ;


clients débiteurs oubliés ;


fournisseurs payés deux fois ;


caisse physique différente du solde logiciel ;


banque non rapprochée ;


pertes, fraude, confusion.


Le vrai système doit donc fonctionner par événements synchronisés.
Exemple :

Une vente validée peut créer une facture.
Une facture payée crée un encaissement.
Un encaissement validé met à jour la caisse ou la banque.
Une vente produit met à jour le stock.
Une facture validée nourrit la comptabilité.
Un retard déclenche une relance.
Une annulation crée une trace d’audit.


2. Modules nécessaires
A. Module Clients
Informations minimales :


nom / raison sociale ;


type : particulier, entreprise, administration, ONG, association ;


téléphone ;


WhatsApp ;


email ;


adresse ;


ville ;


pays ;


RCCM / NIF si entreprise ;


contact principal ;


catégorie client ;


plafond de crédit ;


délai de paiement autorisé ;


statut : actif, suspendu, mauvais payeur, archivé ;


historique des devis, factures, paiements, relances, contrats.


Omissions fréquentes :


ne pas distinguer client particulier et client entreprise ;


ne pas gérer le plafond de crédit ;


ne pas bloquer les clients en impayés ;


ne pas avoir d’historique complet ;


ne pas savoir qui a validé quoi.



B. Module Fournisseurs
Informations minimales :


nom fournisseur ;


type : produit, service, sous-traitant, bailleur, prestataire ;


téléphone ;


email ;


adresse ;


NIF / RCCM si applicable ;


conditions de paiement ;


délai de livraison ;


historique achats ;


dettes fournisseurs ;


documents administratifs ;


statut : actif, suspendu, blacklisté, archivé.


Omissions fréquentes :


payer un fournisseur sans bon de commande ;


ne pas suivre les avances fournisseurs ;


ne pas suivre les livraisons partielles ;


ne pas lier facture fournisseur, réception et paiement.



C. Module Produits / Services
Produit
Champs nécessaires :


code produit ;


désignation ;


catégorie ;


unité : pièce, boîte, kg, litre, paquet, carton ;


prix d’achat ;


prix de vente ;


marge ;


TVA ou taxe applicable ;


stock disponible ;


stock réservé ;


stock minimum ;


emplacement ;


date expiration si applicable ;


numéro de lot si applicable ;


code-barres si applicable.


Service
Champs nécessaires :


désignation service ;


catégorie ;


prix standard ;


durée ;


coût estimé ;


responsable ;


livrable attendu ;


mode de facturation : fixe, horaire, forfaitaire, périodique ;


conditions de validation du service rendu.


Omissions fréquentes :


mélanger produit et service ;


vendre un produit sans vérifier le stock ;


vendre un service sans preuve de réalisation ;


ne pas distinguer stock disponible et stock réservé.



3. Workflow de vente
3.1 Demande client
Déclencheurs possibles :


appel téléphonique ;


WhatsApp ;


email ;


visite physique ;


formulaire web ;


recommandation ;


contrat existant ;


commande directe ;


appel d’offres ;


renouvellement.


Statut initial :


prospect


demande_reçue


en_analyse


Actions :


identifier le client ;


créer ou retrouver la fiche client ;


qualifier le besoin ;


préciser produit, service ou contrat ;


vérifier disponibilité ;


vérifier prix ;


vérifier conditions de paiement ;


vérifier délai demandé.


Pièces possibles :


demande écrite ;


message WhatsApp ;


email ;


cahier des charges ;


appel d’offres ;


bon de commande client ;


contrat existant.



3.2 Proposition commerciale / Devis
Statuts du devis :


brouillon


envoyé


vu_par_client


en_négociation


accepté


refusé


expiré


annulé


converti_en_facture


Contenu du devis :


numéro unique ;


date ;


client ;


objet ;


produits ;


services ;


quantités ;


prix unitaires ;


remises ;


taxes ;


total HT ;


total taxes ;


total TTC ;


délai de validité ;


délai de livraison ;


conditions de paiement ;


modalités de livraison ;


responsable commercial ;


signature/cachet si nécessaire.


Omissions fréquentes :


devis sans durée de validité ;


devis non numéroté ;


devis modifié sans historique ;


remise accordée sans validation ;


devis accepté oralement sans trace ;


devis accepté mais non converti en facture.



3.3 Validation client
Cas possibles :
Client accepte
Actions :


enregistrer acceptation ;


joindre preuve ;


convertir en commande ou facture ;


réserver stock si produit ;


planifier service si service ;


créer échéancier si paiement en plusieurs fois ;


créer contrat si vente récurrente.


Preuves possibles :


bon pour accord ;


signature ;


email ;


WhatsApp ;


bon de commande ;


avance payée ;


contrat signé.


Client refuse
Actions :


enregistrer motif ;


clôturer opportunité ;


garder historique ;


éventuellement programmer relance future.


Motifs :


prix élevé ;


délai trop long ;


concurrent choisi ;


besoin annulé ;


budget indisponible ;


conditions refusées.


Client ne répond pas
Actions :


relance automatique ;


statut sans_réponse ;


relance J+1, J+3, J+7, J+15 ;


clôture automatique si silence prolongé.


Client demande modification
Actions :


créer version du devis ;


ne pas écraser l’ancien ;


tracer auteur et date ;


recalculer prix ;


revalider si remise importante.



4. Workflow facture client
4.1 Création facture
Déclencheurs :


devis accepté ;


bon de commande reçu ;


vente comptoir ;


livraison effectuée ;


service réalisé ;


échéance contrat atteinte ;


abonnement mensuel ;


paiement d’avance ;


facture proforma convertie.


Types de facture :


facture proforma ;


facture définitive ;


facture d’acompte ;


facture de solde ;


facture récurrente ;


facture d’avoir ;


facture corrective ;


facture partielle ;


facture globale ;


facture de service ;


facture de produit ;


facture mixte produit + service.


Statuts :


brouillon


émise


envoyée


partiellement_payée


payée


en_retard


contestée


annulée


avoir_émis


irrécouvrable


Champs essentiels :


numéro facture ;


client ;


date facture ;


date échéance ;


objet ;


lignes produit/service ;


remise ;


taxes ;


total ;


montant payé ;


reste à payer ;


mode de paiement attendu ;


commercial ;


pièce liée : devis, contrat, bon de commande ;


statut ;


historique d’envoi.


Omissions fréquentes :


facture sans date d’échéance ;


facture modifiée après émission sans avoir ;


facture supprimée au lieu d’être annulée ;


paiement reçu mais facture encore ouverte ;


facture payée sans pièce d’encaissement ;


facture envoyée sans preuve d’envoi.



5. Workflow encaissement
5.1 Déclencheurs d’encaissement
Un encaissement peut venir de :


paiement facture client ;


acompte client ;


avance client ;


vente comptoir ;


remboursement fournisseur ;


apport associé ;


prêt reçu ;


subvention ;


dépôt bancaire ;


régularisation caisse ;


compensation ;


troc valorisé ;


mobile money ;


virement ;


chèque ;


espèces ;


carte bancaire ;


paiement en ligne.



5.2 Création encaissement
Statuts :


brouillon


en_attente_validation


validé


rejeté


annulé


rapproché


partiellement_affecté


Champs nécessaires :


numéro encaissement ;


date ;


client ou origine ;


facture liée ;


contrat lié ;


montant ;


devise ;


mode de paiement ;


compte destination : caisse, banque, mobile money ;


référence transaction ;


pièce justificative ;


agent ayant reçu ;


validateur ;


commentaire ;


statut.


Modes de paiement :


espèces ;


chèque ;


virement bancaire ;


mobile money ;


carte ;


compensation ;


avoir ;


troc ;


dépôt direct ;


paiement mixte.



5.3 Affectation du paiement
Cas possibles :
Paiement exact


facture passe à payée ;


encaissement passe à validé ;


caisse/banque augmente ;


écriture comptable générée ;


reçu généré.


Paiement partiel


facture passe à partiellement_payée ;


reste à payer calculé ;


échéancier mis à jour ;


relance future programmée.


Paiement supérieur
Options :


créer avoir client ;


affecter à autre facture ;


enregistrer trop-perçu ;


rembourser client ;


créer solde créditeur client.


Paiement sans facture
Options :


acompte ;


avance client ;


dépôt ;


paiement à affecter ;


erreur à régulariser.


Statut recommandé :


non_affecté


à_lettrer


Omission fréquente :
Recevoir l’argent sans savoir à quelle facture l’affecter. C’est une source directe de désordre comptable.

5.4 Validation encaissement
Règles :


celui qui encaisse ne doit pas forcément être celui qui valide ;


tout encaissement doit avoir un justificatif ;


toute modification après validation doit créer une trace ;


annulation possible uniquement avec motif ;


suppression interdite après validation.


Contrôles :


montant > 0 ;


facture existante si paiement facture ;


mode de paiement renseigné ;


référence obligatoire pour virement, chèque, mobile money ;


caisse ou banque destination obligatoire ;


pièce jointe obligatoire selon seuil ;


devise cohérente.



5.5 Reçu client
Après validation :


génération reçu ;


impression possible ;


envoi email ;


envoi WhatsApp ;


signature/cachet ;


QR code éventuel ;


lien vers facture ;


référence encaissement.


Omission fréquente :


encaisser sans remettre de reçu ;


remettre un reçu manuel non synchronisé avec le système.



6. Workflow décaissement
6.1 Déclencheurs de décaissement
Un décaissement peut venir de :


paiement fournisseur ;


achat comptant ;


salaire ;


avance salaire ;


remboursement employé ;


frais mission ;


loyer ;


carburant ;


transport ;


douane ;


internet ;


électricité ;


eau ;


maintenance ;


sous-traitance ;


impôts/taxes ;


remboursement client ;


retrait bancaire ;


transfert caisse ;


achat immobilisation ;


achat stock ;


frais bancaires ;


paiement crédit/prêt.



6.2 Demande de dépense
Statuts :


brouillon


soumise


en_validation


approuvée


rejetée


annulée


payée


justifiée


non_justifiée


Champs :


demandeur ;


service ;


motif ;


bénéficiaire ;


fournisseur ;


montant estimé ;


urgence ;


catégorie ;


centre de coût ;


projet ;


pièce jointe ;


date souhaitée ;


mode de paiement proposé ;


commentaire.


Catégories :


achat marchandise ;


achat consommable ;


prestation ;


salaire ;


avance ;


mission ;


loyer ;


taxe ;


transport ;


carburant ;


maintenance ;


remboursement ;


autre.



6.3 Validation de dépense
Niveaux possibles :


demandeur ;


chef de service ;


direction ;


finance ;


caisse ;


comptabilité.


Règles par montant :


petit montant : validation simple ;


montant moyen : responsable + finance ;


gros montant : direction obligatoire ;


dépense exceptionnelle : justification renforcée ;


fournisseur nouveau : validation administrative.


Contrôles :


budget disponible ;


fournisseur valide ;


facture ou proforma jointe ;


dépense conforme ;


doublon inexistant ;


montant cohérent ;


autorisation suffisante.


Omissions fréquentes :


payer avant validation ;


valider sans budget ;


ne pas tracer le validateur ;


ne pas distinguer demande de dépense et paiement réel.



6.4 Paiement
Statuts paiement :


à_payer


en_cours


payé


échec_paiement


annulé


remboursé


Champs paiement :


montant payé ;


date paiement ;


caisse ou banque source ;


mode paiement ;


référence ;


bénéficiaire ;


pièce de paiement ;


agent payeur ;


validateur ;


solde avant ;


solde après.


Modes :


espèces ;


chèque ;


virement ;


mobile money ;


carte ;


compensation ;


transfert interne.


Après paiement :


caisse/banque diminue ;


dette fournisseur diminue ;


facture fournisseur passe à payée ou partiellement payée ;


écriture comptable créée ;


pièce de décaissement générée.



6.5 Justification après décaissement
Très important pour les avances, missions, achats terrain.
Statuts justification :


à_justifier


justification_partielle


justifiée


écart_à_rembourser


complément_à_payer


non_justifiée


Cas :
Montant utilisé = montant reçu


dossier clôturé.


Montant utilisé < montant reçu


reliquat à rembourser ;


encaissement de remboursement créé.


Montant utilisé > montant reçu


complément à payer ;


nouvelle demande de décaissement.


Aucune pièce


alerte ;


blocage éventuel du demandeur ;


escalade direction.


Omission fréquente :
Donner de l’argent pour une mission ou un achat sans contrôler la justification ensuite.

7. Workflow achat
7.1 Expression du besoin
Déclencheurs :


stock minimum atteint ;


demande service ;


commande client ;


contrat à exécuter ;


panne ;


besoin administratif ;


achat récurrent ;


projet ;


remplacement équipement.


Statuts :


besoin_identifié


demande_achat_brouillon


demande_achat_soumise


validée


rejetée


transformée_en_bon_commande


Champs :


demandeur ;


service ;


produit/service demandé ;


quantité ;


justification ;


urgence ;


budget ;


fournisseur suggéré ;


date souhaitée ;


pièce jointe.



7.2 Consultation fournisseur
Actions :


demander devis ;


comparer offres ;


vérifier disponibilité ;


vérifier délai ;


vérifier conditions ;


négocier prix ;


choisir fournisseur.


Documents :


demande de prix ;


devis fournisseur ;


tableau comparatif ;


note de sélection ;


validation direction.


Statuts :


consultation_en_cours


devis_reçus


comparaison_effectuée


fournisseur_sélectionné


abandonné


Omissions fréquentes :


choisir un fournisseur sans comparaison ;


ne pas conserver les devis concurrents ;


ne pas expliquer pourquoi un fournisseur est retenu.



7.3 Bon de commande fournisseur
Statuts :


brouillon


soumis


validé


envoyé


accepté_fournisseur


partiellement_livré


livré


annulé


clôturé


Champs :


numéro BC ;


fournisseur ;


lignes produits/services ;


quantités ;


prix ;


taxes ;


total ;


délai livraison ;


lieu livraison ;


conditions paiement ;


responsable achat ;


validation ;


signature/cachet.


Règle :

Aucun achat sérieux ne devrait être payé sans lien avec une demande, un devis ou un bon de commande, sauf petite caisse autorisée.


7.4 Réception
Achat produit
Actions :


recevoir marchandise ;


contrôler quantité ;


contrôler qualité ;


vérifier conformité BC ;


enregistrer bon de réception ;


mettre stock à jour ;


signaler écart ;


refuser si non conforme.


Statuts :


non_reçu


réception_partielle


réception_totale


écart_quantité


non_conforme


retourné


accepté


Achat service
Actions :


vérifier service réalisé ;


valider livrable ;


joindre rapport ;


obtenir validation demandeur ;


autoriser facture fournisseur.


Omissions fréquentes :


payer sans réception ;


entrer en stock sans contrôle ;


réceptionner moins que commandé sans signaler ;


ne pas gérer les livraisons partielles.



7.5 Facture fournisseur
Statuts :


reçue


à_vérifier


validée


contestée


partiellement_payée


payée


annulée


Contrôles :


facture fournisseur correspond au BC ;


facture correspond à la réception ;


prix conforme ;


quantité conforme ;


taxes conformes ;


fournisseur correct ;


doublon facture inexistant.


Principe important :

Paiement fournisseur = facture validée + réception confirmée + autorisation paiement.


8. Workflow vente produit
Étapes


demande client ;


devis ou vente directe ;


vérification stock ;


réservation stock ;


facture ;


paiement ou crédit ;


livraison ;


sortie stock ;


reçu ;


comptabilisation ;


clôture.


Statuts vente produit :


brouillon


en_attente_stock


stock_réservé


facturée


payée


livraison_en_cours


livrée


partiellement_livrée


annulée


retournée


clôturée


Contrôles :


ne pas vendre plus que le stock disponible ;


stock réservé ≠ stock livré ;


livraison doit créer sortie stock ;


retour client doit créer entrée stock ou perte ;


facture doit rester liée à la livraison.


Omissions fréquentes :


stock vendu mais non sorti ;


produit sorti mais facture non payée ;


retour client non enregistré ;


livraison partielle non suivie.



9. Workflow vente service
Étapes


demande client ;


devis ;


validation client ;


ordre de service ;


planification ;


exécution ;


validation service fait ;


facturation ;


encaissement ;


clôture.


Statuts :


demande_reçue


devis_envoyé


accepté


planifié


en_cours


réalisé


validé_client


facturé


payé


clôturé


contesté


Documents :


devis ;


ordre de mission ;


rapport d’intervention ;


PV de réception ;


fiche de présence ;


photos avant/après ;


facture ;


reçu.


Omissions fréquentes :


facturer un service sans preuve de réalisation ;


ne pas faire signer la réception ;


ne pas suivre les réclamations ;


ne pas calculer la marge réelle du service.



10. Workflow contrat
Types de contrats


contrat client ;


contrat fournisseur ;


contrat de prestation ;


contrat de maintenance ;


abonnement ;


location ;


bail ;


contrat salarial ;


contrat cadre ;


contrat avec paiement récurrent ;


contrat avec échéancier ;


contrat avec tacite reconduction.



10.1 Création contrat
Champs essentiels :


numéro contrat ;


partie concernée ;


type contrat ;


objet ;


date début ;


date fin ;


durée ;


renouvellement automatique ou non ;


montant ;


périodicité ;


conditions paiement ;


pénalités ;


obligations ;


documents joints ;


signataires ;


statut.


Statuts :


brouillon


en_validation


signé


actif


suspendu


résilié


expiré


renouvelé


clôturé


litige


Omissions fréquentes :


contrat signé mais non activé dans le système ;


contrat actif sans facturation automatique ;


contrat expiré mais toujours exécuté ;


absence d’alerte avant échéance ;


pas de document signé attaché.



11. Workflow paiement récurrent
Cas concernés


abonnement mensuel ;


contrat de maintenance ;


location ;


assurance ;


internet ;


logiciel ;


crédit ;


salaire ;


prestation périodique ;


leasing ;


remboursement échelonné ;


cotisation ;


service renouvelable.



11.1 Paramétrage récurrence
Champs :


contrat lié ;


client/fournisseur/employé ;


montant ;


périodicité : jour, semaine, mois, trimestre, semestre, année ;


date prochaine échéance ;


date fin ;


nombre d’échéances ;


mode de facturation ;


mode de paiement prévu ;


rappel avant échéance ;


pénalité retard ;


statut.


Statuts :


actif


suspendu


terminé


en_retard


annulé



11.2 Génération automatique
À chaque échéance :


créer facture client si contrat client ;


créer dette fournisseur si contrat fournisseur ;


créer décaissement prévu si charge récurrente ;


créer alerte ;


créer tâche de suivi ;


mettre à jour prochaine échéance.


Exemples :
Contrat client mensuel


facture générée automatiquement chaque mois ;


client notifié ;


échéance suivie ;


retard déclenche relance.


Loyer bureau


décaissement prévu chaque mois ;


validation paiement ;


pièce justificative ;


classement charge.


Salaire


bulletin généré ;


validation paie ;


décaissement salaire ;


reçu ou preuve paiement.


Omissions fréquentes :


oublier les abonnements ;


payer deux fois une charge récurrente ;


ne pas arrêter une récurrence après résiliation ;


ne pas alerter avant échéance ;


ne pas distinguer facture générée et paiement reçu.



12. Synchronisation caisse, banque, mobile money
Comptes financiers
Types :


caisse principale ;


caisse secondaire ;


caisse projet ;


banque ;


mobile money ;


compte carte ;


coffre ;


compte d’attente ;


compte compensation.


Chaque compte doit avoir :


solde initial ;


entrées ;


sorties ;


solde théorique ;


solde réel ;


écarts ;


responsable ;


devise ;


historique.



Mouvements
Encaissement


augmente caisse / banque / mobile money.


Décaissement


diminue caisse / banque / mobile money.


Transfert interne
Exemple : caisse vers banque.
Il faut deux mouvements liés :


sortie caisse ;


entrée banque.


Statuts :


initié


validé_sortie


validé_entrée


rapproché


écart


annulé


Omission fréquente :


enregistrer seulement la sortie caisse sans entrée banque ;


déposer de l’argent en banque sans bordereau ;


ne pas rapprocher avec relevé bancaire.



13. Rapprochement bancaire / caisse
Rapprochement caisse
Fréquence :


quotidien ;


hebdomadaire ;


mensuel ;


à chaque changement de caissier.


Contrôles :


solde logiciel ;


argent physique ;


justificatifs ;


écarts ;


signature caissier ;


validation responsable.


Statuts :


conforme


écart_positif


écart_négatif


à_expliquer


validé


corrigé


Rapprochement bancaire
Contrôles :


relevé bancaire ;


virements entrants ;


virements sortants ;


frais bancaires ;


chèques non débités ;


dépôts non crédités ;


erreurs banque ;


opérations en attente.


Omissions fréquentes :


considérer qu’un virement annoncé est déjà encaissé ;


ne pas gérer les chèques en attente ;


ne pas saisir les frais bancaires ;


ne pas rapprocher mobile money.



14. Comptabilité / Journal
Chaque événement validé doit créer une écriture ou au minimum une ligne de journal.
Événements comptables


facture client émise ;


encaissement validé ;


facture fournisseur validée ;


décaissement validé ;


achat stock réceptionné ;


sortie stock ;


salaire validé ;


avance ;


remboursement ;


avoir ;


perte stock ;


transfert interne ;


frais bancaire ;


écart caisse ;


annulation.


Statut des écritures


brouillon


générée


validée


verrouillée


annulée_par_extourne


Principe :

Après validation comptable, on ne modifie pas silencieusement. On corrige par écriture inverse, avoir, extourne ou régularisation.

Omissions fréquentes :


supprimer une opération validée ;


modifier le passé sans trace ;


ne pas séparer brouillon et validé ;


ne pas verrouiller les périodes clôturées.



15. Statuts normalisés à utiliser
Statuts généraux


brouillon


soumis


en_validation


validé


rejeté


annulé


clôturé


archivé


Paiement


non_payé


partiellement_payé


payé


en_retard


surpayé


remboursé


Livraison / réception


non_livré


partiellement_livré


livré


retourné


non_conforme


Contrat


brouillon


signé


actif


suspendu


expiré


résilié


renouvelé


Stock


disponible


réservé


sorti


retourné


endommagé


perdu


expiré



16. Règles de synchronisation importantes
Vente → Facture
Une vente acceptée doit pouvoir générer :


facture ;


livraison ;


réservation stock ;


tâche service ;


contrat ;


échéancier.


Facture → Encaissement
Une facture payée doit synchroniser :


montant payé ;


reste à payer ;


statut facture ;


reçu ;


caisse/banque ;


journal ;


relance désactivée.


Achat → Réception → Stock
Un achat produit doit synchroniser :


commande fournisseur ;


réception ;


entrée stock ;


dette fournisseur ;


facture fournisseur.


Facture fournisseur → Décaissement
Une facture fournisseur validée doit synchroniser :


dette fournisseur ;


paiement ;


caisse/banque ;


journal ;


statut facture.


Contrat → Facturation récurrente
Un contrat actif doit synchroniser :


échéances ;


factures automatiques ;


alertes ;


relances ;


suspension en cas d’impayé ;


renouvellement ou expiration.


Stock → Vente
Le stock doit bloquer ou alerter si :


stock insuffisant ;


stock réservé ;


stock minimum atteint ;


produit expiré ;


produit non disponible.



17. Alertes, rappels, notifications
Alertes commerciales


devis non relancé ;


devis expirant bientôt ;


client sans réponse ;


facture envoyée non vue ;


facture proche échéance ;


facture en retard ;


client dépasse plafond crédit.


Alertes finance


décaissement à valider ;


paiement fournisseur en attente ;


facture fournisseur échue ;


caisse négative ;


solde banque insuffisant ;


encaissement non affecté ;


écart caisse ;


rapprochement non fait.


Alertes achat


demande achat non traitée ;


fournisseur non validé ;


commande en retard ;


réception partielle ;


facture fournisseur sans réception ;


stock minimum atteint.


Alertes contrat


contrat expire bientôt ;


renouvellement automatique proche ;


échéance à facturer ;


paiement récurrent en retard ;


contrat actif sans facture ;


contrat signé sans document joint.


Alertes stock


stock bas ;


stock nul ;


produit expirant bientôt ;


écart inventaire ;


sortie non justifiée ;


retour client en attente contrôle.



18. Exceptions à prévoir
Client


paiement partiel ;


trop-perçu ;


facture contestée ;


client demande remboursement ;


client annule après paiement ;


client paie mauvaise facture ;


client paie sans référence ;


client insolvable ;


client change de conditions.


Fournisseur


facture supérieure au bon de commande ;


livraison partielle ;


marchandise non conforme ;


facture doublon ;


paiement échoué ;


acompte versé mais livraison non reçue ;


fournisseur à rembourser ;


litige fournisseur.


Caisse / banque


erreur de saisie ;


écart caisse ;


faux billet ;


chèque impayé ;


virement annoncé non reçu ;


frais bancaire oublié ;


dépôt banque non confirmé ;


mobile money bloqué.


Stock


perte ;


vol ;


casse ;


expiration ;


retour client ;


erreur inventaire ;


transfert entre dépôts ;


produit réservé mais commande annulée.



19. Documents à générer
Vente


fiche client ;


devis ;


bon de commande client ;


facture proforma ;


facture définitive ;


facture d’acompte ;


facture de solde ;


avoir ;


reçu ;


bon de livraison ;


PV de réception ;


contrat ;


échéancier.


Achat


demande d’achat ;


demande de prix ;


tableau comparatif ;


bon de commande fournisseur ;


bon de réception ;


fiche non-conformité ;


facture fournisseur ;


ordre de paiement ;


preuve paiement.


Finance


pièce d’encaissement ;


pièce de décaissement ;


bordereau caisse ;


état caisse ;


rapprochement bancaire ;


état mobile money ;


journal ;


rapport impayés ;


rapport dettes fournisseurs.


Stock


fiche produit ;


bon d’entrée ;


bon de sortie ;


bon de transfert ;


inventaire ;


fiche écart ;


fiche retour ;


fiche casse/perte.



20. Permissions et rôles
Commercial
Peut :


créer client ;


créer devis ;


suivre relances ;


consulter factures clients.


Ne devrait pas :


valider paiement ;


modifier facture payée ;


supprimer client avec historique.


Caissier
Peut :


enregistrer encaissement ;


enregistrer décaissement autorisé ;


imprimer reçu ;


clôturer caisse.


Ne devrait pas :


valider seul ses propres opérations sensibles ;


supprimer une opération ;


modifier une facture.


Finance / Comptabilité
Peut :


valider paiements ;


rapprocher banque ;


suivre dettes/créances ;


valider journal ;


gérer avoirs ;


contrôler caisse.


Achat
Peut :


créer demande achat ;


consulter fournisseurs ;


gérer bons de commande ;


suivre réceptions.


Direction
Peut :


valider grosses dépenses ;


approuver remises exceptionnelles ;


consulter tableaux de bord ;


annuler avec motif ;


clôturer période.


Admin système
Peut :


gérer utilisateurs ;


gérer paramètres ;


gérer droits ;


accéder aux logs.


Ne devrait pas :


modifier les opérations métier sans trace.



21. Tableaux de bord nécessaires
Direction


chiffre d’affaires ;


encaissements ;


décaissements ;


bénéfice brut ;


créances clients ;


dettes fournisseurs ;


trésorerie ;


ventes par produit/service ;


dépenses par catégorie ;


contrats actifs ;


impayés ;


alertes critiques.


Commercial


devis envoyés ;


devis acceptés ;


taux conversion ;


clients à relancer ;


ventes du mois ;


factures impayées par client.


Finance


solde caisse ;


solde banque ;


paiements à valider ;


factures échues ;


dettes fournisseurs ;


rapprochements en attente ;


écarts caisse.


Achat / Stock


demandes achat ;


commandes en cours ;


réceptions attendues ;


stock bas ;


produits expirants ;


écarts inventaire.



22. Automatisations utiles
Automatisations vente


transformer devis accepté en facture ;


relancer devis non répondu ;


relancer facture avant échéance ;


bloquer client mauvais payeur ;


créer tâche commerciale après refus.


Automatisations achat


alerte stock minimum ;


génération demande achat ;


rappel commande fournisseur en retard ;


blocage paiement si réception absente.


Automatisations finance


reçu automatique après encaissement validé ;


alerte décaissement non justifié ;


rapprochement assisté ;


verrouillage période clôturée ;


rapport quotidien caisse.


Automatisations contrat


facture récurrente automatique ;


rappel renouvellement ;


suspension contrat si impayé ;


notification fin contrat ;


génération échéancier.



23. Règles anti-fraude et contrôle interne
À intégrer dès le départ :


aucune suppression physique des opérations validées ;


toute annulation exige un motif ;


journal d’audit obligatoire ;


séparation demandeur / validateur / payeur ;


plafond par utilisateur ;


double validation au-delà d’un seuil ;


pièces justificatives obligatoires ;


verrouillage des périodes clôturées ;


numérotation automatique ;


détection doublons facture ;


détection paiements suspects ;


historique des modifications ;


sauvegarde automatique ;


export journalier ;


rapprochement obligatoire.



24. Journal d’audit
Chaque action sensible doit enregistrer :


utilisateur ;


date/heure ;


action ;


module ;


ancien état ;


nouvel état ;


motif ;


adresse IP si application web ;


pièce concernée.


Actions à auditer :


création facture ;


modification facture ;


annulation facture ;


validation paiement ;


annulation paiement ;


changement prix ;


changement remise ;


création fournisseur ;


changement RIB ;


changement stock ;


clôture caisse ;


clôture période ;


suppression brouillon ;


changement rôle utilisateur.



25. Processus complet résumé
Vente produit
Demande client→ Devis→ Acceptation→ Réservation stock→ Facture→ Encaissement→ Livraison→ Sortie stock→ Reçu→ Journal→ Clôture
Vente service
Demande client→ Devis→ Acceptation→ Planification→ Exécution service→ Validation service fait→ Facture→ Encaissement→ Reçu→ Journal→ Clôture
Contrat récurrent client
Contrat signé→ Activation→ Génération échéances→ Facture automatique→ Relance→ Encaissement→ Mise à jour contrat→ Renouvellement / expiration
Achat produit
Besoin→ Demande achat→ Validation→ Consultation fournisseur→ Bon de commande→ Réception→ Entrée stock→ Facture fournisseur→ Validation→ Décaissement→ Journal→ Clôture
Achat service
Besoin→ Demande achat→ Validation→ Commande service→ Service réalisé→ Validation service fait→ Facture fournisseur→ Décaissement→ Journal→ Clôture
Décaissement simple
Demande dépense→ Validation→ Paiement→ Justificatif→ Journal→ Clôture
Encaissement simple
Paiement reçu→ Identification origine→ Affectation facture/contrat/client→ Validation→ Reçu→ Mise à jour caisse/banque→ Journal→ Clôture

26. Données minimales à prévoir en base
Tables principales :


clients ;


fournisseurs ;


produits ;


services ;


contrats ;


devis ;


devis_lignes ;


factures_clients ;


factures_clients_lignes ;


encaissements ;


achats_demandes ;


bons_commandes_fournisseurs ;


receptions ;


factures_fournisseurs ;


decaissements ;


stock_mouvements ;


comptes_financiers ;


rapprochements ;


echeances ;


relances ;


documents ;


journal_comptable ;


audit_logs ;


utilisateurs ;


roles ;


paramètres.


Tables souvent oubliées :


paiements_affectations ;


trop_percus ;


avoirs ;


retours_clients ;


litiges ;


validations ;


notifications ;


contrats_echeances ;


caisse_clotures ;


inventaires ;


ecarts_stock ;


transferts_internes ;


justificatifs_depenses.



27. Formulaires indispensables
Formulaire client


identité ;


contacts ;


conditions paiement ;


documents ;


historique.


Formulaire devis


client ;


objet ;


lignes ;


remises ;


validité ;


conditions.


Formulaire facture


client ;


source ;


lignes ;


échéance ;


statut ;


paiements liés.


Formulaire encaissement


origine ;


facture ;


montant ;


mode ;


compte destination ;


référence ;


pièce.


Formulaire demande achat


besoin ;


demandeur ;


urgence ;


budget ;


justification.


Formulaire bon de commande


fournisseur ;


lignes ;


prix ;


délai ;


validation.


Formulaire réception


commande ;


quantités reçues ;


écarts ;


conformité ;


stock.


Formulaire décaissement


bénéficiaire ;


motif ;


montant ;


mode ;


compte source ;


pièce ;


validation.


Formulaire contrat


parties ;


objet ;


durée ;


montant ;


récurrence ;


échéances ;


documents.



28. Ce qui est souvent oublié mais important
Liste directe :


gestion des acomptes ;


gestion des trop-perçus ;


gestion des avoirs ;


gestion des paiements partiels ;


gestion des paiements mixtes ;


gestion des factures contestées ;


gestion des chèques impayés ;


gestion des virements annoncés mais non reçus ;


gestion des factures fournisseurs doublons ;


gestion des avances fournisseurs ;


gestion des avances employés ;


justification des dépenses ;


validation des remises ;


plafond crédit client ;


blocage client mauvais payeur ;


stock réservé ;


livraison partielle ;


réception partielle ;


retour produit ;


perte stock ;


expiration produit ;


transfert entre caisses ;


transfert caisse vers banque ;


rapprochement mobile money ;


clôture caisse ;


clôture comptable ;



verrouillage période ;


audit des modifications ;


numérotation automatique ;


signatures et documents joints ;


alertes avant échéance ;


relances après échéance ;


contrats sans facture ;


factures sans paiement ;


paiements non affectés ;


dépenses sans justificatif ;


fournisseur payé sans réception ;


service facturé sans PV de réalisation.



29. Structure de statuts recommandée
Devis
brouillonenvoyévuen_négociationacceptérefuséexpiréconvertiannulé
Facture client
brouillonémiseenvoyéepartiellement_payéepayéeen_retardcontestéeannuléeavoir_émis
Encaissement
brouillonen_attente_validationvalidérejetéannuléaffecténon_affectérapproché
Demande achat
brouillonsoumisevalidéerejetéetransformée_en_commandeannulée
Bon de commande fournisseur
brouillonvalidéenvoyéacceptépartiellement_livrélivréannuléclôturé
Facture fournisseur
reçueà_vérifiervalidéecontestéepartiellement_payéepayéeannulée
Décaissement
brouillonsoumisvalidépayéà_justifierjustifiérejetéannulé
Contrat
brouillonen_validationsignéactifsuspendurésiliéexpirérenouveléclôturé

30. Architecture logique de synchronisation
CLIENT  ↓DEVIS  ↓COMMANDE / CONTRAT  ↓FACTURE CLIENT  ↓ENCAISSEMENT  ↓CAISSE / BANQUE / MOBILE MONEY  ↓JOURNAL / COMPTABILITÉ
BESOIN INTERNE  ↓DEMANDE ACHAT  ↓BON COMMANDE FOURNISSEUR  ↓RÉCEPTION PRODUIT / SERVICE FAIT  ↓FACTURE FOURNISSEUR  ↓DÉCAISSEMENT  ↓CAISSE / BANQUE / MOBILE MONEY  ↓JOURNAL / COMPTABILITÉ
PRODUIT  ↓STOCK  ↓VENTE  ↓SORTIE STOCK  ↓LIVRAISON  ↓FACTURE  ↓ENCAISSEMENT
CONTRAT ACTIF  ↓ÉCHÉANCIER  ↓FACTURE RÉCURRENTE  ↓RELANCE / ENCAISSEMENT  ↓RENOUVELLEMENT / SUSPENSION / RÉSILIATION

31. Verdict opérationnel
Le processus complet doit reposer sur 6 règles :


Rien ne doit être payé sans origine claire.
Facture, contrat, achat, demande, salaire, remboursement ou justification.


Rien ne doit être encaissé sans affectation.
Facture, acompte, avance, trop-perçu ou compte d’attente.


Rien ne doit être livré sans impact stock.


Rien ne doit être validé sans trace.


Rien ne doit être supprimé après validation.


Toute opération financière doit toucher automatiquement caisse, banque, journal, statut et historique.


Sinon, ce n’est pas un workflow d’entreprise. C’est une saisie dispersée.