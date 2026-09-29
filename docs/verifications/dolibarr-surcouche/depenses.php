<?php
/*
 * Étape 5 de la vérification « surcouche » (bac à sable, 29/09/2026) :
 * les décaissements, par le code des classes d'API REST de Dolibarr.
 *   a. une dépense de caisse (carburant, 50 000 XAF, sans TVA) : un service
 *      « Carburant » portant son compte de charge (6053), une facture
 *      fournisseur, sa validation, son paiement en caisse ;
 *   b. un salaire net payé en caisse (150 000 XAF) : un salaire et son paiement.
 * Idempotent. Tiers, service et salaire portent « ESSAI SMI ».
 * Le bénéficiaire du salaire est l'administrateur du bac à sable : aucun
 * compte utilisateur n'est créé pour l'essai.
 */
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';
require_once DOL_DOCUMENT_ROOT.'/includes/restler/framework/Luracast/Restler/AutoLoader.php';
require_once DOL_DOCUMENT_ROOT.'/api/class/api.class.php';
require_once DOL_DOCUMENT_ROOT.'/api/class/api_access.class.php';
require_once DOL_DOCUMENT_ROOT.'/societe/class/api_thirdparties.class.php';
require_once DOL_DOCUMENT_ROOT.'/product/class/api_products.class.php';
require_once DOL_DOCUMENT_ROOT.'/fourn/class/api_supplier_invoices.class.php';
require_once DOL_DOCUMENT_ROOT.'/salaries/class/api_salaries.class.php';

function etape($m) { echo '  '.$m."\n"; }
function valeur($db, $sql) { $r = $db->query($sql); $o = $r ? $db->fetch_row($r) : null; return $o ? $o[0] : null; }
function echec($quoi, $e) {
	etape('ERREUR '.$quoi.' : code '.$e->getCode().' '.$e->getMessage().' '.json_encode(method_exists($e, 'getDetails') ? $e->getDetails() : null));
	exit(1);
}

$login = valeur($db, 'SELECT login FROM '.MAIN_DB_PREFIX.'user WHERE admin = 1 AND statut = 1 ORDER BY rowid LIMIT 1');
$user->fetch(0, $login, '', 1);
$user->loadRights();
DolibarrApiAccess::$user = $user;
$caisse = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."bank_account WHERE ref = 'CAISSE'");
$especes = (int) valeur($db, "SELECT id FROM ".MAIN_DB_PREFIX."c_paiement WHERE code = 'LIQ'");

// a. Dépense de carburant.
$nom = 'ESSAI SMI - fournisseur';
$fournisseur = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."societe WHERE nom = '".$db->escape($nom)."'");
if (!$fournisseur) {
	try {
		$fournisseur = (int) (new Thirdparties())->post(['name' => $nom, 'fournisseur' => 1, 'code_fournisseur' => -1, 'country_id' => 72, 'note_private' => 'Verification surcouche SMI du 29/09/2026 - a supprimer']);
		etape('POST /thirdparties -> fournisseur #'.$fournisseur);
	} catch (Exception $e) { echec('fournisseur', $e); }
}

$service = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."product WHERE ref = 'SMI-CARBURANT'");
if (!$service) {
	try {
		// La catégorie SMI « Carburant » devient un service Dolibarr qui porte son compte de charge.
		$service = (int) (new Products())->post(['ref' => 'SMI-CARBURANT', 'label' => 'ESSAI SMI - Carburant', 'type' => 1, 'status' => 1, 'status_buy' => 1, 'accountancy_code_buy' => '6053']);
		etape('POST /products -> service Carburant #'.$service.' (compte d achat 6053)');
	} catch (Exception $e) { echec('service', $e); }
}

$refFournisseur = 'SMI-DEC-CARB-1';
$facture = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."facture_fourn WHERE ref_supplier = '".$refFournisseur."'");
if (!$facture) {
	try {
		$facture = (int) (new SupplierInvoices())->post(['socid' => $fournisseur, 'ref_supplier' => $refFournisseur, 'date' => dol_mktime(12, 0, 0, 2, 10, 2026), 'type' => 0, 'label' => 'Carburant']);
		etape('POST /supplierinvoices -> facture #'.$facture);
		(new SupplierInvoices())->postLine($facture, ['description' => 'Carburant', 'pu_ht' => 50000, 'tva_tx' => 0, 'qty' => 1, 'fk_product' => $service, 'product_type' => 1]);
		etape('POST /supplierinvoices/'.$facture.'/lines -> ligne ajoutee');
		(new SupplierInvoices())->validate($facture);
		etape('POST /supplierinvoices/'.$facture.'/validate -> '.valeur($db, 'SELECT ref FROM '.MAIN_DB_PREFIX.'facture_fourn WHERE rowid = '.$facture));
	} catch (Exception $e) { echec('facture fournisseur', $e); }
}
if (!(int) valeur($db, 'SELECT paye FROM '.MAIN_DB_PREFIX.'facture_fourn WHERE rowid = '.$facture)) {
	try {
		$p = (new SupplierInvoices())->addPayment($facture, dol_mktime(12, 0, 0, 2, 10, 2026), $especes, 'yes', $caisse, '', 'SMI decaissement carburant');
		etape('POST /supplierinvoices/'.$facture.'/payments -> paiement #'.$p);
	} catch (Exception $e) { echec('paiement fournisseur', $e); }
}
$f = $db->fetch_object($db->query('SELECT ref, total_ht, total_ttc, fk_statut, paye FROM '.MAIN_DB_PREFIX.'facture_fourn WHERE rowid = '.$facture));
etape(sprintf('facture fournisseur %s : HT %s, TTC %s, statut %d, payee %d', $f->ref, price2num($f->total_ht), price2num($f->total_ttc), $f->fk_statut, $f->paye));

// b. Salaire net payé en caisse.
// Premier essai (« fevrier ») : paiement créé sans ligne de banque, faute du
// champ fk_typepayment — l'API a pourtant répondu par un succès. Il reste
// dans le bac à sable comme témoin ; l'essai se refait sur « mars ».
$libelle = 'ESSAI SMI - salaire net mars';
$salaire = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."salary WHERE label = '".$db->escape($libelle)."'");
if (!$salaire) {
	try {
		$salaire = (int) (new Salaries())->post([
			'fk_user' => $user->id, 'label' => $libelle, 'amount' => 150000,
			'datesp' => dol_mktime(0, 0, 0, 3, 1, 2026), 'dateep' => dol_mktime(0, 0, 0, 3, 31, 2026),
			'type_payment' => $especes, 'fk_account' => $caisse,
		]);
		etape('POST /salaries -> salaire #'.$salaire);
	} catch (Exception $e) { echec('salaire', $e); }
}
if (!(int) valeur($db, 'SELECT COUNT(*) FROM '.MAIN_DB_PREFIX.'payment_salary WHERE fk_salary = '.$salaire)) {
	try {
		$p = (new Salaries())->addPayment($salaire, [
			'chid' => $salaire,
			'datep' => dol_mktime(12, 0, 0, 3, 31, 2026), 'datepaye' => dol_mktime(12, 0, 0, 3, 31, 2026),
			'amount' => 150000, 'amounts' => [$salaire => 150000],
			// L'API exige « paiementtype » à la validation mais la ligne de
			// banque lit « fk_typepayment » : sans le second, pas de ligne de
			// banque, et l'appel répond quand même par un succès.
			'paiementtype' => $especes, 'fk_typepayment' => $especes, 'accountid' => $caisse,
			'num_payment' => '', 'note' => 'SMI paie fevrier',
		]);
		etape('POST /salaries/'.$salaire.'/payments -> paiement #'.$p);
	} catch (Exception $e) { echec('paiement salaire', $e); }
	// Constaté le 29/09/2026 : l'appel répond, mais sa transaction reste
	// ouverte ; à la fin du processus, tout est annulé.
	$fkBank = (int) valeur($db, 'SELECT fk_bank FROM '.MAIN_DB_PREFIX.'payment_salary WHERE fk_salary = '.$salaire.' ORDER BY rowid DESC LIMIT 1');
	etape('ligne de banque du paiement de salaire : '.($fkBank ? '#'.$fkBank : 'AUCUNE — l API a repondu sans la creer'));
}
$s = $db->fetch_object($db->query('SELECT amount, paye FROM '.MAIN_DB_PREFIX.'salary WHERE rowid = '.$salaire));
etape(sprintf('salaire : montant %s, paye %d', price2num($s->amount), $s->paye));
