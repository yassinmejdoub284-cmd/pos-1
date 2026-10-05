import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensure, integer, PosError, dayInTunis } from './money.mjs';
import {cloudData} from './cloud-data.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const digest=value=>createHash('sha256').update(value).digest();
const same=(a,b)=>typeof a==='string'&&timingSafeEqual(digest(a),digest(b));
export function createCloud({file='data/cloud.db',syncToken,adminPassword}) {
  ensure(typeof syncToken==='string'&&syncToken.length>=24,'SYNC_TOKEN requis (24 caractères minimum).');ensure(typeof adminPassword==='string'&&adminPassword.length>=12,'ADMIN_PASSWORD requis (12 caractères minimum).');
  if(file!==':memory:')mkdirSync(dirname(resolve(file)),{recursive:true});const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,device TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,data TEXT NOT NULL,active INTEGER NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS changes(cursor INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS records(type TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(type,id));
    CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,last_seen TEXT NOT NULL);`);
  const sessions=new Map(),attempts=new Map();
  const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
  function sync(body){
    ensure(typeof body.deviceId==='string'&&/^[0-9a-f-]{36}$/i.test(body.deviceId),'Poste invalide.');integer(body.cursor,'Curseur');ensure(Array.isArray(body.events)&&body.events.length<=200,'Lot invalide.');
    return tx(()=>{
      const results=[];
      for(const event of body.events){
        ensure(typeof event.id==='string'&&/^[0-9a-f-]{36}$/i.test(event.id),'Événement invalide.');integer(event.seq,'Séquence',1);ensure(['entity','sale','saleVoid','session','expense','clientPayment','supplierPayment','company','stock'].includes(event.type),'Type d’événement inconnu.');
        const hash=digest(JSON.stringify(event)).toString('hex'),prior=db.prepare('SELECT * FROM receipts WHERE id=?').get(event.id);
        if(prior){ensure(prior.device===body.deviceId&&prior.hash===hash,'Identifiant déjà utilisé pour une autre opération.',409);results.push(JSON.parse(prior.result));continue;}
        const p=event.payload;ensure(p&&typeof p==='object'&&!Array.isArray(p),'Contenu invalide.');let result={id:event.id,status:'accepted'};
        if(event.type==='entity'){
          ensure(['family','product','supplement','comment','expenseCategory','client','supplier'].includes(p.kind)&&typeof p.id==='string'&&p.data&&typeof p.data.name==='string','Fiche invalide.');integer(p.baseRevision,'Révision');
          const current=db.prepare('SELECT * FROM entities WHERE id=?').get(p.id);
          if((current?.revision||0)!==p.baseRevision){result={id:event.id,status:'conflict',remote:{id:current.id,kind:current.kind,data:JSON.parse(current.data),active:!!current.active,revision:current.revision}};}
          else {const revision=(current?.revision||0)+1;db.prepare('INSERT INTO entities VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,active=excluded.active,revision=excluded.revision').run(p.id,p.kind,JSON.stringify(p.data),Number(p.active),revision);db.prepare('INSERT INTO changes(type,payload) VALUES (?,?)').run('entity',JSON.stringify({...p,revision}));result.revision=revision;}
        }else{
          if(event.type==='sale'){
            ensure(p.deviceId===body.deviceId&&Array.isArray(p.items)&&p.items.length>0,'Vente invalide.');integer(p.total,'Total');integer(p.subtotal,'Sous-total');integer(p.discount,'Remise',0,p.subtotal);ensure(p.total===p.subtotal-p.discount,'Total incohérent.');
            let subtotal=0;for(const i of p.items){integer(i.quantity,'Quantité',1,99);integer(i.price,'Prix');ensure(Array.isArray(i.supplements),'Suppléments invalides.');let unit=i.price;for(const x of i.supplements)unit+=integer(x.price,'Prix supplément');ensure(i.total===unit*i.quantity,'Ligne incohérente.');subtotal+=i.total;}ensure(subtotal===p.subtotal,'Sous-total incohérent.');
          }
          if(event.type==='stock'){ensure(p.deviceId===body.deviceId&&p.id===`${body.deviceId}:${p.productId}`&&typeof p.active==='boolean','Stock invalide.');integer(p.quantity,'Stock',0,1_000_000);integer(p.minQuantity,'Seuil de stock',0,1_000_000);}
          const id=event.type==='company'?'company':p.id;ensure(typeof id==='string'&&id.length<=100,'Identifiant manquant.');
          const old=db.prepare('SELECT * FROM records WHERE type=? AND id=?').get(event.type,id);
          if(old&&['sale','expense','clientPayment','supplierPayment','saleVoid'].includes(event.type))ensure(old.payload===JSON.stringify(p),'Un enregistrement financier ne peut pas être écrasé.',409);
          db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(type,id) DO UPDATE SET payload=excluded.payload').run(event.type,id,JSON.stringify(p));
        }
        db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(event.id,body.deviceId,hash,JSON.stringify(result));results.push(result);
      }
      db.prepare('INSERT INTO devices VALUES (?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen').run(body.deviceId,new Date().toISOString());
      const changes=db.prepare('SELECT * FROM changes WHERE cursor>? ORDER BY cursor LIMIT 500').all(body.cursor);const cursor=changes.length?changes.at(-1).cursor:body.cursor;
      return {results,changes:changes.map(r=>({type:r.type,payload:JSON.parse(r.payload)})),cursor,hasMore:!!db.prepare('SELECT 1 FROM changes WHERE cursor>? LIMIT 1').get(cursor)};
    });
  }
  const all=type=>db.prepare('SELECT payload FROM records WHERE type=?').all(type).map(r=>JSON.parse(r.payload));
  function report(day){
    ensure(/^\d{4}-\d{2}-\d{2}$/.test(day),'Date invalide.');const originals=all('sale'),voids=all('saleVoid'),voidIds=new Set(voids.map(x=>x.id));const sales=originals.filter(s=>s.day===day).map(s=>({...s,voided:voidIds.has(s.id)}));const refunds=voids.filter(v=>dayInTunis(new Date(v.voidedAt))===day).map(v=>originals.find(s=>s.id===v.id)).filter(Boolean),expenses=all('expense').filter(e=>e.day===day);
    const sum=xs=>xs.reduce((n,s)=>n+s.total,0),net=p=>sum(sales.filter(s=>s.payment===p))-sum(refunds.filter(s=>s.payment===p)),byProduct={};
    for(const [list,sign] of [[sales,1],[refunds,-1]])for(const s of list)for(const i of s.items){const p=byProduct[i.productId]||={name:i.name,quantity:0,total:0};p.quantity+=sign*i.quantity;p.total+=sign*i.total;}
    return {day,sales,expenses,grossTotal:sum(sales),refundsTotal:sum(refunds),total:sum(sales)-sum(refunds),count:sales.length,voided:refunds.length,cash:net('cash'),card:net('card'),credit:net('credit'),expensesTotal:expenses.reduce((n,e)=>n+e.amount,0),products:Object.values(byProduct).sort((a,b)=>b.quantity-a.quantity),devices:db.prepare('SELECT * FROM devices').all(),company:all('company')[0]||{name:'Samurai POS'}};
  }
  const server=createServer(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
    try{
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/health')return send(200,{ok:true,version:1});
      if(req.method==='GET'&&['/','/online.js','/ui.mjs','/dashboard-period.mjs','/styles.css','/theme.css','/online.css'].includes(url.pathname)){
        const path=url.pathname==='/'?'online.html':url.pathname==='/online.js'?'cloud-ui.mjs':url.pathname.slice(1);res.writeHead(200,{'Content-Type':path.endsWith('.html')?'text/html; charset=utf-8':(path.endsWith('.js')||path.endsWith('.mjs'))?'text/javascript; charset=utf-8':'text/css; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'});return res.end(readFileSync(resolve(root,'frontend',path)));
      }
      let body={};if(req.method==='POST'){ensure(req.headers['content-type']?.startsWith('application/json'),'JSON requis.',415);let size=0,raw='';for await(const chunk of req){size+=chunk.length;ensure(size<=2_000_000,'Requête trop volumineuse.',413);raw+=chunk;}body=JSON.parse(raw);}
      if(req.method==='POST'&&url.pathname==='/sync'){ensure(same(req.headers.authorization||'',`Bearer ${syncToken}`),'Clé incorrecte.',401);return send(200,sync(body));}
      if(req.method==='POST'&&url.pathname==='/admin/login'){
        const ip=req.socket.remoteAddress,attempt=attempts.get(ip)||{n:0,until:0};ensure(attempt.until<Date.now(),'Réessayez dans 5 minutes.',429);
        if(!same(body.password,adminPassword)){attempt.n++;if(attempt.n>=5){attempt.until=Date.now()+300000;attempt.n=0;}attempts.set(ip,attempt);throw new PosError('Mot de passe incorrect.',401);}attempts.delete(ip);
        const token=randomBytes(32).toString('hex');sessions.set(token,Date.now()+3600000);return send(200,{token});
      }
      const token=(req.headers.authorization||'').replace(/^Bearer /,'');ensure((sessions.get(token)||0)>Date.now(),'Connexion requise.',401);
      if(req.method==='GET'&&url.pathname==='/admin/data')return send(200,dashboard(Object.fromEntries(url.searchParams)));
      if(req.method==='GET'&&url.pathname==='/admin/report')return send(200,report(url.searchParams.get('day')||dayInTunis()));
      throw new PosError('Page introuvable.',404);
    }catch(error){send(error.status||400,{error:error instanceof SyntaxError?'Requête JSON invalide.':error.message});}
  });
  function dashboard(args){return cloudData({records:db.prepare('SELECT type,payload FROM records').all().map(r=>({...r,payload:JSON.parse(r.payload)})),entities:db.prepare('SELECT * FROM entities').all().map(r=>({...r,data:JSON.parse(r.data)})),devices:db.prepare('SELECT * FROM devices ORDER BY last_seen DESC').all()},args);}
  return {server,db,sync,report,dashboard,close:()=>{server.close();db.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const cloud=createCloud({file:process.env.POS_CLOUD_DB||'data/cloud.db',syncToken:process.env.SYNC_TOKEN,adminPassword:process.env.ADMIN_PASSWORD});
  cloud.server.listen(Number(process.env.PORT||3256),process.env.HOST||'127.0.0.1',()=>console.log('Samurai POS : serveur de synchronisation démarré.'));
}
