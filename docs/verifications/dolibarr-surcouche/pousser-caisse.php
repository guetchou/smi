<?php
/*
 * Étape 2 de la vérification « surcouche » (bac à sable, 29/09/2026).
 * Appelle le code de l'API REST de Dolibarr (classe BankAccounts) comme le
 * ferait Tala SMI, l'administrateur du bac à sable tenant lieu d'appelant :
 *   - un encaissement de caisse « vente au comptant » : POST /bankaccounts/{id}/lines,
 *     avec le compte comptable 706 ;
 *   - un retrait en banque : POST /bankaccounts/transfer, BCH → Caisse.
 * Mêmes montants et dates que les opérations n° 12 et n° 20 de Tala SMI.
 * Idempotent : une ligne déjà poussée n'est pas repoussée.
 */
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';
require_once DOL_DOCUMENT_ROOT.'/includes/restler/framework/Luracast/Restler/AutoLoader.php';
require_once DOL_DOCUMENT_ROOT.'/api/class/api.class.php';
require_once DOL_DOCUMENT_ROOT.'/api/class/api_access.class.php';
require_once DOL_DOCUMENT_ROOT.'/compta/bank/class/api_bankaccounts.class.php';
require_once DOL_DOCUMENT_ROOT.'/compta/bank/class/account.class.php';

function etape($m) { echo '  '.$m."\n"; }
function valeur($db, $sql) { $r = $db->query($sql); $o = $r ? $db->fetch_row($r) : null; return $o ? $o[0] : null; }

$login = valeur($db, 'SELECT login FROM '.MAIN_DB_PREFIX.'user WHERE admin = 1 AND statut = 1 ORDER BY rowid LIMIT 1');
$user->fetch(0, $login, '', 1);
$user->loadRights();
DolibarrApiAccess::$user = $user;

// Compte bancaire BCH (5211), s'il manque.
$idCaisse = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."bank_account WHERE ref = 'CAISSE'");
$idBch = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."bank_account WHERE ref = 'BCH'");
if (!$idBch) {
	$a = new Account($db);
	$a->ref = 'BCH';
	$a->label = 'Banque BCH';
	$a->type = Account::TYPE_CURRENT;
	$a->courant = Account::TYPE_CURRENT;
	$a->currency_code = 'XAF';
	$a->country_id = 72;
	$a->account_number = '5211';
	$a->fk_accountancy_journal = (int) valeur($db, 'SELECT rowid FROM '.MAIN_DB_PREFIX.'accounting_journal WHERE nature = 4 AND active = 1 ORDER BY rowid LIMIT 1');
	$a->date_solde = dol_now();
	$a->solde = 0;
	$idBch = $a->create($user);
	etape('compte Banque BCH : '.($idBch > 0 ? 'cree #'.$idBch : 'ERREUR '.$a->error));
}

$api = new BankAccounts();

$libelleVente = 'SMI op 12 - Recette prestation';
if (!valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."bank WHERE label = '".$db->escape($libelleVente)."'")) {
	try {
		$id = $api->addLine($idCaisse, dol_mktime(12, 0, 0, 1, 13, 2026), 'LIQ', $libelleVente, 1200000, 0, '', '', '', '706');
		etape('POST /bankaccounts/'.$idCaisse.'/lines -> ligne #'.$id);
	} catch (Exception $e) { etape('ERREUR addLine : '.$e->getMessage()); }
} else {
	etape('vente deja poussee');
}

$libelleRetrait = 'SMI op 20 - retrait banque';
if (!valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."bank WHERE label = '".$db->escape($libelleRetrait)."'")) {
	try {
		$r = $api->transfer($idBch, $idCaisse, dol_mktime(12, 0, 0, 2, 5, 2026), $libelleRetrait, 600000);
		etape('POST /bankaccounts/transfer -> '.json_encode($r));
	} catch (Exception $e) { etape('ERREUR transfer : '.$e->getMessage()); }
} else {
	etape('retrait deja pousse');
}

$r = $db->query('SELECT b.rowid, ba.ref, b.dateo, b.amount, b.fk_type, b.label, b.fk_account FROM '.MAIN_DB_PREFIX.'bank b JOIN '.MAIN_DB_PREFIX.'bank_account ba ON ba.rowid = b.fk_account ORDER BY b.rowid');
while ($o = $db->fetch_object($r)) etape(sprintf('ligne #%d %-6s %s %12s %-4s %s', $o->rowid, $o->ref, $o->dateo, price2num($o->amount), $o->fk_type, $o->label));
