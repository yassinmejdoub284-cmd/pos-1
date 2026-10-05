const {contextBridge,ipcRenderer}=require('electron');
const actions=new Set(['setupStatus','setup','login','logout','bootstrap','saveEntity','reorderProducts','archiveEntity','openSession','sessionSummary','closeSession','sale','saleDetails','saleByRequest','configureStock','stockMovement','clearLocalHistory','voidSale','expense','clientPayment','supplierPayment','report','saveUser','saveSettings','sync','resolveConflict','printers','previewReceipt','printSale','printReport','closures','previewClosure','printClosure','backup','vfdPorts','saveVfd','testVfd','vfdProduct']);
contextBridge.exposeInMainWorld('pos',{call:(action,args={},token)=>{
  if(!actions.has(action))return Promise.reject(new Error('Opération inconnue.'));
  return ipcRenderer.invoke('pos:call',action,args,token);
}});
