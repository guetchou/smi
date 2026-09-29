<?php
/*
 * API du module « smi » : ce que Tala SMI demande à Dolibarr et que l'API
 * standard n'offre pas. Tout passe par les classes de Dolibarr (BookKeeping) ;
 * aucune écriture SQL directe dans le grand livre.
 *
 *   POST /smi/pieces      écrire une pièce comptable équilibrée (paie, OD)
 *   GET  /smi/grandlivre  lire le grand livre
 *   GET  /smi/etat        état de la tâche planifiée « grand livre »
 *   GET  /smi/exercices   exercices comptables ouverts
 */
use Luracast\Restler\RestException;

// BookKeeping::create() contrôle l'exercice avec dol_get_last_hour(), sans
// charger date.lib.php : selon l'ordre des appels, la fonction manque et la
// requête tombe en erreur fatale (constaté le 29/09/2026).
require_once DOL_DOCUMENT_ROOT.'/core/lib/date.lib.php';
require_once DOL_DOCUMENT_ROOT.'/accountancy/class/bookkeeping.class.php';
require_once DOL_DOCUMENT_ROOT.'/accountancy/class/accountingjournal.class.php';

/**
 * Pont Tala SMI.
 *
 * Sans ces deux annotations, Restler publie les points d'API SANS
 * authentification : constaté le 29/09/2026 (500 au lieu de 401 sans clé).
 *
 * @access protected
 * @class  DolibarrApiAccess {@requires user,external}
 */
class Smi extends DolibarrApi
{
	/** Pièces écrites par Tala SMI : ce type les distingue de celles de Dolibarr. */
	const DOC_TYPE = 'smi';

	public function __construct()
	{
		global $db;
		$this->db = $db;
	}

	/**
	 * Écrire une pièce comptable équilibrée
	 *
	 * Toutes les lignes ou aucune. Une pièce déjà écrite sous la même référence
	 * n'est pas réécrite : l'appel rend la pièce existante.
	 *
	 * @param string $journal    Code du journal (OD, VT, AC, BQ…) {@from body}
	 * @param string $date       Date de la pièce, AAAA-MM-JJ {@from body}
	 * @param string $reference  Référence Tala SMI, unique {@from body}
	 * @param int    $source_id  Identifiant Tala SMI de la pièce {@from body}
	 * @param array  $lignes     [{compte, libelle, debit, credit, tiers}] {@from body}
	 * @return array
	 *
	 * @url POST /pieces
	 * @throws RestException 403|422|500
	 */
	public function postPiece($journal, $date, $reference, $source_id, $lignes)
	{
		global $conf;
		if (!DolibarrApiAccess::$user->hasRight('accounting', 'mouvements', 'creer')) {
			throw new RestException(403);
		}
		$reference = trim((string) $reference);
		if ($reference === '' || strlen($reference) > 100) {
			throw new RestException(422, 'Reference invalide');
		}

		$existante = $this->pieceExistante($reference);
		if ($existante) {
			return array('statut' => 'deja_ecrite', 'piece_num' => $existante['piece_num'], 'lignes' => $existante['lignes']);
		}

		$j = new AccountingJournal($this->db);
		if ($j->fetch(0, (string) $journal) <= 0 || empty($j->active)) {
			throw new RestException(422, 'Journal inconnu ou inactif : '.$journal);
		}
		$reg = array();
		if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', (string) $date, $reg) || !checkdate((int) $reg[2], (int) $reg[3], (int) $reg[1])) {
			throw new RestException(422, 'Date invalide : '.$date);
		}
		$quand = dol_mktime(12, 0, 0, (int) $reg[2], (int) $reg[3], (int) $reg[1]);

		$propres = $this->verifierLignes($lignes);

		$this->db->begin();
		$piece = 0;
		foreach ($propres as $i => $l) {
			$bk = new BookKeeping($this->db);
			$bk->doc_date = $quand;
			$bk->doc_type = self::DOC_TYPE;
			$bk->doc_ref = $reference;
			$bk->fk_doc = (int) $source_id;
			$bk->fk_docdet = $i + 1;
			$bk->thirdparty_code = $l['tiers'];
			$bk->subledger_account = $l['tiers'];
			$bk->subledger_label = $l['tiers'];
			$bk->numero_compte = $l['compte'];
			$bk->label_compte = $l['libelle_compte'];
			$bk->label_operation = $l['libelle'];
			$bk->montant = $l['debit'] > 0 ? $l['debit'] : $l['credit'];
			$bk->sens = $l['debit'] > 0 ? 'D' : 'C';
			$bk->debit = $l['debit'];
			$bk->credit = $l['credit'];
			$bk->code_journal = $j->code;
			$bk->journal_label = $j->label;
			$bk->fk_user_author = DolibarrApiAccess::$user->id;
			$bk->entity = $conf->entity;
			$bk->date_creation = dol_now();
			if ($bk->create(DolibarrApiAccess::$user) < 0) {
				$this->db->rollback();
				throw new RestException(422, 'Ecriture refusee par Dolibarr', array_merge(array($bk->error), (array) $bk->errors));
			}
			$piece = $bk->piece_num;
		}
		$this->db->commit();
		return array('statut' => 'ecrite', 'piece_num' => $piece, 'lignes' => count($propres));
	}

	/**
	 * Lire le grand livre
	 *
	 * @param string $date_debut  AAAA-MM-JJ {@from query}
	 * @param string $date_fin    AAAA-MM-JJ {@from query}
	 * @param string $compte      Préfixe de compte, facultatif {@from query}
	 * @param string $journal     Code de journal, facultatif {@from query}
	 * @return array
	 *
	 * @url GET /grandlivre
	 * @throws RestException 403|422
	 */
	public function getGrandLivre($date_debut, $date_fin, $compte = '', $journal = '')
	{
		global $conf;
		if (!DolibarrApiAccess::$user->hasRight('accounting', 'mouvements', 'lire')) {
			throw new RestException(403);
		}
		foreach (array($date_debut, $date_fin) as $d) {
			if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $d)) {
				throw new RestException(422, 'Date invalide : '.$d);
			}
		}
		$sql = 'SELECT doc_date, code_journal, piece_num, doc_type, doc_ref, numero_compte, label_compte, label_operation, subledger_account, debit, credit';
		$sql .= ' FROM '.$this->db->prefix().'accounting_bookkeeping';
		$sql .= ' WHERE entity = '.((int) $conf->entity);
		$sql .= " AND doc_date >= '".$this->db->escape($date_debut)." 00:00:00' AND doc_date <= '".$this->db->escape($date_fin)." 23:59:59'";
		if ($compte !== '') {
			$sql .= " AND numero_compte LIKE '".$this->db->escape(preg_replace('/[^0-9A-Za-z]/', '', $compte))."%'";
		}
		if ($journal !== '') {
			$sql .= " AND code_journal = '".$this->db->escape($journal)."'";
		}
		$sql .= ' ORDER BY doc_date, piece_num, rowid';
		$res = $this->db->query($sql);
		if (!$res) {
			throw new RestException(500, 'Lecture du grand livre impossible');
		}
		$lignes = array();
		$debit = 0;
		$credit = 0;
		while ($o = $this->db->fetch_object($res)) {
			$lignes[] = array(
				'date' => substr((string) $o->doc_date, 0, 10), 'journal' => $o->code_journal, 'piece' => (int) $o->piece_num,
				'origine' => $o->doc_type, 'reference' => $o->doc_ref, 'compte' => $o->numero_compte,
				'libelle_compte' => $o->label_compte, 'libelle' => $o->label_operation, 'tiers' => $o->subledger_account,
				'debit' => (float) $o->debit, 'credit' => (float) $o->credit,
			);
			$debit += (float) $o->debit;
			$credit += (float) $o->credit;
		}
		return array('lignes' => $lignes, 'total_debit' => round($debit, 2), 'total_credit' => round($credit, 2));
	}

	/**
	 * Exercices comptables ouverts
	 *
	 * @return array
	 *
	 * @url GET /exercices
	 * @throws RestException 403|500
	 */
	public function getExercices()
	{
		global $conf;
		if (!DolibarrApiAccess::$user->hasRight('accounting', 'mouvements', 'lire')) {
			throw new RestException(403);
		}
		// La colonne d'état s'appelle « statut » : 0 = ouvert.
		$sql = 'SELECT label, date_start, date_end FROM '.$this->db->prefix().'accounting_fiscalyear';
		$sql .= ' WHERE statut = 0 AND entity = '.((int) $conf->entity).' ORDER BY date_start';
		$res = $this->db->query($sql);
		if (!$res) {
			throw new RestException(500, 'Lecture des exercices impossible');
		}
		$exercices = array();
		while ($o = $this->db->fetch_object($res)) {
			$exercices[] = array('libelle' => $o->label, 'debut' => substr((string) $o->date_start, 0, 10), 'fin' => substr((string) $o->date_end, 0, 10));
		}
		return $exercices;
	}

	/**
	 * État de la tâche « grand livre » (ADR 0002 §5.6)
	 *
	 * Rend le dernier passage de la tâche planifiée et dit s'il est en retard :
	 * un journal qui ne s'écrit plus ne doit pas passer inaperçu.
	 *
	 * @param int $retard_minutes  Au-delà, le passage est en retard {@from query}
	 * @return array
	 *
	 * @url GET /etat
	 * @throws RestException 403
	 */
	public function getEtat($retard_minutes = 15)
	{
		if (!DolibarrApiAccess::$user->hasRight('accounting', 'mouvements', 'lire')) {
			throw new RestException(403);
		}
		$etat = json_decode(getDolGlobalString('SMI_GRAND_LIVRE_ETAT'), true);
		if (!is_array($etat)) {
			return array('statut' => 'jamais_passe', 'en_retard' => true);
		}
		$depuis = isset($etat['horodatage']) ? strtotime($etat['horodatage']) : false;
		$etat['minutes_depuis'] = $depuis ? (int) floor((time() - $depuis) / 60) : null;
		$etat['en_retard'] = !$depuis || $etat['minutes_depuis'] > max(1, (int) $retard_minutes);
		return $etat;
	}

	/** Contrôle d'une pièce avant toute écriture : comptes du plan actif, montants, équilibre. */
	private function verifierLignes($lignes)
	{
		if (!is_array($lignes) || count($lignes) < 2) {
			throw new RestException(422, 'Une piece compte au moins deux lignes');
		}
		$plan = (int) getDolGlobalInt('CHARTOFACCOUNTS');
		$propres = array();
		$vues = array();
		$debit = 0;
		$credit = 0;
		foreach ($lignes as $n => $l) {
			$l = (array) $l;
			$compte = preg_replace('/[^0-9A-Za-z]/', '', (string) ($l['compte'] ?? ''));
			$d = round((float) ($l['debit'] ?? 0), 2);
			$c = round((float) ($l['credit'] ?? 0), 2);
			if ($d < 0 || $c < 0 || ($d > 0) === ($c > 0)) {
				throw new RestException(422, 'Ligne '.($n + 1).' : un debit ou un credit positif, pas les deux');
			}
			// Le plan comptable est tenu par entité : une autre société de la même
			// instance ne doit pas valider un compte à la place de celle-ci.
			$sql = 'SELECT a.label FROM '.$this->db->prefix().'accounting_account a';
			$sql .= ' JOIN '.$this->db->prefix().'accounting_system s ON s.pcg_version = a.fk_pcg_version';
			$sql .= " WHERE s.rowid = ".$plan." AND a.account_number = '".$this->db->escape($compte)."' AND a.active = 1";
			$sql .= ' AND a.entity = '.((int) $GLOBALS['conf']->entity);
			$res = $this->db->query($sql);
			$o = $res ? $this->db->fetch_object($res) : null;
			if (!$o) {
				throw new RestException(422, 'Ligne '.($n + 1).' : compte '.$compte.' absent du plan comptable actif');
			}
			$libelle = trim((string) ($l['libelle'] ?? ''));
			$tiers = trim((string) ($l['tiers'] ?? ''));
			// Dolibarr reconnaît une ligne déjà écrite à (pièce, compte, libellé, tiers) : deux lignes
			// identiques sur ces points ne feraient qu'une.
			$cle = $compte.'|'.$libelle.'|'.$tiers;
			if (isset($vues[$cle])) {
				throw new RestException(422, 'Ligne '.($n + 1).' : meme compte, libelle et tiers qu une autre ligne');
			}
			$vues[$cle] = true;
			$propres[] = array('compte' => $compte, 'libelle_compte' => $o->label, 'libelle' => $libelle, 'tiers' => $tiers, 'debit' => $d, 'credit' => $c);
			$debit += $d;
			$credit += $c;
		}
		if (abs($debit - $credit) > 0.005) {
			throw new RestException(422, 'Piece non equilibree : debit '.$debit.', credit '.$credit);
		}
		return $propres;
	}

	private function pieceExistante($reference)
	{
		$sql = 'SELECT piece_num, COUNT(*) AS n FROM '.$this->db->prefix().'accounting_bookkeeping';
		// Par entité : la même référence dans une autre société de l'instance n'est pas « déjà écrite » ici.
		$sql .= " WHERE doc_type = '".self::DOC_TYPE."' AND doc_ref = '".$this->db->escape($reference)."'";
		$sql .= ' AND entity = '.((int) $GLOBALS['conf']->entity).' GROUP BY piece_num';
		$res = $this->db->query($sql);
		$o = $res ? $this->db->fetch_object($res) : null;
		return $o ? array('piece_num' => (int) $o->piece_num, 'lignes' => (int) $o->n) : null;
	}
}
