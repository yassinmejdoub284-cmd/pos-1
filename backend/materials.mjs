import {randomUUID,createHash} from 'node:crypto';
import {ensure,integer,label,dayInTunis} from './money.mjs';

// Quantities use thousandths of a gram/piece. Values use millionths of a millime.
// Integer ratios preserve tiny ingredient costs without floating point drift.
export const QUANTITY_SCALE=1000, VALUE_SCALE=1_000_000;
export const roundedRatio=(value,numerator,denominator)=>Number((BigInt(value)*BigInt(numerator)+BigInt(denominator)/2n)/BigInt(denominator));
export const costMillimes=value=>Math.round(value/VALUE_SCALE);
const json=JSON.parse,now=()=>new Date().toISOString();
export class MaterialInventory {
  constructor(service){this.s=service;}
  row(id){return this.s.db.prepare('SELECT * FROM material_inventory WHERE material_id=?').get(id);}
  snapshot(){return this.s.entities('material').map(m=>{const r=this.row(m.id);return {...m,quantity:r?.quantity||0,valueMicros:r?.value_micros||0,updatedAt:r?.updated_at||null};});}
  emit(id){const s=this.s,r=this.row(id),m=s.db.prepare('SELECT data,active FROM entities WHERE id=? AND kind=?').get(id,'material');if(!m)return;const data=json(m.data);s.emit('materialStock',{id:`${s.get('deviceId')}:${id}`,deviceId:s.get('deviceId'),materialId:id,name:data.name,unit:data.unit,active:!!m.active,quantity:r?.quantity||0,valueMicros:r?.value_micros||0,updatedAt:now()});}
  saveRecipe(args,user){
    const s=this.s;ensure(['product','supplement'].includes(args.kind),'Recette réservée aux produits et suppléments.');const entity=s.entity(args.id,args.kind);
    ensure(Array.isArray(args.ingredients)&&args.ingredients.length<=100,'Recette invalide (100 matières maximum).');
    ensure(args.ingredients.length||args.emptyConfirmed===true,'Confirmez explicitement une recette sans matière.');
    const ids=new Set(),recipe=args.ingredients.map(i=>{const material=s.entity(i.materialId,'material');ensure(!ids.has(material.id),'Une matière première ne doit apparaître qu’une fois.');ids.add(material.id);return {materialId:material.id,quantity:integer(i.quantity,'Quantité de recette',1,1_000_000_000)};});
    return s.transaction(()=>{const row=s.db.prepare('SELECT * FROM entities WHERE id=?').get(entity.id),data={...json(row.data),recipe,recipeConfigured:true};s.db.prepare('UPDATE entities SET data=? WHERE id=?').run(JSON.stringify(data),row.id);s.emit('entity',{id:row.id,kind:row.kind,data,active:!!row.active,baseRevision:row.revision});s.audit(user,'recipe.save',{id:row.id,kind:row.kind});return {ok:true};});
  }
  purchase(args,user){
    const s=this.s,requestId=label(args.requestId,'Identifiant d’achat',100);
    const input={materialId:args.materialId,quantity:args.quantity,amount:args.amount,source:args.source,supplierId:args.supplierId||'',note:typeof args.note==='string'?args.note.trim():''};
    ensure(input.note.length<=300,'Note trop longue.');const inputHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior=s.db.prepare('SELECT * FROM material_purchases WHERE request_id=?').get(requestId);
    if(prior){const data=json(prior.data);ensure(prior.user_id===user.id&&data.inputHash===inputHash,'Cette demande d’achat a déjà un autre contenu.',409);return {...data,duplicate:true};}
    const material=s.entity(args.materialId,'material'),quantity=integer(args.quantity,'Quantité achetée',1,1_000_000_000_000),amount=integer(args.amount,'Montant d’achat',1),supplier=args.supplierId?s.entity(args.supplierId,'supplier'):null;
    ensure(['cash','bank','credit'].includes(args.source),'Paiement d’achat invalide.');if(args.source==='credit')ensure(supplier,'Choisissez un fournisseur pour un achat à crédit.');const session=args.source==='cash'?s.sessionRequired(user):null;
    return s.transaction(()=>{
      const id=randomUUID(),createdAt=now(),day=dayInTunis(),r=this.row(material.id),after=(r?.quantity||0)+quantity,valueMicros=(r?.value_micros||0)+amount*VALUE_SCALE;
      integer(after,'Stock matière',0,1_000_000_000_000);integer(valueMicros,'Valeur du stock',0,Number.MAX_SAFE_INTEGER);
      const data={...input,id,requestId,inputHash,deviceId:s.get('deviceId'),materialName:material.name,unit:material.unit,userId:user.id,userName:user.name,supplierName:supplier?.name||'',sessionId:session?.id||null,createdAt,day};
      s.db.prepare('INSERT INTO material_purchases VALUES (?,?,?,?,?)').run(id,requestId,user.id,JSON.stringify(data),createdAt);
      s.db.prepare('INSERT INTO material_inventory VALUES (?,?,?,?) ON CONFLICT(material_id) DO UPDATE SET quantity=excluded.quantity,value_micros=excluded.value_micros,updated_at=excluded.updated_at').run(material.id,after,valueMicros,createdAt);
      this.movement(material.id,'purchase',quantity,amount*VALUE_SCALE,null,data,createdAt);
      // A purchase creates its charge exactly once, including cash/supplier debt.
      let category=s.get('materialExpenseCategory');
      if(!category||!s.db.prepare('SELECT 1 FROM entities WHERE id=? AND active=1').get(category)){
        category=randomUUID();const categoryData={name:'Achats matières premières',color:'#197768'};s.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?)').run(category,'expenseCategory',JSON.stringify(categoryData),0,1);s.put('materialExpenseCategory',category);s.emit('entity',{id:category,kind:'expenseCategory',data:categoryData,active:true,baseRevision:0});
      }
      const expense={id,requestId:`material:${requestId}`,materialPurchaseId:id,materialId:material.id,categoryId:category,category:'Achats matières premières',description:`Achat · ${material.name}${input.note?' · '+input.note:''}`,supplierId:supplier?.id||'',supplierName:supplier?.name||'',amount,source:args.source,userName:user.name,sessionId:session?.id||null,createdAt,day};
      s.db.prepare('INSERT INTO expenses VALUES (?,?,?,?,?,?,?,?,?)').run(id,expense.requestId,session?.id||null,user.id,day,createdAt,amount,args.source,JSON.stringify(expense));
      s.emit('expense',expense);s.emit('materialPurchase',data);this.emit(material.id);s.audit(user,'material.purchase',{id,materialId:material.id,quantity,amount});return data;
    });
  }
  movement(materialId,kind,quantity,valueMicros,saleId,data,createdAt){this.s.db.prepare('INSERT INTO material_movements VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),materialId,kind,quantity,valueMicros,saleId,JSON.stringify(data),createdAt);}
  consume(items,saleId,user,createdAt){
    const s=this.s,touched=new Set(),required=s.entities('material').some(m=>m.active);
    for(const item of items){
      const ingredients=[],missing=[];
      for(const [kind,id,name] of [['product',item.productId,item.name],...item.supplements.map(x=>['supplement',x.id,x.name])]){
        const entity=s.entity(id,kind);
        if(!entity.recipeConfigured){missing.push({kind,id,name,reason:'Recette à renseigner'});continue;}
        for(const i of entity.recipe||[]){
          const m=s.entity(i.materialId,'material'),r=this.row(m.id),quantity=integer(i.quantity*item.quantity,'Consommation matière',1,1_000_000_000_000);
          ensure(r&&r.quantity>=quantity,`Stock matière insuffisant : ${m.name}. Enregistrez l’achat avant de vendre ${item.name}.`);
          const valueMicros=quantity===r.quantity?r.value_micros:roundedRatio(r.value_micros,quantity,r.quantity);
          s.db.prepare('UPDATE material_inventory SET quantity=?,value_micros=?,updated_at=? WHERE material_id=?').run(r.quantity-quantity,r.value_micros-valueMicros,createdAt,m.id);
          const ingredient={materialId:m.id,name:m.name,unit:m.unit,quantity,valueMicros,cost:costMillimes(valueMicros),sourceKind:kind,sourceId:id,sourceName:name};ingredients.push(ingredient);touched.add(m.id);
          this.movement(m.id,'sale',-quantity,-valueMicros,saleId,{lineId:item.lineId,userId:user.id,...ingredient},createdAt);
        }
      }
      ensure(!required||!missing.length,`Recette à renseigner : ${missing.map(x=>x.name).join(', ')}. Complétez les matières premières avant la vente.`);
      const valueMicros=ingredients.reduce((n,i)=>n+i.valueMicros,0);integer(valueMicros,'Coût de ligne',0,Number.MAX_SAFE_INTEGER);
      item.costing={method:'CUMP',complete:!missing.length,ingredients,missing,valueMicros};item.knownCost=costMillimes(valueMicros);item.cost=missing.length?null:item.knownCost;
    }
    for(const id of touched)this.emit(id);
  }
  restore(sale,user,createdAt){
    const s=this.s,touched=new Set();
    for(const item of sale.items)for(const i of item.costing?.ingredients||[]){const r=this.row(i.materialId);ensure(r,'Stock matière introuvable pour l’annulation.');const quantity=r.quantity+i.quantity,valueMicros=r.value_micros+i.valueMicros;integer(quantity,'Stock matière',0,1_000_000_000_000);integer(valueMicros,'Valeur du stock',0,Number.MAX_SAFE_INTEGER);s.db.prepare('UPDATE material_inventory SET quantity=?,value_micros=?,updated_at=? WHERE material_id=?').run(quantity,valueMicros,createdAt,i.materialId);this.movement(i.materialId,'void',i.quantity,i.valueMicros,sale.id,{lineId:item.lineId,userId:user.id,...i},createdAt);touched.add(i.materialId);}
    for(const id of touched)this.emit(id);
  }
}
