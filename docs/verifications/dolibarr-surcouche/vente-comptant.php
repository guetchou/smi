<?php
/*
 * Étape 4 de la vérification « surcouche » (bac à sable, 29/09/2026).
 * La vente au comptant n° 12 de Tala SMI (1 200 000 XAF, espèces, sans TVA),
 * passée comme Dolibarr l'attend : une facture, validée, payée en caisse.
 * Uniquement le code de l'API REST (Thirdparties, Invoices). Idempotent.
 * Le tiers créé porte « ESSAI SMI » : à retirer du bac à sable après l'essai.
 */
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';
require_once DOL_DOCUMENT_ROOT.'/includes/restler/framework/Luracast/Restler/AutoLoader.php';
require_once DOL_DOCUMENT_ROOT.'/api/class/api.class.php';
require_once DOL_DOCUMENT_ROOT.'/api/class/api_access.class.php';
require_once DOL_DOCUMENT_ROOT.'/societe/class/api_thirdparties.class.php';
require_once DOL_DOCUMENT_ROOT.'/compta/facture/class/api_invoices.class.php';

function etape($m) { echo '  '.$m."\n"; }
function valeur($db, $sql) { $r = $db->query($sql); $o = $r ? $db->fetch_row($r) : null; return $o ? $o[0] : null; }

$login = valeur($db, 'SELECT login FROM '.MAIN_DB_PREFIX.'user WHERE admin = 1 AND statut = 1 ORDER BY rowid LIMIT 1');
$user->fetch(0, $login, '', 1);
$user->loadRights();
DolibarrApiAccess::$user = $user;

$nomTiers = 'ESSAI SMI - client comptant';
$socid = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."societe WHERE nom = '".$db->escape($nomTiers)."'");
if (!$socid) {
	try {
		// code_client = -1 : numérotation automatique, comme le formulaire.
		$socid = (int) (new Thirdparties())->post(['name' => $nomTiers, 'client' => 1, 'code_client' => -1, 'country_id' => 72, 'note_private' => 'Cree par la verification surcouche SMI du 29/09/2026 - a supprimer']);
		etape('POST /thirdparties -> tiers #'.$socid);
	} catch (Exception $e) {
		etape('ERREUR tiers : '.$e->getMessage().' '.json_encode(method_exists($e, 'getDetails') ? $e->getDetails() : null));
		exit(1);
	}
}

$refClient = 'SMI-OP-12';
$idFacture = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."facture WHERE ref_client = '".$refClient."'");
$api = new Invoices();
if (!$idFacture) {
	try {
		$idFacture = (int) $api->post([
			'socid' => $socid, 'type' => 0, 'date' => dol_mktime(12, 0, 0, 1, 13, 2026), 'ref_client' => $refClient,
			'lines' => [['desc' => 'Recette prestation', 'subprice' => 1200000, 'qty' => 1, 'tva_tx' => 0, 'product_type' => 1]],
		]);
		etape('POST /invoices -> facture #'.$idFacture);
		$api->validate($idFacture);
		etape('POST /invoices/'.$idFacture.'/validate -> '.valeur($db, 'SELECT ref FROM '.MAIN_DB_PREFIX.'facture WHERE rowid = '.$idFacture));
	} catch (Exception $e) { etape('ERREUR facture : '.$e->getMessage()); exit(1); }
} else {
	etape('facture deja creee #'.$idFacture);
}

// Paiement : un appel d'API distinct, comme deux requêtes HTTP distinctes.
if (!(int) valeur($db, 'SELECT paye FROM '.MAIN_DB_PREFIX.'facture WHERE rowid = '.$idFacture)) {
	try {
		$especes = (int) valeur($db, "SELECT id FROM ".MAIN_DB_PREFIX."c_paiement WHERE code = 'LIQ'");
		$caisse = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."bank_account WHERE ref = 'CAISSE'");
		$p = (new Invoices())->addPayment($idFacture, dol_mktime(12, 0, 0, 1, 13, 2026), $especes, 'yes', $caisse, '', 'SMI op 12');
		etape('POST /invoices/'.$idFacture.'/payments -> paiement #'.$p);
	} catch (Exception $e) { etape('ERREUR paiement : '.$e->getMessage()); exit(1); }
}
$f = $db->fetch_object($db->query('SELECT ref, total_ht, total_ttc, fk_statut, paye FROM '.MAIN_DB_PREFIX.'facture WHERE rowid = '.$idFacture));
etape(sprintf('facture %s : HT %s, TTC %s, statut %d, payee %d', $f->ref, price2num($f->total_ht), price2num($f->total_ttc), $f->fk_statut, $f->paye));
