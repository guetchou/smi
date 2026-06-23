'use strict';
process.env.DB_DRIVER='mysql';
const db=require('../backend/db');
async function main(){
  const employees=await db.execute("UPDATE employes e JOIN org_postes p ON LOWER(TRIM(p.libelle))=LOWER(TRIM(e.poste)) AND p.actif=1 SET e.poste_id=p.id WHERE e.poste_id IS NULL AND COALESCE(e.poste,'')<>''");
  const functions=await db.execute('UPDATE org_departement_fonctions f JOIN employes e ON e.id=f.employe_id SET f.poste_id=e.poste_id WHERE f.poste_id IS NULL AND e.poste_id IS NOT NULL');
  console.log(JSON.stringify({ok:true,employee_jobs:employees.affectedRows,function_jobs:functions.affectedRows}));
}
main().then(()=>db._pool.end()).catch(async error=>{console.error('[org-jobs-backfill]',error.message);try{await db._pool.end();}catch(_){}process.exitCode=1;});
