import pg from 'pg';
import {createHash} from 'node:crypto';
import {ensure} from './money.mjs';
import {validateSync} from './cloud-validation.mjs';
import {cloudData} from './cloud-data.mjs';
const SCHEMA=`CREATE TABLE IF NOT EXISTS pos_receipts(id TEXT PRIMARY KEY,device TEXT NOT NULL,hash TEXT NOT NULL,result JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS pos_entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data JSONB NOT NULL,active BOOLEAN NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pos_changes(cursor BIGSERIAL PRIMARY KEY,type TEXT NOT NULL,payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS pos_records(type TEXT NOT NULL,id TEXT NOT NULL,device TEXT NOT NULL,payload JSONB NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(type,id));
CREATE TABLE IF NOT EXISTS pos_devices(id TEXT PRIMARY KEY,last_seen TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS pos_login_attempts(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,blocked_until TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL);`;
export class PostgresCloud{
 constructor(connectionString,{pool}={}){this.pool=pool||new pg.Pool({connectionString,max:3,idleTimeoutMillis:10000,connectionTimeoutMillis:10000,statement_timeout:15000});this.pool.on?.('error',()=>{});this.ready=null;}
 initialize(){if(!this.ready)this.ready=(async()=>{const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(748279031)');await c.query(SCHEMA);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}})().catch(e=>{this.ready=null;throw e;});return this.ready;}
 async transaction(fn){await this.initialize();const c=await this.pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async sync(body){validateSync(body);return this.transaction(async c=>{
 await c.query('SELECT pg_advisory_xact_lock(748279031)');const results=[];
 for(const event of body.events){const hash=createHash('sha256').update(JSON.stringify(event)).digest('hex'),prior=(await c.query('SELECT * FROM pos_receipts WHERE id=$1',[event.id])).rows[0];
 if(prior){ensure(prior.device===body.deviceId&&prior.hash===hash,'Identifiant déjà utilisé pour une autre opération.',409);results.push(prior.result);continue;}
 const p=event.payload;let result={id:event.id,status:'accepted'};
 if(event.type==='entity'){const current=(await c.query('SELECT * FROM pos_entities WHERE id=$1',[p.id])).rows[0];if(current&&p.kind==='material')ensure(current.data.unit===p.data.unit,'L’unité matière ne peut pas changer.');if((current?.revision||0)!==p.baseRevision){ensure(current,'Révision distante introuvable.',409);result={id:event.id,status:'conflict',remote:{id:current.id,kind:current.kind,data:current.data,active:current.active,revision:current.revision}};}else{const revision=(current?.revision||0)+1;await c.query('INSERT INTO pos_entities VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET data=excluded.data,active=excluded.active,revision=excluded.revision',[p.id,p.kind,p.data,p.active,revision]);await c.query('INSERT INTO pos_changes(type,payload) VALUES ($1,$2)',['entity',{...p,revision}]);result.revision=revision;}}
 else{const id=event.type==='company'?'company':p.id,payloadHash=createHash('sha256').update(JSON.stringify(p)).digest('hex'),old=(await c.query('SELECT * FROM pos_records WHERE type=$1 AND id=$2',[event.type,id])).rows[0];if(old&&['sale','expense','clientPayment','supplierPayment','saleVoid','materialPurchase'].includes(event.type))ensure(old.device===body.deviceId&&old.hash===payloadHash,'Un enregistrement financier ne peut pas être écrasé.',409);if(old&&event.type==='session')ensure(old.device===body.deviceId,'Cette session appartient à un autre poste.',409);if(old&&event.type==='session'&&old.payload.closedAt&&!p.closedAt){/* An old opening event cannot reopen a synchronized closure. */}else await c.query('INSERT INTO pos_records VALUES ($1,$2,$3,$4,$5) ON CONFLICT(type,id) DO UPDATE SET payload=excluded.payload,hash=excluded.hash,device=excluded.device',[event.type,id,body.deviceId,p,payloadHash]);}
 await c.query('INSERT INTO pos_receipts VALUES ($1,$2,$3,$4)',[event.id,body.deviceId,hash,result]);results.push(result);
 }
 await c.query('INSERT INTO pos_devices VALUES ($1,NOW()) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen',[body.deviceId]);
 const changes=(await c.query('SELECT * FROM pos_changes WHERE cursor>$1 ORDER BY cursor LIMIT 500',[body.cursor])).rows,cursor=changes.length?Number(changes.at(-1).cursor):body.cursor;
 return {results,changes:changes.map(r=>({type:r.type,payload:r.payload})),cursor,hasMore:(await c.query('SELECT 1 FROM pos_changes WHERE cursor>$1 LIMIT 1',[cursor])).rowCount>0};
 });}
 async dashboard(args){return this.transaction(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');const records=(await c.query('SELECT type,device,payload FROM pos_records')).rows,entities=(await c.query('SELECT * FROM pos_entities')).rows,devices=(await c.query('SELECT id,last_seen FROM pos_devices ORDER BY last_seen DESC')).rows.map(d=>({...d,last_seen:new Date(d.last_seen).toISOString()}));return cloudData({records,entities,devices},args);});}
 async loginAttempt(id,valid){return this.transaction(async c=>{await c.query('DELETE FROM pos_login_attempts WHERE updated_at<NOW()-INTERVAL \'1 day\'');await c.query('INSERT INTO pos_login_attempts(id,updated_at) VALUES ($1,NOW()) ON CONFLICT(id) DO NOTHING',[id]);const r=(await c.query('SELECT * FROM pos_login_attempts WHERE id=$1 FOR UPDATE',[id])).rows[0];ensure(!r.blocked_until||new Date(r.blocked_until).getTime()<Date.now(),'Réessayez dans 5 minutes.',429);if(valid){await c.query('DELETE FROM pos_login_attempts WHERE id=$1',[id]);return true;}const n=r.attempts+1;await c.query('UPDATE pos_login_attempts SET attempts=$2,blocked_until=CASE WHEN $2>=5 THEN NOW()+INTERVAL \'5 minutes\' ELSE NULL END,updated_at=NOW() WHERE id=$1',[id,n>=5?5:n]);return false;});}
 close(){return this.pool.end();}
}
