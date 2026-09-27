const {spawn}=require('node:child_process'),{readFileSync}=require('node:fs'),path=require('node:path'),readline=require('node:readline');
class SerialTransport{
  constructor(){this.pending=new Map();this.sequence=0;this.child=null;}
  start(){
    if(this.child)return;
    const script=readFileSync(path.join(__dirname,'vfd-helper.ps1'),'utf8');
    const child=this.child=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let diagnostic='';child.stderr.on('data',data=>diagnostic=(diagnostic+data.toString()).slice(-1000));
    const fail=message=>{if(this.child===child)this.child=null;for(const [id,p] of this.pending){if(p.child!==child)continue;clearTimeout(p.timer);p.reject(new Error(message));this.pending.delete(id);}};
    readline.createInterface({input:child.stdout}).on('line',line=>{try{const value=JSON.parse(line),p=this.pending.get(value.id);if(!p)return;this.pending.delete(value.id);clearTimeout(p.timer);value.ok?p.resolve(value):p.reject(new Error(value.error||'Connexion VFD refusée.'));}catch{/* Only structured helper responses are accepted. */}});
    child.on('error',error=>fail(error.message));child.on('exit',()=>fail(diagnostic||'Connexion VFD interrompue.'));child.stdin.on('error',()=>{});
  }
  request(action,data={}){
    this.start();const id=++this.sequence,child=this.child;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('L’afficheur ne répond pas. Vérifiez le port COM.'));if(this.child===child)this.stop();},6000);this.pending.set(id,{resolve,reject,timer,child});child.stdin.write(JSON.stringify({id,action,...data})+'\n',error=>{if(error){const p=this.pending.get(id);if(p){this.pending.delete(id);clearTimeout(timer);reject(error);}}});});
  }
  async ports(){return (await this.request('ports')).ports.sort((a,b)=>Number(a.slice(3))-Number(b.slice(3)));}
  write(config,bytes){return this.request('write',{config,bytes:bytes.toString('base64')});}
  close(){return this.child?this.request('close'):Promise.resolve();}
  stop(){const child=this.child;this.child=null;child?.kill();}
}
module.exports={SerialTransport};
