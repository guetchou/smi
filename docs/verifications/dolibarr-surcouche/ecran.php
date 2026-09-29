<?php
/*
 * Exécute un écran de comptabilité de Dolibarr comme le comptable le ferait
 * d'un clic (bac à sable, vérification du 29/09/2026), puis affiche ses
 * messages et le grand livre.
 *   ECRAN=accountancy/customer/index.php ACTION=validatehistory   ventilation automatique
 *   ECRAN=accountancy/journal/sellsjournal.php ACTION=writebookkeeping JOURNAL=VT
 *   ECRAN=accountancy/journal/bankjournal.php  ACTION=writebookkeeping JOURNAL=BQ
 */
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION', 'NOCSRFCHECK'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';

$r = $db->query('SELECT login FROM '.MAIN_DB_PREFIX.'user WHERE admin = 1 AND statut = 1 ORDER BY rowid LIMIT 1');
$user->fetch(0, $db->fetch_object($r)->login, '', 1);
$user->loadRights();

$params = ['action' => getenv('ACTION'), 'year' => 2026,
	'date_startday' => 1, 'date_startmonth' => 1, 'date_startyear' => 2026,
	'date_endday' => 31, 'date_endmonth' => 12, 'date_endyear' => 2026];
if (getenv('JOURNAL')) {
	$params['id_journal'] = $db->fetch_row($db->query("SELECT rowid FROM ".MAIN_DB_PREFIX."accounting_journal WHERE code = '".$db->escape(getenv('JOURNAL'))."'"))[0];
}
$_GET = $_REQUEST = $params;
$_SERVER['REQUEST_METHOD'] = 'GET';

// Messages seulement : certains écrans ferment la connexion en fin de page.
// Le grand livre se lit avec grand-livre.php.
register_shutdown_function(function () {
	while (ob_get_level()) ob_end_clean();
	foreach (($_SESSION['dol_events'] ?? []) as $type => $messages) {
		foreach (array_unique((array) $messages) as $m) echo '  message '.$type.' : '.substr(strip_tags($m), 0, 160)."\n";
	}
});

ob_start();
chdir(dirname('/var/www/html/'.getenv('ECRAN')));
require '/var/www/html/'.getenv('ECRAN');
