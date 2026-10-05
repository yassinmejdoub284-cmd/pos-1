const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'public');fs.mkdirSync(out,{recursive:true});
for(const [source,target] of [['online.html','index.html'],['cloud-ui.mjs','online.js'],['dashboard-period.mjs','dashboard-period.mjs'],['online.css','online.css'],['ui.mjs','ui.mjs'],['styles.css','styles.css'],['theme.css','theme.css']])fs.copyFileSync(path.join(root,'frontend',source),path.join(out,target));
console.log('Tableau de bord web construit : public/ ; synchronisation via /sync.');
