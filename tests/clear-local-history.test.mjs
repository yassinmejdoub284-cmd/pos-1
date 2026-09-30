import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../backend/database.mjs';
import {PosService} from '../backend/service.mjs';

const code='123*456*789*+-';

test('vider le stockage exige administrateur, code et caisses fermées',async()=>{
  const store=openDatabase(':memory:'),service=new PosService(store);
  try {
    await service.call('setup',{name:'Admin',pin:'123456',company:'Test'});
    const admin=(await service.call('login',{name:'Admin',pin:'123456'})).token;
    await service.call('saveUser',{name:'Employe',pin:'654321',permissions:['settings','sell'],admin:false},admin);
    const employee=(await service.call('login',{name:'Employe',pin:'654321'})).token;
    await assert.rejects(service.call('clearLocalHistory',{code},employee),/administrateur/);
    await assert.rejects(service.call('clearLocalHistory',{code:'incorrect'},admin),/Code de sécurité/);
    await service.call('openSession',{opening:0},admin);
    await assert.rejects(service.call('clearLocalHistory',{code},admin),/Clôturez toutes les caisses/);
  } finally {store.db.close();}
});

test('vider ventes et clôtures locales conserve charges, règlements, soldes et catalogue',async()=>{
  const store=openDatabase(':memory:'),service=new PosService(store);
  const call=(action,args={})=>service.call(action,args,token);
  let token;
  try {
    await service.call('setup',{name:'Admin',pin:'123456',company:'Test'});
    token=(await service.call('login',{name:'Admin',pin:'123456'})).token;
    const family=await call('saveEntity',{kind:'family',data:{name:'Repas'}});
    const product=await call('saveEntity',{kind:'product',data:{name:'Chapati',familyId:family.id,price:7000}});
    const client=await call('saveEntity',{kind:'client',data:{name:'Client',creditLimit:50000}});
    const supplier=await call('saveEntity',{kind:'supplier',data:{name:'Fournisseur'}});
    const category=await call('saveEntity',{kind:'expenseCategory',data:{name:'Achats'}});
    await call('openSession',{opening:50000});
    const items=[{productId:product.id,quantity:1}];
    const credit=await call('sale',{requestId:randomUUID(),items,payment:'credit',clientId:client.id,print:true});
    await call('sale',{requestId:randomUUID(),items,payment:'cash',received:7000,print:true});
    await call('clientPayment',{requestId:randomUUID(),clientId:client.id,amount:2000,method:'cash'});
    await call('expense',{requestId:randomUUID(),categoryId:category.id,supplierId:supplier.id,description:'Fromage',amount:3000,source:'cash'});
    const closed=await call('closeSession',{closing:56000});
    assert.equal(closed.expected,56000);
    assert.equal(service.clientBalances()[client.id],5000);
    const result=await call('clearLocalHistory',{code});
    assert.deepEqual(result,{ok:true,sales:2,closures:1});
    const data=await call('bootstrap');
    assert.equal(data.sales.length,0);
    assert.equal(data.sessions.length,0);
    assert.equal(data.lastClosure,null);
    assert.equal((await call('closures')).length,0);
    assert.equal((await call('report')).count,0);
    assert.equal(data.catalog.product.length,1);
    assert.equal(data.catalog.family.length,1);
    assert.equal(data.catalog.client.length,1);
    assert.equal(data.catalog.supplier.length,1);
    assert.equal(data.users.length,1);
    assert.equal(data.expenses.length,1);
    assert.equal(data.clientPayments.length,1);
    assert.equal(data.clientBalances[client.id],5000);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM print_jobs').get().n,0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM closure_print_jobs').get().n,0);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE type IN ('sale','saleVoid','session')").get().n,0);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action IN ('sale.create','sale.void','session.open','session.close')").get().n,0);
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
    await assert.rejects(call('saleDetails',{id:credit.id}),/introuvable/);
    await assert.rejects(call('previewClosure',{id:closed.id}),/introuvable/);
    assert.equal((await call('clearLocalHistory',{code})).sales,0);
    await call('openSession',{opening:0});
    const later=await call('sale',{requestId:randomUUID(),items,payment:'cash',received:7000,print:false});
    assert.equal(later.ticket,3);
    assert.equal(service.clientBalances()[client.id],5000);
  } finally {store.db.close();}
});
