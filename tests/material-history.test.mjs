import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../backend/database.mjs';
import {PosService} from '../backend/service.mjs';
import {SyncEngine} from '../backend/sync.mjs';
import {createCloud} from '../backend/cloud.mjs';
import {PostgresCloud} from '../backend/postgres-cloud.mjs';
import {PGlite} from '@electric-sql/pglite';
import {validateSync} from '../backend/cloud-validation.mjs';
import {movementForm,renderMaterials} from '../frontend/materials.mjs';
import {materialQuantity,purchaseTotal,quantityForUnit} from '../frontend/material-units.mjs';

async function fixture(){
 const store=openDatabase(':memory:'),s=new PosService(store);await s.call('setup',{name:'Admin',pin:'123456',company:'Test'});const {token}=await s.call('login',{name:'Admin',pin:'123456'}),call=(a,b={})=>s.call(a,b,token),save=(kind,data,id)=>call('saveEntity',{kind,data,id});
 const material=await save('material',{name:'Œuf',unit:'piece'}),supplier=await save('supplier',{name:'Épicerie'}),family=await save('family',{name:'Repas'}),product=await save('product',{name:'Omelette',price:5000,familyId:family.id});
 await call('saveRecipe',{id:product.id,kind:'product',ingredients:[{materialId:material.id,quantity:1000}]});await call('openSession',{opening:100000});
 const buy=(quantity=10000,amount=10000,source='bank')=>call('materialPurchase',{requestId:randomUUID(),materialId:material.id,quantity,amount,source,supplierId:supplier.id,note:'Facture'});
 const sale=(quantity=1)=>call('sale',{requestId:randomUUID(),items:[{productId:product.id,quantity}],payment:'cash',received:5000*quantity,print:false});
 const movement=id=>store.db.prepare("SELECT * FROM material_movements WHERE kind='purchase' AND json_extract(data,'$.id')=?").get(id);
 const edit=(purchase,changes={})=>{const row=movement(purchase.id),data=JSON.parse(row.data);return call('editMaterialMovement',{id:row.id,revision:data.revision||0,requestId:randomUUID(),quantity:row.quantity,amount:data.amount,note:data.note,...changes});};
 return {store,s,call,save,material,supplier,product,buy,sale,movement,edit,token,close:()=>store.db.close()};
}
const inventory=f=>{const r=f.s.materials.row(f.material.id);return {quantity:r.quantity,valueMicros:r.value_micros};};
const effects=f=>JSON.stringify({inventory:inventory(f),purchases:f.store.db.prepare('SELECT * FROM material_purchases').all(),sales:f.store.db.prepare('SELECT * FROM sales').all(),expenses:f.store.db.prepare('SELECT * FROM expenses').all(),outbox:f.store.db.prepare('SELECT * FROM outbox').all(),corrections:f.store.db.prepare('SELECT * FROM material_corrections').all(),movements:f.store.db.prepare('SELECT * FROM material_movements').all()});

test('ancien et nouvel achat : prix, quantité, CUMP, charge et dette sont corrigés ensemble',async()=>{
 const f=await fixture();try{const first=await f.buy(10000,10000,'credit'),sale=await f.sale(2),last=await f.buy(5000,20000);await f.edit(first,{quantity:20000,amount:30000,note:'Facture corrigée'});
 assert.deepEqual(inventory(f),{quantity:23000,valueMicros:47000*1e6});assert.equal((await f.call('saleDetails',{id:sale.id})).cost,3000);assert.equal(f.s.supplierBalances()[f.supplier.id],30000);
 let report=await f.call('report',{day:sale.day});assert.equal(report.costTotal,3000);assert.equal(report.expensesTotal,50000);assert.equal(report.grossMargin,7000);
 await f.edit(last,{quantity:6000,amount:24000});assert.deepEqual(inventory(f),{quantity:24000,valueMicros:51000*1e6});assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM expenses').get().n,2);
 const history=await f.call('materialHistory',{kind:'purchase'}),row=history.rows.find(r=>r.data.id===first.id);assert.equal(row.corrections[0].before.amount,10000);assert.equal(row.corrections[0].after.amount,30000);assert.equal(row.revision,1);assert.equal(row.createdAt,first.createdAt);assert.match(movementForm(row),/Valeurs précédentes/);
 }finally{f.close();}
});

test('achat épuisé : une baisse de prix recalcule le coût sans créer une valeur de stock négative',async()=>{
 const f=await fixture();try{const p=await f.buy(),sale=await f.sale(10);await f.edit(p,{amount:5000});assert.deepEqual(inventory(f),{quantity:0,valueMicros:0});assert.equal((await f.call('saleDetails',{id:sale.id})).cost,5000);await f.call('voidSale',{id:sale.id,reason:'Commande annulée'});assert.deepEqual(inventory(f),{quantity:10000,valueMicros:5000*1e6});}finally{f.close();}
});

test('annulations existantes : restitution au coût corrigé et coût des ventes suivantes',async()=>{
 const f=await fixture();try{const p=await f.buy(),sale=await f.sale(2);await f.buy(5000,20000);await f.call('voidSale',{id:sale.id,reason:'Erreur de commande'});await f.edit(p,{amount:20000});assert.deepEqual(inventory(f),{quantity:15000,valueMicros:40000*1e6});assert.equal((await f.call('saleDetails',{id:sale.id})).cost,4000);assert.equal((await f.call('report',{day:sale.day})).costTotal,0);const next=await f.sale(3);assert.equal(next.cost,8000);}finally{f.close();}
});

test('recettes et suppléments : même matière consommée plusieurs fois, arrondis et annulation exacte',async()=>{
 const f=await fixture();try{const p=await f.buy(),extra=await f.save('supplement',{name:'Demi-œuf',price:1000,productIds:[f.product.id]});await f.call('saveRecipe',{id:extra.id,kind:'supplement',ingredients:[{materialId:f.material.id,quantity:500}]});
 const sale=await f.call('sale',{requestId:randomUUID(),items:[{productId:f.product.id,quantity:2,supplements:[extra.id]},{productId:f.product.id,quantity:1}],payment:'cash',received:17000,print:false});assert.equal(sale.cost,4000);await f.edit(p,{amount:20001});const corrected=await f.call('saleDetails',{id:sale.id});assert.equal(corrected.cost,8000);assert.equal(corrected.items[0].cost,6000);assert.equal(corrected.items[1].cost,2000);assert.equal(corrected.items[0].costing.ingredients[1].sourceKind,'supplement');assert.equal(inventory(f).quantity,6000);await f.call('voidSale',{id:sale.id,reason:'Erreur commande'});assert.deepEqual(inventory(f),{quantity:10000,valueMicros:20001*1e6});
 }finally{f.close();}
});

test('quantité historique insuffisante : refus atomique malgré un réapprovisionnement ultérieur',async()=>{
 const f=await fixture();try{const p=await f.buy();await f.sale(10);await f.buy();const before=effects(f);await assert.rejects(f.edit(p,{quantity:9000}),/stock insuffisant/);assert.equal(effects(f),before);for(const changes of [{quantity:0},{quantity:-1},{quantity:1.5},{amount:0},{amount:-1},{note:'x'.repeat(301)}]){await assert.rejects(f.edit(p,changes));assert.equal(effects(f),before);}}finally{f.close();}
});

test('inventaires historiques absolus, stock zéro et compatibilité des anciennes lignes',async()=>{
 const f=await fixture();try{await f.save('material',{name:'Œuf',unit:'piece',quantity:10000,unitPrice:1000},f.material.id);const first=f.store.db.prepare("SELECT * FROM material_movements WHERE kind='adjustment'").get(),legacy=JSON.parse(first.data);delete legacy.afterQuantity;delete legacy.afterValueMicros;f.store.db.prepare('UPDATE material_movements SET data=? WHERE id=?').run(JSON.stringify(legacy),first.id);
 const sale=await f.sale(2);await f.save('material',{name:'Œuf',unit:'piece',quantity:5000,unitPrice:3000},f.material.id);await f.call('editMaterialMovement',{id:first.id,revision:0,requestId:randomUUID(),quantity:20000,unitPrice:2000,note:'Comptage corrigé'});assert.deepEqual(inventory(f),{quantity:5000,valueMicros:15000*1e6});assert.equal((await f.call('saleDetails',{id:sale.id})).cost,4000);
 const last=f.store.db.prepare("SELECT * FROM material_movements WHERE kind='adjustment' ORDER BY rowid DESC LIMIT 1").get();await f.call('editMaterialMovement',{id:last.id,revision:0,requestId:randomUUID(),quantity:0,unitPrice:4500});assert.deepEqual(inventory(f),{quantity:0,valueMicros:0});assert.equal(f.s.entity(f.material.id).unitPrice,4500);
 }finally{f.close();}
});

test('reprise après réponse perdue et protection contre les modifications concurrentes',async()=>{
 const f=await fixture();try{const p=await f.buy(),requestId=randomUUID(),args={requestId,quantity:12000,amount:15000};await f.edit(p,args);const before=effects(f);assert.equal((await f.edit(p,{...args,revision:0})).duplicate,true);assert.equal(effects(f),before);await assert.rejects(f.edit(p,{...args,amount:16000,revision:0}),/autre contenu/);await assert.rejects(f.edit(p,{revision:0}),/Actualisez/);assert.equal(effects(f),before);}finally{f.close();}
});

test('achat caisse d’une session clôturée : montant attendu, écart et résumé actualisés',async()=>{
 const f=await fixture();try{const p=await f.buy(10000,10000,'cash'),closed=await f.call('closeSession',{closing:90000});await f.edit(p,{amount:20000});const closure=(await f.call('closures')).find(c=>c.id===closed.id);assert.equal(closure.expected,80000);assert.equal(closure.variance,10000);assert.equal(closure.summary.expenses,20000);assert.equal((await f.call('bootstrap')).session,null);}finally{f.close();}
});

test('historique complet paginé, recherche globale et matières archivées modifiables',async()=>{
 const f=await fixture();try{const first=await f.buy();for(let n=0;n<104;n++)await f.buy(1,1);assert.equal((await f.call('bootstrap')).materialPurchases.length,100);const page=await f.call('materialHistory',{kind:'purchase',page:2,query:'éPICERIE'});assert.equal(page.total,105);assert.equal(page.pages,3);assert.equal(page.rows.at(-1).data.id,first.id);await f.edit(first,{note:'Référence unique'});assert.equal((await f.call('materialHistory',{kind:'purchase',query:'unique'})).total,1);
 await f.save('material',{name:'Œuf',unit:'piece',quantity:0,unitPrice:1000},f.material.id);await f.call('archiveEntity',{id:f.material.id,kind:'material'}).catch(async()=>{await f.call('saveRecipe',{id:f.product.id,kind:'product',ingredients:[],emptyConfirmed:true});await f.call('archiveEntity',{id:f.material.id,kind:'material'});});await f.edit(first,{amount:20000});assert.equal(inventory(f).quantity,0);
 }finally{f.close();}
});

test('permission stock obligatoire et consommation de vente non modifiable',async()=>{
 const f=await fixture();try{const p=await f.buy();await f.sale();await f.call('saveUser',{name:'Caissier',pin:'654321',permissions:['sell'],admin:false});const {token}=await f.s.call('login',{name:'Caissier',pin:'654321'});await assert.rejects(f.s.call('materialHistory',{},token),/permission/);await assert.rejects(f.s.call('editMaterialMovement',{id:f.movement(p.id).id},token),/permission/);const row=f.store.db.prepare("SELECT id FROM material_movements WHERE kind='sale'").get();await assert.rejects(f.call('editMaterialMovement',{id:row.id,requestId:randomUUID()}),/Seuls les achats/);}finally{f.close();}
});

async function pgPool(){const db=new PGlite();await db.waitReady;let tail=Promise.resolve();const query=async(sql,args)=>{if(!args&&sql.includes(';')){const r=await db.exec(sql);return {rows:r.at(-1)?.rows||[],rowCount:r.at(-1)?.affectedRows||0};}const r=await db.query(sql,args);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length};};return {connect:async()=>{const previous=tail;let release;tail=new Promise(r=>release=r);await previous;return {query,release};},query,on:()=>{},end:()=>db.close()};}
for(const kind of ['SQLite','PostgreSQL'])test(`corrections ${kind} : données déjà synchronisées, hors ligne et réponse perdue sans doublon`,async()=>{
 const f=await fixture(),cloud=kind==='SQLite'?createCloud({file:':memory:',syncToken:'x'.repeat(32),adminPassword:'test-admin-password'}):new PostgresCloud('',{pool:await pgPool()});
 try{const p=await f.buy(10000,10000,'credit'),sale=await f.sale(2),settings=f.s.settings();settings.sync={enabled:true,endpoint:'https://test.example'};f.store.put('settings',JSON.stringify(settings));let lose=false;const engine=new SyncEngine(f.s,()=>'x'.repeat(32),async(url,options)=>{const data=await cloud.sync(JSON.parse(options.body));if(lose){lose=false;throw Error('Réponse perdue');}return {ok:true,json:async()=>data};});
 await engine.run();await f.edit(p,{quantity:20000,amount:30000});await f.edit(p,{amount:40000});lose=true;await assert.rejects(engine.run(),/perdue/);await engine.run();let d=await cloud.dashboard({day:sale.day});assert.equal(d.report.costTotal,4000);assert.equal(d.report.expensesTotal,40000);assert.equal(d.supplierBalances[f.supplier.id],40000);assert.equal(d.materialPurchases.length,1);assert.equal(d.materialPurchases[0].amount,40000);assert.equal(d.materialPurchases[0].revision,2);assert.equal(d.materials[0].quantity,18000);assert.equal(d.materials[0].valueMicros,36000*1e6);
 await f.call('voidSale',{id:sale.id,reason:'Commande annulée'});await engine.run();d=await cloud.dashboard({day:sale.day});assert.equal(d.report.costTotal,0);assert.equal(d.materials[0].quantity,20000);
 const correction=JSON.parse(f.store.db.prepare("SELECT payload FROM outbox WHERE type='materialCorrection' LIMIT 1").get().payload),foreign=randomUUID(),event={id:randomUUID(),seq:1,type:'materialCorrection',payload:{...correction,id:randomUUID(),deviceId:foreign}};await assert.rejects(Promise.resolve().then(()=>cloud.sync({deviceId:foreign,cursor:0,events:[event]})),/sur ce poste/);
 const bad=JSON.parse(f.store.db.prepare("SELECT payload FROM outbox WHERE type='saleCostCorrection' LIMIT 1").get().payload);bad.items[0].cost++;assert.throws(()=>validateSync({deviceId:f.store.get('deviceId'),cursor:0,events:[{id:randomUUID(),seq:1,type:'saleCostCorrection',payload:bad}]}),/Coût de ligne/);
 const badQuantity=JSON.parse(f.store.db.prepare("SELECT payload FROM outbox WHERE type='saleCostCorrection' LIMIT 1").get().payload);badQuantity.id=randomUUID();badQuantity.items[0].costing.ingredients[0].quantity++;await assert.rejects(Promise.resolve().then(()=>cloud.sync({deviceId:f.store.get('deviceId'),cursor:0,events:[{id:randomUUID(),seq:1000,type:'saleCostCorrection',payload:badQuantity}]})),/Consommation historique/);
 }finally{f.close();if(kind==='SQLite')cloud.db.close();else await cloud.close();}
});

test('anciens effacements : stock conservé, facture corrigée et prochains achats modifiables',async()=>{
 const f=await fixture();try{const p=await f.buy();await f.sale(2);await f.call('closeSession',{closing:110000});await f.call('clearLocalHistory',{code:'123*456*789*+-'});const before=inventory(f);await f.edit(p,{amount:5000});assert.deepEqual(inventory(f),before);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM material_movements WHERE kind='checkpoint'").get().n,1);const next=await f.buy();await f.edit(next,{quantity:20000,amount:30000});assert.deepEqual(inventory(f),{quantity:28000,valueMicros:38000*1e6});}finally{f.close();}
});

test('interface : zéro, fractions, prix unitaire, historique et pagination',()=>{
 assert.equal(materialQuantity('0','g',true),0);assert.throws(()=>materialQuantity('0','g'));assert.equal(purchaseTotal(125000,30000,'g'),3750);assert.equal(purchaseTotal(500,1000,'piece'),500);
 assert.equal(quantityForUnit(125000,'kg'),'0.125');assert.equal(quantityForUnit(500,'g'),'0.5');assert.throws(()=>quantityForUnit(500,'kg'),/fractions de gramme/);
 const html=renderMaterials({state:{data:{materials:[],catalog:{product:[],supplement:[]}},tableSearch:'',materialTab:'history',materialHistory:{rows:[],page:0,pages:3,total:105}}});assert.match(html,/Historique du stock/);assert.match(html,/Page 1 \/ 3/);assert.match(html,/material-history-page/);
});
