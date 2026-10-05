import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {openDatabase} from '../backend/database.mjs';
import {PosService} from '../backend/service.mjs';
import {receiptHtml} from '../backend/receipts.mjs';
import {createCloud} from '../backend/cloud.mjs';
import {SyncEngine} from '../backend/sync.mjs';
import {submitSaleWithRecovery} from '../frontend/sale-recovery.mjs';

async function fixture(){
 const store=openDatabase(':memory:'),service=new PosService(store,{receipt:receiptHtml});
 await service.call('setup',{company:'Test',name:'Admin',pin:'123456'});
 const {token}=await service.call('login',{name:'Admin',pin:'123456'}),call=(action,args={})=>service.call(action,args,token);
 const f=await call('saveEntity',{kind:'family',data:{name:'Repas'}}),p=await call('saveEntity',{kind:'product',data:{name:'Chapati',familyId:f.id,price:7000}});
 await call('openSession',{opening:0});
 const args=(kitchenNote,quantity=1)=>({requestId:randomUUID(),items:[{productId:p.id,quantity,supplements:[],comments:[],...(kitchenNote===undefined?{}:{kitchenNote})}],discount:0,payment:'cash',received:7000*quantity,clientId:'',mode:'sur_place',note:'',print:false});
 return {store,service,call,p,args};
}
test('note libre par ligne : conservée dans la vente, uniquement sous le bon produit du ticket cuisine',async()=>{
 const f=await fixture();try{
  const input=f.args('  Bien cuit\nصلصة وحدها <script>alert(1)</script>  ');
  input.items.push({...input.items[0],kitchenNote:'Sans sel'});input.received=14000;
  const sale=await f.call('sale',input);assert.equal(sale.total,14000);assert.equal(sale.items[0].kitchenNote,'Bien cuit\nصلصة وحدها <script>alert(1)</script>');assert.equal(sale.items[1].kitchenNote,'Sans sel');
  const saved=await f.call('saleDetails',{id:sale.id});assert.deepEqual(saved.items,sale.items);
  const settings=f.service.settings();settings.print.kitchenComments=false;settings.print.clientComments=true;
  const kitchen=receiptHtml(saved,'kitchen',settings),client=receiptHtml(saved,'client',settings);
  const sections=[...kitchen.matchAll(/<section>(.*?)<\/section>/gs)].map(m=>m[1]);assert.match(sections[0],/Bien cuit\nصلصة وحدها &lt;script&gt;/);assert.doesNotMatch(sections[0],/Sans sel/);assert.match(sections[1],/Sans sel/);assert.doesNotMatch(sections[1],/Bien cuit/);
  assert.doesNotMatch(client,/Bien cuit|صلصة وحدها|Sans sel|Note cuisine :/);assert.doesNotMatch(kitchen,/<script>/);
  const restarted=new PosService(f.store,{receipt:receiptHtml}),session=await restarted.call('login',{name:'Admin',pin:'123456'});
  assert.match(await restarted.call('previewReceipt',{id:sale.id,kind:'kitchen'},session.token),/Bien cuit/);
  assert.doesNotMatch(await restarted.call('previewReceipt',{id:sale.id,kind:'client'},session.token),/Bien cuit/);
 }finally{f.store.db.close();}
});
test('note cuisine : limite et type contrôlés avant vente ; anciennes commandes et suppression acceptées',async()=>{
 const f=await fixture();try{
  for(const note of [null,{},42,'x'.repeat(301)])await assert.rejects(f.call('sale',f.args(note)),/Note cuisine invalide/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM sales').get().n,0);
  const legacy=await f.call('sale',f.args());assert.equal(legacy.items[0].kitchenNote,'');
  assert.equal((await f.call('sale',f.args('   '))).items[0].kitchenNote,'');
  assert.equal((await f.call('sale',f.args('x'.repeat(300)))).items[0].kitchenNote.length,300);
 }finally{f.store.db.close();}
});
test('note cuisine : reprise idempotente sans perte de note et modification distinguée d’un doublon',async()=>{
 const f=await fixture();try{
  const input=f.args('Bien cuit'),first=await f.call('sale',input);
  const options={submit:x=>f.call('sale',x),find:requestId=>f.call('saleByRequest',{requestId}),newRequestId:()=>randomUUID()};
  const same=await submitSaleWithRecovery({...input,print:true},options);assert.equal(same.sale.id,first.id);assert.equal(same.sale.duplicate,true);
  const changed=await submitSaleWithRecovery({...input,items:[{...input.items[0],kitchenNote:'Sauce à part'}]},options);
  assert.notEqual(changed.sale.id,first.id);assert.equal(changed.sale.items[0].kitchenNote,'Sauce à part');assert.equal(changed.previousTicket,first.displayTicket);
  assert.equal((await f.call('saleDetails',{id:first.id})).items[0].kitchenNote,'Bien cuit');
 }finally{f.store.db.close();}
});
test('note cuisine : synchronisation conserve les notes des lignes sans changement de montant',async()=>{
 const f=await fixture(),cloud=createCloud({file:':memory:',syncToken:'x'.repeat(32),adminPassword:'admin-test-password'});try{
  const sale=await f.call('sale',f.args('Sans piment'));
  const settings=f.service.settings();settings.sync={enabled:true,endpoint:'http://localhost:3256',intervalMinutes:20};f.service.put('settings',JSON.stringify(settings));
  await new SyncEngine(f.service,()=>'x'.repeat(32),async(url,options)=>({ok:true,json:async()=>cloud.sync(JSON.parse(options.body))})).run();
  const report=cloud.dashboard({day:sale.day}).report;assert.equal(report.total,7000);assert.equal(report.sales[0].items[0].kitchenNote,'Sans piment');
 }finally{f.store.db.close();cloud.db.close();}
});
test('desktop : le pont IPC autorise vente avec note, reprise de vente et opérations stock, refuse les actions inconnues',async()=>{
 let api;const calls=[];
 runInNewContext(readFileSync(new URL('../desktop/preload.cjs',import.meta.url),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(name,value)=>api=value},ipcRenderer:{invoke:(...args)=>{calls.push(args);return Promise.resolve({ok:true});}}})});
 const args={items:[{productId:'p',kitchenNote:'Sauce à part'}]};await api.call('sale',args,'token');assert.equal(calls[0][2],args);
 for(const action of ['saleByRequest','configureStock','stockMovement','clearLocalHistory'])await api.call(action,{},'token');
 assert.equal(calls.length,5);await assert.rejects(api.call('unknown'),/Opération inconnue/);assert.equal(calls.length,5);
});
