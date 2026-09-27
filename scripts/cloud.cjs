const {spawn}=require('node:child_process');const path=require('node:path');
const child=spawn(require('electron'),[path.join(__dirname,'..','backend','cloud.mjs')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true});child.on('exit',code=>process.exit(code??1));
