import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,createHmac} from 'node:crypto';
import {canonical} from '../backend/fiscal-integrity.mjs';
export function verifyArchive(archive,key){
  if(!archive||archive.format!=='samurai-fiscal-archive-1')throw Error('Format d’archive inconnu.');
  const {sha256,hmac,...data}=archive;
  if(createHash('sha256').update(canonical(data)).digest('hex')!==sha256)throw Error('Checksum SHA-256 incorrect.');
  if(key){
    if(key.length!==32)throw Error('La clé de vérification doit contenir 32 octets bruts (pas le fichier Windows chiffré).');
    const mac=v=>createHmac('sha256',key).update(canonical(v)).digest('hex');
    if(mac(data)!==hmac)throw Error('HMAC de l’archive incorrect.');
    let previous=data.chainPredecessor,seq=(data.integrity[0]?.seq||1)-1;
    for(const r of data.integrity){
      if(r.seq!==++seq||r.previous!==previous||mac({seq:r.seq,kind:r.kind,ref:r.ref,data:JSON.parse(r.data),createdAt:r.created_at,previous:r.previous})!==r.digest)throw Error('Piste d’intégrité de l’archive incorrecte.');
      previous=r.digest;
    }
    if(data.integrity.length&&previous!==data.head)throw Error('Tête de chaîne incorrecte.');
  }
  return {checksum:true,authenticated:!!key,year:data.year,documents:data.documents.length,auditEntries:data.legacyAudit.length};
}
if(process.argv[1]&&import.meta.url===new URL('file:'+process.argv[1]).href){
  try{
    const args=process.argv.slice(2),file=args[0];if(!file)throw Error('Usage: node scripts/verify-fiscal-archive.mjs ARCHIVE.json [--key-file CLE_BRUTE] [--audit-out MF_IMDF_MAC.txt]');
    const option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
    const archive=JSON.parse(readFileSync(file,'utf8')),keyPath=option('--key-file'),result=verifyArchive(archive,keyPath?readFileSync(keyPath):null);
    const auditOut=option('--audit-out');if(auditOut)writeFileSync(auditOut,archive.auditText,{flag:'wx',mode:0o600});
    console.log(JSON.stringify(result));if(!keyPath)console.log('Checksum uniquement : aucune preuve d’authenticité sans vérification HMAC.');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
