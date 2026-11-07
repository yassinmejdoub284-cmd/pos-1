import {createHash,randomUUID} from 'node:crypto';
import {ensure,integer,label} from './money.mjs';
import {VALUE_SCALE,QUANTITY_SCALE,roundedRatio,costMillimes} from './materials.mjs';

const parse=JSON.parse;
const valueFor=(quantity,unitPrice,unit)=>roundedRatio(unitPrice*VALUE_SCALE,quantity,unit==='g'?1_000_000:QUANTITY_SCALE);
const ingredientKey=(saleId,d)=>JSON.stringify([saleId,d.lineId,d.materialId,d.sourceKind,d.sourceId]);

export class MaterialHistory {
  constructor(inventory){this.inventory=inventory;this.s=inventory.s;}
  rows(materialId){return this.s.db.prepare('SELECT rowid sequence,* FROM material_movements WHERE material_id=? ORDER BY rowid').all(materialId);}
  // Older versions recorded inventory corrections as deltas. Capture their
  // absolute targets before replaying so later inventory counts remain fixed.
  prepareHistory(materialId){
    const s=this.s,rows=this.rows(materialId);let quantity=0,valueMicros=0;
    for(const row of rows){const d=parse(row.data);if(row.kind==='checkpoint'){quantity=d.afterQuantity;valueMicros=d.afterValueMicros;continue;}quantity+=row.quantity;valueMicros+=row.value_micros;
      if(row.kind==='adjustment'&&d.afterQuantity===undefined)s.db.prepare('UPDATE material_movements SET data=? WHERE id=?').run(JSON.stringify({...d,afterQuantity:quantity,afterValueMicros:valueMicros}),row.id);
    }
    const current=this.inventory.row(materialId);
    if(current&&(current.quantity!==quantity||current.value_micros!==valueMicros)){
      // A purge made by an older version removed consumption movements.
      // Its remaining stock is the only reliable starting point after that purge.
      this.inventory.movement(materialId,'checkpoint',0,0,null,{afterQuantity:current.quantity,afterValueMicros:current.value_micros,note:'Stock conservé après un ancien effacement d’historique'},new Date().toISOString());
    }
  }
  list(args={}){
    const page=integer(args.page??0,'Page',0,1_000_000),pageSize=50,s=this.s,query=String(args.query||'').trim().toLocaleLowerCase('fr'),kind=args.kind==='purchase'?'purchase':'';
    const histories=new Map();for(const row of s.db.prepare('SELECT data FROM material_corrections ORDER BY rowid').all()){const d=parse(row.data);if(!histories.has(d.movementId))histories.set(d.movementId,[]);histories.get(d.movementId).push(d);}
    const rows=[];
    for(const material of s.entities('material')){
      let quantity=0,valueMicros=0;const movements=this.rows(material.id),checkpoint=movements.findLast(row=>row.kind==='checkpoint')?.sequence||0;
      for(const row of movements){
        const data=parse(row.data),beforeQuantity=quantity,beforeValueMicros=valueMicros;
        quantity=row.kind==='checkpoint'?data.afterQuantity:quantity+row.quantity;valueMicros=row.kind==='checkpoint'?data.afterValueMicros:valueMicros+row.value_micros;
        if(kind&&row.kind!==kind)continue;
        if(query&&!`${material.name} ${data.supplierName||''} ${data.note||''}`.toLocaleLowerCase('fr').includes(query))continue;
        rows.push({id:row.id,sequence:row.sequence,materialId:material.id,materialName:material.name,unit:material.unit,kind:row.kind,quantity:row.quantity,valueMicros:row.value_micros,beforeQuantity,afterQuantity:quantity,beforeValueMicros,afterValueMicros:valueMicros,beforeCheckpoint:row.sequence<checkpoint,createdAt:row.created_at,data,revision:data.revision||0,corrections:histories.get(row.id)||[]});
      }
    }
    rows.sort((a,b)=>b.sequence-a.sequence);const pages=Math.max(1,Math.ceil(rows.length/pageSize)),current=Math.min(page,pages-1);
    return {rows:rows.slice(current*pageSize,(current+1)*pageSize),total:rows.length,page:current,pages};
  }
  edit(args,user){
    const s=this.s,requestId=label(args.requestId,'Identifiant de correction',100),input={id:args.id,revision:args.revision,quantity:args.quantity,amount:args.amount,unitPrice:args.unitPrice,note:typeof args.note==='string'?args.note.trim():''};
    const inputHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior=s.db.prepare('SELECT * FROM material_corrections WHERE id=?').get(requestId);
    if(prior){const d=parse(prior.data);ensure(prior.user_id===user.id&&d.inputHash===inputHash,'Cette demande de correction a déjà un autre contenu.',409);return {...d,duplicate:true};}
    return s.transaction(()=>{
      const row=s.db.prepare('SELECT * FROM material_movements WHERE id=?').get(args.id);ensure(row&&['purchase','adjustment'].includes(row.kind),'Seuls les achats et corrections d’inventaire peuvent être modifiés.');
      this.prepareHistory(row.material_id);
      const current=s.db.prepare('SELECT * FROM material_movements WHERE id=?').get(row.id),d=parse(current.data),m=s.entities('material').find(m=>m.id===row.material_id),revision=d.revision||0;ensure(m,'Matière introuvable.');
      ensure(args.revision===revision,'Cette ligne a été modifiée. Actualisez l’historique avant de recommencer.',409);
      const quantity=integer(args.quantity,row.kind==='purchase'?'Quantité achetée':'Stock corrigé',row.kind==='purchase'?1:0,1_000_000_000_000);ensure(input.note.length<=300,'Note trop longue.');
      const before=row.kind==='purchase'?{quantity:row.quantity,amount:d.amount,note:d.note||''}:{quantity:d.afterQuantity,unitPrice:d.unitPrice,note:d.note||''};
      const after=row.kind==='purchase'?{quantity,amount:integer(args.amount,'Montant d’achat',1),note:input.note}:{quantity,unitPrice:integer(args.unitPrice,'Prix unitaire',0),note:input.note};
      const createdAt=new Date().toISOString(),correction={id:requestId,inputHash,deviceId:s.get('deviceId'),movementId:row.id,materialId:m.id,kind:row.kind,purchaseId:row.kind==='purchase'?d.id:null,revision:revision+1,before,after,userId:user.id,userName:user.name,createdAt};
      if(row.kind==='purchase'){
        const purchase=s.db.prepare('SELECT * FROM material_purchases WHERE id=?').get(d.id);ensure(purchase,'Achat introuvable.');const updated={...parse(purchase.data),...after,revision:revision+1,updatedAt:createdAt};
        s.db.prepare('UPDATE material_purchases SET data=? WHERE id=?').run(JSON.stringify(updated),d.id);
        s.db.prepare('UPDATE material_movements SET quantity=?,value_micros=?,data=? WHERE id=?').run(quantity,after.amount*VALUE_SCALE,JSON.stringify(updated),row.id);
        const expense=s.db.prepare('SELECT * FROM expenses WHERE id=?').get(d.id);ensure(expense,'Charge liée introuvable.');const expenseData={...parse(expense.data),amount:after.amount,description:`Achat · ${d.materialName}${after.note?' · '+after.note:''}`};
        s.db.prepare('UPDATE expenses SET amount=?,data=? WHERE id=?').run(after.amount,JSON.stringify(expenseData),d.id);
        this.updateClosure(expense.session_id);
      }else{
        const valueMicros=valueFor(quantity,after.unitPrice,m.unit);integer(valueMicros,'Valeur du stock',0,Number.MAX_SAFE_INTEGER);
        s.db.prepare('UPDATE material_movements SET data=? WHERE id=?').run(JSON.stringify({...d,...after,afterQuantity:quantity,afterValueMicros:valueMicros,revision:revision+1}),row.id);
        const latest=s.db.prepare("SELECT id FROM material_movements WHERE material_id=? AND kind='adjustment' ORDER BY rowid DESC LIMIT 1").get(m.id);
        if(latest.id===row.id){const entity=s.db.prepare('SELECT * FROM entities WHERE id=?').get(m.id),data={...parse(entity.data),unitPrice:after.unitPrice};s.db.prepare('UPDATE entities SET data=? WHERE id=?').run(JSON.stringify(data),m.id);s.emit('entity',{id:m.id,kind:'material',data,active:!!entity.active,baseRevision:entity.revision});}
      }
      this.replay(m,createdAt,requestId);
      s.db.prepare('INSERT INTO material_corrections VALUES (?,?,?,?,?)').run(requestId,row.id,user.id,JSON.stringify(correction),createdAt);
      s.emit('materialCorrection',correction);this.inventory.emit(m.id);s.audit(user,'material.history.edit',correction);return correction;
    });
  }
  updateClosure(sessionId){
    if(!sessionId)return;const s=this.s,row=s.db.prepare('SELECT * FROM sessions WHERE id=? AND closed_at IS NOT NULL AND id NOT IN (SELECT id FROM purged_sessions)').get(sessionId);if(!row)return;
    const summary=s.cashSummary(sessionId),variance=row.closing-summary.expected,data={...parse(row.data),summary};s.db.prepare('UPDATE sessions SET expected=?,variance=?,data=? WHERE id=?').run(summary.expected,variance,JSON.stringify(data),sessionId);
    s.emit('session',s.sessionData({...row,expected:summary.expected,variance,data:JSON.stringify(data)}));
  }
  replay(material,updatedAt,correctionId){
    const s=this.s,consumed=new Map(),saleChanges=new Map();let quantity=0,valueMicros=0;
    const rows=this.rows(material.id),checkpoint=rows.findLastIndex(row=>row.kind==='checkpoint');
    if(checkpoint>=0){const data=parse(rows[checkpoint].data);quantity=data.afterQuantity;valueMicros=data.afterValueMicros;}
    for(const row of rows.slice(checkpoint+1)){
      const d=parse(row.data);let deltaQuantity=row.quantity,deltaValue=row.value_micros;
      if(row.kind==='adjustment'){deltaQuantity=d.afterQuantity-quantity;deltaValue=d.afterValueMicros-valueMicros;}
      if(row.kind==='sale'){
        ensure(quantity>=-deltaQuantity,`Correction impossible : stock insuffisant pour une vente historique de ${material.name}.`);
        deltaValue=-(-deltaQuantity===quantity?valueMicros:roundedRatio(valueMicros,-deltaQuantity,quantity));consumed.set(ingredientKey(row.sale_id,d),-deltaValue);
        if(deltaValue!==row.value_micros){if(!saleChanges.has(row.sale_id))saleChanges.set(row.sale_id,[]);saleChanges.get(row.sale_id).push({...d,valueMicros:-deltaValue,cost:costMillimes(-deltaValue)});}
      }
      if(row.kind==='void')deltaValue=consumed.get(ingredientKey(row.sale_id,d))??deltaValue;
      quantity+=deltaQuantity;valueMicros+=deltaValue;integer(quantity,'Stock matière après correction',0,1_000_000_000_000);integer(valueMicros,'Valeur après correction',0,Number.MAX_SAFE_INTEGER);ensure(quantity||!valueMicros,'Valeur de stock incohérente après correction.');
      const data=['sale','void'].includes(row.kind)?{...d,valueMicros:Math.abs(deltaValue),cost:costMillimes(Math.abs(deltaValue))}:d;
      s.db.prepare('UPDATE material_movements SET quantity=?,value_micros=?,data=? WHERE id=?').run(deltaQuantity,deltaValue,JSON.stringify(data),row.id);
    }
    s.db.prepare('UPDATE material_inventory SET quantity=?,value_micros=?,updated_at=? WHERE material_id=?').run(quantity,valueMicros,updatedAt,material.id);
    for(const [saleId,changes] of saleChanges){
      const row=s.db.prepare('SELECT data FROM sales WHERE id=?').get(saleId);if(!row)continue;const sale=parse(row.data);
      for(const change of changes){const item=sale.items.find(i=>i.lineId===change.lineId),ingredient=item?.costing?.ingredients.find(i=>i.materialId===change.materialId&&i.sourceKind===change.sourceKind&&i.sourceId===change.sourceId);ensure(ingredient,'Détail de coût historique introuvable.');Object.assign(ingredient,{valueMicros:change.valueMicros,cost:change.cost});}
      for(const item of sale.items){item.costing.valueMicros=item.costing.ingredients.reduce((n,i)=>n+i.valueMicros,0);integer(item.costing.valueMicros,'Coût de ligne',0,Number.MAX_SAFE_INTEGER);item.knownCost=costMillimes(item.costing.valueMicros);item.cost=item.costing.complete?item.knownCost:null;}
      sale.knownCost=sale.items.reduce((n,i)=>n+i.knownCost,0);integer(sale.knownCost,'Coût de vente',0,Number.MAX_SAFE_INTEGER);sale.cost=sale.costComplete?sale.knownCost:null;sale.costRevision=(sale.costRevision||0)+1;
      s.db.prepare('UPDATE sales SET data=? WHERE id=?').run(JSON.stringify(sale),saleId);
      s.emit('saleCostCorrection',{id:randomUUID(),correctionId,saleId,deviceId:s.get('deviceId'),revision:sale.costRevision,createdAt:updatedAt,items:sale.items.map(i=>({lineId:i.lineId,costing:i.costing,knownCost:i.knownCost,cost:i.cost})),knownCost:sale.knownCost,cost:sale.cost,costComplete:sale.costComplete});
    }
  }
}
