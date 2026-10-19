import {createHmac,createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {ensure} from './money.mjs';
export const canonical=value=>JSON.stringify(sort(value));
function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,sort(v[k])])):v;}
export class FiscalIntegrity {
  constructor(store,key){this.s=store;this.key=key;}
  digest(value){ensure(this.key,'Clé d’intégrité indisponible : restauration contrôlée requise.',423);return createHmac('sha256',this.key).update(canonical(value)).digest('hex');}
  sealHead(){
    if(this.s.db.isTransaction)return;
    const row=this.s.db.prepare('SELECT seq,digest FROM fiscal_integrity ORDER BY seq DESC LIMIT 1').get();if(!row)return;
    const anchor={seq:row.seq,digest:row.digest};this.anchor={...anchor,mac:this.digest(anchor)};
    if(this.s.path!==':memory:'){
      const file=this.s.path+'.integrity-head',temp=file+'.'+randomUUID()+'.tmp',raw=Buffer.from(JSON.stringify(this.anchor));
      writeFileSync(temp,this.s.options.protectIntegrityKey?this.s.options.protectIntegrityKey(raw):raw,{mode:0o600,flag:'wx'});renameSync(temp,file);
    }
  }
  readAnchor(){
    if(this.s.path!==':memory:'){
      const file=this.s.path+'.integrity-head';if(!existsSync(file))return null;
      try{const raw=readFileSync(file);return JSON.parse(this.s.options.unprotectIntegrityKey?this.s.options.unprotectIntegrityKey(raw).toString():raw.toString());}catch{throw Error('Ancre d’intégrité illisible : restauration contrôlée requise.');}
    }
    return this.anchor;
  }
  append(kind,ref,data){
    const last=this.s.db.prepare('SELECT seq,digest FROM fiscal_integrity ORDER BY seq DESC LIMIT 1').get();
    const entry={seq:(last?.seq||0)+1,kind,ref,data,createdAt:new Date().toISOString(),previous:last?.digest||'GENESIS'};
    const digest=this.digest(entry);
    this.s.db.prepare('INSERT INTO fiscal_integrity VALUES (?,?,?,?,?,?,?)').run(entry.seq,kind,ref,JSON.stringify(data),entry.createdAt,entry.previous,digest);
    this.s.put('fiscalIntegrityHead',digest);this.sealHead();return digest;
  }
  verify(){
    let previous='GENESIS',seq=0,anchorSeen=false;const anchor=this.readAnchor();
    if(anchor)ensure(anchor.mac===this.digest({seq:anchor.seq,digest:anchor.digest}),'Ancre d’intégrité altérée.',423);
    for(const r of this.s.db.prepare('SELECT * FROM fiscal_integrity ORDER BY seq').all()){
      const expected=this.digest({seq:r.seq,kind:r.kind,ref:r.ref,data:JSON.parse(r.data),createdAt:r.created_at,previous:r.previous});
      ensure(r.seq===++seq&&r.previous===previous&&r.digest.length===expected.length&&timingSafeEqual(Buffer.from(r.digest),Buffer.from(expected)),'Altération de la piste fiscale détectée.',423);previous=r.digest;
      if(anchor&&r.seq===anchor.seq&&r.digest===anchor.digest)anchorSeen=true;
      if(r.kind==='DOCUMENT_SIGNED'){
        const doc=this.s.db.prepare('SELECT payload,signed FROM fiscal_documents WHERE id=?').get(r.ref);
        ensure(doc&&canonical({payload:JSON.parse(doc.payload),signed:JSON.parse(doc.signed)})===canonical(JSON.parse(r.data)),'Altération d’un ticket fiscal détectée.',423);
      }
      if(r.kind==='SALE_COMMITTED'){
        const sale=this.s.db.prepare('SELECT data FROM sales WHERE id=?').get(r.ref);
        ensure(sale&&canonical(JSON.parse(sale.data))===canonical(JSON.parse(r.data)),'Altération d’une vente fiscale détectée.',423);
      }
      if(r.kind==='MIGRATION_ANCHOR'){for(const [table,items] of Object.entries(JSON.parse(r.data)))for(const item of items){const row=this.s.db.prepare(`SELECT * FROM ${table==='sales'?'sales':'audit'} WHERE id=?`).get(item.id);ensure(row&&createHash('sha256').update(canonical(row)).digest('hex')===item.hash,'Altération des données antérieures à la migration.',423);}}
      if(r.kind==='AUDIT'){
        const row=this.s.db.prepare('SELECT * FROM audit WHERE id=?').get(r.ref);
        ensure(row&&canonical(row)===canonical(JSON.parse(r.data)),'Altération d’une trace audit détectée.',423);
      }
    }
    ensure((seq?previous:'')===(this.s.get('fiscalIntegrityHead')||''),'Troncature de la piste fiscale détectée.',423);
    ensure(!anchor&&!seq||anchor&&anchorSeen,'Ancre absente ou troncature du journal fiscal détectée.',423);
    if(anchor&&seq>anchor.seq)this.sealHead();
    return {ok:true,entries:seq,head:seq?previous:null};
  }
}
