// Transcription of the ticket 1.1.4 schema supplied by CIMF documentation.
// Kept separate from illustrative Postman examples (which still say 1.1.3).
const str=(minLength,maxLength,extra={})=>({type:'string',...(minLength!==undefined?{minLength}:{}),...(maxLength!==undefined?{maxLength}:{}),...extra});
const int=(minimum=0)=>({type:'integer',minimum});
const en=values=>({type:'string',enum:values});
const obj=(properties,required=Object.keys(properties),extra={})=>({type:'object',properties,required,additionalProperties:false,...extra});
const arr=(items,minItems=0,uniqueItems=true)=>({type:'array',items,minItems,uniqueItems});
const mf=str(8,8,{pattern:'^\\d{7}[A-Z]$'});
const discount=obj({percent:{type:'number',minimum:0,maximum:100},value:int()});
const tax=obj({type:en(['fixed','percent']),value:{type:'number',minimum:0.01},tax_code:str(1,16)});
const payment=obj({method:en(['cash','check','bank_card','restaurant_ticket','mobile_payment','contre_bon','wire_transfer']),amount:int(1)});
export const ticketSchema={
  $schema:'https://json-schema.org/draft/2020-12/schema',
  ...obj({
    data_type:{type:'string',const:'ncf.cashier.operation'},version:{type:'string',const:'1.1.4'},
    transaction:obj({id:str(8,48),timestamp:str(undefined,undefined,{format:'date-time'}),
      operation:obj({op_type:en(['TICKET','PROFORMA','REFUND','DUPLICATE']),context:en(['SALE','TRAINING'])},['op_type','context'],{
        additionalProperties:true,if:{properties:{op_type:{const:'DUPLICATE'}}},
        then:{properties:{duplicated_transaction_identifier:str(8,48)},required:['duplicated_transaction_identifier']}
      }),
      originator:obj({agent_identifier:str(3,32),imdf:str(14,16),cash_register_serialnumber:str(8,32),cash_register_software:str(8,32),accreditation_reference:str(8,32)})
    }),
    merchant_identity:obj({id:mf,id_type:{type:'string',const:'MF'},taxpayer_establishment:obj({commercial_name:str(undefined,64),reference:str(undefined,undefined,{pattern:'^\\d{3}$'}),address:str(8,128),city:str(3,32)})},undefined,{additionalProperties:true}),
    customer_identity:obj({fiscal_advantages:str(3,48),id_type:en(['PP','NP']),id:{type:'string'}},['id_type'],{
      allOf:[{if:{properties:{id_type:{const:'PP'}}},then:{properties:{id:mf},required:['id']}}]
    }),
    sale_details:arr(obj({product:obj({family_code:str(2,8),name:str(3,64),price_pre_tax:int(1)}),taxation:arr(tax),quantity:int(1),discount_per_unit:discount}),1,false),
    tax_summary:arr(obj({tax_code:str(1,16),total_amount:int()})),
    general_discount:discount,
    additional_tax:obj({type:en(['fixed','percent']),value:{type:'number',minimum:0},tax_code:str(1,16)}),
    payment_details:obj({collection_details:arr(payment,1),returned_change:arr(obj({method:en(['cash','contre_bon']),amount:int(1)}))}),
    sale_summary:obj({total_excl_tax:int(),total_incl_tax:int(),total_tax:int()}),
    delivery_details:obj({type:en(['SELF_PICKUP','DELIVERY'])},[],{additionalProperties:true,if:{properties:{type:{const:'DELIVERY'}}},then:{properties:{carrier_id:mf},required:['carrier_id']}})
  })
};
