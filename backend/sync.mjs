import { ensure } from './money.mjs';
export class SyncEngine {
  constructor(service,getToken,fetcher=fetch) {this.service=service;this.getToken=getToken;this.fetcher=fetcher;this.running=false;}
  async run() {
    const s=this.service,config=s.settings().sync;
    if(!config.enabled)return {disabled:true};if(this.running)return {running:true};
    const token=this.getToken();ensure(token,'Enregistrez une clé de synchronisation.');this.running=true;s.put('syncLastAttempt',new Date().toISOString());
    try {
      let sent=0;
      for(let batch=0;batch<100;batch++) {
        const events=s.db.prepare("SELECT * FROM outbox WHERE state='pending' ORDER BY seq LIMIT 200").all().map(r=>({id:r.id,seq:r.seq,type:r.type,payload:JSON.parse(r.payload)}));
        const response=await this.fetcher(`${config.endpoint}/sync`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({deviceId:s.get('deviceId'),cursor:Number(s.get('syncCursor')||0),events}),signal:AbortSignal.timeout(30000)});
        ensure(response.ok,`Serveur de synchronisation : ${response.status}.`);const data=await response.json();
        ensure(Array.isArray(data.results)&&Array.isArray(data.changes)&&Number.isSafeInteger(data.cursor),'Réponse de synchronisation invalide.');
        const ids=new Set(events.map(e=>e.id));ensure(data.results.length===events.length&&new Set(data.results.map(r=>r.id)).size===events.length,'Le serveur n’a pas confirmé chaque opération une seule fois.');
        s.transaction(()=>{
          for(const result of data.results) {
            ensure(ids.has(result.id)&&['accepted','conflict'].includes(result.status),'Confirmation de synchronisation invalide.');const event=events.find(e=>e.id===result.id);
            if(result.status==='accepted'){
              s.db.prepare("UPDATE outbox SET state='synced',error=NULL WHERE id=?").run(result.id);sent++;
              if(event.type==='entity'&&Number.isSafeInteger(result.revision)){
                s.db.prepare('UPDATE entities SET revision=? WHERE id=?').run(result.revision,event.payload.id);
                const pending=s.db.prepare("SELECT * FROM outbox WHERE type='entity' AND state='pending' AND json_extract(payload,'$.id')=?").all(event.payload.id);
                for(const p of pending){const payload=JSON.parse(p.payload);payload.baseRevision=result.revision;s.db.prepare('UPDATE outbox SET payload=? WHERE id=?').run(JSON.stringify(payload),p.id);}
              }
            }else{
              s.db.prepare("UPDATE outbox SET state='conflict',error='Modification concurrente' WHERE id=?").run(result.id);
              s.db.prepare('INSERT OR REPLACE INTO sync_conflicts VALUES (?,?)').run(result.id,JSON.stringify({event,remote:result.remote}));
            }
          }
          ensure(data.results.length===events.length,'Le serveur n’a pas confirmé toutes les opérations.');
          for(const change of data.changes){
            if(change.type==='entity'){
              const p=change.payload;ensure(typeof p.id==='string'&&typeof p.kind==='string'&&Number.isSafeInteger(p.revision)&&p.data&&typeof p.data==='object','Fiche distante invalide.');
              if(s.db.prepare("SELECT 1 FROM outbox WHERE type='entity' AND state IN ('pending','conflict') AND json_extract(payload,'$.id')=?").get(p.id))continue;
              s.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=excluded.revision,active=excluded.active').run(p.id,p.kind,JSON.stringify(p.data),p.revision,Number(p.active));
            }
          }
          s.put('syncCursor',data.cursor);s.put('syncLastSuccess',new Date().toISOString());s.put('syncLastError','');
        });
        if(events.length<200 && !data.hasMore)break;
      }
      return {ok:true,sent};
    }catch(error){s.put('syncLastError',error.message);throw error;}finally{this.running=false;}
  }
  resolve(args){
    const s=this.service,row=s.db.prepare('SELECT * FROM sync_conflicts WHERE id=?').get(args.id);ensure(row,'Conflit introuvable.');ensure(['local','remote'].includes(args.choice),'Choix invalide.');const c=JSON.parse(row.data),p=c.event.payload;
    return s.transaction(()=>{
      if(args.choice==='remote'){const r=c.remote;s.db.prepare('UPDATE entities SET data=?,revision=?,active=? WHERE id=?').run(JSON.stringify(r.data),r.revision,Number(r.active),p.id);s.db.prepare("UPDATE outbox SET state='superseded' WHERE type='entity' AND state IN ('conflict','pending') AND json_extract(payload,'$.id')=?").run(p.id);}
      else {const row=s.db.prepare('SELECT * FROM entities WHERE id=?').get(p.id);s.db.prepare('UPDATE entities SET revision=? WHERE id=?').run(c.remote.revision,p.id);s.emit('entity',{id:p.id,kind:row.kind,data:JSON.parse(row.data),active:!!row.active,baseRevision:c.remote.revision});s.db.prepare("UPDATE outbox SET state='superseded' WHERE id=?").run(args.id);}
      s.db.prepare('DELETE FROM sync_conflicts WHERE id=?').run(args.id);return {ok:true};
    });
  }
  start(){this.timer=setInterval(()=>this.tick(),60000);this.timer.unref?.();void this.tick();}
  async tick(){const s=this.service;if(!s.settings().sync.enabled||this.running)return;const success=Date.parse(s.get('syncLastSuccess')||0)||0,attempt=Date.parse(s.get('syncLastAttempt')||0)||0;if(Date.now()-success>=20*60000&&Date.now()-attempt>=5*60000){try{await this.run();}catch{ /* Persisted in settings; retry without disrupting the cashier. */ }}}
  stop(){clearInterval(this.timer);}
}
