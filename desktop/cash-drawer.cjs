const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const path=require('node:path');

const runCommand=promisify(execFile);
const nativeSource=String.raw`
using System;
using System.Runtime.InteropServices;
public static class SamuraiPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
  }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int StartDocPrinter(IntPtr handle, int level, [In] DOCINFO info);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr handle, [In] byte[] bytes, int count, out int written);
}`;

function drawerCommand(printerName,pin=2){
  if(typeof printerName!=='string'||!printerName.trim()||printerName.length>200)throw Error('Choisissez une imprimante pour le tiroir-caisse.');
  if(![2,5].includes(pin))throw Error('Connecteur de tiroir invalide.');
  const name=Buffer.from(printerName,'utf8').toString('base64');
  const pulse=pin===2?0:1;
  const script=`$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${nativeSource}\n'@\n$printerName=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${name}'))\n$handle=[IntPtr]::Zero\nif(-not [SamuraiPrinter]::OpenPrinter($printerName,[ref]$handle,[IntPtr]::Zero)){throw 'Imprimante du tiroir indisponible.'}\ntry {\n  $doc=New-Object SamuraiPrinter+DOCINFO\n  $doc.pDocName='Samurai POS - tiroir caisse'\n  $doc.pDatatype='RAW'\n  if([SamuraiPrinter]::StartDocPrinter($handle,1,$doc) -eq 0){throw 'Le pilote refuse la commande du tiroir.'}\n  try {\n    if(-not [SamuraiPrinter]::StartPagePrinter($handle)){throw 'Page de commande du tiroir refusée.'}\n    try {\n      [byte[]]$bytes=@(27,112,${pulse},25,250)\n      $written=0\n      if(-not [SamuraiPrinter]::WritePrinter($handle,$bytes,$bytes.Length,[ref]$written) -or $written -ne $bytes.Length){throw 'Commande du tiroir incomplète.'}\n    } finally { [void][SamuraiPrinter]::EndPagePrinter($handle) }\n  } finally { [void][SamuraiPrinter]::EndDocPrinter($handle) }\n} finally { [void][SamuraiPrinter]::ClosePrinter($handle) }`;
  return Buffer.from(script,'utf16le').toString('base64');
}

async function pulseDrawer(printerName,pin=2,run=runCommand){
  const encoded=drawerCommand(printerName,pin);
  const executable=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  try{await run(executable,['-NoProfile','-NonInteractive','-EncodedCommand',encoded],{windowsHide:true,timeout:10000,maxBuffer:128*1024});}
  catch(error){
    const detail=String(error.stderr||'');
    if(error.killed||error.signal)throw Error('Le tiroir ne répond pas. Vérifiez l’imprimante et le pilote.');
    if(detail.includes('Imprimante du tiroir indisponible'))throw Error('Imprimante du tiroir indisponible. Vérifiez son nom dans les paramètres.');
    if(detail.includes('Le pilote refuse')||detail.includes('Page de commande')||detail.includes('Commande du tiroir incomplète'))throw Error('Le pilote a refusé la commande du tiroir. Vérifiez sa compatibilité ESC/POS.');
    throw Error('Le tiroir-caisse n’a pas répondu. Vérifiez le port RJ11/RJ12 et le pilote.');
  }
  return {ok:true};
}

module.exports={drawerCommand,pulseDrawer};
