import {buildReport,reportFilters,inReportPeriod} from './reporting.mjs';
import {dayInTunis} from './money.mjs';
export function cloudData({records,entities,devices},args={}){
 const filters=reportFilters(args),all=type=>records.filter(r=>r.type===type).map(r=>({...r.payload,syncDeviceId:r.device||r.payload.deviceId||''}));
 const sales=all('sale').map(s=>({...s,clientId:s.clientId||s.client?.id||'',clientName:s.clientName||s.client?.name||''})),voids=all('saleVoid'),voidMap=new Map(voids.map(v=>[v.id,v]));
 const refunds=sales.filter(s=>voidMap.has(s.id)).map(s=>({...s,...voidMap.get(s.id)}));
 const expenses=all('expense'),clientPayments=all('clientPayment'),supplierPayments=all('supplierPayment'),sessions=all('session');
 const report=buildReport({sales:sales.map(s=>({...s,voidedAt:voidMap.get(s.id)?.voidedAt})),refunds,expenses,sessions,clientPayments,supplierPayments},filters);
 const catalog=Object.fromEntries(['family','product','client','supplier','expenseCategory'].map(kind=>[kind,entities.filter(e=>e.kind===kind).map(e=>({...e.data,id:e.id,active:!!e.active,revision:e.revision}))]));
 const clientBalances={},supplierBalances={};
 for(const s of sales)if(s.payment==='credit'&&!voidMap.has(s.id)&&s.clientId)clientBalances[s.clientId]=(clientBalances[s.clientId]||0)+s.total;
 for(const p of clientPayments)clientBalances[p.clientId]=(clientBalances[p.clientId]||0)-p.amount;
 for(const e of expenses)if(e.source==='credit'&&e.supplierId)supplierBalances[e.supplierId]=(supplierBalances[e.supplierId]||0)+e.amount;
 for(const p of supplierPayments)supplierBalances[p.supplierId]=(supplierBalances[p.supplierId]||0)-p.amount;
 const closures=sessions.filter(s=>s.closedAt&&inReportPeriod(filters,dayInTunis(new Date(s.closedAt)),s.closedAt)&&(!filters.userId||s.userId===filters.userId)).sort((a,b)=>b.closedAt.localeCompare(a.closedAt));
 const purchases={};for(const e of expenses)if(e.supplierId)purchases[e.supplierId]=(purchases[e.supplierId]||0)+e.amount;
 const productNames=new Map(catalog.product.map(p=>[p.id,p.name])),supplierNames=new Map(catalog.supplier.map(s=>[s.id,s.name]));
 const stock=all('stock').filter(s=>s.active).map(s=>({...s,productName:productNames.get(s.productId)||s.productId,supplierName:supplierNames.get(s.supplierId)||'',low:s.quantity<=s.minQuantity})).sort((a,b)=>a.productName.localeCompare(b.productName,'fr'));
 return {company:all('company')[0]||{name:'Samurai POS'},report:{...report,sales:report.sales.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,200),refunds:report.refunds.slice(0,200)},catalog,clientBalances,supplierBalances,purchases,stock,closures:closures.slice(0,300),closureCount:closures.length,devices,updatedAt:new Date().toISOString(),users:[...new Map(sales.map(s=>[s.userId,{id:s.userId,name:s.userName}])).values()]};
}
