import {ensure,integer} from './money.mjs';
export const VFD_DEFAULTS={enabled:false,port:'COM3',baudRate:9600,dataBits:8,parity:'None',stopBits:'One',handshake:'None',dtrEnable:false,rtsEnable:false,protocol:'epson'};
export function validateVfd(value){
  const c={...VFD_DEFAULTS,...value};
  ensure(typeof c.enabled==='boolean'&&typeof c.dtrEnable==='boolean'&&typeof c.rtsEnable==='boolean','Activation VFD invalide.');
  ensure(/^COM[1-9]\d{0,2}$/.test(c.port),'Choisissez un port COM de 1 à 999.');
  ensure([1200,2400,4800,9600,19200,38400,57600,115200].includes(c.baudRate),'Vitesse VFD invalide.');
  ensure([7,8].includes(c.dataBits)&&['None','Even','Odd'].includes(c.parity)&&['One','Two'].includes(c.stopBits)&&['None','RequestToSend','XOnXOff','RequestToSendXOnXOff'].includes(c.handshake),'Paramètres série invalides.');
  ensure(['epson','text'].includes(c.protocol),'Protocole VFD invalide.');
  return Object.fromEntries(Object.keys(VFD_DEFAULTS).map(k=>[k,c[k]]));
}
export const vfdLine=value=>String(value??'').replace(/œ/g,'oe').replace(/Œ/g,'OE').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\x20-\x7e]/g,'').slice(0,20).padEnd(20,' ');
export const vfdMoney=value=>(integer(value,'Montant VFD',0,Number.MAX_SAFE_INTEGER)/1000).toFixed(3)+' DT';
export function vfdPacket(lines,protocol='epson'){
  const [a,b]=lines.map(vfdLine);ensure(a&&b,'Deux lignes sont nécessaires.');
  if(protocol==='text')return Buffer.from(a+'\r\n'+b,'ascii');
  ensure(protocol==='epson','Protocole VFD invalide.');
  return Buffer.concat([Buffer.from([12,31,1,31,36,1,1]),Buffer.from(a,'ascii'),Buffer.from([31,36,1,2]),Buffer.from(b,'ascii')]);
}
export class VfdDisplay{
  constructor(transport,{demo=false}={}){this.transport=transport;this.tail=Promise.resolve();this.state={connected:false,demo,lines:['',''],error:null,lastSent:null};}
  status(){return {...this.state,lines:[...this.state.lines]};}
  ports(){return this.transport.ports();}
  configure(){this.state.connected=false;this.state.error=null;this.tail=this.tail.then(()=>this.transport.close()).catch(error=>{this.state.error=error.message;});return this.tail;}
  show(config,lines){
    if(!config.enabled)return Promise.resolve(this.status());
    const clean=lines.map(vfdLine);
    this.tail=this.tail.then(async()=>{this.state.lines=clean;try{await this.transport.write(config,vfdPacket(clean,config.protocol));this.state.connected=true;this.state.error=null;this.state.lastSent=new Date().toISOString();}catch(error){this.state.connected=false;this.state.error=error.message;}});
    return this.tail.then(()=>this.status());
  }
  total(config,sale){return this.show(config,['TOTAL A PAYER',vfdMoney(sale.total)]);}
}
