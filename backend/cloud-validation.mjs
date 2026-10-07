import {ensure,integer} from './money.mjs';
import {validateMaterialEntity,validateMaterialRecord,validateSaleCosts} from './material-validation.mjs';
export function validateSync(body){
 ensure(body&&typeof body==='object'&&!Array.isArray(body),'Requête invalide.');
 ensure(typeof body.deviceId==='string'&&/^[0-9a-f-]{36}$/i.test(body.deviceId),'Poste invalide.');integer(body.cursor,'Curseur');ensure(Array.isArray(body.events)&&body.events.length<=200,'Lot invalide.');
 for(const event of body.events){ensure(typeof event.id==='string'&&/^[0-9a-f-]{36}$/i.test(event.id),'Événement invalide.');integer(event.seq,'Séquence',1);ensure(['entity','sale','saleVoid','session','expense','clientPayment','supplierPayment','company','stock','materialStock','materialPurchase'].includes(event.type),'Type inconnu.');
 const p=event.payload;ensure(p&&typeof p==='object'&&!Array.isArray(p),'Contenu invalide.');
 if(event.type==='entity'){ensure(['family','product','supplement','comment','expenseCategory','client','supplier','material'].includes(p.kind)&&typeof p.id==='string'&&p.data&&typeof p.data.name==='string'&&typeof p.active==='boolean','Fiche invalide.');integer(p.baseRevision,'Révision');validateMaterialEntity(p);}
 else{ensure(event.type==='company'||typeof p.id==='string'&&p.id.length<=100,'Identifiant manquant.');}
 if(event.type==='sale'){ensure(p.deviceId===body.deviceId&&Array.isArray(p.items)&&p.items.length>0&&p.items.length<=100&&['cash','card','credit'].includes(p.payment),'Vente invalide.');integer(p.total,'Total');integer(p.subtotal,'Sous-total');integer(p.discount,'Remise',0,p.subtotal);ensure(p.total===p.subtotal-p.discount,'Total incohérent.');let subtotal=0;for(const i of p.items){integer(i.quantity,'Quantité',1,99);integer(i.price,'Prix');ensure(Array.isArray(i.supplements)&&i.supplements.length<=30,'Suppléments invalides.');let unit=i.price;for(const x of i.supplements)unit+=integer(x.price,'Prix supplément');ensure(i.total===unit*i.quantity,'Ligne incohérente.');subtotal+=i.total;}ensure(subtotal===p.subtotal&&/^\d{4}-\d{2}-\d{2}$/.test(p.day),'Sous-total ou date incohérente.');}
 validateMaterialRecord(event.type,p,body.deviceId);
 if(event.type==='sale')validateSaleCosts(p);
 if(event.type==='stock'){ensure(p.deviceId===body.deviceId&&p.id===`${body.deviceId}:${p.productId}`&&typeof p.productId==='string'&&typeof p.active==='boolean','Stock invalide.');integer(p.quantity,'Stock',0,1_000_000);integer(p.minQuantity,'Seuil de stock',0,1_000_000);}
 if(['expense','clientPayment','supplierPayment'].includes(event.type)){integer(p.amount,'Montant',1);ensure(/^\d{4}-\d{2}-\d{2}$/.test(p.day),'Date manquante.');}
 }
}
