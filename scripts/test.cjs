const {spawn}=require('node:child_process');const path=require('node:path'),fs=require('node:fs');
const tests=fs.readdirSync(path.join(__dirname,'..','tests')).filter(n=>n.endsWith('.test.mjs')).map(n=>path.join(__dirname,'..','tests',n));
const child=spawn(require('electron'),['--test',...tests],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true});child.on('exit',code=>process.exit(code??1));
