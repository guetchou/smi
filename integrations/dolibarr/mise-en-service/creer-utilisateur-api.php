<?php
/*
 * Crée l'utilisateur d'API de Tala SMI dans son entité et lui donne une clé.
 * Appelé par creer-utilisateur-api.sh, jamais seul : la clé sort sur la
 * sortie standard, que le script hôte écrit dans .env sans l'afficher.
 *
 *   DOLENTITY=2 php creer-utilisateur-api.php
 *
 * L'utilisateur n'a pas de mot de passe (Dolibarr n'est jamais montré) et ne
 * reçoit que les droits dont le module smi a besoin : lire et créer des
 * mouvements comptables. Refuse s'il a déjà une clé : la remplacer coupe
 * Tala SMI, c'est une décision à part.
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
require_once DOL_DOCUMENT_ROOT.'/user/class/user.class.php';
require_once DOL_DOCUMENT_ROOT.'/core/lib/security2.lib.php';

const LOGIN = 'tala-smi';
function dire($m) { fwrite(STDERR, '  '.$m."\n"); }
function valeur($db, $sql) { $r = $db->query($sql); $o = $r ? $db->fetch_row($r) : null; return $o ? $o[0] : null; }

if ((int) $conf->entity !== $cible || !isModEnabled('smi') || !isModEnabled('api')) {
	dire('ERREUR : entite '.$cible.' non configuree (lancer mettre-en-service.sh d abord)');
	exit(1);
}
$login = valeur($db, 'SELECT login FROM '.MAIN_DB_PREFIX.'user WHERE admin = 1 AND statut = 1 AND entity = 0 ORDER BY rowid LIMIT 1');
if (!$login || $user->fetch(0, $login, '', 1) <= 0) {
	dire('ERREUR : aucun administrateur d instance actif');
	exit(1);
}

$u = new User($db);
$id = (int) valeur($db, "SELECT rowid FROM ".MAIN_DB_PREFIX."user WHERE login = '".LOGIN."' AND entity = ".$cible);
if ($id) {
	$u->fetch($id);
	if (!empty($u->api_key)) {
		dire('refus : '.LOGIN.' a deja une cle dans l entite '.$cible);
		exit(3);
	}
} else {
	$u->login = LOGIN;
	$u->lastname = 'Tala SMI';
	$u->entity = $cible;
	$u->admin = 0;
	$id = $u->create($user);
	if ($id <= 0) { dire('ERREUR creation : '.$u->error); exit(1); }
	$u->fetch($id);
	dire('utilisateur '.LOGIN.' cree #'.$id.' dans l entite '.$cible);
}

// Droits : exactement ceux que vérifie le module smi.
$r = $db->query("SELECT id FROM ".MAIN_DB_PREFIX."rights_def WHERE module = 'accounting' AND perms = 'mouvements' AND subperms IN ('lire', 'creer') AND entity = ".$cible);
$droits = 0;
while ($o = $db->fetch_object($r)) {
	if ($u->addrights((int) $o->id, '', '', $cible) < 0) { dire('ERREUR droit '.$o->id.' : '.$u->error); exit(1); }
	$droits++;
}
if ($droits !== 2) { dire('ERREUR : '.$droits.' droit(s) trouve(s) au lieu de 2'); exit(1); }
dire('droits : mouvements comptables, lire et creer');

$cle = getRandomPassword(true);
$u->api_key = $cle;
if ($u->update($user) < 0) { dire('ERREUR cle : '.$u->error); exit(1); }
dire('cle creee (chiffree par Dolibarr)');
// Sur une ligne marquée : un avertissement PHP sur la sortie ne se mêle pas à la clé.
echo "\nCLE=".$cle."\n";
