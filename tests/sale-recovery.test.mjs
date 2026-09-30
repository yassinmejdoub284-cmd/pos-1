import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../backend/database.mjs';
import {PosService} from '../backend/service.mjs';
import {submitSaleWithRecovery} from '../frontend/sale-recovery.mjs';

test('une ancienne demande garde sa vente et une commande modifiée passe sans blocage',async()=>{
  const store=openDatabase(':memory:');
  try {
    const service=new PosService(store);
    await service.call('setup',{company:'Test',name:'Admin',pin:'123456'});
    const {token}=await service.call('login',{name:'Admin',pin:'123456'});
    const call=(action,args={})=>service.call(action,args,token);
    const family=await call('saveEntity',{kind:'family',data:{name:'Repas'}});
    const product=await call('saveEntity',{kind:'product',data:{name:'Chapati',price:7000,familyId:family.id}});
    await call('openSession',{opening:0});
    const requestId=randomUUID(),items=[{productId:product.id,quantity:1,supplements:[],comments:[]}];
    const original={requestId,items,discount:0,payment:'cash',received:7000,clientId:'',mode:'sur_place',note:'',print:false};
    const first=await call('sale',original);
    const submit=async args=>{try{return await call('sale',args);}catch(error){throw error;}};
    const find=id=>call('saleByRequest',{requestId:id});
    const same=await submitSaleWithRecovery({...original,print:true},{submit,find,newRequestId:()=>{throw Error('Un doublon ne doit pas recevoir un nouvel identifiant.');}});
    assert.equal(same.sale.id,first.id);
    assert.equal(same.sale.duplicate,true);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM sales').get().n,1);
    const freshId=randomUUID();
    const changed=await submitSaleWithRecovery({...original,items:[{...items[0],quantity:2}],received:14000},{submit,find,newRequestId:()=>freshId});
    assert.equal(changed.previousTicket,first.ticket);
    assert.equal(changed.sale.requestId,freshId);
    assert.equal(changed.sale.total,14000);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM sales').get().n,2);
  } finally {store.db.close();}
});
