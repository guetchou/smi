<?php
/*
 * Module « smi » — pont entre Tala SMI et Dolibarr, sans écran.
 *
 * ADR 0002 de Tala SMI (29/09/2026) : Dolibarr fait foi pour les tiers, les
 * factures et la comptabilité, mais n'est jamais montré aux utilisateurs.
 * Ce module ajoute à l'API REST ce qui n'y figure pas ; il ne crée ni menu,
 * ni écran, ni table, ni droit : il s'appuie sur les droits de la comptabilité.
 */
include_once DOL_DOCUMENT_ROOT.'/core/modules/DolibarrModules.class.php';

class modSmi extends DolibarrModules
{
	public function __construct($db)
	{
		$this->db = $db;
		// Plage réservée aux modules externes.
		$this->numero = 509950;
		$this->rights_class = 'smi';
		$this->family = 'financial';
		$this->module_position = '90';
		$this->name = preg_replace('/^mod/i', '', get_class($this));
		$this->description = 'Pont Tala SMI (API, sans ecran)';
		$this->version = '0.1.0';
		$this->const_name = 'MAIN_MODULE_'.strtoupper($this->name);
		$this->picto = 'generic';
		$this->module_parts = array();
		$this->dirs = array();
		$this->config_page_url = array();
		$this->depends = array('modAccounting', 'modBanque', 'modApi');
		$this->requiredby = array();
		$this->conflictwith = array();
		$this->langfiles = array();
		$this->phpmin = array(7, 4);
		$this->need_dolibarr_version = array(22, 0);
		$this->const = array();
		$this->rights = array();
		$this->menu = array();
	}

	public function init($options = '')
	{
		return $this->_init(array(), $options);
	}

	public function remove($options = '')
	{
		return $this->_remove(array(), $options);
	}
}
