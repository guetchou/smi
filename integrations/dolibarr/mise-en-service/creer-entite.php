<?php
/*
 * Prépare une entité (société) Dolibarr pour Tala SMI dans une instance
 * partagée — ADR 0002, décision « multi-société » du 29/09/2026.
 *
 * Dolibarr sait tenir plusieurs sociétés (colonne entity partout ; DOLENTITY
 * en ligne de commande ; l'API place un utilisateur dans son entité). Le
 * module externe MultiCompany n'apporte que les écrans et la recopie des
 * référentiels à la création d'une entité. Les écrans ne servent pas ici
 * (Dolibarr n'est jamais montré) ; la recopie, ce script la fait, pour les
 * seuls référentiels dont les mouvements de Tala SMI ont besoin.
 *
 *   DOLENTITY=2 php creer-entite.php
 *
 * Idempotent : un référentiel déjà présent dans l'entité n'est pas recopié.
 * L'entité source (1) n'est jamais modifiée.
 */
if (PHP_SAPI !== 'cli') {
	http_response_code(403);
	exit;
}
$cible = (int) getenv('DOLENTITY');
if ($cible < 2) {
	fwrite(STDERR, "DOLENTITY doit valoir 2 ou plus : l'entite 1 est celle qui existe deja\n");
	exit(1);
}
define('DOLENTITY', $cible);
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';

const SOURCE = 1;
const REFERENTIELS = array('accounting_journal', 'c_paiement', 'c_payment_term', 'c_tva', 'c_invoice_subtype');

function etape($m) { echo '  '.$m."\n"; }
if ((int) $conf->entity !== $cible) {
	etape('ERREUR : Dolibarr travaille sur l entite '.$conf->entity.' au lieu de '.$cible);
	exit(1);
}

$base = $db->database_name;
foreach (REFERENTIELS as $t) {
	$table = MAIN_DB_PREFIX.$t;
	$r = $db->query('SELECT COUNT(*) FROM '.$table.' WHERE entity = '.$cible);
	if (!$r) { etape($t.' : ERREUR '.$db->lasterror()); exit(1); }
	$deja = (int) $db->fetch_row($r)[0];
	if ($deja) { etape($t.' : deja '.$deja.' ligne(s) dans l entite '.$cible); continue; }

	// Toutes les colonnes sauf la clé auto-incrémentée ; entity remplacée par la cible.
	$cols = array();
	$r = $db->query("SELECT column_name, extra FROM information_schema.columns WHERE table_schema = '".$db->escape($base)."' AND table_name = '".$db->escape($table)."' ORDER BY ordinal_position");
	while ($o = $db->fetch_object($r)) {
		if (stripos((string) $o->extra, 'auto_increment') !== false) continue;
		$cols[] = $o->column_name;
	}
	$liste = implode(', ', array_map(function ($c) { return '`'.$c.'`'; }, $cols));
	$select = implode(', ', array_map(function ($c) use ($cible) { return $c === 'entity' ? (string) $cible : '`'.$c.'`'; }, $cols));
	$db->begin();
	$ok = $db->query('INSERT INTO '.$table.' ('.$liste.') SELECT '.$select.' FROM '.$table.' WHERE entity = '.SOURCE);
	if (!$ok) { $db->rollback(); etape($t.' : ERREUR '.$db->lasterror()); exit(1); }
	$db->commit();
	$r = $db->query('SELECT COUNT(*) FROM '.$table.' WHERE entity = '.$cible);
	etape($t.' : '.(int) $db->fetch_row($r)[0].' ligne(s) recopiee(s) depuis l entite '.SOURCE);
}
