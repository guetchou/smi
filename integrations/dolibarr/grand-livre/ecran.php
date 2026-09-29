<?php
/*
 * Exécutant de la tâche « grand livre » (ADR 0002 §5.6, voie A).
 *
 * Exécute UN écran de comptabilité de Dolibarr en ligne de commande, comme le
 * comptable d'un clic, sur la période des exercices ouverts, et imprime ses
 * messages en JSON. Un processus par écran : chaque écran termine la requête
 * (redirection) une fois son action faite.
 *
 *   ECRAN=accountancy/customer/index.php ACTION=validatehistory
 *   ECRAN=accountancy/journal/bankjournal.php ACTION=writebookkeeping JOURNAL=BQ
 *
 * Jamais servi par le web : copié dans /tmp du conteneur à chaque passage, et
 * refuse de tourner hors ligne de commande.
 */
if (PHP_SAPI !== 'cli') {
	http_response_code(403);
	exit;
}
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION', 'NOCSRFCHECK'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';

$sortie = function ($etat, $messages) {
	echo json_encode(['ecran' => getenv('ECRAN'), 'journal' => getenv('JOURNAL') ?: null, 'etat' => $etat, 'messages' => $messages], JSON_UNESCAPED_UNICODE)."\n";
};

$r = $db->query('SELECT login FROM '.MAIN_DB_PREFIX.'user WHERE admin = 1 AND statut = 1 ORDER BY rowid LIMIT 1');
$o = $r ? $db->fetch_object($r) : null;
if (!$o) { $sortie('erreur', ['aucun administrateur actif']); exit(1); }
$user->fetch(0, $o->login, '', 1);
$user->loadRights();

// Période : de l'ouverture du plus ancien exercice ouvert à la clôture du plus récent.
// La colonne s'appelle « statut » (0 = ouvert) ; une erreur SQL se dit comme telle.
$r = $db->query('SELECT MIN(date_start) AS d, MAX(date_end) AS f FROM '.MAIN_DB_PREFIX.'accounting_fiscalyear WHERE statut = 0 AND entity = '.((int) $conf->entity));
if (!$r) { $sortie('erreur', ['lecture des exercices impossible : '.$db->lasterror()]); exit(1); }
$p = $db->fetch_object($r);
if (!$p || !$p->d) { $sortie('erreur', ['aucun exercice comptable ouvert : rien ne peut etre ecrit']); exit(1); }
$d = explode('-', substr($p->d, 0, 10));
$f = explode('-', substr($p->f, 0, 10));

$params = ['action' => getenv('ACTION'), 'year' => (int) $d[0],
	'date_startday' => (int) $d[2], 'date_startmonth' => (int) $d[1], 'date_startyear' => (int) $d[0],
	'date_endday' => (int) $f[2], 'date_endmonth' => (int) $f[1], 'date_endyear' => (int) $f[0]];
if (getenv('JOURNAL')) {
	$r = $db->query("SELECT rowid FROM ".MAIN_DB_PREFIX."accounting_journal WHERE code = '".$db->escape(getenv('JOURNAL'))."' AND active = 1");
	$j = $r ? $db->fetch_row($r) : null;
	if (!$j) { $sortie('erreur', ['journal introuvable ou inactif : '.getenv('JOURNAL')]); exit(1); }
	$params['id_journal'] = $j[0];
}
$_GET = $_REQUEST = $params;
$_SERVER['REQUEST_METHOD'] = 'GET';

// Les écrans rangent leurs messages dans la session ; on les rend à la sortie.
register_shutdown_function(function () use ($sortie) {
	while (ob_get_level()) ob_end_clean();
	$erreurs = [];
	$infos = [];
	foreach (($_SESSION['dol_events'] ?? []) as $type => $messages) {
		foreach (array_unique((array) $messages) as $m) {
			$texte = trim(substr(strip_tags((string) $m), 0, 200));
			// « Some of the transactions could not be journalized » arrive en avertissement : c'est un échec.
			if ($type === 'errors' || stripos($texte, 'could not be journalized') !== false) $erreurs[] = $texte;
			else $infos[] = $texte;
		}
	}
	$fatale = error_get_last();
	if ($fatale && in_array($fatale['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
		$erreurs[] = 'erreur PHP : '.$fatale['message'];
	}
	$sortie($erreurs ? 'erreur' : 'ok', $erreurs ?: $infos);
});

ob_start();
chdir(dirname('/var/www/html/'.getenv('ECRAN')));
require '/var/www/html/'.getenv('ECRAN');
