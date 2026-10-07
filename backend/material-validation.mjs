import {ensure,integer} from './money.mjs';
import {costMillimes} from './materials.mjs';
const units=['g','piece'];
export function validateMaterialEntity(p){
  if(p.kind==='material')ensure(units.includes(p.data.unit),'Unité matière invalide.');
  if(p.data.recipeConfigured!==undefined){ensure(['product','supplement'].includes(p.kind)&&p.data.recipeConfigured===true&&Array.isArray(p.data.recipe)&&p.data.recipe.length<=100,'Recette invalide.');const ids=new Set();for(const i of p.data.recipe){ensure(typeof i.materialId==='string'&&!ids.has(i.materialId),'Matière de recette invalide.');ids.add(i.materialId);integer(i.quantity,'Quantité de recette',1,1_000_000_000);}}
}
export function validateMaterialRecord(type,p,deviceId){
  if(type==='materialStock'){ensure(p.deviceId===deviceId&&p.id===`${deviceId}:${p.materialId}`&&typeof p.materialId==='string'&&typeof p.active==='boolean'&&units.includes(p.unit),'Stock matière invalide.');integer(p.quantity,'Stock matière',0,1_000_000_000_000);integer(p.valueMicros,'Valeur matière',0,Number.MAX_SAFE_INTEGER);ensure(p.quantity>0||p.valueMicros===0,'Valeur de stock incohérente.');}
  if(type==='materialPurchase'){ensure(p.deviceId===deviceId&&typeof p.materialId==='string'&&units.includes(p.unit)&&['cash','bank','credit'].includes(p.source),'Achat matière invalide.');integer(p.quantity,'Quantité achetée',1,1_000_000_000_000);integer(p.amount,'Montant d’achat',1);ensure(/^\d{4}-\d{2}-\d{2}$/.test(p.day),'Date d’achat invalide.');}
}
export function validateSaleCosts(sale){
  const present=sale.items.filter(i=>i.costing!==undefined);if(!present.length){ensure(sale.cost===undefined&&sale.knownCost===undefined&&sale.costComplete===undefined,'Coût sans détail.');return;}
  ensure(present.length===sale.items.length,'Détails de coût incomplets.');
  for(const i of sale.items){const c=i.costing;ensure(c&&c.method==='CUMP'&&typeof c.complete==='boolean'&&Array.isArray(c.ingredients)&&c.ingredients.length<=3100&&Array.isArray(c.missing)&&c.missing.length<=31,'Détail de coût invalide.');let micros=0;for(const m of c.ingredients){ensure(typeof m.materialId==='string'&&units.includes(m.unit)&&['product','supplement'].includes(m.sourceKind),'Consommation invalide.');integer(m.quantity,'Consommation',1,1_000_000_000_000);integer(m.valueMicros,'Valeur consommée',0,Number.MAX_SAFE_INTEGER);ensure(m.cost===costMillimes(m.valueMicros),'Coût matière incohérent.');micros+=m.valueMicros;}
    integer(micros,'Coût de ligne',0,Number.MAX_SAFE_INTEGER);ensure(c.valueMicros===micros&&c.complete===(c.missing.length===0)&&i.knownCost===costMillimes(micros)&&i.cost===(c.complete?i.knownCost:null),'Coût de ligne incohérent.');
  }
  const complete=sale.items.every(i=>i.costing.complete),knownCost=sale.items.reduce((n,i)=>n+i.knownCost,0);integer(knownCost,'Coût connu',0,Number.MAX_SAFE_INTEGER);ensure(sale.costComplete===complete&&sale.knownCost===knownCost&&sale.cost===(complete?knownCost:null),'Coût de vente incohérent.');
}
