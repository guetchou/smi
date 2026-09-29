<?php
/*
 * Empreinte des données d'une entité et des réglages communs à toute
 * l'instance (entité 0). mettre-en-service.sh la relève avant et après : elle
 * doit être identique pour l'entité 1, qui appartient à un autre projet.
 *
 *   ENTITE_OBSERVEE=1 php empreinte.php
 *
 * Lecture seule. Une ligne par table : nombre de lignes et somme de contrôle.
 */
if (PHP_SAPI !== 'cli') {
	http_response_code(403);
	exit;
}
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';

$ent = (int) getenv('ENTITE_OBSERVEE');
if ($ent < 1) { fwrite(STDERR, "ENTITE_OBSERVEE manquante\n"); exit(1); }

// table => colonnes relevées ; la somme de contrôle porte sur leur contenu.
$tables = [
	'const' => 'name, value',
	'user' => 'login, statut, admin',
	'user_rights' => 'fk_user, fk_id',
	'societe' => 'nom, code_client',
	'product' => 'ref, label, price',
	'facture' => 'ref, total_ttc, fk_statut',
	'bank_account' => 'ref, account_number',
	'bank' => 'amount, label, dateo',
	'accounting_account' => 'account_number, active',
	'accounting_journal' => 'code, active',
	'accounting_bookkeeping' => 'doc_ref, numero_compte, debit, credit',
	'accounting_fiscalyear' => 'label, statut',
];
foreach ([$ent, 0] as $x) {
	foreach ($tables as $t => $cols) {
		$sql = 'SELECT COUNT(*), COALESCE(MD5(GROUP_CONCAT(CONCAT_WS(0x1f, '.$cols.') ORDER BY rowid SEPARATOR 0x1e)), \'-\') FROM '.MAIN_DB_PREFIX.$t.' WHERE entity = '.$x;
		if ($t === 'bank') {
			// llx_bank n'a pas de colonne entity : une ligne appartient à l'entité de son compte.
			$sql = 'SELECT COUNT(*), COALESCE(MD5(GROUP_CONCAT(CONCAT_WS(0x1f, b.amount, b.label, b.dateo) ORDER BY b.rowid SEPARATOR 0x1e)), \'-\') FROM '.MAIN_DB_PREFIX.'bank b JOIN '.MAIN_DB_PREFIX.'bank_account ba ON ba.rowid = b.fk_account WHERE ba.entity = '.$x;
		}
		$db->query('SET SESSION group_concat_max_len = 67108864');
		$r = $db->query($sql);
		if (!$r) { echo 'entite '.$x.' '.$t.' ERREUR '.$db->lasterror()."\n"; continue; }
		[$n, $md5] = $db->fetch_row($r);
		// L'entité 0 ne porte que des réglages et des comptes d'instance : les autres tables y sont vides.
		if ($x === 0 && (int) $n === 0) continue;
		printf("entite %d %-24s %6d %s\n", $x, $t, $n, $md5);
	}
}
