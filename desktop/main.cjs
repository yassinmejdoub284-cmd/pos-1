const {app,BrowserWindow,ipcMain,dialog,safeStorage}=require('electron');
const path=require('node:path'),fs=require('node:fs');
let mainWindow,service,engine,printQueue,serialTransport;
app.setName('Samurai POS');
if(process.env.POS_DATA_DIR){fs.mkdirSync(process.env.POS_DATA_DIR,{recursive:true});app.setPath('userData',path.resolve(process.env.POS_DATA_DIR));}
const locked=app.requestSingleInstanceLock();if(!locked)app.quit();else{
app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.focus();}});
app.whenReady().then(async()=>{
  const {openDatabase}=await import('../backend/database.mjs');const {PosService}=await import('../backend/service.mjs');const {SyncEngine}=await import('../backend/sync.mjs');const {PrintQueue}=await import('../backend/print-queue.mjs');const {receiptHtml,reportHtml,closureHtml}=await import('../backend/receipts.mjs');
  const dataDir=process.env.POS_DATA_DIR||app.getPath('userData');fs.mkdirSync(dataDir,{recursive:true});const store=openDatabase(path.join(dataDir,'samurai-pos.sqlite'));const keyPath=path.join(dataDir,'sync-key.bin');
  const getToken=()=>{try{return safeStorage.isEncryptionAvailable()&&fs.existsSync(keyPath)?safeStorage.decryptString(fs.readFileSync(keyPath)):'';}catch{return '';}};
  const saveSyncToken=token=>{if(!safeStorage.isEncryptionAvailable())throw new Error('Le stockage protégé de Windows est indisponible.');fs.writeFileSync(keyPath,safeStorage.encryptString(token));};
  const printers=async()=>mainWindow.webContents.getPrintersAsync();
  async function printHtml(html,deviceName,copies=1){
    if(deviceName){const list=await printers();if(!list.some(p=>p.name===deviceName))throw new Error(`Imprimante indisponible : ${deviceName}`);}
    const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    try{await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));await win.webContents.executeJavaScript('Promise.all([document.fonts.ready,...Array.from(document.images).map(img=>img.complete?Promise.resolve():new Promise(r=>{img.onload=r;img.onerror=r}))])');const pixels=await win.webContents.executeJavaScript('document.body.scrollHeight');const height=Math.max(60000,Math.min(1500000,Math.ceil(pixels*264.583)+8000));
      await new Promise((resolve,reject)=>win.webContents.print({silent:true,deviceName,printBackground:true,copies,pageSize:{width:80000,height},margins:{marginType:'none'},scaleFactor:100},(ok,error)=>ok?resolve():reject(new Error(error||'L’imprimante a refusé le ticket.'))));
      return {ok:true};
    }finally{win.destroy();}
  }
  const runPrintJobs=()=>printQueue.drain();
  const {VfdDisplay}=await import('../backend/vfd.mjs');const {SerialTransport}=require('./vfd.cjs');serialTransport=new SerialTransport();const vfd=new VfdDisplay(serialTransport);
  service=new PosService(store,{vfd,testMode:!!process.env.POS_TEST_MODE,printers,saveSyncToken,receipt:receiptHtml,closureReceipt:closureHtml,
    printSale:(sale,kind)=>printQueue.printSale(sale,kind),
    printClosure:session=>printQueue.printClosure(session),
    printReport:(report,settings)=>printHtml(reportHtml(report,settings),settings.print.clientPrinter),
    backup:async()=>{const result=await dialog.showSaveDialog(mainWindow,{title:'Sauvegarder la base de caisse',defaultPath:`Samurai-POS-${new Date().toISOString().slice(0,10)}.sqlite`,filters:[{name:'Base SQLite',extensions:['sqlite']}]});if(result.canceled)return {cancelled:true};if(path.resolve(result.filePath).toLowerCase()===path.resolve(store.path).toLowerCase())throw new Error('Choisissez un autre fichier que la base active.');if(fs.existsSync(result.filePath))throw new Error('Choisissez un nouveau nom pour conserver la sauvegarde existante.');store.db.prepare('VACUUM INTO ?').run(result.filePath);return {path:result.filePath};}
  });
  engine=new SyncEngine(service,getToken);service.options.sync=engine;
  printQueue=new PrintQueue(service,{receiptHtml,closureHtml,printHtml});printQueue.recover();
  mainWindow=new BrowserWindow({show:!process.env.POS_SMOKE_OUTPUT,width:1480,height:960,minWidth:1000,minHeight:700,title:'Samurai POS',backgroundColor:'#f6f7fb',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  let signalReady;const rendererReady=new Promise(resolve=>signalReady=resolve);
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));mainWindow.webContents.on('will-navigate',event=>event.preventDefault());
  ipcMain.handle('pos:call',async(event,action,args,token)=>{
    if(event.sender!==mainWindow.webContents)return {error:'Accès refusé.',status:403};
    try{if(JSON.stringify(args).length>2_000_000)throw new Error('Requête trop volumineuse.');const result=await service.call(action,args,token);if(action==='setupStatus')signalReady(result);if(action==='sale'||action==='closeSession')void runPrintJobs();return result;}catch(error){return {error:error.message,status:error.status||400};}
  });
  const settings=service.settings();if(!settings.print.clientPrinter&&!settings.print.kitchenPrinter){try{const list=await printers();const physical=list.filter(p=>!/(pdf|onenote|fax|xps)/i.test(p.name));if(physical.length===1){settings.print.clientPrinter=physical[0].name;settings.print.kitchenPrinter=physical[0].name;store.put('settings',JSON.stringify(settings));}}catch{/* Printer discovery must not prevent offline sales. */}}
  await mainWindow.loadFile(path.join(__dirname,'..','frontend','index.html'));
  if(process.env.POS_SMOKE_OUTPUT){const ready=await Promise.race([rendererReady,new Promise((_,reject)=>setTimeout(()=>reject(new Error('La fenêtre n’a pas contacté le moteur de caisse.')),10000))]);fs.writeFileSync(process.env.POS_SMOKE_OUTPUT,JSON.stringify({ready,version:app.getVersion(),printers:(await printers()).map(p=>({name:p.name,status:p.status})),selectedPrinter:service.settings().print.clientPrinter,vfdPorts:await vfd.ports(),vfdEnabled:service.settings().vfd.enabled}));store.db.close();return app.quit();}
  engine.start();void runPrintJobs();
});
app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>{engine?.stop();serialTransport?.stop();});
}
