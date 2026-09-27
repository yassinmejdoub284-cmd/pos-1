import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {VFD_DEFAULTS,validateVfd,vfdLine,vfdPacket,VfdDisplay} from '../backend/vfd.mjs';
import {openDatabase} from '../backend/database.mjs';
import {PosService} from '../backend/service.mjs';
test('VFD : validation des paramètres série et suppression des commandes injectées',()=>{
 assert.equal(validateVfd({port:'COM999'}).port,'COM999');
 for(const change of [{port:'COM0'},{port:'COM3;other'},{baudRate:12345},{dataBits:9},{parity:'invalid'},{protocol:'invalid'},{enabled:'yes'}])assert.throws(()=>validateVfd(change));
 assert.equal(vfdLine('Crème œuf\x1b\n').trim(),'Creme oeuf');assert.equal(vfdLine('a'.repeat(40)).length,20);
 const packet=vfdPacket(['Crème','7.000 DT']);assert.deepEqual([...packet.subarray(0,7)],[12,31,1,31,36,1,1]);assert.equal(packet.subarray(7,27).toString(),'Creme               ');assert.deepEqual([...packet.subarray(27,31)],[31,36,1,2]);assert.equal(packet.length,51);
 assert.equal(vfdPacket(['A','B'],'text').toString(),'A                   \r\nB                   ');
});
test('VFD : ordre produit puis total, désactivation et panne récupérable',async()=>{
 const sent=[],display=new VfdDisplay({ports:async()=>['COM3'],close:async()=>{},write:async(c,b)=>{if(c.port==='COM4')throw new Error('Port occupé');sent.push(b.toString('ascii'));}});
 await display.show(VFD_DEFAULTS,['Ignored','0']);assert.equal(sent.length,0);
 const c={...VFD_DEFAULTS,enabled:true};const product=display.show(c,['Chapati','7.000 DT']),total=display.total(c,{total:8000});await Promise.all([product,total]);assert.equal(sent.length,2);assert.equal(display.status().lines[0].trim(),'TOTAL A PAYER');
 await display.show({...c,port:'COM4'},['Test','1.000 DT']);assert.equal(display.status().connected,false);assert.match(display.status().error,/occupé/);await display.show(c,['Test','1.000 DT']);assert.equal(display.status().connected,true);assert.equal(display.status().error,null);
});
test('VFD : prix calculé côté caisse avec supplément, total remisé et aucune écriture sans impression',async()=>{
 const store=openDatabase(':memory:'),sent=[];const display=new VfdDisplay({ports:async()=>['COM3'],close:async()=>{},write:async(c,b)=>sent.push(b)}),s=new PosService(store,{vfd:display});
 try{await s.call('setup',{company:'Test',name:'Admin',pin:'123456'});const {token}=await s.call('login',{name:'Admin',pin:'123456'});const call=(a,b={})=>s.call(a,b,token),save=(kind,data)=>call('saveEntity',{kind,data});
 const family=await save('family',{name:'Chapati'}),p=await save('product',{name:'Chapati chawarma',price:7000,familyId:family.id}),extra=await save('supplement',{name:'Fromage',price:1000,productIds:[p.id]});
 await call('saveVfd',{...VFD_DEFAULTS,enabled:true});await call('vfdProduct',{productId:p.id,supplements:[extra.id],price:1});assert.equal(display.status().lines[1].trim(),'8.000 DT');
 await call('openSession',{opening:0});await call('sale',{requestId:randomUUID(),items:[{productId:p.id,quantity:1,supplements:[extra.id]}],payment:'cash',received:7000,discount:1000,print:true});await display.tail;assert.equal(display.status().lines[0].trim(),'TOTAL A PAYER');assert.equal(display.status().lines[1].trim(),'7.000 DT');
 const count=sent.length;await call('sale',{requestId:randomUUID(),items:[{productId:p.id,quantity:1}],payment:'cash',received:7000,print:false});await display.tail;assert.equal(sent.length,count);
 const settings=s.settings();await call('saveSettings',settings);assert.equal(s.settings().vfd.enabled,true);
 await call('saveUser',{name:'Cashier',pin:'654321',permissions:['sell'],active:true});const user=await s.call('login',{name:'Cashier',pin:'654321'});await assert.rejects(s.call('saveVfd',VFD_DEFAULTS,user.token),/permission/);
 }finally{store.db.close();}
});
test('VFD : une panne de matériel ne bloque pas la validation du ticket',async()=>{
 const store=openDatabase(':memory:'),display=new VfdDisplay({ports:async()=>[],close:async()=>{},write:async()=>{throw new Error('Débranché');}}),s=new PosService(store,{vfd:display});
 try{await s.call('setup',{company:'Test',name:'Admin',pin:'123456'});const {token}=await s.call('login',{name:'Admin',pin:'123456'}),call=(a,b={})=>s.call(a,b,token);await call('saveVfd',{enabled:true});const f=await call('saveEntity',{kind:'family',data:{name:'Test'}}),p=await call('saveEntity',{kind:'product',data:{name:'Test',price:7000,familyId:f.id}});await call('openSession',{opening:0});const sale=await call('sale',{requestId:randomUUID(),items:[{productId:p.id,quantity:1}],payment:'cash',received:7000,print:true});await display.tail;assert.equal(sale.total,7000);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM sales').get().n,1);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM print_jobs').get().n,2);assert.match(display.status().error,/Débranché/);
 }finally{store.db.close();}
});
