export const presets=[['today',"Aujourd’hui"],['yesterday','Hier'],['week','7 jours'],['month','30 jours'],['currentMonth','Ce mois']];
export function presetDates(name,today){
  const shift=days=>{const date=new Date(today+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);};
  switch(name){
    case 'today':return {from:today,to:today};
    case 'yesterday':return {from:shift(-1),to:shift(-1)};
    case 'week':return {from:shift(-6),to:today};
    case 'month':return {from:shift(-29),to:today};
    case 'currentMonth':return {from:today.slice(0,7)+'-01',to:today};
    default:throw Error('Période inconnue.');
  }
}
export function periodLabel(filters){
  const format=date=>date.split('-').reverse().join('/');
  const dates=filters.from===filters.to?format(filters.from):`${format(filters.from)} → ${format(filters.to)}`;
  if(!filters.startTime&&!filters.endTime)return dates+' · Toute la journée';
  const start=filters.startTime||'00:00',end=filters.endTime||'23:59';
  return `${dates} · ${start}–${end} chaque jour${start>end?' (nuit)':''}`;
}
