import test from 'node:test';
import assert from 'node:assert/strict';
import drawer from '../desktop/cash-drawer.cjs';
import {openDatabase} from '../backend/database.mjs';
import {PosService} from '../backend/service.mjs';

test('commande tiroir Windows cible une imprimante précise et les broches 2 ou 5',async()=>{
  const printer='XP-80 `$(echo unsafe)';
  const pin2=Buffer.from(drawer.drawerCommand(printer,2),'base64').toString('utf16le');
  const pin5=Buffer.from(drawer.drawerCommand(printer,5),'base64').toString('utf16le');
  assert.ok(pin2.includes("[byte[]]$bytes=@(27,112,0,25,250)"));
  assert.ok(pin5.includes("[byte[]]$bytes=@(27,112,1,25,250)"));
  assert.ok(pin2.includes(Buffer.from(printer,'utf8').toString('base64')));
  assert.ok(!pin2.includes(printer));
  assert.throws(()=>drawer.drawerCommand('',2),/imprimante/);
  assert.throws(()=>drawer.drawerCommand('XP-80',3),/Connecteur/);
  let invoked=false;
  const result=await drawer.pulseDrawer('XP-80',2,async(executable,args,options)=>{invoked=true;assert.match(executable,/powershell\.exe$/i);assert.deepEqual(args.slice(0,3),['-NoProfile','-NonInteractive','-EncodedCommand']);assert.equal(options.windowsHide,true);});
  assert.equal(invoked,true);
  assert.deepEqual(result,{ok:true});
  await assert.rejects(drawer.pulseDrawer('XP-80',2,async()=>{throw {stderr:'Imprimante du tiroir indisponible'};}),/Imprimante du tiroir indisponible/);
});

test('réglages du tiroir conservés et bouton de test réservé aux paramètres',async()=>{
  const store=openDatabase(':memory:');let tested=0;
  const service=new PosService(store,{testDrawer:async()=>{tested++;return {ok:true};}});
  try{
    await service.call('setup',{name:'Admin',pin:'123456',company:'Test'});
    const admin=(await service.call('login',{name:'Admin',pin:'123456'})).token;
    assert.equal(service.settings().print.drawerEnabled,true);
    const original=service.settings();
    await service.call('saveSettings',{...original,print:{...original.print,drawerPrinter:'XP-80',drawerPin:5,drawerEnabled:true}},admin);
    assert.equal(service.settings().print.drawerPrinter,'XP-80');
    assert.equal(service.settings().print.drawerPin,5);
    await assert.rejects(service.call('saveSettings',{...original,print:{...original.print,drawerPin:3}},admin),/Connecteur/);
    await service.call('testDrawer',{},admin);
    assert.equal(tested,1);
    await service.call('saveUser',{name:'Caisse',pin:'654321',permissions:['sell'],admin:false},admin);
    const cashier=(await service.call('login',{name:'Caisse',pin:'654321'})).token;
    await assert.rejects(service.call('testDrawer',{},cashier),/permission/);
  }finally{store.db.close();}
});
