export function materialQuantity(value,unit){
  const str=String(value).trim().replace(',','.');if(!/^\d+(?:\.\d{1,3})?$/.test(str))throw Error('Saisissez une quantité positive, avec trois décimales au maximum.');
  if(!['g','kg','piece'].includes(unit))throw Error('Unité invalide.');
  const [whole,part='']=str.split('.'),q=(Number(whole)*1000+Number(part.padEnd(3,'0')))*(unit==='kg'?1000:1);
  if(!Number.isSafeInteger(q)||q<=0||q>1_000_000_000_000)throw Error('Quantité invalide ou trop élevée.');return q;
}
export const quantityInput=q=>(q/1000).toFixed(3).replace(/\.?0+$/,'');
export function quantityText(q,unit){const kg=unit==='g'&&Math.abs(q)>=1_000_000;return (q/(kg?1_000_000:1000)).toLocaleString('fr-TN',{maximumFractionDigits:3})+' '+(unit==='piece'?'pièce(s)':kg?'kg':'g');}
export function averageMaterialCost(m){return m.quantity>0?Math.round(m.valueMicros/m.quantity*(m.unit==='g'?1_000_000:1000)/1_000_000):null;}
