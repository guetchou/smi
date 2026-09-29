<?php
/*
 * Étape 6 de la vérification (bac à sable, 29/09/2026) : le module « smi ».
 * Active le module, puis appelle son API comme le ferait Tala SMI :
 *   - une pièce de paie de mars (journal OD), équilibrée ;
 *   - la même pièce une seconde fois : elle ne doit pas être réécrite ;
 *   - une pièce déséquilibrée et une pièce sur un compte inconnu : refusées,
 *     sans rien écrire ;
 *   - la lecture du grand livre du compte 422.
 */
// Entite visee (DOLENTITY=2 : Top Center dans une instance partagee) ; 1 par defaut.
if ((int) getenv('DOLENTITY') > 0 && !defined('DOLENTITY')) define('DOLENTITY', (int) getenv('DOLENTITY'));
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';
require_once DOL_DOCUMENT_ROOT.'/core/lib/admin.lib.php';
require_once DOL_DOCUMENT_ROOT.'/includes/restler/framework/Luracast/Restler/AutoLoader.php';
require_once DOL_DOCUMENT_ROOT.'/api/class/api.class.php';
require_once DOL_DOCUMENT_ROOT.'/api/class/api_access.class.php';

function etape($m) { echo '  '.$m."\n"; }
function valeur($db, $sql) { $r = $db->query($sql); $o = $r ? $db->fetch_row($r) : null; return $o ? $o[0] : null; }

$login = valeur($db, 'SELECT login FROM '.MAIN_DB_PREFIX.'user WHERE admin = 1 AND statut = 1 ORDER BY rowid LIMIT 1');
$user->fetch(0, $login, '', 1);
$user->loadRights();
DolibarrApiAccess::$user = $user;

$r = activateModule('modSmi');
etape('module smi : '.(empty($r['errors']) ? 'actif' : 'ERREUR '.implode(' ; ', $r['errors'])));
require_once dol_buildpath('/smi/class/api_smi.class.php', 0);

$compter = function () use ($db, $conf) { return (int) valeur($db, "SELECT COUNT(*) FROM ".MAIN_DB_PREFIX."accounting_bookkeeping WHERE doc_type = 'smi'".' AND entity = '.((int) $conf->entity)); };
$appel = function ($quoi, $fn) {
	try { $r = $fn(); etape($quoi.' -> '.json_encode($r)); return $r; }
	catch (Exception $e) { etape($quoi.' -> refus '.$e->getCode().' : '.$e->getMessage().' '.json_encode(method_exists($e, 'getDetails') ? $e->getDetails() : null)); return null; }
};

$paie = array(
	array('compte' => '6611', 'libelle' => 'Salaires bruts mars', 'debit' => 180000),
	array('compte' => '6641', 'libelle' => 'CNSS part patronale mars', 'debit' => 25000),
	array('compte' => '422', 'libelle' => 'Net a payer mars', 'credit' => 150000),
	array('compte' => '431', 'libelle' => 'CNSS part salariale mars', 'credit' => 12000),
	array('compte' => '431', 'libelle' => 'CNSS part patronale mars', 'credit' => 25000),
	array('compte' => '447', 'libelle' => 'IRPP retenu mars', 'credit' => 18000),
);

$avant = $compter();
$appel('POST /smi/pieces paie mars', function () use ($paie) { return (new Smi())->postPiece('OD', '2026-03-31', 'SMI-PAIE-2026-03', 202603, $paie); });
$apres = $compter();
etape('lignes smi au grand livre : '.$avant.' -> '.$apres);

$appel('POST /smi/pieces paie mars, seconde fois', function () use ($paie) { return (new Smi())->postPiece('OD', '2026-03-31', 'SMI-PAIE-2026-03', 202603, $paie); });
etape('lignes apres la seconde fois : '.$compter().' (attendu '.$apres.')');

$desequilibree = $paie;
$desequilibree[0]['debit'] = 180001;
$appel('POST /smi/pieces desequilibree', function () use ($desequilibree) { return (new Smi())->postPiece('OD', '2026-03-31', 'SMI-ESSAI-DESEQ', 1, $desequilibree); });
$inconnu = $paie;
$inconnu[0]['compte'] = '999999';
$appel('POST /smi/pieces compte inconnu', function () use ($inconnu) { return (new Smi())->postPiece('OD', '2026-03-31', 'SMI-ESSAI-INCONNU', 2, $inconnu); });
$appel('POST /smi/pieces hors exercice', function () use ($paie) { return (new Smi())->postPiece('OD', '2025-06-30', 'SMI-ESSAI-2025', 3, $paie); });
etape('lignes apres les refus : '.$compter().' (attendu '.$apres.')');

$gl = $appel('GET /smi/grandlivre compte 422', function () { return (new Smi())->getGrandLivre('2026-01-01', '2026-12-31', '422'); });
if ($gl) {
	foreach ($gl['lignes'] as $l) etape(sprintf('   %s %-3s %-18s %-6s D %8s C %8s  %s', $l['date'], $l['journal'], $l['reference'], $l['compte'], $l['debit'], $l['credit'], $l['libelle']));
}
