<?php
/* Lit le grand livre du bac à sable Dolibarr (vérification du 29/09/2026). */
// Entite visee (DOLENTITY=2 : Top Center dans une instance partagee) ; 1 par defaut.
if ((int) getenv('DOLENTITY') > 0 && !defined('DOLENTITY')) define('DOLENTITY', (int) getenv('DOLENTITY'));
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';
$r = $db->query('SELECT code_journal, doc_ref, numero_compte, subledger_account, label_operation, debit, credit FROM '.MAIN_DB_PREFIX.'accounting_bookkeeping WHERE entity = '.((int) $conf->entity).' ORDER BY rowid');
$n = 0;
while ($o = $db->fetch_object($r)) {
	$n++;
	printf("  %-3s %-16s %-7s %-10s %-26s D %10s  C %10s\n", $o->code_journal, substr($o->doc_ref, 0, 16), $o->numero_compte, $o->subledger_account ?: '-', substr($o->label_operation, 0, 26), price2num($o->debit), price2num($o->credit));
}
if (!$n) echo "  (aucune ecriture)\n";
