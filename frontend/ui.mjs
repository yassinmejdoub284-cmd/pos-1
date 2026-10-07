export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money=n=>(n/1000).toLocaleString('fr-TN',{minimumFractionDigits:3,maximumFractionDigits:3})+' DT';
export const amount=n=>(n/1000).toFixed(3);
export function millimes(value) {const str=String(value).trim();if(!/^\d+(?:[.,]\d{0,3})?$/.test(str))throw new Error('Saisissez un montant positif avec trois décimales au maximum.');const [whole,fraction='']=str.replace(',','.').split('.');const result=Number(whole)*1000+Number(fraction.padEnd(3,'0'));if(!Number.isSafeInteger(result)||result>100_000_000)throw new Error('Montant trop élevé.');return result;}
export const time=v=>new Intl.DateTimeFormat('fr-TN',{timeZone:'Africa/Tunis',dateStyle:'short',timeStyle:'short'}).format(new Date(v));
export function today(){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Tunis',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const g=k=>p.find(x=>x.type===k).value;return `${g('year')}-${g('month')}-${g('day')}`;}
const paths={
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  bag:'<path d="M5 7h14l1 14H4L5 7Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  box:'<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v9l9 5 9-5V8M12 13v9M7 5.8l9 5"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5.6"/>',
  wallet:'<path d="M20 7H5a2 2 0 0 1 0-4h13v4M3 5v14a2 2 0 0 0 2 2h15V7"/><path d="M20 12h-6v5h6"/><circle cx="16.5" cy="14.5" r=".5"/>',
  history:'<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2"/>',
  lock:'<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 15v3"/>',
  chart:'<path d="M3 3v18h18M7 16v-5M12 16V7M17 16v-9"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3Z"/>',
  sync:'<path d="M20 8a8 8 0 0 0-13-3L3 9M3 3v6h6M4 16a8 8 0 0 0 13 3l4-4M21 21v-6h-6"/>',
  search:'<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  trash:'<path d="M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  print:'<path d="M6 9V3h12v6M6 17H3V9h18v8h-3M6 14h12v7H6v-7M17 11h1"/>',
  edit:'<path d="m15 4 5 5M4 16l12-12a3 3 0 0 1 4 4L8 20l-5 1 1-5Z"/>',
  out:'<path d="M9 4H4v16h5M10 12h11m-5-5 5 5-5 5"/>',
  card:'<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 9h20M6 15h3"/>',
  note:'<path d="M4 3h16v18H4zM8 8h8M8 12h8M8 16h5"/>',
  cloud:'<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5 5 0 0 1 0 11H6Z"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
};
export const icon=name=>`<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.grid}</svg>`;
export const button=(label,action,id='',cls='')=>`<button type="button" class="btn ${cls}" data-action="${esc(action)}" ${id?`data-id="${esc(id)}"`:''}>${label}</button>`;
export const field=(name,label,value='',type='text',extra='')=>`<div class="field"><label for="f-${esc(name)}">${esc(label)}</label><input id="f-${esc(name)}" name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></div>`;
export const checkbox=(name,label,checked=false)=>`<label class="check"><input type="checkbox" name="${esc(name)}" ${checked?'checked':''}>${esc(label)}</label>`;
export const option=(value,label,selected)=>`<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(label)}</option>`;
export const empty=(title,description,action='',label='Ajouter')=>`<div class="empty"><div class="empty-icon">${icon('box')}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action?button(icon('plus')+label,action,'','primary'):''}</div>`;
export const stat=(title,value,subtitle='',sym='chart')=>`<div class="stat"><div class="stat-head"><span>${esc(title)}</span><span class="stat-icon">${icon(sym)}</span></div><strong>${esc(value)}</strong><small>${esc(subtitle)}</small></div>`;
export const permissionNames={suppliers:'Gérer les fournisseurs',stock:'Gérer stocks, matières premières, recettes et achats',sell:'Utiliser la caisse',discount:'Accorder une remise',void:'Annuler et rembourser une vente',catalog:'Gérer le catalogue',clients:'Gérer les clients et règlements',expenses:'Gérer les charges et catégories',reports:'Consulter les rapports',close:'Clôturer sa caisse',users:'Gérer les comptes et permissions',settings:'Modifier les paramètres',sync:'Synchroniser et résoudre les conflits',backup:'Exporter une sauvegarde'};
