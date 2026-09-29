<?php
/* Diagnostic : le paiement de salaire a-t-il sa ligne de banque, et pourquoi le journal l'ignore-t-il ? */
// Entite visee (DOLENTITY=2 : Top Center dans une instance partagee) ; 1 par defaut.
if ((int) getenv('DOLENTITY') > 0 && !defined('DOLENTITY')) define('DOLENTITY', (int) getenv('DOLENTITY'));
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';
// Une requête en erreur le dit : c'est un diagnostic muet qui a égaré la première lecture.
$q = function ($sql) use ($db) {
	$r = $db->query($sql);
	if (!$r) { echo '    ERREUR SQL : '.$db->lasterror()."\n"; return []; }
	$t = []; while ($o = $db->fetch_object($r)) $t[] = (array) $o; return $t;
};
echo "  paiements de salaire :\n";
foreach ($q('SELECT rowid, fk_salary, amount, fk_bank FROM '.MAIN_DB_PREFIX.'payment_salary') as $l) echo '    '.json_encode($l)."\n";
echo "  lignes de banque et liens :\n";
foreach ($q('SELECT b.rowid, b.amount, b.label, b.fk_type, (SELECT GROUP_CONCAT(CONCAT(u.type,":",u.url_id)) FROM '.MAIN_DB_PREFIX.'bank_url u WHERE u.fk_bank = b.rowid) liens FROM '.MAIN_DB_PREFIX.'bank b WHERE b.rowid > 6') as $l) echo '    '.json_encode($l)."\n";
echo "  lignes de banque deja au grand livre :\n";
foreach ($q("SELECT DISTINCT fk_doc FROM ".MAIN_DB_PREFIX."accounting_bookkeeping WHERE doc_type = 'bank' ORDER BY fk_doc") as $l) echo '    '.json_encode($l)."\n";
echo "  compte comptable de l utilisateur beneficiaire :\n";
foreach ($q('SELECT u.rowid, u.login IS NOT NULL a_login, u.accountancy_code, u.accountancy_code_user_general FROM '.MAIN_DB_PREFIX.'user u JOIN '.MAIN_DB_PREFIX.'salary s ON s.fk_user = u.rowid') as $l) echo '    '.json_encode($l)."\n";
echo "  reglages salaires / personnel :\n";
foreach ($q("SELECT name, value FROM ".MAIN_DB_PREFIX."const WHERE name IN ('SALARIES_ACCOUNTING_ACCOUNT_PAYMENT','ACCOUNTING_ACCOUNT_EMPLOYEE','ACCOUNTING_ACCOUNT_USER')") as $l) echo '    '.json_encode($l)."\n";
