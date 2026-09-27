import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from './database.mjs';
import {PosService} from './service.mjs';
import {SyncEngine} from './sync.mjs';
import {receiptHtml,reportHtml,closureHtml} from './receipts.mjs';
import {VfdDisplay} from './vfd.mjs';
import {seedDemo} from './demo.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');const port=Number(process.env.POS_PREVIEW_PORT||4178);
const store=openDatabase(process.env.POS_PREVIEW_DB||resolve(root,'data','preview.sqlite'));let syncToken='';
const service=new PosService(store,{vfd:new VfdDisplay({ports:async()=>[],write:async()=>{},close:async()=>{}},{demo:true}),testMode:true,receipt:receiptHtml,closureReceipt:closureHtml,printClosure:s=>({previewOnly:true,html:closureHtml(s,service.settings())}),printers:()=>[],saveSyncToken:v=>syncToken=v,printSale:()=>({previewOnly:true}),printReport:(r,s)=>({previewOnly:true,html:reportHtml(r,s)}),backup:()=>({cancelled:true})});
service.options.sync=new SyncEngine(service,()=>syncToken);await seedDemo(service);
const server=createServer(async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
    if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(req.headers.host))throw new Error('Hôte refusé.');
    const url=new URL(req.url,`http://127.0.0.1:${port}`);
    if(req.method==='POST'&&url.pathname==='/api'){
      if(req.headers['x-pos-request']!=='1'||!req.headers['content-type']?.startsWith('application/json'))throw new Error('Requête refusée.');
      if(req.headers.origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin))throw new Error('Origine refusée.');
      let raw='',size=0;for await(const chunk of req){size+=chunk.length;if(size>2_000_000)throw new Error('Requête trop volumineuse.');raw+=chunk;}const {action,args,token}=JSON.parse(raw);return send(200,await service.call(action,args,token));
    }
    if(req.method==='GET'){
      const name=url.pathname==='/'?'index.html':url.pathname.slice(1);if(!['index.html','app.mjs','ui.mjs','views.mjs','pagination.mjs','advanced.mjs','settlements.mjs','vfd.mjs','styles.css','theme.css'].includes(name))return send(404,{error:'Introuvable'});
      const file=resolve(root,'frontend',name);if(!existsSync(file))return send(404,{error:'Introuvable'});res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(readFileSync(file));
    }
    send(404,{error:'Introuvable'});
  }catch(error){send(error.status||400,{error:error.message,status:error.status||400});}
});
server.listen(port,'127.0.0.1',()=>console.log(`Aperçu de test : http://127.0.0.1:${port}`));
