<?php
/*
 * Configure le bac à sable Dolibarr pour la vérification « surcouche » du
 * 29/09/2026. Uniquement des fonctions de Dolibarr (celles de ses écrans
 * d'administration) ; idempotent ; ne touche ni aux tiers ni aux clés d'API.
 */
// Entite visee (DOLENTITY=2 : Top Center dans une instance partagee) ; 1 par defaut.
if ((int) getenv('DOLENTITY') > 0 && !defined('DOLENTITY')) define('DOLENTITY', (int) getenv('DOLENTITY'));
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';
require_once DOL_DOCUMENT_ROOT.'/core/lib/admin.lib.php';
require_once DOL_DOCUMENT_ROOT.'/compta/bank/class/account.class.php';

function etape($m) { echo '  '.$m."\n"; }
function valeur($db, $sql) { $r = $db->query($sql); $o = $r ? $db->fetch_row($r) : null; return $o ? $o[0] : null; }

$login = valeur($db, 'SELECT login FROM '.MAIN_DB_PREFIX.'user WHERE admin = 1 AND statut = 1 ORDER BY rowid LIMIT 1');
$user->fetch(0, $login, '', 1);
$user->loadRights();
etape('agit en tant que l administrateur du bac a sable');

// 1. Société au Congo, en francs CFA.
dolibarr_set_const($db, 'MAIN_INFO_SOCIETE_COUNTRY', '72:CG:Congo', 'chaine', 0, '', $conf->entity);
dolibarr_set_const($db, 'MAIN_MONNAIE', 'XAF', 'chaine', 0, '', $conf->entity);
etape('pays CG, monnaie XAF');

// 2. Modules.
foreach (['modBanque', 'modFacture', 'modAccounting', 'modProduct', 'modService', 'modFournisseur', 'modSalaries'] as $m) {
	$r = activateModule($m);
	etape($m.' : '.(empty($r['errors']) ? 'actif' : 'ERREUR '.implode(' ; ', $r['errors'])));
}

// 3. Plan SYSCOHADA du Congo, chargé comme le fait accountancy/admin/account.php.
$chart = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."accounting_system WHERE pcg_version = 'SYSCOHADA-CG'");
$deja = (int) valeur($db, "SELECT COUNT(*) FROM ".MAIN_DB_PREFIX."accounting_account WHERE fk_pcg_version = 'SYSCOHADA-CG'".' AND entity = '.((int) $conf->entity));
if (!$deja) {
	$sqlfile = DOL_DOCUMENT_ROOT.'/install/mysql/data/llx_accounting_account_cg.sql';
	$offset = 0;
	$reg = array();
	if (preg_match('/-- ADD (\d+) to rowid/ims', file_get_contents($sqlfile), $reg)) $offset += $reg[1];
	$offset += ($conf->entity * 100000000);
	$res = run_sql($sqlfile, 1, $conf->entity, 1, '', 'default', 32768, 0, $offset);
	etape('chargement du plan : '.($res > 0 ? 'ok' : 'ERREUR'));
}
dolibarr_set_const($db, 'CHARTOFACCOUNTS', $chart, 'chaine', 0, '', $conf->entity);
etape('plan SYSCOHADA-CG (#'.$chart.') : '.valeur($db, "SELECT COUNT(*) FROM ".MAIN_DB_PREFIX."accounting_account WHERE fk_pcg_version = 'SYSCOHADA-CG'".' AND entity = '.((int) $conf->entity)).' comptes');

// 4. Comptes par défaut.
foreach ([
	'ACCOUNTING_ACCOUNT_CUSTOMER' => '411',
	'ACCOUNTING_ACCOUNT_SUPPLIER' => '401',
	'ACCOUNTING_SERVICE_SOLD_ACCOUNT' => '706',
	'ACCOUNTING_ACCOUNT_SUSPENSE' => '471',
	'ACCOUNTING_ACCOUNT_TRANSFER_CASH' => '585',
	// Dépenses : un service sans compte propre tombe en 605 « Autres achats ».
	'ACCOUNTING_SERVICE_BUY_ACCOUNT' => '605',
	// Salaires : le paiement solde 422 « Personnel, rémunérations dues ».
	'SALARIES_ACCOUNTING_ACCOUNT_PAYMENT' => '422',
] as $k => $v) {
	dolibarr_set_const($db, $k, $v, 'chaine', 0, '', $conf->entity);
}
etape('comptes par defaut : clients 411, services vendus 706, attente 471');

// 5. Compte « Caisse principale » (type espèces), rattaché au 5711.
$journal = (int) valeur($db, 'SELECT rowid FROM '.MAIN_DB_PREFIX.'accounting_journal WHERE nature = 4 AND active = 1'.' AND entity = '.((int) $conf->entity).' ORDER BY rowid LIMIT 1');
$idCaisse = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."bank_account WHERE ref = 'CAISSE'".' AND entity = '.((int) $conf->entity));
if (!$idCaisse) {
	$a = new Account($db);
	$a->ref = 'CAISSE';
	$a->label = 'Caisse principale (Bureau)';
	$a->type = Account::TYPE_CASH;
	$a->courant = Account::TYPE_CASH;
	$a->currency_code = 'XAF';
	$a->country_id = 72;
	$a->account_number = '5711';
	$a->fk_accountancy_journal = $journal;
	$a->date_solde = dol_now();
	$a->solde = 0;
	$idCaisse = $a->create($user);
	etape('compte Caisse principale : '.($idCaisse > 0 ? 'cree #'.$idCaisse : 'ERREUR '.$a->error.' '.implode(' ; ', (array) $a->errors)));
} else {
	etape('compte Caisse principale : deja present #'.$idCaisse);
}
etape('journal de banque utilise : #'.$journal.' '.valeur($db, 'SELECT code FROM '.MAIN_DB_PREFIX.'accounting_journal WHERE rowid = '.$journal));

// 6. Exercice comptable 2026 ouvert : sans lui, Dolibarr refuse toute écriture
//    (« The bookkeeping doc date is not inside the active fiscal period »).
require_once DOL_DOCUMENT_ROOT.'/core/class/fiscalyear.class.php';
if (!valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."accounting_fiscalyear WHERE date_start <= '2026-01-01' AND date_end >= '2026-12-31'".' AND entity = '.((int) $conf->entity))) {
	$fy = new Fiscalyear($db);
	$fy->label = '2026';
	$fy->date_start = dol_mktime(0, 0, 0, 1, 1, 2026);
	$fy->date_end = dol_mktime(0, 0, 0, 12, 31, 2026);
	$fy->status = 0;
	$fy->statut = 0;
	$fy->entity = $conf->entity;
	$res = $fy->create($user);
	etape('exercice 2026 : '.($res > 0 ? 'ouvert #'.$res : 'ERREUR '.$fy->error));
} else {
	etape('exercice 2026 : deja present');
}
