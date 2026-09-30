import {createHash} from 'node:crypto';
import {PostgresCloud} from '../backend/postgres-cloud.mjs';
import {adminToken,validAdminToken,secureEqual} from '../backend/cloud-auth.mjs';
import {ensure,PosError} from '../backend/money.mjs';
let cloud;
export function createHandler({env=process.env,getCloud=()=>cloud||=(new PostgresCloud(env.DATABASE_URL||env.POSTGRES_URL))}={}){
 return async(req,res)=>{
 const send=(status,data)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.end(JSON.stringify(data));};
 try{
 const url=new URL(req.url,'http://localhost'),route=(url.searchParams.get('route')||url.pathname.replace(/^\/api\/cloud\/?/,'')).replace(/^\//,'');
 const missing=[];if(!(env.DATABASE_URL||env.POSTGRES_URL))missing.push('DATABASE_URL');if(!env.SYNC_TOKEN||env.SYNC_TOKEN.length<24)missing.push('SYNC_TOKEN');if(!env.ADMIN_PASSWORD||env.ADMIN_PASSWORD.length<12)missing.push('ADMIN_PASSWORD');
 if(route==='health'&&req.method==='GET'){if(missing.length)return send(503,{ok:false,configured:false,missing});await getCloud().initialize();return send(200,{ok:true,configured:true,storage:'postgresql',version:'0.3.1'});}
 ensure(!missing.length,'Configurez dans Vercel : '+missing.join(', ')+'.',503);
 let body={};if(req.method==='POST'){ensure(req.headers['content-type']?.startsWith('application/json'),'JSON requis.',415);if(req.body!==undefined){ensure(Buffer.byteLength(typeof req.body==='string'?req.body:JSON.stringify(req.body))<=2_000_000,'Requête trop volumineuse.',413);body=typeof req.body==='string'?JSON.parse(req.body):req.body;}else{let raw='',size=0;for await(const chunk of req){size+=chunk.length;ensure(size<=2_000_000,'Requête trop volumineuse.',413);raw+=chunk;}body=JSON.parse(raw);}}
 ensure(body&&typeof body==='object'&&!Array.isArray(body),'Requête JSON invalide.');
 const authorization=req.headers.authorization||'',secret=env.ADMIN_PASSWORD+'\n'+env.SYNC_TOKEN;
 if(route==='sync'&&req.method==='POST'){ensure(secureEqual(authorization,'Bearer '+env.SYNC_TOKEN),'Clé incorrecte.',401);return send(200,await getCloud().sync(body));}
 if(route==='admin/login'&&req.method==='POST'){const valid=secureEqual(body.password,env.ADMIN_PASSWORD),ip=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0],id=createHash('sha256').update(ip).digest('hex');ensure(await getCloud().loginAttempt(id,valid),'Mot de passe incorrect.',401);return send(200,{token:adminToken(secret)});}
 ensure(validAdminToken(authorization.replace(/^Bearer /,''),secret),'Connexion requise.',401);
 if(route==='admin/data'&&req.method==='GET')return send(200,await getCloud().dashboard(Object.fromEntries(url.searchParams)));
 throw new PosError('Page introuvable.',404);
 }catch(e){const status=e instanceof PosError?e.status:e instanceof SyntaxError?400:503;send(status,{error:e instanceof PosError?e.message:e instanceof SyntaxError?'Requête JSON invalide.':'Base en ligne indisponible. Vérifiez DATABASE_URL dans Vercel.'});}
 };
}
export default createHandler();
