function sameOrder(previous, request) {
  const items=previous.items.map(line=>({
    productId:line.productId,
    quantity:line.quantity,
    supplements:line.supplements.map(item=>item.id),
    comments:line.comments.map(item=>item.id),
  }));
  return JSON.stringify(items)===JSON.stringify(request.items)
    && previous.discount===request.discount
    && previous.payment===request.payment
    && (previous.client?.id||'')===request.clientId;
}

export async function submitSaleWithRecovery(request,{submit,find,newRequestId}) {
  try {return {sale:await submit(request),previousTicket:null};}
  catch(error) {
    if(error.status!==409)throw error;
    const previous=await find(request.requestId);
    if(!previous)throw error;
    if(sameOrder(previous,request))return {sale:{...previous,duplicate:true},previousTicket:null};
    const requestId=newRequestId();
    return {sale:await submit({...request,requestId}),previousTicket:previous.ticket};
  }
}
