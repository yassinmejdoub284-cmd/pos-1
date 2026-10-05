import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReport,reportFilters,clockInTunis} from '../backend/reporting.mjs';
import {cloudData} from '../backend/cloud-data.mjs';
import {presetDates,periodLabel} from '../frontend/dashboard-period.mjs';

const from='2026-10-01',to='2026-10-02';
const sale=(id,createdAt,extra={})=>({id,createdAt,day:createdAt.slice(0,10),userId:'cashier',userName:'Amine',payment:'cash',mode:'sur_place',subtotal:10000,discount:1000,total:9000,items:[{productId:'p',familyId:'f',name:'Produit',familyName:'Famille',quantity:2,total:10000}],...extra});
const records=[sale('before','2026-10-01T07:59:59Z'),sale('start','2026-10-01T08:00:00Z'),sale('end','2026-10-01T09:00:59Z'),sale('after','2026-10-01T09:01:00Z'),sale('next','2026-10-02T08:30:00Z')];
const hourly={from,to,startTime:'09:00',endTime:'10:00'};
test('Web : filtre horaire répété chaque jour, heure de Tunis et bornes incluses à la minute',()=>{
  const r=buildReport({sales:records,refunds:[]},hourly);
  assert.deepEqual(r.sales.map(s=>s.id),['start','end','next']);assert.equal(r.total,27000);assert.equal(r.averageTicket,9000);assert.equal(r.quantity,6);
  assert.equal(r.products[0].total,27000);assert.equal(r.hourly.find(h=>h.hour==='09:00').sales,2);assert.equal(r.peakHour.hour,'09:00');
  assert.equal(r.hourly.reduce((n,h)=>n+h.total,0),r.total);assert.equal(r.filtered,true);
  assert.equal(buildReport({sales:records,refunds:[]},{from,to}).count,5);
});
test('Web : début seul, fin seule, heure identique et plage de nuit',()=>{
  assert.equal(buildReport({sales:records,refunds:[]},{from,to,startTime:'10:01'}).count,1);
  assert.equal(buildReport({sales:records,refunds:[]},{from,to,endTime:'08:59'}).count,1);
  assert.equal(buildReport({sales:records,refunds:[]},{from,to,startTime:'10:00',endTime:'10:00'}).count,1);
  const night=[sale('evening','2026-10-01T22:30:00Z'),sale('morning','2026-10-02T00:30:00Z'),sale('noon','2026-10-02T11:00:00Z')];
  assert.deepEqual(buildReport({sales:night,refunds:[]},{from,to,startTime:'22:00',endTime:'02:00'}).sales.map(s=>s.id),['evening','morning']);
  assert.equal(clockInTunis('2026-10-01T23:15:00Z'),'00:15');
});
test('Web : remboursements à leur heure réelle, charges et règlements sur la même sélection',()=>{
  const refunds=[sale('old','2026-09-30T11:00:00Z',{voidedAt:'2026-10-02T08:05:00Z'}),sale('outside','2026-10-01T08:05:00Z',{voidedAt:'2026-10-02T14:05:00Z'})];
  const operations=[{day:from,createdAt:'2026-10-01T08:05:00Z',amount:2000},{day:from,createdAt:'2026-10-01T11:05:00Z',amount:7000}];
  const r=buildReport({sales:records,refunds,expenses:operations,clientPayments:operations,supplierPayments:operations},hourly);
  assert.equal(r.voided,1);assert.equal(r.refundsTotal,9000);assert.equal(r.total,18000);assert.equal(r.cash,18000);assert.equal(r.expensesTotal,2000);assert.equal(r.clientPaymentsTotal,2000);assert.equal(r.supplierPaymentsTotal,2000);
  assert.equal(r.hourly.reduce((n,h)=>n+h.total,0),r.total);assert.equal(r.hourly.find(h=>h.hour==='09:00').refunds,1);
  const empty=buildReport({sales:[],refunds:[]},hourly);assert.equal(empty.peakHour,null);assert.equal(empty.averageTicket,0);
});
test('Web : heure inconnue exclue quand filtrée, mauvais formats et dates refusés',()=>{
  for(const startTime of ['24:00','12:60','9:00','09:00:10',42])assert.throws(()=>reportFilters({...hourly,startTime}),/Heure invalide/);
  assert.throws(()=>reportFilters({...hourly,endTime:'abc'}),/Heure invalide/);
  assert.throws(()=>reportFilters({from:'2026-02-30',to}),/Date invalide/);
  assert.throws(()=>reportFilters({from:to,to:from}),/date de début/);
  const s=sale('legacy','2026-10-01T08:00:00Z');delete s.createdAt;
  assert.equal(buildReport({sales:[s],refunds:[]},hourly).count,0);
  assert.equal(buildReport({sales:[s],refunds:[]},{from,to}).count,1);
});
test('Web : filtres horaires combinés au produit et paiement, remise exacte et clôtures filtrées',()=>{
  const mixed=sale('mixed','2026-10-01T08:05:00Z',{payment:'card',subtotal:9000,total:8000,items:[{productId:'p',familyId:'f',name:'P',quantity:1,total:7000},{productId:'q',familyId:'g',name:'Q',quantity:1,total:2000}]});
  const r=buildReport({sales:[mixed],refunds:[]},{...hourly,productId:'p',payment:'card'});assert.equal(r.total,6222);assert.equal(r.averageTicket,6222);assert.equal(r.peakHour.total,6222);
  const sessions=[{id:'in',userId:'cashier',openedAt:'2026-10-01T06:00:00Z',closedAt:'2026-10-01T08:05:00Z'},{id:'out',userId:'cashier',openedAt:'2026-10-01T06:00:00Z',closedAt:'2026-10-01T14:05:00Z'}];
  const d=cloudData({records:[...sessions.map(payload=>({type:'session',payload})),{type:'sale',payload:mixed}],entities:[],devices:[]},hourly);
  assert.deepEqual(d.closures.map(s=>s.id),['in']);assert.equal(d.closureCount,1);assert.equal(d.report.total,8000);
});
test('Web : raccourcis de période aux changements de mois/année et libellé de nuit',()=>{
  assert.deepEqual(presetDates('week','2026-01-02'),{from:'2025-12-27',to:'2026-01-02'});
  assert.deepEqual(presetDates('yesterday','2026-03-01'),{from:'2026-02-28',to:'2026-02-28'});
  assert.deepEqual(presetDates('month','2026-03-01'),{from:'2026-01-31',to:'2026-03-01'});
  assert.deepEqual(presetDates('currentMonth','2026-10-06'),{from:'2026-10-01',to:'2026-10-06'});
  assert.match(periodLabel({...hourly,startTime:'22:00',endTime:'02:00'}),/chaque jour \(nuit\)/);
  assert.match(periodLabel({from,to}),/Toute la journée/);
});
