'use strict';
const assert=require('assert'),mysql=require('../backend/node_modules/mysql2/promise');
const name='smi_avances_banc_'+Date.now()+'_'+process.pid;
const options={host:process.env.MYSQL_HOST||'127.0.0.1',port:Number(process.env.MYSQL_PORT||3306),user:process.env.MYSQL_USER||'root',password:process.env.MYSQL_PASSWORD||'',multipleStatements:true};
async function main(){
 const admin=await mysql.createConnection(options);let db,created=false;
 try{
 if(!/^smi_avances_banc_[0-9]+_[0-9]+$/.test(name))throw Error('Unsafe fixture');
 await admin.query('CREATE DATABASE '+name);created=true;await admin.changeUser({database:name});
 await admin.query([
 "CREATE TABLE employes(id INT PRIMARY KEY,nom VARCHAR(100),prenom VARCHAR(100),actif INT,statut_dossier VARCHAR(30))",
 "CREATE TABLE employes_avances(id INT PRIMARY KEY,employe_id INT,montant DECIMAL(15,2),solde_restant DECIMAL(15,2),montant_rembourse DECIMAL(15,2) DEFAULT 0,statut VARCHAR(30),statut_workflow VARCHAR(30),operation_id INT,updated_at DATETIME)",
 "CREATE TABLE employes_avances_remboursements(id INT AUTO_INCREMENT PRIMARY KEY,avance_id INT,date DATE,montant DECIMAL(15,2),notes TEXT,created_by INT)",
 "CREATE TABLE positions(id INT PRIMARY KEY,actif INT,type VARCHAR(30),ordre INT,ledger_status VARCHAR(30),solde_initial DECIMAL(15,2))",
 "CREATE TABLE cashbox_balances(caisse_id INT PRIMARY KEY,solde_courant DECIMAL(15,2),derniere_operation_id INT,updated_at DATETIME)",
 "CREATE TABLE categories(id INT PRIMARY KEY,type VARCHAR(30),nom VARCHAR(100))",
 "CREATE TABLE operations(id INT AUTO_INCREMENT PRIMARY KEY,date DATE,libelle TEXT,tiers TEXT,montant DECIMAL(15,2),type_op VARCHAR(30),position_id INT,position_source_id INT,categorie_id INT,mode_reglement VARCHAR(30),employe_id INT,statut VARCHAR(30),dec_statut VARCHAR(30),paid_by INT,paid_at DATETIME,created_by INT)",
 "CREATE TABLE cash_ledger(id INT AUTO_INCREMENT PRIMARY KEY,caisse_id INT,operation_id INT,type_mouvement VARCHAR(30),montant DECIMAL(15,2),solde_avant DECIMAL(15,2),solde_apres DECIMAL(15,2),reference TEXT,created_by INT)",
 "CREATE TABLE audit_logs(id INT AUTO_INCREMENT PRIMARY KEY,table_name VARCHAR(80),record_id INT,action VARCHAR(80),details TEXT,user_id INT)",
 "CREATE TABLE periodes_cloturees(annee INT,mois INT)",
 "CREATE TABLE cashbox_closures(caisse_id INT,date_cloture DATE,statut VARCHAR(30))",
 "CREATE TABLE caisses_clotures(position_id INT,date_cloture DATE,statut VARCHAR(30))",
 "INSERT INTO employes VALUES(1,'Agent','Test',1,'actif')",
 "INSERT INTO positions VALUES(1,1,'caisse',1,'ready',100)",
 "INSERT INTO cashbox_balances(caisse_id,solde_courant) VALUES(1,100)",
 "INSERT INTO categories VALUES(1,'depense','Avance salaire')"
 ].join(';'));
 Object.assign(process.env,{DB_DRIVER:'mysql',DB_POOL_SIZE:'2',MYSQL_DATABASE:name,MYSQL_HOST:options.host,MYSQL_PORT:String(options.port),MYSQL_USER:options.user,MYSQL_PASSWORD:options.password,JWT_SECRET:require('crypto').randomBytes(32).toString('hex')});
 db=require('../backend/db');const router=require('../backend/routes/agents_ecosystem_safe');
 async function call(action,id,body){
  const layer=router.stack.find(x=>x.route?.path==='/:id/avances/:aid/'+action);
  const res={headersSent:false,code:200,status(c){this.code=c;return this},json(p){this.body=p;this.headersSent=true;return this}};
  let error;await layer.route.stack[0].handle({params:{id:1,aid:id},body,user:{id:1,role:'admin'}},res,e=>{error=e});
  if(error)throw error;return res;
 }
 async function advance(id,amount=70){
 await db.execute("INSERT INTO employes_avances(id,employe_id,montant,solde_restant,statut,statut_workflow) VALUES (?,1,?,?,'en_cours','approuve_dg')",[id,amount,amount]);
 }
 await advance(1,100);
 const refund=await Promise.all([call('remboursements',1,{date:'2026-10-08',montant:70}),call('remboursements',1,{date:'2026-10-08',montant:70})]);
 assert.deepStrictEqual(refund.map(x=>x.code).sort(),[201,400]);
 assert.strictEqual((await db.queryOne('SELECT solde_restant FROM employes_avances WHERE id=1')).solde_restant,30);
 assert.strictEqual((await db.queryOne('SELECT COUNT(*) n FROM employes_avances_remboursements')).n,1);
 await advance(2);await advance(3);
 const paid=await Promise.all([call('decaisser',2,{position_id:1}),call('decaisser',3,{position_id:1})]);
 assert.deepStrictEqual(paid.map(x=>x.code).sort(),[200,400]);
 assert.strictEqual((await db.queryOne('SELECT solde_courant FROM cashbox_balances WHERE caisse_id=1')).solde_courant,30);
 assert.strictEqual((await db.queryOne('SELECT COUNT(*) n FROM operations')).n,1);
 await db.execute('UPDATE cashbox_balances SET solde_courant=100 WHERE caisse_id=1');await advance(4);
 const twice=await Promise.all([call('decaisser',4,{position_id:1}),call('decaisser',4,{position_id:1})]);
 assert.deepStrictEqual(twice.map(x=>x.code).sort(),[200,400]);
 await db.execute('UPDATE cashbox_balances SET solde_courant=100 WHERE caisse_id=1');await advance(5);
 await db.execute("INSERT INTO cashbox_closures VALUES(1,CURDATE(),'cloturee')");
 assert.strictEqual((await call('decaisser',5,{position_id:1})).code,400);
 await db.execute('DELETE FROM cashbox_closures');
 const before=(await db.queryOne('SELECT COUNT(*) n FROM operations')).n;
 const tx=db.transaction.bind(db);db.transaction=fn=>tx(t=>fn({...t,execute:async(sql,p)=>{if(sql.startsWith('INSERT INTO audit_logs'))throw Error('injected audit failure');return t.execute(sql,p)}}));
 await assert.rejects(()=>call('decaisser',5,{position_id:1}),/injected/);
 await assert.rejects(()=>call('remboursements',1,{date:'2026-10-08',montant:10}),/injected/);
 db.transaction=tx;
 assert.strictEqual((await db.queryOne('SELECT COUNT(*) n FROM operations')).n,before);
 assert.strictEqual((await db.queryOne('SELECT solde_courant FROM cashbox_balances WHERE caisse_id=1')).solde_courant,100);
 assert.strictEqual((await db.queryOne('SELECT operation_id FROM employes_avances WHERE id=5')).operation_id,null);
 assert.strictEqual((await db.queryOne('SELECT solde_restant FROM employes_avances WHERE id=1')).solde_restant,30);
 await db.execute("INSERT INTO positions VALUES(2,1,'caisse',2,'legacy',100)");await advance(6);await advance(7);
 const legacy=await Promise.all([call('decaisser',6,{position_id:2}),call('decaisser',7,{position_id:2})]);
 assert.deepStrictEqual(legacy.map(x=>x.code).sort(),[200,400]);
 assert.strictEqual((await db.queryOne('SELECT SUM(montant) total FROM operations WHERE position_id=2')).total,70);
 console.log('avances_concurrency_mysql: OK - concurrent repayments, competing payments, duplicate payment, closed day, audit rollback');
 }finally{if(db)await db._pool.end();if(created)await admin.query('DROP DATABASE '+name);await admin.end()}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
