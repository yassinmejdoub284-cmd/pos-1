import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {ticketSchema} from './nacef-schema.mjs';
import {ensure,integer} from './money.mjs';
const ajv=new Ajv2020({allErrors:true,strict:false});addFormats(ajv);
export const validateTicketSchema=ajv.compile(ticketSchema);
export function validateFiscalTicket(t){
  ensure(validateTicketSchema(t),'Ticket NACEF invalide : '+ajv.errorsText(validateTicketSchema.errors,{separator:' ; '}));
  const summary=t.sale_summary,details=t.payment_details;
  ensure(summary.total_incl_tax===summary.total_excl_tax+summary.total_tax,'Totaux HT / taxes / TTC incohérents.');
  ensure(t.tax_summary.reduce((n,x)=>n+x.total_amount,0)===summary.total_tax,'Récapitulatif des taxes incohérent.');
  ensure(details.collection_details.reduce((n,x)=>n+x.amount,0)-details.returned_change.reduce((n,x)=>n+x.amount,0)===summary.total_incl_tax,'Règlements et monnaie rendue incohérents.');
  return t;
}
export function fiscalTicket(sale,config,{reference,operation='TICKET',context='SALE',originalReference,customer={id_type:'NP'},carrierId}={}){
  ensure(['TICKET','REFUND','PROFORMA','DUPLICATE'].includes(operation),'Type fiscal invalide.');
  ensure(['SALE','TRAINING'].includes(context),'Contexte fiscal invalide.');
  ensure(sale.total>0,'Le schéma NACEF exige un règlement positif : ticket gratuit non pris en charge.');
  ensure(sale.payment!=='credit','Crédit client : mode fiscal à définir avec NACEF ; aucun paiement fictif ne sera émis.');
  const taxes=new Map(),lines=[];let totalHT=0,discountHT=0,allocated=0;
  // Catalog prices remain TTC. Allocate discounts exactly in millimes; never send food costing or kitchen notes.
  sale.items.forEach((item,index)=>{
    const mapping=config.families[item.familyId];ensure(mapping,`Famille fiscale / TVA non configurée : ${item.familyName}.`);
    const bps=integer(mapping.rateBps,'Taux TVA',0,10000);
    const gross=item.total;
    const lineDiscount=index===sale.items.length-1?sale.discount-allocated:Math.floor(gross*sale.discount/sale.subtotal);allocated+=lineDiscount;
    const unitTTC=item.price+item.supplements.reduce((n,x)=>n+x.price,0);
    const grossHT=Math.round(gross*10000/(10000+bps));
    const netTTC=gross-lineDiscount,netHT=Math.round(netTTC*10000/(10000+bps));
    const reduction=grossHT-netHT;
    const names=[item.name,...item.supplements.map(x=>x.name)].join(' + ');
    ensure(names.length<=64&&!/[\u0000-\u001f\u007f]/.test(names),'Désignation fiscale invalide (3-64 caractères, sans caractères de contrôle).');
    const grouped=new Map();
    // Distribute the integer HT rounding remainder, rather than inventing a discount.
    for(let i=0;i<item.quantity;i++){
      const unitHT=Math.floor(grossHT/item.quantity)+(i<grossHT%item.quantity?1:0);
      const discount=Math.floor(reduction/item.quantity)+(i<reduction%item.quantity?1:0);
      ensure(unitHT>0&&discount<=unitHT,'Prix HT ou remise incompatible avec le schéma.');
      const key=unitHT+':'+discount,g=grouped.get(key)||{quantity:0,unitHT,discount};g.quantity++;grouped.set(key,g);
    }
    for(const g of grouped.values())lines.push({product:{family_code:mapping.code,name:names,price_pre_tax:g.unitHT},taxation:bps?[{type:'percent',value:bps/100,tax_code:mapping.taxCode}]:[],quantity:g.quantity,discount_per_unit:{percent:0,value:g.discount}});
    totalHT+=netHT;discountHT+=reduction;
    // TTC is authoritative: HT rounded in millimes, tax = TTC - HT (no loss of a millime).
    const amount=netTTC-netHT;
    if(bps)taxes.set(mapping.taxCode,(taxes.get(mapping.taxCode)||0)+amount);
  });
  const totalTax=[...taxes.values()].reduce((a,b)=>a+b,0),total=totalHT+totalTax;
  ensure(total===sale.total,`Arrondis fiscaux incohérents (${total} au lieu de ${sale.total} millimes). Ajustez les prix/remises ; aucun montant ne sera modifié silencieusement.`);
  const collection=sale.payment==='cash'?sale.received:total;
  const delivery=sale.mode==='livraison'?{type:'DELIVERY',carrier_id:carrierId||config.carrierId}:{type:'SELF_PICKUP'};
  const t={data_type:'ncf.cashier.operation',version:'1.1.4',transaction:{id:reference,timestamp:sale.createdAt,operation:{op_type:operation,context,...(operation==='DUPLICATE'?{duplicated_transaction_identifier:originalReference}:{})},originator:{agent_identifier:sale.userId,imdf:config.imdf,cash_register_serialnumber:config.serialNumber,cash_register_software:config.software,accreditation_reference:config.accreditationReference}},merchant_identity:{id:config.merchantId,id_type:'MF',taxpayer_establishment:{commercial_name:config.commercialName,reference:config.establishment,address:config.address,city:config.city}},customer_identity:customer,sale_details:lines,tax_summary:[...taxes].map(([tax_code,total_amount])=>({tax_code,total_amount})),general_discount:{percent:0,value:0},additional_tax:{type:'fixed',value:0,tax_code:config.zeroAdditionalTaxCode},payment_details:{collection_details:[{method:sale.payment==='card'?'bank_card':'cash',amount:collection}],returned_change:collection>total?[{method:'cash',amount:collection-total}]:[]},sale_summary:{total_excl_tax:totalHT,total_incl_tax:total,total_tax:totalTax},delivery_details:delivery};
  // UUID user IDs are longer than the 32-char fiscal agent limit; stable hexadecimal identifier.
  t.transaction.originator.agent_identifier=sale.userId.replaceAll('-','');
  return validateFiscalTicket(t);
}
