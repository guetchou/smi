'use strict';
const assert = require('assert');
const mysql = require('../backend/node_modules/mysql2/promise');
const base = 'smi_provision_banc_' + Date.now() + '_' + process.pid;
const options = { host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || '', multipleStatements: true };
async function main() {
  const admin = await mysql.createConnection(options);
  let db;
  try {
    if (!/^smi_provision_banc_[0-9]+_[0-9]+$/.test(base)) throw Error('Unsafe test database');
    await admin.query('CREATE DATABASE ' + base);
    await admin.changeUser({database:base});
    await admin.query([
      "CREATE TABLE employes(id INT AUTO_INCREMENT PRIMARY KEY,matricule VARCHAR(100),nom VARCHAR(100),prenom VARCHAR(100),email VARCHAR(150),email_professionnel VARCHAR(150),actif INT DEFAULT 1,statut_dossier VARCHAR(30) DEFAULT 'actif',onboarding_status VARCHAR(30) DEFAULT 'incomplet',updated_at DATETIME)",
      "CREATE TABLE users(id INT AUTO_INCREMENT PRIMARY KEY,nom VARCHAR(100),prenom VARCHAR(100),email VARCHAR(150) UNIQUE,login_identifier VARCHAR(100) UNIQUE,password_hash VARCHAR(100),role VARCHAR(40),roles TEXT,sous_role VARCHAR(40),employe_id INT,actif INT,must_change_password INT,temp_password_hash VARCHAR(100),provisioned_by INT,provisioned_at DATETIME,created_at DATETIME,updated_at DATETIME,sessions_invalides_avant DATETIME)",
      "CREATE TABLE profiles(id INT AUTO_INCREMENT PRIMARY KEY,code VARCHAR(100) UNIQUE,libelle VARCHAR(100),actif INT DEFAULT 1)",
      "CREATE TABLE user_profiles(id INT AUTO_INCREMENT PRIMARY KEY,user_id INT,profile_id INT,active INT,source VARCHAR(30),created_by INT,updated_at DATETIME,UNIQUE(user_id,profile_id),FOREIGN KEY(user_id) REFERENCES users(id))",
      "CREATE TABLE permission_audit_logs(id INT AUTO_INCREMENT PRIMARY KEY,actor_user_id INT,target_user_id INT,table_name VARCHAR(80),record_id INT,action VARCHAR(100),details TEXT)",
      "CREATE TABLE onboarding_tasks(id INT AUTO_INCREMENT PRIMARY KEY,employe_id INT,task_key VARCHAR(100),status VARCHAR(30),required INT,completed_at DATETIME,completed_by INT,notes TEXT,updated_at DATETIME)",
      "CREATE TABLE onboarding_events(id INT AUTO_INCREMENT PRIMARY KEY,employe_id INT,event_type VARCHAR(100),new_value TEXT,created_by INT,created_at DATETIME,ip_address VARCHAR(100))",
      "INSERT INTO profiles(code,libelle) VALUES ('technicien_surface','Technicien de surface')"
    ].join(';'));
    Object.assign(process.env,{DB_DRIVER:'mysql',MYSQL_DATABASE:base,MYSQL_HOST:options.host,MYSQL_PORT:String(options.port),MYSQL_USER:options.user,MYSQL_PASSWORD:options.password,JWT_SECRET:require('crypto').randomBytes(32).toString('hex')});
    db = require('../backend/db');
    const service = require('../backend/services/user_provisioning');
    let seq=0;
    async function employee() {
      const suffix='provision_'+(++seq);
      const r=await db.execute("INSERT INTO employes(matricule,nom,prenom,email) VALUES (?,'Agent','Test',?)",[suffix,suffix+'@example.invalid']);
      await db.execute("INSERT INTO onboarding_tasks(employe_id,task_key,status,required) VALUES (?,'create_user_account','todo',1)",[r.insertId]);
      return r.insertId;
    }
    const emp=await employee();
    const result=await service.provisionUser(emp,{role:'lecteur',profile_code:'technicien_surface'},'127.0.0.1');
    assert(result.temp_password && result.user_id);
    assert.strictEqual((await db.queryOne('SELECT onboarding_status FROM employes WHERE id=?',[emp])).onboarding_status,'pret');
    assert.strictEqual((await db.queryOne('SELECT status FROM onboarding_tasks WHERE employe_id=?',[emp])).status,'done');
    assert.strictEqual((await db.queryOne('SELECT COUNT(*) n FROM user_profiles WHERE user_id=? AND active=1 AND source=?',[result.user_id,'manual'])).n,1);
    assert.strictEqual((await db.queryOne('SELECT COUNT(*) n FROM permission_audit_logs WHERE target_user_id=?',[result.user_id])).n,1);
    assert.strictEqual((await db.queryOne('SELECT COUNT(*) n FROM onboarding_events WHERE employe_id=?',[emp])).n,1);
    await assert.rejects(()=>service.provisionUser(emp,{role:'lecteur',profile_code:'technicien_surface'}));
    const concurrentEmployee=await employee();
    const concurrent=await Promise.allSettled(['first','second'].map(name=>service.provisionUser(concurrentEmployee,{role:'lecteur',profile_code:'technicien_surface',email:name+'@example.invalid'})));
    assert.strictEqual(concurrent.filter(r=>r.status==='fulfilled').length,1,'concurrent requests created two accounts');
    assert.strictEqual((await db.queryOne('SELECT COUNT(*) n FROM users WHERE employe_id=?',[concurrentEmployee])).n,1);
    const otherEmployee=await employee();
    const other=await service.provisionUser(otherEmployee,{role:'lecteur',profile_code:'technicien_surface'});
    const reassignedEmployee=await employee();
    const identity=require('../backend/services/identity_access');
    const reassign=await Promise.allSettled([result.user_id,other.user_id].map(id=>identity.updateUserAccess(id,{employe_id:reassignedEmployee})));
    assert.strictEqual(reassign.filter(r=>r.status==='fulfilled').length,1,'concurrent edits linked two users to one employee');
    assert.strictEqual((await db.queryOne('SELECT COUNT(*) n FROM users WHERE employe_id=?',[reassignedEmployee])).n,1);
    const inactive=await employee();
    await db.execute('UPDATE employes SET actif=0 WHERE id=?',[inactive]);
    await assert.rejects(()=>service.provisionUser(inactive,{role:'lecteur',profile_code:'technicien_surface'}));
    assert.strictEqual((await db.queryOne('SELECT COUNT(*) n FROM users WHERE employe_id=?',[inactive])).n,0);
    const transaction=db.transaction.bind(db);
    for(const marker of ['INSERT INTO user_profiles','UPDATE onboarding_tasks','INSERT INTO onboarding_events','UPDATE employes SET onboarding_status']) {
      const target=await employee();
      const tables=['users','user_profiles','permission_audit_logs','onboarding_events'];
      const counts=await Promise.all(tables.map(t=>db.queryOne('SELECT COUNT(*) n FROM '+t)));
      db.transaction=fn=>transaction(async tx=>{
        const execute=tx.execute.bind(tx);
        tx.execute=async(sql,params)=>{
          if(sql.trim().startsWith(marker))throw Error('FORCED_PROVISION_FAILURE');
          return execute(sql,params);
        };
        return fn(tx);
      });
      try {await assert.rejects(()=>service.provisionUser(target,{role:'lecteur',profile_code:'technicien_surface'}),/FORCED_PROVISION_FAILURE/);}
      finally {db.transaction=transaction;}
      for(let i=0;i<tables.length;i++)assert.strictEqual((await db.queryOne('SELECT COUNT(*) n FROM '+tables[i])).n,counts[i].n,marker+' left partial '+tables[i]);
      assert.strictEqual((await db.queryOne('SELECT status FROM onboarding_tasks WHERE employe_id=?',[target])).status,'todo');
      assert.strictEqual((await db.queryOne('SELECT onboarding_status FROM employes WHERE id=?',[target])).onboarding_status,'incomplet');
    }
    console.log('user_provisioning_atomic_mysql: OK - commit, chosen profile, onboarding status, duplicate and concurrent refusal and four complete rollbacks');
  } finally {
    if(db)await db._pool.end();
    if(/^smi_provision_banc_[0-9]+_[0-9]+$/.test(base))await admin.query('DROP DATABASE IF EXISTS '+base);
    await admin.end();
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
