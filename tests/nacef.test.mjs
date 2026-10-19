import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SyncEngine} from '../backend/sync.mjs';
import {openDatabase} from '../backend/database.mjs';
import {PosService} from '../backend/service.mjs';
import {NacefClient,NacefError,assertCanSign,qrDataURL,agentURL} from '../backend/nacef-client.mjs';
import {validateFiscalTicket} from '../backend/fiscal-ticket.mjs';
import {receiptHtml,closureHtml} from '../backend/receipts.mjs';
import {PrintQueue} from '../backend/print-queue.mjs';
import {verifyArchive} from '../scripts/verify-fiscal-archive.mjs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcxkAAAAASUVORK5CYII=';
function fake(){
  const state={manifest:{imdf:'12345678901234',status:'0',state:'ONLINE',certificateInfo:{certRequestStatus:'CREATED',expired:false,revoked:false,expirationDate:'2099-01-01T00:00:00Z'},availableOfflineTickets:10},calls:[],signs:[],unknown:false,logFailure:false};
  state.call=async(op,payload)=>{
    state.calls.push({op,payload});
    if(op==='manifest')return structuredClone(state.manifest);
    if(op==='certificate'){state.manifest.status='2';state.manifest.certificateInfo.certRequestStatus='PIN_VALIDATED';return structuredClone(state.manifest);}
    if(op==='sync'){state.manifest.status='5';state.manifest.certificateInfo.certRequestStatus='CERTIFICATE_GENERATED';state.manifest.availableOfflineTickets=10;return {...structuredClone(state.manifest),ticketZeroQRCode:png};}
    if(op==='log'){if(state.logFailure)throw Error('Logs indisponibles');return {};}
    if(op==='sign'){
      if(state.unknown)throw new NacefError('timeout',{ambiguous:true});
      assertCanSign(state.manifest);const ticket=JSON.parse(Buffer.from(payload.base64Ticket,'base64'));validateFiscalTicket(ticket);
      assert.equal(payload.totalHT,ticket.sale_summary.total_excl_tax);assert.equal(payload.totalTax,ticket.sale_summary.total_tax);
      assert.equal(payload.operationType,ticket.transaction.operation.op_type);assert.equal(payload.transactionType,ticket.transaction.operation.context);
      state.signs.push(ticket);
      if(state.manifest.state==='OFFLINE'){state.manifest.availableOfflineTickets--;if(!state.manifest.availableOfflineTickets)state.manifest.status='4';}
      return {ticketIdentifier:'NACEF-'+state.signs.length,qrcodeImage:png};
    }
  };return state;
}
async function fixture(file=':memory:'){
  const store=openDatabase(file),agent=fake(),service=new PosService(store,{integrityKey:Buffer.alloc(32,7),nacefClientFactory:()=>agent,receipt:receiptHtml});
  await service.call('setup',{name:'Admin',pin:'123456',company:'Restaurant Test'});
  const token=(await service.call('login',{name:'Admin',pin:'123456'})).token;
  const call=(action,args={})=>service.call(action,args,token);
  const family=await call('saveEntity',{kind:'family',data:{name:'Repas'}}),product=await call('saveEntity',{kind:'product',data:{name:'Chapati',price:7000,familyId:family.id}});
  const config={enabled:true,environment:'test',agentURL:'http://localhost:10006/sic/external',serialNumber:'CE-00000001',imdf:'12345678901234',model:'Samurai POS',software:'SamuraiPOS-0.7.0',accreditationReference:'TEST-00000001',merchantId:'1234567A',commercialName:'Restaurant Test',address:'12 avenue de la République',city:'Sfax',establishment:'000',zeroAdditionalTaxCode:'20',families:{[family.id]:{code:'01',rateBps:700,taxCode:'10'}}};
  await call('fiscalConfigure',config);await call('openSession',{opening:0});
  const request=(extra={})=>({requestId:randomUUID(),items:[{productId:product.id,quantity:1}],payment:'cash',received:7000,print:true,...extra});
  return {store,agent,service,token,call,family,product,config,request,close:()=>store.db.close()};
}
test('NACEF: certificate gate, ticket zero, online, offline quota, suspension and revocation (procedure 1-21)',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.call('sale',f.request()),/certificat/);assert.equal(f.agent.signs.length,0);
    await f.call('fiscalCertificate');assert.equal((await f.call('fiscalStatus')).manifest.status,'2');
    await assert.rejects(f.call('sale',f.request()),/Demande déposée/);
    f.agent.manifest.certificateInfo.certRequestStatus='CERTIFICATE_GENERATED';f.agent.manifest.status='4';
    await assert.rejects(f.call('sale',f.request()),/Synchronisez/);
    await f.call('fiscalSynchronize');assert.ok(f.store.get('fiscalTicketZero'));
    await f.call('sale',f.request());await f.call('sale',f.request());
    f.agent.manifest.state='OFFLINE';for(let n=0;n<3;n++)await f.call('sale',f.request());
    f.agent.manifest.state='ONLINE';await f.call('fiscalManifest');assert.equal((await f.call('fiscalStatus')).manifest.availableOfflineTickets,7);
    await f.call('sale',f.request());f.agent.manifest.state='OFFLINE';for(let n=0;n<7;n++)await f.call('sale',f.request());
    f.agent.manifest.state='ONLINE';await assert.rejects(f.call('sale',f.request()),/Synchronisez/);
    await f.call('fiscalSynchronize');f.agent.manifest.status='3';
    await assert.rejects(f.call('sale',f.request()),/suspendue/);f.agent.manifest.state='OFFLINE';await assert.rejects(f.call('sale',f.request()),/suspendue/);
    f.agent.manifest.certificateInfo.revoked=true;for(const state of ['ONLINE','OFFLINE']){f.agent.manifest.state=state;await assert.rejects(f.call('sale',f.request()),/révoqué/);}
    assert.equal(f.agent.signs.length,13);assert.ok((await f.call('fiscalVerify')).ok);
  }finally{f.close();}
});
test('NACEF: idempotent sale, immutable receipts, distinct duplicate and compensating refund',async()=>{
  const f=await fixture();try{
    await f.call('fiscalSynchronize');const req=f.request();const sale=await f.call('sale',req);
    assert.equal((await f.call('sale',req)).duplicate,true);assert.equal(f.agent.signs.length,1);
    await assert.rejects(f.call('sale',{...req,received:8000}),/autre contenu/);
    const html=receiptHtml(sale,'client',f.service.settings());assert.match(html,/NACEF-1/);assert.match(html,/IMDF/);assert.match(html,/6\.542 DT/);assert.doesNotMatch(html,/costing|knownCost/);
    const copy=await f.call('fiscalDuplicate',{id:sale.fiscal.documentId,requestId:randomUUID()});
    assert.equal(copy.fiscal.payload.transaction.operation.op_type,'DUPLICATE');assert.equal(copy.fiscal.payload.transaction.operation.duplicated_transaction_identifier,sale.fiscal.reference);assert.notEqual(copy.fiscal.reference,sale.fiscal.reference);
    await f.call('voidSale',{id:sale.id,reason:'Produit retourné'});assert.equal(f.agent.signs.at(-1).transaction.operation.op_type,'REFUND');assert.equal((await f.call('sessionSummary')).expected,0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sales').get().n,1);assert.ok((await f.call('fiscalVerify')).ok);
    assert.throws(()=>f.store.db.prepare('DELETE FROM sales').run(),/interdite/);
    assert.throws(()=>f.store.db.prepare("UPDATE sales SET total=1").run(),/immuables/);
    await assert.rejects(f.call('clearLocalHistory',{code:'any'}),/Effacement interdit/);
    await assert.rejects(f.call('fiscalConfigure',{...f.config,enabled:false}),/désactivé/);
  }finally{f.close();}
});
test('NACEF: ambiguous signature is persisted and never automatically submitted twice',async()=>{
  const f=await fixture();try{
    await f.call('fiscalSynchronize');f.agent.unknown=true;const req=f.request();
    await assert.rejects(f.call('sale',req),/timeout/);assert.equal(f.store.db.prepare('SELECT status FROM fiscal_documents').get().status,'UNKNOWN');
    for(const a of [()=>f.call('sale',req),()=>f.call('sale',f.request()),()=>f.call('closeSession',{closing:0}),()=>f.call('fiscalResume')])await assert.rejects(a(),/inconnu|réconcilier|modifier|attente/);
    assert.equal(f.agent.calls.filter(x=>x.op==='sign').length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sales').get().n,0);
  }finally{f.close();}
});
test('NACEF: training and proforma are signed without consuming stock or increasing revenue',async()=>{
  const f=await fixture();try{
    await f.call('fiscalSynchronize');const training=await f.call('fiscalTraining',f.request()),proforma=await f.call('fiscalProforma',f.request());
    assert.equal(training.fiscal.payload.transaction.operation.context,'TRAINING');assert.equal(proforma.fiscal.payload.transaction.operation.op_type,'PROFORMA');assert.equal((await f.call('report')).total,0);assert.equal((await f.call('sessionSummary')).expected,0);
    assert.match(receiptHtml(training,'client',f.service.settings()),/TICKET FORMATION/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM fiscal_print_jobs').get().n,2);
  }finally{f.close();}
});
test('NACEF: period counters, yearly archive and database tamper detection',async()=>{
  const f=await fixture();try{
    await f.call('fiscalSynchronize');await f.call('sale',f.request());await f.call('closeSession',{closing:7000});
    const period=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const closed=await f.call('fiscalClosePeriod',{kind:'day',period});assert.equal(closed.total,7000);assert.equal(closed.perpetual,7000);
    await f.call('openSession',{opening:0});await assert.rejects(f.call('sale',f.request()),/clôturée/);
    const archive=await f.call('fiscalExport',{year:period.slice(0,4)});assert.equal(archive.documents.length,1);assert.equal(archive.hmac.length,64);
    assert.equal(verifyArchive(archive,Buffer.alloc(32,7)).authenticated,true);assert.equal(verifyArchive(archive).authenticated,false);
    assert.match(archive.auditText,/LC:/);assert.ok([...archive.auditText].every(c=>c.charCodeAt(0)<128));
    const altered=structuredClone(archive);altered.documents[0].payload.sale_summary.total_incl_tax=1;assert.throws(()=>verifyArchive(altered),/Checksum/);
    f.store.db.exec('DROP TRIGGER fiscal_sales_no_update');f.store.db.prepare("UPDATE sales SET data=json_set(data,'$.total',1)").run();
    await assert.rejects(f.call('fiscalVerify'),/Altération/);
  }finally{f.close();}
});
test('NACEF: millime rounding, change, fiscal access and required delivery identity',async()=>{
  const f=await fixture();try{
    await f.call('fiscalSynchronize');const sale=await f.call('sale',f.request({items:[{productId:f.product.id,quantity:2}],discount:1000,received:15000}));
    assert.equal(sale.total,13000);assert.equal(sale.fiscal.payload.payment_details.returned_change[0].amount,2000);
    assert.equal(sale.fiscal.payload.sale_summary.total_excl_tax,12150);assert.equal(sale.fiscal.payload.sale_summary.total_tax,850);
    await assert.rejects(f.call('sale',f.request({mode:'livraison'})),/Ticket NACEF invalide/);
    await f.call('saveUser',{name:'Agent',pin:'654321',permissions:['sell'],admin:false});const agent=(await f.service.call('login',{name:'Agent',pin:'654321'})).token;
    await assert.rejects(f.service.call('fiscalCertificate',{},agent),/contribuable/);await assert.rejects(f.service.call('sale',f.request(),agent),/contribuable/);
    assert.equal(f.agent.signs.length,1);
  }finally{f.close();}
});
test('NACEF: actual API paths, envelopes, 401, timeout, QR types and endpoint restrictions',async()=>{
  const calls=[];let response={status:200,ok:true,text:async()=>JSON.stringify({object:{status:'5'},errorCode:0})};
  const client=new NacefClient('http://localhost:10006/sic/external',{fetchImpl:async(url,options)=>{calls.push({url,options});return response;}});
  assert.equal((await client.call('manifest')).status,'5');await client.call('sign',{totalHT:13000,totalTax:2240});assert.match(calls[1].url,/\/sic\/external\/sign\/request$/);assert.equal(calls[1].options.headers['Content-Type'],'application/json');
  response={status:401,ok:false,text:async()=>JSON.stringify({message:'no'})};await assert.rejects(client.call('manifest'),/certificat/);
  response={status:200,ok:true,text:async()=>'{broken'};await assert.rejects(client.call('sign',{}),e=>e.ambiguous===true);
  assert.match(qrDataURL([...Buffer.from(png,'base64')]),/^data:image\/png/);assert.throws(()=>qrDataURL('PHNjcmlwdD4='),/PNG|invalide/);
  assert.throws(()=>agentURL('http://evil.example/sic/external'),/HTTPS/);assert.throws(()=>agentURL('https://localhost/other'),/chemin/);
});
test('NACEF: original printer failure retries without signing; completed original creates a new duplicate',async()=>{
  const f=await fixture();try{
    await f.call('fiscalSynchronize');const sale=await f.call('sale',f.request());let fail=true;
    const queue=new PrintQueue(f.service,{receiptHtml,closureHtml,printHtml:async()=>{if(fail)throw Error('papier');}});f.service.options.printSale=(s,k)=>queue.printSale(s,k);
    await queue.drain();assert.equal(f.agent.signs.length,1);fail=false;await f.call('printSale',{id:sale.id,kind:'client'});assert.equal(f.agent.signs.length,1);
    const copy=await f.call('printSale',{id:sale.id,kind:'client',requestId:randomUUID()});assert.equal(copy.fiscal.payload.transaction.operation.op_type,'DUPLICATE');assert.equal(f.agent.signs.length,2);
  }finally{f.close();}
});
test('NACEF: a signed result survives a crash before business commit, without another signature',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nacef-recovery-')),file=join(dir,'pos.sqlite');const f=await fixture(file);let reopened;
  try{
    await f.call('fiscalSynchronize');f.service.fiscal.commitSale=()=>{throw Error('power loss');};
    await assert.rejects(f.call('sale',f.request()),/power loss/);assert.equal(f.agent.signs.length,1);f.store.db.close();
    reopened=openDatabase(file);const s=new PosService(reopened,{integrityKey:Buffer.alloc(32,7),nacefClientFactory:()=>f.agent});
    const token=(await s.call('login',{name:'Admin',pin:'123456'})).token;const recovered=await s.call('fiscalResume',{},token);
    assert.equal(recovered.total,7000);assert.equal(f.agent.signs.length,1);assert.equal(reopened.db.prepare('SELECT COUNT(*) n FROM sales').get().n,1);assert.ok(s.fiscal.integrity.verify().ok);
  }finally{try{f.store.db.close();}catch{}reopened?.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('NACEF: UNKNOWN remains blocked after restart and concurrent checkout/cloud changes are refused',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nacef-unknown-')),file=join(dir,'pos.sqlite');const f=await fixture(file);let reopened;
  try{
    await f.call('fiscalSynchronize');let release;const waiting=new Promise(r=>release=r),original=f.agent.call;let entered;const ready=new Promise(r=>entered=r);
    f.agent.call=async(op,p)=>{if(op==='sign'){entered();await waiting;throw new NacefError('lost response',{ambiguous:true});}return original(op,p);};
    const attempt=f.call('sale',f.request());await ready;await assert.rejects(f.call('sale',f.request()),/en cours/);
    assert.equal((await new SyncEngine(f.service,()=>null).run()).fiscalPending,true);release();await assert.rejects(attempt,/lost response/);f.store.db.close();
    reopened=openDatabase(file);const s=new PosService(reopened,{integrityKey:Buffer.alloc(32,7),nacefClientFactory:()=>f.agent});const token=(await s.call('login',{name:'Admin',pin:'123456'})).token;
    await assert.rejects(s.call('fiscalResume',{},token),/inconnu/);assert.equal(s.fiscal.pending().status,'UNKNOWN');
  }finally{try{f.store.db.close();}catch{}reopened?.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('NACEF: protected anchor detects truncation even if the database head is rewritten',async()=>{
  const f=await fixture();try{
    await f.call('fiscalSynchronize');await f.call('sale',f.request());
    const last=f.store.db.prepare('SELECT seq,previous FROM fiscal_integrity ORDER BY seq DESC LIMIT 1').get();
    f.store.db.exec('DROP TRIGGER fiscal_integrity_no_delete');f.store.db.prepare('DELETE FROM fiscal_integrity WHERE seq=?').run(last.seq);f.store.put('fiscalIntegrityHead',last.previous);
    await assert.rejects(f.call('fiscalVerify'),/troncature/);await assert.rejects(f.service.call('login',{name:'Admin',pin:'123456'}),/troncature/);
  }finally{f.close();}
});
