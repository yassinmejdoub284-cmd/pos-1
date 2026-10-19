import {PosError,ensure} from './money.mjs';
export const NACEF_PATHS={manifest:'/manifest',certificate:'/certificate/request',sync:'/sync/request',sign:'/sign/request',log:'/log/'};
export class NacefError extends PosError {
  constructor(message,{httpStatus=503,errorCode=null,ambiguous=false}={}){super(message,httpStatus);Object.assign(this,{errorCode,ambiguous});}
}
export function agentURL(value){
  const u=new URL(value);
  ensure(!u.username&&!u.password&&!u.search&&!u.hash,'URL S-MDF invalide.');
  ensure(u.pathname.replace(/\/$/,'')==='/sic/external','Le chemin S-MDF doit être /sic/external.');
  ensure(u.protocol==='https:'||(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)),'S-MDF : HTTP uniquement sur ce poste ; HTTPS requis à distance.');
  return u.href.replace(/\/$/,'');
}
export function unwrapResponse(body){
  ensure(body&&typeof body==='object'&&!Array.isArray(body),'Réponse S-MDF non structurée.');
  const key=Object.hasOwn(body,'object')?'object':Object.hasOwn(body,'objet')?'objet':null;
  if(body.errorCode!==undefined&&body.errorCode!==null&&body.errorCode!==0&&body.errorCode!=='0')throw new NacefError(body.message||'Erreur S-MDF.',{errorCode:body.errorCode,httpStatus:400});
  return key?body[key]:body;
}
export function manifestState(m){
  const states={0:'FACTORY',2:'CERT_REQUESTED',3:'SUSPENDED',4:'NOT_SYNCHRONIZED',5:'SYNCHRONIZED',6:'SYNCHRONIZATION_IN_PROGRESS'};
  const raw=String(m?.status??'UNKNOWN').trim();
  return states[raw]||raw;
}
export function assertCanSign(m){
  ensure(['ONLINE','OFFLINE'].includes(String(m?.state).toUpperCase()),'Mode de communication S-MDF inconnu.',423);
  if(m?.maintenanceEnabled)throw new PosError('Caisse en maintenance : synchronisez après intervention.',423);
  if(m?.certificateInfo?.revoked)throw new PosError('Certificat révoqué : une nouvelle demande est nécessaire.',423);
  if(m?.certificateInfo?.expired||(m?.certificateInfo?.expirationDate&&Date.parse(m.certificateInfo.expirationDate)<=Date.now()))throw new PosError('Certificat expiré : renouvelez le certificat.',423);
  const state=manifestState(m);
  const messages={FACTORY:'Obtenez un certificat électronique avant toute transaction.',CERT_REQUESTED:'Demande déposée : attendez la génération du certificat.',SUSPENDED:'Caisse suspendue par NACEF.',NOT_SYNCHRONIZED:'Synchronisez la caisse avec NACEF avant toute transaction.',SYNCHRONIZATION_IN_PROGRESS:'Synchronisation en cours. Attendez sa fin.'};
  ensure(state==='SYNCHRONIZED',messages[state]||'État S-MDF inconnu : transaction bloquée.',423);
  ensure(m?.certificateInfo&&Number.isFinite(Date.parse(m.certificateInfo.expirationDate)),'Certificat électronique absent ou non vérifiable.',423);
  ensure(!m?.certificateInfo||['CERTIFICATE_GENERATED',undefined].includes(m.certificateInfo.certRequestStatus),'Certificat électronique non généré.',423);
  ensure(!['OFFLINE','Offline'].includes(m.state)||(Number.isInteger(m.availableOfflineTickets)&&m.availableOfflineTickets>0),'Quota de tickets hors ligne épuisé. Synchronisez la caisse.',423);
}
export function qrDataURL(value){
  let b;
  if(typeof value==='string'){
    const raw=value.replace(/^data:image\/(?:png|jpeg);base64,/,'');
    ensure(/^[A-Za-z0-9+/]+={0,2}$/.test(raw)&&raw.length%4===0,'QR S-MDF invalide.');b=Buffer.from(raw,'base64');
  }else if(Array.isArray(value)&&value.every(x=>Number.isInteger(x)&&x>=-128&&x<=255))b=Buffer.from(value);
  else if(Array.isArray(value)&&value.length===1&&typeof value[0]==='string')return qrDataURL(value[0]);
  else throw new NacefError('Encodage QR S-MDF non reconnu.');
  ensure(b.length>8&&b.length<1_500_000,'Image QR S-MDF invalide.');
  const png=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=b[0]===255&&b[1]===216&&b[2]===255;
  ensure(png||jpeg,'Le QR S-MDF doit être une image PNG ou JPEG.');
  return `data:image/${png?'png':'jpeg'};base64,${b.toString('base64')}`;
}
export class NacefClient {
  constructor(baseURL,{fetchImpl=globalThis.fetch,timeout=120000}={}){this.baseURL=agentURL(baseURL);this.fetch=fetchImpl;this.timeout=timeout;}
  async call(operation,payload){
    let response,body;
    try{
      response=await this.fetch(this.baseURL+NACEF_PATHS[operation],{method:operation==='manifest'?'GET':'POST',headers:{Accept:'application/json',...(payload===undefined?{}:{'Content-Type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(operation==='manifest'?Math.min(this.timeout,10000):this.timeout),redirect:'error'});
      if(response.status===401)throw new NacefError('S-MDF non autorisé : obtenez ou synchronisez le certificat.',{httpStatus:423,errorCode:401});
      const raw=await response.text();if(raw.length>3_000_000)throw Error('Réponse trop volumineuse.');body=JSON.parse(raw);
    }catch(error){if(error instanceof NacefError)throw error;throw new NacefError(operation==='sign'?'Réponse de signature inconnue. Ne renvoyez pas ce ticket : contrôlez son état avec le support NACEF.':`S-MDF injoignable ou réponse invalide (${error.name}).`,{ambiguous:operation==='sign'});}
    if(response.status===401)throw new NacefError('S-MDF non autorisé : obtenez ou synchronisez le certificat.',{httpStatus:423,errorCode:401});
    if(!response.ok)throw new NacefError(body?.message||`Erreur S-MDF HTTP ${response.status}.`,{httpStatus:response.status>=500?503:400,errorCode:body?.errorCode,ambiguous:operation==='sign'&&response.status>=500});
    try{return unwrapResponse(body);}catch(error){if(operation==='sign'&&!(error instanceof NacefError))error.ambiguous=true;throw error;}
  }
}
