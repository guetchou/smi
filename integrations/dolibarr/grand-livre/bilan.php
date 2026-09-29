<?php
/*
 * Bilan de la tâche « grand livre » (ADR 0002 §5.6).
 *   MODE=compter      imprime le nombre de lignes du grand livre
 *   MODE=enregistrer  range l'état du passage (ETAT, JSON) dans le réglage
 *                     SMI_GRAND_LIVRE_ETAT, que GET /smi/etat rend à Tala SMI
 * Jamais servi par le web : même régime que ecran.php.
 */
if (PHP_SAPI !== 'cli') {
	http_response_code(403);
	exit;
}
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';
require_once DOL_DOCUMENT_ROOT.'/core/lib/admin.lib.php';

$r = $db->query('SELECT COUNT(*) FROM '.MAIN_DB_PREFIX.'accounting_bookkeeping WHERE entity = '.((int) $conf->entity));
$lignes = (int) ($r ? $db->fetch_row($r)[0] : -1);

if (getenv('MODE') === 'compter') {
	echo $lignes."\n";
	exit(0);
}
$etat = json_decode((string) getenv('ETAT'), true);
if (!is_array($etat)) {
	fwrite(STDERR, "ETAT n'est pas un JSON valide\n");
	exit(1);
}
$etat['lignes_grand_livre'] = $lignes;
$ok = dolibarr_set_const($db, 'SMI_GRAND_LIVRE_ETAT', json_encode($etat, JSON_UNESCAPED_UNICODE), 'chaine', 0, 'Tache grand livre de Tala SMI', $conf->entity);
exit($ok > 0 ? 0 : 1);
