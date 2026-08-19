'use strict';

const db = require('../db');
const daily = require('./pointeuse_v3_daily_service');

function localToUtc(date, time) {
  if (!date || !time) return null;
  const hhmmss = String(time).length === 5 ? `${time}:00` : String(time).slice(0, 8);
  const d = new Date(`${date}T${hhmmss}+01:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

async function insertIfMissing(tx, row, eventType, localTime, keySuffix) {
  if (!localTime) return false;
  const idem = `legacy:${row.id}:${keySuffix}`;
  const existing = await tx.queryOne('SELECT id FROM pointeuse_events WHERE employe_id=? AND idempotency_key=?', [row.employe_id, idem]);
  if (existing) return false;
  const utc = localToUtc(row.date, localTime);
  if (!utc) return false;
  await tx.execute(
    `INSERT INTO pointeuse_events
     (employe_id,event_type,occurred_at_utc,local_date,work_date,local_time,timezone_name,utc_offset_minutes,
      source,mode,site_code,idempotency_key,ip_address,latitude,longitude,precision_gps,hors_perimetre,payload_json,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.employe_id,eventType,utc,row.date,row.date,String(localTime).slice(0,8),'Africa/Brazzaville',60,
     'import',row.mode === 'teletravail' ? 'teletravail' : row.mode === 'terrain' ? 'terrain' : 'bureau',null,idem,
     row.ip_entree || null,row.latitude ?? null,row.longitude ?? null,row.precision_gps ?? null,Number(row.hors_perimetre||0),
     JSON.stringify({legacy_pointage_id:Number(row.id),legacy_status:row.statut,shadow_sync:true}),row.cree_par || null]
  );
  return true;
}

async function syncRange({ debut, fin, employeId = null }) {
  const params = [debut, fin];
  let filter = '';
  if (employeId) { filter = ' AND employe_id=?'; params.push(Number(employeId)); }
  const rows = await db.query(
    `SELECT id,employe_id,date,heure_entree,heure_sortie,statut,mode,ip_entree,latitude,longitude,precision_gps,hors_perimetre,cree_par
     FROM pointages WHERE date BETWEEN ? AND ?${filter} ORDER BY date,id`, params
  );
  let insertedEvents = 0;
  const touched = new Set();
  for (const row of rows) {
    const n = await db.transaction(async tx => {
      let c = 0;
      if (await insertIfMissing(tx,row,'clock_in',row.heure_entree,'in')) c++;
      if (await insertIfMissing(tx,row,'clock_out',row.heure_sortie,'out')) c++;
      return c;
    });
    insertedEvents += n;
    if (row.heure_entree || row.heure_sortie) touched.add(`${row.employe_id}:${row.date}`);
  }
  let recalculatedDays = 0;
  for (const item of touched) {
    const [employee, date] = item.split(':');
    try { await daily.recalculateDay(Number(employee), date); recalculatedDays++; }
    catch (error) { if (error.code !== 'DAY_CLOSED') throw error; }
  }
  return { debut, fin, pointages: rows.length, inserted_events: insertedEvents, recalculated_days: recalculatedDays };
}

module.exports = { localToUtc, syncRange };
