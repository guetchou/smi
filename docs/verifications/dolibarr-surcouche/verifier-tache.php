<?php
/*
 * Preuve de la tâche « grand livre » (bac à sable, 29/09/2026) : la vente
 * poussée par l'API (REF) est-elle au grand livre, et GET /smi/etat rend-il
 * le dernier passage ?
 */
foreach (['NOTOKENRENEWAL', 'NOREQUIREMENU', 'NOREQUIREHTML', 'NOREQUIREAJAX', 'NOLOGIN', 'NOSESSION'] as $c) {
	if (!defined($c)) define($c, '1');
}
require_once '/var/www/htdocs/master.inc.php';
require_once DOL_DOCUMENT_ROOT.'/includes/restler/framework/Luracast/Restler/AutoLoader.php';
require_once DOL_DOCUMENT_ROOT.'/api/class/api.class.php';
require_once DOL_DOCUMENT_ROOT.'/api/class/api_access.class.php';
require_once dol_buildpath('/smi/class/api_smi.class.php', 0);

$r = $db->query('SELECT login FROM '.MAIN_DB_PREFIX.'user WHERE admin = 1 AND statut = 1 ORDER BY rowid LIMIT 1');
$user->fetch(0, $db->fetch_object($r)->login, '', 1);
$user->loadRights();
DolibarrApiAccess::$user = $user;

$ref = getenv('REF');
$r = $db->query("SELECT f.ref FROM ".MAIN_DB_PREFIX."facture f WHERE f.ref_client = '".$db->escape($ref)."'");
$facture = $r ? $db->fetch_object($r)->ref : '?';
echo "  facture $ref = $facture ; ses ecritures :\n";
$sql = "SELECT code_journal, numero_compte, debit, credit, label_operation FROM ".MAIN_DB_PREFIX."accounting_bookkeeping";
$sql .= " WHERE doc_ref = '".$db->escape($facture)."' OR label_operation LIKE '%".$db->escape($facture)."%' OR (doc_type = 'bank' AND fk_doc IN (SELECT b.fk_bank FROM ".MAIN_DB_PREFIX."paiement b JOIN ".MAIN_DB_PREFIX."paiement_facture pf ON pf.fk_paiement = b.rowid JOIN ".MAIN_DB_PREFIX."facture f ON f.rowid = pf.fk_facture WHERE f.ref = '".$db->escape($facture)."'))";
$sql .= " ORDER BY rowid";
$r = $db->query($sql);
while ($r && ($o = $db->fetch_object($r))) {
	printf("    %-3s %-6s D %8s  C %8s  %s\n", $o->code_journal, $o->numero_compte, price2num($o->debit), price2num($o->credit), substr($o->label_operation, 0, 40));
}
echo '  GET /smi/etat -> '.json_encode(array_intersect_key((new Smi())->getEtat(), array_flip(['horodatage', 'statut', 'ecritures_ajoutees', 'minutes_depuis', 'en_retard', 'lignes_grand_livre'])))."\n";
