<?php
/*
 * Configure l'entité (société) de Top Center dans un Dolibarr partagé —
 * ADR 0002, décision « multi-société » du 29/09/2026.
 *
 *   DOLENTITY=2 php configurer-entite.php
 *
 * Mêmes réglages que ceux prouvés sur le bac à sable
 * (docs/verifications/dolibarr-surcouche/configurer-bac-a-sable.php), tous
 * écrits dans l'entité visée seulement :
 *   pays Congo, monnaie XAF, plan SYSCOHADA-CG, comptes par défaut ;
 *   modules banque, factures, fournisseurs, salaires, comptabilité, API et smi ;
 *   comptes « CAISSE » (5711) et « BCH » (5211) ;
 *   exercice de l'année en cours, ouvert.
 * Idempotent. Refuse l'entité 1 : dans une instance partagée, elle appartient
 * à un autre projet.
 */
if (PHP_SAPI !== 'cli') {
	http_response_code(403);
	exit;
}
$cible = (int) getenv('DOLENTITY');
if ($cible < 2) {
	fwrite(STDERR, "DOLENTITY doit valoir 2 ou plus\n");
	exit(1);
}
define('DOLENTITY', $cible);
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';
require_once DOL_DOCUMENT_ROOT.'/core/lib/admin.lib.php';
require_once DOL_DOCUMENT_ROOT.'/compta/bank/class/account.class.php';
require_once DOL_DOCUMENT_ROOT.'/core/class/fiscalyear.class.php';

function etape($m) { echo '  '.$m."\n"; }
function valeur($db, $sql) { $r = $db->query($sql); $o = $r ? $db->fetch_row($r) : null; return $o ? $o[0] : null; }
$e = ' AND entity = '.$cible;

if ((int) $conf->entity !== $cible) {
	etape('ERREUR : Dolibarr travaille sur l entite '.$conf->entity.' au lieu de '.$cible);
	exit(1);
}
if (!valeur($db, 'SELECT COUNT(*) FROM '.MAIN_DB_PREFIX.'accounting_journal WHERE 1 = 1'.$e)) {
	etape('ERREUR : referentiels absents, lancer creer-entite.php d abord');
	exit(1);
}

// Un administrateur de toute l'instance (entité 0) : jamais celui d'une autre société.
$login = valeur($db, 'SELECT login FROM '.MAIN_DB_PREFIX.'user WHERE admin = 1 AND statut = 1 AND entity = 0 ORDER BY rowid LIMIT 1');
if (!$login || $user->fetch(0, $login, '', 1) <= 0) {
	etape('ERREUR : aucun administrateur d instance actif');
	exit(1);
}
$user->loadRights();

// 1. Société au Congo, en francs CFA.
dolibarr_set_const($db, 'MAIN_INFO_SOCIETE_COUNTRY', '72:CG:Congo', 'chaine', 0, '', $cible);
dolibarr_set_const($db, 'MAIN_MONNAIE', 'XAF', 'chaine', 0, '', $cible);
etape('pays CG, monnaie XAF');

// 2. Modules. modSmi suppose le module copié dans custom/smi.
foreach (['modBanque', 'modFacture', 'modFournisseur', 'modSalaries', 'modAccounting', 'modApi', 'modSmi'] as $m) {
	$r = activateModule($m);
	etape($m.' : '.(empty($r['errors']) ? 'actif' : 'ERREUR '.implode(' ; ', $r['errors'])));
	if (!empty($r['errors'])) exit(1);
}

// 3. Plan SYSCOHADA du Congo, chargé comme le fait accountancy/admin/account.php.
$chart = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."accounting_system WHERE pcg_version = 'SYSCOHADA-CG'");
$compter = function () use ($db, $e) {
	return (int) valeur($db, "SELECT COUNT(*) FROM ".MAIN_DB_PREFIX."accounting_account WHERE fk_pcg_version = 'SYSCOHADA-CG'".$e);
};
if (!$compter()) {
	$sqlfile = DOL_DOCUMENT_ROOT.'/install/mysql/data/llx_accounting_account_cg.sql';
	$offset = 0;
	$reg = array();
	if (preg_match('/-- ADD (\d+) to rowid/ims', file_get_contents($sqlfile), $reg)) $offset += $reg[1];
	$offset += ($cible * 100000000);
	$res = run_sql($sqlfile, 1, $cible, 1, '', 'default', 32768, 0, $offset);
	if ($res <= 0) { etape('ERREUR chargement du plan'); exit(1); }
}
dolibarr_set_const($db, 'CHARTOFACCOUNTS', $chart, 'chaine', 0, '', $cible);
etape('plan SYSCOHADA-CG (#'.$chart.') : '.$compter().' comptes');

// 4. Comptes par défaut (mêmes valeurs que le bac à sable).
foreach ([
	'ACCOUNTING_ACCOUNT_CUSTOMER' => '411',
	'ACCOUNTING_ACCOUNT_SUPPLIER' => '401',
	'ACCOUNTING_SERVICE_SOLD_ACCOUNT' => '706',
	'ACCOUNTING_ACCOUNT_SUSPENSE' => '471',
	'ACCOUNTING_ACCOUNT_TRANSFER_CASH' => '585',
	'ACCOUNTING_SERVICE_BUY_ACCOUNT' => '605',
	'SALARIES_ACCOUNTING_ACCOUNT_PAYMENT' => '422',
] as $k => $v) {
	dolibarr_set_const($db, $k, $v, 'chaine', 0, '', $cible);
}
etape('comptes par defaut : 411, 401, 706, 471, 585, 605, 422');

// 5. Comptes de trésorerie, rattachés au journal de banque de l'entité.
$journal = (int) valeur($db, 'SELECT rowid FROM '.MAIN_DB_PREFIX.'accounting_journal WHERE nature = 4 AND active = 1'.$e.' ORDER BY rowid LIMIT 1');
foreach ([
	['CAISSE', 'Caisse principale (Bureau)', Account::TYPE_CASH, '5711'],
	['BCH', 'Banque BCH', Account::TYPE_CURRENT, '5211'],
] as [$ref, $libelle, $type, $compte]) {
	$id = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."bank_account WHERE ref = '".$ref."'".$e);
	if ($id) { etape('compte '.$ref.' : deja present #'.$id); continue; }
	$a = new Account($db);
	$a->ref = $ref;
	$a->label = $libelle;
	$a->type = $type;
	$a->courant = $type;
	$a->currency_code = 'XAF';
	$a->country_id = 72;
	$a->account_number = $compte;
	$a->fk_accountancy_journal = $journal;
	$a->date_solde = dol_now();
	$a->solde = 0;
	$id = $a->create($user);
	if ($id <= 0) { etape('compte '.$ref.' : ERREUR '.$a->error.' '.implode(' ; ', (array) $a->errors)); exit(1); }
	etape('compte '.$ref.' : cree #'.$id.' ('.$compte.')');
}

// 6. Exercice de l'année en cours, ouvert : sans lui, Dolibarr refuse toute écriture.
$annee = (int) date('Y');
if (!valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."accounting_fiscalyear WHERE date_start <= '".$annee."-01-01' AND date_end >= '".$annee."-12-31'".$e)) {
	$fy = new Fiscalyear($db);
	$fy->label = (string) $annee;
	$fy->date_start = dol_mktime(0, 0, 0, 1, 1, $annee);
	$fy->date_end = dol_mktime(0, 0, 0, 12, 31, $annee);
	$fy->status = 0;
	$fy->statut = 0;
	$fy->entity = $cible;
	$res = $fy->create($user);
	if ($res <= 0) { etape('exercice '.$annee.' : ERREUR '.$fy->error); exit(1); }
	etape('exercice '.$annee.' : ouvert #'.$res);
} else {
	etape('exercice '.$annee.' : deja present');
}
