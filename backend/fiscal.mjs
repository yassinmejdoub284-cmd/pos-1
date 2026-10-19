import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {ensure,label,integer,dayInTunis,PosError} from './money.mjs';
import {NacefClient,NacefError,agentURL,manifestState,assertCanSign,qrDataURL} from './nacef-client.mjs';
import {FiscalIntegrity,canonical} from './fiscal-integrity.mjs';
import {fiscalTicket,validateFiscalTicket} from './fiscal-ticket.mjs';
export const FISCAL_DEFAULTS={enabled:false,environment:'test',agentURL:'http://localhost:10006/sic/external',model:'Samurai POS',software:'SamuraiPOS-0.7.0',serialNumber:'',imdf:'',accreditationReference:'',merchantId:'',commercialName:'',establishment:'000',address:'',city:'',zeroAdditionalTaxCode:'20',carrierId:'',families:{}};
const json=JSON.parse;
const now=()=>new Date().toISOString();
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const readonly=new Set(['bootstrap','setupStatus','login','logout','saleByRequest','saleDetails','report','closures','previewClosure','previewReceipt','printers','sessionSummary','vfdPorts','fiscalStatus','fiscalManifest','fiscalDocuments','fiscalExport','fiscalPreview','fiscalVerify']);
export function installFiscalSchema(s){
  s.db.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_documents(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,sale_id TEXT,kind TEXT NOT NULL,context TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,sale_snapshot TEXT NOT NULL,status TEXT NOT NULL,signed TEXT,error TEXT,input_hash TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fiscal_integrity(seq INTEGER PRIMARY KEY,kind TEXT NOT NULL,ref TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,previous TEXT NOT NULL,digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fiscal_periods(id TEXT PRIMARY KEY,kind TEXT NOT NULL,period TEXT NOT NULL UNIQUE,data TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fiscal_print_jobs(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES fiscal_documents(id),state TEXT NOT NULL DEFAULT 'pending',error TEXT,attempts INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fiscal_log_outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fiscal_applied_documents(id TEXT PRIMARY KEY REFERENCES fiscal_documents(id));
    CREATE TRIGGER IF NOT EXISTS fiscal_applied_no_delete BEFORE DELETE ON fiscal_applied_documents BEGIN SELECT RAISE(ABORT,'Application fiscale immuable'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_applied_no_update BEFORE UPDATE ON fiscal_applied_documents BEGIN SELECT RAISE(ABORT,'Application fiscale immuable'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_integrity_no_update BEFORE UPDATE ON fiscal_integrity BEGIN SELECT RAISE(ABORT,'Piste fiscale immuable'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_integrity_no_delete BEFORE DELETE ON fiscal_integrity BEGIN SELECT RAISE(ABORT,'Piste fiscale immuable'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_documents_no_delete BEFORE DELETE ON fiscal_documents BEGIN SELECT RAISE(ABORT,'Ticket fiscal immuable'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_documents_payload_locked BEFORE UPDATE OF payload,reference,request_id,sale_snapshot,kind,context,sale_id,input_hash,created_at ON fiscal_documents BEGIN SELECT RAISE(ABORT,'Ticket fiscal immuable'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_signed_locked BEFORE UPDATE ON fiscal_documents WHEN OLD.signed IS NOT NULL BEGIN SELECT RAISE(ABORT,'Signature fiscale immuable'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_period_no_delete BEFORE DELETE ON fiscal_periods BEGIN SELECT RAISE(ABORT,'Clôture fiscale immuable'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_period_no_update BEFORE UPDATE ON fiscal_periods BEGIN SELECT RAISE(ABORT,'Clôture fiscale immuable'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_sales_no_delete BEFORE DELETE ON sales WHEN (SELECT value FROM meta WHERE key='fiscalLocked')='1' BEGIN SELECT RAISE(ABORT,'Suppression de vente interdite'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_sales_no_update BEFORE UPDATE OF data,total,ticket,request_id,user_id,created_at,day ON sales WHEN (SELECT value FROM meta WHERE key='fiscalLocked')='1' BEGIN SELECT RAISE(ABORT,'Données de vente immuables'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_audit_no_delete BEFORE DELETE ON audit WHEN (SELECT value FROM meta WHERE key='fiscalLocked')='1' BEGIN SELECT RAISE(ABORT,'Suppression audit interdite'); END;
    CREATE TRIGGER IF NOT EXISTS fiscal_audit_no_update BEFORE UPDATE ON audit WHEN (SELECT value FROM meta WHERE key='fiscalLocked')='1' BEGIN SELECT RAISE(ABORT,'Modification audit interdite'); END;
  `);
}
export class FiscalService {
  constructor(service){
    this.s=service;this.busy=false;this.manifest=null;this.error=null;
    installFiscalSchema(service);
    let key=service.options.integrityKey;
    if(!key&&service.path!==':memory:'){
      const file=service.path+'.integrity-key';
      if(existsSync(file)){try{key=service.options.unprotectIntegrityKey?service.options.unprotectIntegrityKey(readFileSync(file)):readFileSync(file);}catch{key=null;}}
      else if(!service.db.prepare('SELECT 1 FROM fiscal_integrity LIMIT 1').get()){
        try{key=randomBytes(32);const bytes=service.options.protectIntegrityKey?service.options.protectIntegrityKey(key):key;writeFileSync(file,bytes,{mode:0o600,flag:'wx'});}catch{key=null;}
      }
    }else if(!key)key=randomBytes(32);
    this.integrity=new FiscalIntegrity(service,key);
    if(this.integrity.readAnchor())this.integrity.verify();
    this.clientFactory=service.options.nacefClientFactory||(url=>new NacefClient(url));
  }
  config(){const c={...FISCAL_DEFAULTS,...this.s.settings().fiscal};const expected=this.s.get('fiscalConfigDigest');if(expected)ensure(this.integrity.digest(c)===expected,'Configuration fiscale altérée : intervention contrôlée requise.',423);return c;}
  enabled(){return this.s.get('fiscalLocked')==='1'||!!this.s.db.prepare('SELECT 1 FROM fiscal_integrity LIMIT 1').get()||this.config().enabled;}
  taxpayer(user){ensure(user.admin||user.permissions.includes('fiscal'),'Accès contribuable NACEF requis.',403);}
  pending(){return this.s.db.prepare("SELECT * FROM fiscal_documents WHERE status IN ('PREPARED','SENDING','UNKNOWN') OR status='SIGNED' AND id NOT IN (SELECT id FROM fiscal_applied_documents) ORDER BY created_at LIMIT 1").get();}
  guard(action){
    if(readonly.has(action))return;
    ensure(!this.busy,'Une opération fiscale est en cours. Attendez son résultat.',409);
    if(this.enabled()){
      const pending=this.pending();
      ensure(!pending||['sale','fiscalResume'].includes(action),`Ticket ${pending?.reference} à réconcilier avant toute autre modification.`,423);
    }
  }
  async exclusive(fn){ensure(!this.busy,'Une opération fiscale est déjà en cours.',409);this.busy=true;try{return await fn();}finally{this.busy=false;}}
  async configure(args,user){
    this.taxpayer(user);ensure(user.admin,'Seul le propriétaire administrateur peut configurer NACEF.',403);
    ensure(this.integrity.key,'Clé d’intégrité protégée indisponible. Rétablissez le stockage sécurisé avant activation.',423);
    const prior=this.config();const c={...prior,...args,families:args.families||prior.families};
    ensure(typeof c.enabled==='boolean'&&['test','production'].includes(c.environment),'Mode NACEF invalide.');c.agentURL=agentURL(c.agentURL);
    ensure(!this.s.get('fiscalLocked')||c.enabled,'Le mode fiscal ne peut pas être désactivé après activation.');
    for(const field of ['model','software','serialNumber','imdf','accreditationReference','merchantId','commercialName','establishment','address','city','zeroAdditionalTaxCode','carrierId'])ensure(typeof c[field]==='string',`Champ fiscal invalide : ${field}.`);
    if(c.enabled){
      ensure(/^\d{7}[A-Z]$/.test(c.merchantId),'Matricule fiscal : 7 chiffres et une lettre majuscule.');
      ensure(/^\d{3}$/.test(c.establishment),'Établissement : 3 chiffres.');
      for(const [field,min,max] of [['model',1,64],['software',8,32],['serialNumber',8,32],['accreditationReference',8,32],['commercialName',1,64],['address',8,128],['city',3,32],['zeroAdditionalTaxCode',1,16]])ensure(c[field].length>=min&&c[field].length<=max,`Champ fiscal ${field} : ${min}-${max} caractères.`);
      ensure(c.imdf.length>=14&&c.imdf.length<=16,'IMDF : 14 à 16 caractères.');
      ensure(!c.carrierId||/^\d{7}[A-Z]$/.test(c.carrierId),'Matricule du transporteur invalide.');
      ensure(c.families&&typeof c.families==='object'&&!Array.isArray(c.families),'Familles fiscales invalides.');
      for(const [id,m] of Object.entries(c.families)){this.s.entity(id,'family');ensure(m&&typeof m.code==='string'&&m.code.length>=2&&m.code.length<=8&&typeof m.taxCode==='string'&&m.taxCode.length>=1&&m.taxCode.length<=16,'Code famille ou taxe invalide.');integer(m.rateBps,'Taux TVA en centièmes de pourcent',0,10000);}
    }
    if(this.s.get('fiscalLocked'))for(const field of ['environment','merchantId','establishment','serialNumber','software','accreditationReference'])ensure(c[field]===prior[field],`Identité fiscale ${field} verrouillée ; nouvelle version/installation contrôlée requise.`);
    if(c.imdf!==prior.imdf&&this.s.get('fiscalLocked'))ensure(typeof args.changeReason==='string'&&args.changeReason.trim().length>=8,'Motif de remplacement du MDF requis.');
    delete c.changeReason;
    return this.s.transaction(()=>{
      const settings=this.s.settings();settings.fiscal=c;this.s.put('settings',JSON.stringify(settings));this.s.put('fiscalConfigDigest',this.integrity.digest(c));
      if(c.enabled&&!this.s.get('fiscalLocked')){this.s.put('fiscalLocked','1');this.integrity.append('MIGRATION_ANCHOR','legacy',{sales:this.s.db.prepare('SELECT * FROM sales ORDER BY ticket').all().map(r=>({id:r.id,hash:hash(r)})),audit:this.s.db.prepare('SELECT * FROM audit ORDER BY created_at,id').all().map(r=>({id:r.id,hash:hash(r)}))});}
      this.s.audit(user,'fiscal.parameters',{before:prior,after:c});this.manifest=null;return c;
    });
  }
  status(){
    let integrity;try{integrity=this.integrity.verify();}catch(e){integrity={ok:false,error:e.message};}
    const c=this.config(),pending=this.pending();
    const cert=this.manifest?.certificateInfo,days=cert?.expirationDate?Math.ceil((Date.parse(cert.expirationDate)-Date.now())/86400000):null;
    return {enabled:c.enabled,environment:c.environment,manifest:this.manifest,error:this.error,checkedAt:this.checkedAt,integrity,pending:pending?{id:pending.id,reference:pending.reference,status:pending.status,requestId:pending.request_id,error:pending.error}:null,certificateWarning:days!==null&&days<=30?`Certificat : expiration dans ${days} jour(s).`:null,logPending:this.s.db.prepare("SELECT COUNT(*) n FROM fiscal_log_outbox WHERE state='pending'").get().n};
  }
  client(){return this.clientFactory(this.config().agentURL);}
  async getManifest(){
    try{this.manifest=await this.client().call('manifest');ensure(this.manifest&&typeof this.manifest==='object','Manifest invalide.');this.checkedAt=now();this.error=null;return this.manifest;}catch(e){this.manifest=null;this.checkedAt=now();this.error=e.message;throw e;}
  }
  async certificate(user){this.taxpayer(user);return this.exclusive(async()=>{const c=this.config();ensure(c.enabled,'Configurez NACEF.');const result=await this.client().call('certificate',{cashRegisterInfo:{model:c.model,serialNumber:c.serialNumber,version:'0.7.0'}});this.manifest=result;this.s.audit(user,'fiscal.certificate.request');return this.status();});}
  async synchronize(args,user){this.taxpayer(user);return this.exclusive(async()=>{const result=await this.client().call('sync',{requestPINupdate:args.requestPINupdate===true,updateSMDFURL:args.updateSMDFURL===true});this.manifest=result;this.s.audit(user,'fiscal.sync');if(result.ticketZeroQRCode){const qr=qrDataURL(result.ticketZeroQRCode);this.s.put('fiscalTicketZero',JSON.stringify({qr,imdf:result.imdf,date:now()}));if(this.s.options.printFiscalZero)await this.s.options.printFiscalZero({qr,imdf:result.imdf,date:now()});}await this.flushLogs();return this.status();});}
  log(action,data,user,auditId){
    if(!this.enabled())return;
    this.integrity.append('AUDIT',auditId,this.s.db.prepare('SELECT * FROM audit WHERE id=?').get(auditId));
    const operations={'login':'USER_LOGIN','login.failed':'USER_LOGIN','sale.create':'CASHING','sale.void':'CASHING','fiscal.parameters':'PARAMETERS','fiscal.certificate.request':'CERT_REQUEST','fiscal.sync':'SYNC_REQUEST','fiscal.signature':'SIGN_REQUEST','backup':'BACKUP','fiscal.archive':'BACKUP','fiscal.printer':'PRINTER'};
    const operation=operations[action]||'PARAMETERS';
    this.s.db.prepare('INSERT INTO fiscal_log_outbox(id,payload,created_at) VALUES (?,?,?)').run(randomUUID(),JSON.stringify({module:action==='login'?'LC_SECURITY':action.startsWith('fiscal.')?'LC_AGENT':'LC',operation,level:action.endsWith('.failed')||data?.error?'ERROR':'INFO',message:JSON.stringify({action,userId:user?.id||null,...data})}),now());
  }
  async flushLogs(){
    for(const row of this.s.db.prepare("SELECT * FROM fiscal_log_outbox WHERE state='pending' ORDER BY created_at LIMIT 100").all()){
      try{await this.client().call('log',json(row.payload));this.s.db.prepare("UPDATE fiscal_log_outbox SET state='sent',error=NULL WHERE id=?").run(row.id);}catch(e){this.s.db.prepare('UPDATE fiscal_log_outbox SET error=? WHERE id=?').run(e.message,row.id);break;}
    }
  }
  assertPeriod(date){const last=this.s.db.prepare('SELECT payload FROM fiscal_documents ORDER BY created_at DESC LIMIT 1').get();ensure(!last||Date.parse(date)>=Date.parse(json(last.payload).transaction.timestamp),'Horloge reculée : chronologie fiscale invalide.',423);const day=dayInTunis(new Date(date));ensure(!this.s.db.prepare('SELECT 1 FROM fiscal_periods WHERE period IN (?,?,?)').get(day,day.slice(0,7),day.slice(0,4)),'Période fiscale clôturée.',423);}
  prepareSale(args,user){try{this.s.createSale(args,user,true);}catch(e){if(e.preparedSale)return e.preparedSale;throw e;}}
  async sale(args,user,{operation='TICKET',context='SALE',original}={}){
    this.taxpayer(user);
    ensure(this.enabled(),'Mode NACEF non activé.');
    ensure(context!=='TRAINING'||user.admin,'Mode formation réservé au contribuable administrateur.',403);
    return this.exclusive(async()=>{
      this.integrity.verify();
      const requestId=label(args.requestId,'Identifiant fiscal',100),inputHash=hash({args,operation,context,original:original?.id||null});
      let doc=this.s.db.prepare('SELECT * FROM fiscal_documents WHERE request_id=?').get(requestId);
      if(doc){ensure(doc.input_hash===inputHash,'Cette demande fiscale possède déjà un autre contenu.',409);return this.finish(doc,user,true);}
      ensure(!this.pending(),'Une signature est à réconcilier avant une nouvelle transaction.',423);
      let sale=original?{...original,id:randomUUID(),requestId,userId:user.id,userName:user.name,createdAt:now(),payment:original.payment,received:original.payment==='cash'?original.total:original.received,change:0}:this.prepareSale({...args,print:true},user);
      this.assertPeriod(sale.createdAt);
      const manifest=await this.getManifest();assertCanSign(manifest);
      ensure(manifest.imdf===this.config().imdf,'IMDF du S-MDF différent de la configuration.');
      let payload,ref;
      this.s.transaction(()=>{
        const sequence=Number(this.s.get('fiscalSequence')||0)+1;ref=`${this.config().serialNumber}-${String(sequence).padStart(10,'0')}`;ensure(ref.length<=48,'Référence fiscale trop longue.');
        if(original){payload=structuredClone(original.fiscal.payload);payload.transaction={...payload.transaction,id:ref,timestamp:sale.createdAt,operation:{op_type:operation,context,...(operation==='DUPLICATE'?{duplicated_transaction_identifier:original.fiscal.reference}:{})},originator:{...payload.transaction.originator,agent_identifier:user.id.replaceAll('-',''),imdf:this.config().imdf}};payload.payment_details={collection_details:[{method:original.payment==='cash'?'cash':'bank_card',amount:original.total}],returned_change:[]};validateFiscalTicket(payload);}
        else{const client=args.clientId?this.s.entity(args.clientId,'client'):null;const customer=client?.fiscalId?{id_type:'PP',id:client.fiscalId}:{id_type:'NP'};payload=fiscalTicket(sale,this.config(),{reference:ref,operation,context,customer,carrierId:args.carrierId});}
        this.s.put('fiscalSequence',sequence);
        if(operation==='TICKET'&&context==='SALE')this.s.put('ticket',sale.ticket);
        const id=randomUUID();this.s.db.prepare('INSERT INTO fiscal_documents(id,request_id,sale_id,kind,context,reference,payload,sale_snapshot,status,input_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,requestId,operation==='TICKET'&&context==='SALE'?sale.id:original?.id||null,operation,context,ref,JSON.stringify(payload),JSON.stringify(sale),'PREPARED',inputHash,now());
        this.integrity.append('DOCUMENT_PREPARED',id,{payload,sale});doc=this.s.db.prepare('SELECT * FROM fiscal_documents WHERE id=?').get(id);
      });
      return this.finish(doc,user,false);
    });
  }
  async finish(doc,user,repeated){
    ensure(!['UNKNOWN','SENDING'].includes(doc.status),`Signature ${doc.reference} au résultat inconnu : rapprochement NACEF requis. Aucun renvoi automatique.`,423);
    ensure(doc.status!=='REJECTED',`Ticket rejeté : ${doc.error}. Corrigez puis utilisez une nouvelle demande.`,400);
    if(doc.status==='PREPARED'){
      const payload=json(doc.payload);validateFiscalTicket(payload);const manifest=await this.getManifest();assertCanSign(manifest);ensure(manifest.imdf===payload.transaction.originator.imdf,'IMDF du ticket différent du S-MDF courant.');
      // Durable intent BEFORE any remote call. A restart never automatically re-signs SENDING.
      this.s.db.prepare("UPDATE fiscal_documents SET status='SENDING' WHERE id=?").run(doc.id);
      let signed;
      try{
        const result=await this.client().call('sign',{base64Ticket:Buffer.from(JSON.stringify(payload),'utf8').toString('base64'),totalHT:payload.sale_summary.total_excl_tax,totalTax:payload.sale_summary.total_tax,operationType:payload.transaction.operation.op_type,transactionType:payload.transaction.operation.context});
        try{ensure(typeof result?.ticketIdentifier==='string'&&result.ticketIdentifier.length>0&&result.ticketIdentifier.length<=200,'Identifiant fiscal signé manquant.');signed={ticketIdentifier:result.ticketIdentifier,qrcodeImage:qrDataURL(result.qrcodeImage)};}catch(e){e.ambiguous=true;throw e;}
      }catch(e){
        const uncertain=e.ambiguous||!(e instanceof NacefError);this.s.transaction(()=>{this.s.db.prepare('UPDATE fiscal_documents SET status=?,error=? WHERE id=?').run(uncertain?'UNKNOWN':'REJECTED',e.message,doc.id);this.integrity.append('SIGNATURE_ERROR',doc.id,{uncertain,error:e.message});});throw e;
      }
      this.s.transaction(()=>{this.s.db.prepare("UPDATE fiscal_documents SET status='SIGNED',signed=?,error=NULL WHERE id=?").run(JSON.stringify(signed),doc.id);this.integrity.append('DOCUMENT_SIGNED',doc.id,{payload,signed});this.s.audit(user,'fiscal.signature',{id:doc.id,reference:doc.reference,ticketIdentifier:signed.ticketIdentifier});});
      doc=this.s.db.prepare('SELECT * FROM fiscal_documents WHERE id=?').get(doc.id);
    }
    const sale=json(doc.sale_snapshot),payload=json(doc.payload),signed=json(doc.signed);
    sale.fiscal={documentId:doc.id,reference:doc.reference,environment:this.config().environment,payload,...signed};
    if(doc.kind==='TICKET'&&doc.context==='SALE'){
      const exists=this.s.db.prepare('SELECT id FROM sales WHERE id=?').get(sale.id);
      if(!exists)this.commitSale(sale,user);
      return {...sale,duplicate:repeated||!!exists};
    }
    if(doc.kind==='REFUND'&&!this.s.db.prepare('SELECT id FROM fiscal_applied_documents WHERE id=?').get(doc.id))this.s.voidSale({id:doc.sale_id,reason:sale.refundReason||'Remboursement fiscal',fiscalDocumentId:doc.id},user,true);
    else this.s.transaction(()=>this.markApplied(doc.id));
    return {...sale,fiscalDocument:true,duplicate:repeated};
  }
  commitSale(sale,user){
    this.s.transaction(()=>{
      const session=this.s.db.prepare('SELECT closed_at FROM sessions WHERE id=?').get(sale.sessionId);ensure(session&&!session.closed_at,'Session du ticket signé fermée : support requis.',423);
      this.s.materials.consume(sale.items,sale.id,user,sale.createdAt);
      for(const item of sale.items){const stock=this.s.db.prepare('SELECT * FROM stock_items WHERE product_id=?').get(item.productId);if(!stock)continue;const after=stock.quantity-item.quantity;ensure(after>=0,'Stock modifié pendant la signature : support requis.');this.s.db.prepare('UPDATE stock_items SET quantity=?,updated_at=? WHERE product_id=?').run(after,sale.createdAt,item.productId);this.s.db.prepare('INSERT INTO stock_movements VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),`${sale.id}:${item.lineId}`,item.productId,stock.supplier_id,'sale',-item.quantity,stock.quantity,after,0,'',sale.id,user.id,sale.createdAt);this.s.emitStock(item.productId);}
      this.s.db.prepare('INSERT INTO sales(id,request_id,ticket,session_id,user_id,created_at,day,total,payment,client_id,data) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(sale.id,sale.requestId,sale.ticket,sale.sessionId,sale.userId,sale.createdAt,sale.day,sale.total,sale.payment,sale.client?.id||null,JSON.stringify(sale));
      this.integrity.append('SALE_COMMITTED',sale.id,sale);this.s.emit('sale',sale);this.s.audit(user,'sale.create',{id:sale.id,ticket:sale.ticket,total:sale.total,fiscalReference:sale.fiscal.reference});
      for(const kind of this.s.settings().print.kitchen?['client','kitchen']:['client'])this.s.db.prepare('INSERT INTO print_jobs(id,sale_id,kind,created_at) VALUES (?,?,?,?)').run(randomUUID(),sale.id,kind,sale.createdAt);
      this.s.db.prepare('INSERT INTO fiscal_applied_documents VALUES (?)').run(sale.fiscal.documentId);
    });
  }
  markApplied(id){
    const doc=this.s.db.prepare('SELECT kind,context FROM fiscal_documents WHERE id=?').get(id);ensure(doc,'Document fiscal introuvable.');
    if(!this.s.db.prepare('SELECT 1 FROM fiscal_print_jobs WHERE document_id=?').get(id))this.s.db.prepare('INSERT INTO fiscal_print_jobs(id,document_id,created_at) VALUES (?,?,?)').run(randomUUID(),id,now());
    this.s.db.prepare('INSERT OR IGNORE INTO fiscal_applied_documents VALUES (?)').run(id);
  }
  documents(){return this.s.db.prepare('SELECT id,reference,kind,context,status,error,created_at FROM fiscal_documents ORDER BY created_at DESC LIMIT 100').all();}
  documentSale(id){const doc=this.s.db.prepare("SELECT * FROM fiscal_documents WHERE id=? AND signed IS NOT NULL").get(id);ensure(doc,'Ticket fiscal signé introuvable.');return {...json(doc.sale_snapshot),fiscal:{documentId:doc.id,reference:doc.reference,environment:this.config().environment,payload:json(doc.payload),...json(doc.signed)}};}
  closePeriod(args,user){
    this.taxpayer(user);ensure(this.enabled(),'Mode NACEF requis.');this.integrity.verify();ensure(!this.pending(),'Réconciliez le ticket fiscal en attente.');
    ensure(['day','month','year'].includes(args.kind),'Type de clôture invalide.');
    const pattern={day:/^\d{4}-\d{2}-\d{2}$/,month:/^\d{4}-\d{2}$/,year:/^\d{4}$/}[args.kind];ensure(pattern.test(args.period),'Période invalide.');
    ensure(args.period<=dayInTunis().slice(0,args.period.length),'Période future interdite.');
    if(args.kind==='day')ensure(dayInTunis(new Date(args.period+'T12:00:00Z'))===args.period,'Date invalide.');
    ensure(!this.s.db.prepare('SELECT 1 FROM sessions WHERE closed_at IS NULL').get(),'Clôturez toutes les sessions avant la clôture fiscale.');
    const prior=this.s.db.prepare('SELECT data FROM fiscal_periods WHERE period=?').get(args.period);if(prior)return json(prior.data);
    const rows=this.s.db.prepare("SELECT payload FROM fiscal_documents WHERE status='SIGNED' AND context='SALE' AND kind IN ('TICKET','REFUND')").all().map(r=>json(r.payload));
    const total=list=>list.reduce((n,t)=>n+(t.transaction.operation.op_type==='REFUND'?-1:1)*t.sale_summary.total_incl_tax,0);
    const data={id:randomUUID(),kind:args.kind,period:args.period,total:total(rows.filter(t=>dayInTunis(new Date(t.transaction.timestamp)).startsWith(args.period))),perpetual:total(rows),createdAt:now()};
    this.s.transaction(()=>{this.s.db.prepare('INSERT INTO fiscal_periods VALUES (?,?,?,?,?)').run(data.id,data.kind,data.period,JSON.stringify(data),data.createdAt);this.integrity.append('PERIOD_CLOSED',data.id,data);this.s.audit(user,'fiscal.period.close',data);});return data;
  }
  exportData(args,user){
    this.taxpayer(user);this.integrity.verify();const year=String(args.year||dayInTunis().slice(0,4));ensure(/^\d{4}$/.test(year),'Année invalide.');
    const inYear=date=>dayInTunis(new Date(date)).startsWith(year);
    const documents=this.s.db.prepare('SELECT * FROM fiscal_documents ORDER BY created_at,id').all().filter(r=>inYear(json(r.payload).transaction.timestamp)).map(r=>({...r,payload:json(r.payload),signed:r.signed?json(r.signed):null,sale_snapshot:json(r.sale_snapshot)}));
    const integrity=this.s.db.prepare('SELECT * FROM fiscal_integrity ORDER BY seq').all().filter(r=>inYear(r.created_at));
    const legacyAudit=this.s.db.prepare('SELECT * FROM audit ORDER BY created_at,id').all().filter(r=>inYear(r.created_at));
    const timestamp=date=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(date)).replaceAll('-','').replace(' ','-').replaceAll(':','');
    const ascii=value=>JSON.stringify(value).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
    const auditText=legacyAudit.map(r=>[timestamp(r.created_at),'LC',r.action,json(r.data).error?'ERREUR':'INFO',ascii({id:r.id,userId:r.user_id,...json(r.data)})].join(':')).join('\n');
    const data={format:'samurai-fiscal-archive-1',year,deviceId:this.s.get('deviceId'),createdAt:now(),documents,periods:this.s.db.prepare('SELECT * FROM fiscal_periods ORDER BY created_at').all().filter(r=>r.period.startsWith(year)),integrity,chainPredecessor:integrity[0]?.previous||null,head:integrity.at(-1)?.digest||null,legacyAudit,auditText};
    this.s.audit(user,'fiscal.archive',{year,documents:documents.length});return {...data,sha256:hash(data),hmac:this.integrity.digest(data)};
  }
}
