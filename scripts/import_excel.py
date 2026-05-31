#!/usr/bin/env python3
"""
Import GESTION CAISSE-TOP-CENTER 2025.xlsx → SQLite caisse.db
Option A : table rase + import complet Excel
"""
import openpyxl
import sqlite3
import re
import sys
from datetime import datetime

EXCEL_PATH = '/opt/projet-smi/GESTION CAISSE-TOP-CENTER 2025.xlsx'
DB_PATH    = '/opt/projet-smi/backend/data/caisse.db'
BACKUP_PATH = '/opt/projet-smi/backend/data/caisse_backup_pre_import.db'

CAISSE_POS_ID = 1
ADMIN_USER_ID = 1  # created_by

# Catégories (id → nom dans la DB)
CAT = {
    'appro':       1,   # APPRO CAISSE
    'remboursement':2,  # Remboursement reçu
    'cheque':       3,  # Remise chèque
    'autre_rec':    4,  # Autres recettes
    'salaire':      5,  # Salaires
    'transport':    6,  # Transport
    'loyer':        7,  # Loyer
    'telecom':      8,  # Télécom & Internet
    'cnss_camu':    9,  # Charges sociales
    'fournitures':  10, # Achats fournitures
    'abonnement':   11, # Abonnements numériques
    'gestion':      12, # Frais de gestion
    'carburant':    13, # Carburant
    'electricite':  14, # Électricité
    'travaux':      15, # Travaux & Maintenance
    'autre_dep':    16, # Autres dépenses
}

def categorize(libelle, type_op):
    l = libelle.lower()
    if type_op == 'encaissement':
        if 'appro' in l:                          return CAT['appro']
        if 'remboursement' in l or 'dette' in l:  return CAT['remboursement']
        if 'cheque' in l:                         return CAT['cheque']
        return CAT['autre_rec']
    else:  # decaissement
        if 'salaire' in l or 'gratification' in l or 'arriéré' in l or 'arrier' in l or 'prime' in l: return CAT['salaire']
        if 'transport' in l:                      return CAT['transport']
        if 'loyer' in l:                          return CAT['loyer']
        if any(x in l for x in ['mtn','airtel','congo telecom','credit','forfait','telecom','internet','pabx','appel test','recharge']):
            return CAT['telecom']
        if any(x in l for x in ['cnss','camu','impot','impôt']):
            return CAT['cnss_camu']
        if any(x in l for x in ['canva','chatgpt','vps','abonnement num','abonnement digit','carte visa','serveur']):
            return CAT['abonnement']
        if any(x in l for x in ['frais de gestion','frais gestion']):
            return CAT['gestion']
        if 'carburant' in l:                      return CAT['carburant']
        if any(x in l for x in ['électricité','electricite','electri']):
            return CAT['electricite']
        if any(x in l for x in ['travaux','nettoyage','reparation','réparation','installation','cablage','câblage','soudeur','ampoule','plombier','électricien','electricien']):
            return CAT['travaux']
        if any(x in l for x in ['achat','eau','fourniture','stylo','classeur','enveloppe','souris','clavier','batterie','panneau','ram','clé usb','usb','chargeur','raclette']):
            return CAT['fournitures']
        return CAT['autre_dep']

def parse_date(date_c):
    """Normalize various date formats to YYYY-MM-DD"""
    if not date_c:
        return None
    s = str(date_c).strip()
    # "2025-11-14 00:00:00"
    if re.match(r'\d{4}-\d{2}-\d{2}', s):
        return s[:10]
    # "17/11/2025" or "   17/11/2025"
    m = re.search(r'(\d{1,2})/(\d{2})/(\d{4})', s)
    if m:
        day, month, year = m.group(1), m.group(2), m.group(3)
        # Fix typo like year=20260
        if len(year) > 4:
            year = year[:4]
        try:
            return datetime(int(year), int(month), int(day)).strftime('%Y-%m-%d')
        except:
            return None
    # "30/04/20260" style typo
    m2 = re.search(r'(\d{1,2})/(\d{2})/(\d{4})\d*', s)
    if m2:
        try:
            return datetime(int(m2.group(3)[:4]), int(m2.group(2)), int(m2.group(1))).strftime('%Y-%m-%d')
        except:
            return None
    return None

# ── 1. Lire Excel ───────────────────────────────────────────────────────────
print('Lecture Excel...')
wb = openpyxl.load_workbook(EXCEL_PATH, data_only=True)
ws = wb['Nov-Dec-2025']

rows_to_insert = []
skipped = 0
for row in ws.iter_rows(values_only=True):
    date_c = row[2]
    detail = row[3]
    recette = row[5]
    depense = row[6]

    has_rec = recette and isinstance(recette, (int, float)) and float(recette) > 0
    has_dep = depense and isinstance(depense, (int, float)) and float(depense) > 0

    if not (has_rec or has_dep):
        skipped += 1
        continue

    # Exclure les lignes TOTAL / en-têtes (date_c contient "TOTAL" ou "Date")
    if date_c and any(kw in str(date_c).upper() for kw in ('TOTAL', 'DATE', 'DÉTAIL')):
        skipped += 1
        continue
    if detail and (str(detail).upper().startswith('TOTAL') or str(detail).strip() in ('DÉTAIL', 'Date')):
        skipped += 1
        continue

    d = parse_date(date_c)
    if not d:
        skipped += 1
        continue

    libelle = str(detail).strip() if detail else '(sans libellé)'
    type_op = 'encaissement' if has_rec else 'decaissement'
    montant = float(recette) if has_rec else float(depense)
    cat_id  = categorize(libelle, type_op)

    rows_to_insert.append((d, libelle, type_op, montant, cat_id))

print(f'  {len(rows_to_insert)} opérations Excel à importer ({skipped} lignes ignorées)')

# ── 2. Vérifier le solde attendu ─────────────────────────────────────────────
total_enc = sum(r[3] for r in rows_to_insert if r[2] == 'encaissement')
total_dec = sum(r[3] for r in rows_to_insert if r[2] == 'decaissement')
opening   = 1_082_400
expected  = opening + total_enc - total_dec
print(f'\nSolde attendu après import:')
print(f'  Ouverture : {opening:>14,.0f} FCFA')
print(f'  Encaissements : {total_enc:>10,.0f} FCFA  ({sum(1 for r in rows_to_insert if r[2]=="encaissement")} ops)')
print(f'  Décaissements : {total_dec:>10,.0f} FCFA  ({sum(1 for r in rows_to_insert if r[2]=="decaissement")} ops)')
print(f'  SOLDE CALCULÉ : {expected:>12,.0f} FCFA')
print(f'  SOLDE ATTENDU :      371 539 FCFA')
print(f'  ÉCART : {(expected - 371539):,.0f} FCFA')

if abs(expected - 371539) > 1:
    print('\nATTENTION: Écart détecté. Vérifier le fichier Excel.')
else:
    print('\n✓ Solde vérifié.')

# ── 3. Backup ────────────────────────────────────────────────────────────────
import shutil
print(f'\nBackup → {BACKUP_PATH}')
shutil.copy2(DB_PATH, BACKUP_PATH)
print('  Backup OK.')

# ── 4. Supprimer toutes les opérations existantes ────────────────────────────
print('\nSuppression des opérations existantes...')
conn = sqlite3.connect(DB_PATH)
conn.execute('PRAGMA foreign_keys = OFF')
cur = conn.cursor()

cur.execute("DELETE FROM audit_logs WHERE table_name = 'operations'")
cur.execute("DELETE FROM operations")
# Remettre le compteur auto à 0
cur.execute("DELETE FROM sqlite_sequence WHERE name='operations'")
conn.commit()
print(f'  Opérations supprimées.')

# ── 5. Insérer Report à Nouveau ──────────────────────────────────────────────
print('\nInsertion Report à Nouveau...')
cur.execute("""
    INSERT INTO operations (date, libelle, detail, type_op, montant, recette, depense,
        position_id, categorie_id, statut, created_by, created_at)
    VALUES (?, ?, ?, 'encaissement', ?, ?, 0,
        ?, ?, 'valide', ?, datetime('now'))
""", (
    '2025-11-14',
    'Report à Nouveau (au 14/11/2025)',
    'Report à Nouveau (au 14/11/2025)',
    opening, opening,
    CAISSE_POS_ID,
    CAT['appro'],
    ADMIN_USER_ID
))

# ── 6. Insérer toutes les opérations Excel ────────────────────────────────────
print(f'Insertion de {len(rows_to_insert)} opérations Excel...')
inserted = 0
for date, libelle, type_op, montant, cat_id in rows_to_insert:
    recette = montant if type_op == 'encaissement' else 0
    depense = montant if type_op == 'decaissement' else 0
    cur.execute("""
        INSERT INTO operations (date, libelle, detail, type_op, montant, recette, depense,
            position_id, categorie_id, statut, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?,
            ?, ?, 'valide', ?, datetime('now'))
    """, (
        date, libelle, libelle,
        type_op, montant, recette, depense,
        CAISSE_POS_ID, cat_id,
        ADMIN_USER_ID
    ))
    inserted += 1

conn.commit()
print(f'  {inserted} opérations insérées.')

# ── 7. Vérification finale ───────────────────────────────────────────────────
cur.execute("""
    SELECT
        SUM(CASE WHEN type_op='encaissement' THEN montant ELSE 0 END) as enc,
        SUM(CASE WHEN type_op='decaissement' THEN montant ELSE 0 END) as dec,
        COUNT(*) as nb
    FROM operations WHERE statut='valide'
""")
row = cur.fetchone()
enc_db, dec_db, nb_db = row
solde_db = enc_db - dec_db
print(f'\n=== VÉRIFICATION FINALE ===')
print(f'  Opérations valides : {nb_db}')
print(f'  Total encaissements : {enc_db:>14,.0f} FCFA')
print(f'  Total décaissements : {dec_db:>14,.0f} FCFA')
print(f'  SOLDE DB            : {solde_db:>14,.0f} FCFA')
print(f'  SOLDE ATTENDU       :      371 539 FCFA')
print(f'  ÉCART               : {(solde_db - 371539):>14,.0f} FCFA')

if abs(solde_db - 371539) < 1:
    print('\n✓ IMPORT RÉUSSI — Solde correct.')
else:
    print('\n✗ Écart résiduel — vérifier manuellement.')

conn.close()
