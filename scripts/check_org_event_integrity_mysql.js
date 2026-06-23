'use strict';
process.env.DB_DRIVER='mysql';
const db=require('../backend/db');
async function main(){
  const index=await db.queryOne("SELECT COUNT(*) AS total FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='org_departement_fonction_events' AND INDEX_NAME='uq_org_dfe_version_event' AND NON_UNIQUE=0");
  if(Number(index?.total||0)<1)throw new Error('Index unique du journal d’événements absent');
  const duplicates=await db.query("SELECT fonction_id,event_type,version_apres,COUNT(*) AS total FROM org_departement_fonction_events GROUP BY fonction_id,event_type,version_apres HAVING COUNT(*)>1");
  if(duplicates.length)throw new Error(`Événements dupliqués: ${JSON.stringify(duplicates)}`);
  console.log(JSON.stringify({ok:true,event_integrity:true}));
}
main().then(()=>db._pool.end()).catch(async error=>{console.error('[org-event-integrity]',error.message);try{await db._pool.end();}catch(_){}process.exitCode=1;});
