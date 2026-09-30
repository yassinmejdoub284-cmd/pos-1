import { randomUUID, randomBytes, pbkdf2Sync, timingSafeEqual, createHash } from 'node:crypto';
import { ensure, integer, label, dayInTunis, PosError } from './money.mjs';
import {VFD_DEFAULTS,validateVfd,vfdMoney} from './vfd.mjs';
import {buildReport,reportFilters} from './reporting.mjs';

export const PERMISSIONS = ['suppliers','sell','discount','void','catalog','clients','expenses','reports','close','users','settings','sync','backup'];
export const DEFAULT_SETTINGS = {
  company: { name: 'Mon établissement', address: '', phone: '', taxId: '', footer: 'Merci pour votre visite !' },
  print: { clientPrinter: '', kitchenPrinter: '', autoPrint: true, kitchen: true, closure: true, clientComments: false, kitchenComments: true, showClient: true, showLogo: false, logo: '', copies: 1 },
  maxDiscountPercent: 20, varianceThreshold: 5000,
  vfd: VFD_DEFAULTS,
  sync: { enabled: false, endpoint: '', intervalMinutes: 20 },
};
const parse = value => JSON.parse(value);
const now = () => new Date().toISOString();
const hashPin = (pin, salt) => pbkdf2Sync(pin, salt, 150000, 32, 'sha256').toString('hex');
const safeUser = row => ({ id: row.id, name: row.name, permissions: parse(row.permissions), active: !!row.active, admin: !!row.admin });
const text = (value, max=500) => typeof value === 'string' ? value.trim().slice(0,max) : '';

export class PosService {
  constructor(store, options={}) {
    Object.assign(this, store); this.tokens = new Map(); this.attempts = new Map(); this.options = options;
    if (!this.get('settings')) this.put('settings', JSON.stringify(DEFAULT_SETTINGS));
    if(!this.get('defaultsV2')){const settings=this.settings();settings.print={...DEFAULT_SETTINGS.print,...settings.print,autoPrint:true,kitchen:true,closure:true};this.put('settings',JSON.stringify(settings));this.put('defaultsV2','1');}
  }
  settings() { const saved=parse(this.get('settings'));return {...DEFAULT_SETTINGS,...saved,print:{...DEFAULT_SETTINGS.print,...saved.print},vfd:{...VFD_DEFAULTS,...saved.vfd}}; }
  audit(user, action, data={}) { this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?)').run(randomUUID(), user?.id || null, action, JSON.stringify(data), now()); }
  emit(type, payload) {
    const seq = Number(this.get('outboxSeq')) + 1; this.put('outboxSeq', seq);
    if (type === 'entity') this.db.prepare("UPDATE outbox SET state='superseded' WHERE type='entity' AND state='pending' AND json_extract(payload,'$.id')=?").run(payload.id);
    this.db.prepare('INSERT INTO outbox(id,seq,type,payload,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),seq,type,JSON.stringify(payload),now());
  }
  user(token) {
    const session = this.tokens.get(token);
    ensure(session && session.expires > Date.now(), 'Reconnectez-vous pour continuer.', 401);
    const row = this.db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(session.id);
    ensure(row, 'Compte désactivé.', 401); session.expires = Date.now() + 12*3600000;
    return safeUser(row);
  }
  require(user, permission) { ensure(user.admin || user.permissions.includes(permission), 'Vous ne disposez pas de cette permission.', 403); }
  entity(id,kind) {
    const row = this.db.prepare('SELECT * FROM entities WHERE id=? AND active=1').get(id);
    ensure(row && (!kind || row.kind===kind), 'Élément introuvable ou désactivé.');
    return { ...parse(row.data), id:row.id, kind:row.kind, revision:row.revision, active:true };
  }
  entities(kind) { const rows=this.db.prepare('SELECT * FROM entities WHERE kind=? ORDER BY json_extract(data,\'$.name\') COLLATE NOCASE').all(kind).map(r=>({...parse(r.data),id:r.id,revision:r.revision,active:!!r.active}));return kind==='product'?rows.sort((a,b)=>(a.sortOrder??100000)-(b.sortOrder??100000)||a.name.localeCompare(b.name,'fr')):rows; }
  currentSession(user) { const row=this.db.prepare('SELECT * FROM sessions WHERE user_id=? AND closed_at IS NULL').get(user.id); return row ? this.sessionData(row) : null; }
  sessionData(row) { return {...parse(row.data), id:row.id,userId:row.user_id,openedAt:row.opened_at,closedAt:row.closed_at,opening:row.opening,closing:row.closing,expected:row.expected,variance:row.variance}; }
  sessionRequired(user) { const session=this.currentSession(user); ensure(session,'Ouvrez votre session de caisse avant cette opération.'); return session; }
  async call(action, args={}, token) {
    ensure(args && typeof args==='object' && !Array.isArray(args), 'Requête invalide.');
    if (action==='setupStatus') return { needsSetup: !this.db.prepare('SELECT 1 FROM users LIMIT 1').get(), deviceId:this.get('deviceId'), testMode:!!this.options.testMode };
    if (action==='setup') return this.setup(args);
    if (action==='login') return this.login(args);
    if (action==='logout') { this.tokens.delete(token); return {ok:true}; }
    const user=this.user(token);
    const actions = {
      bootstrap:()=>this.bootstrap(user),
      saveEntity:()=>{this.require(user,args.kind==='supplier'?'suppliers':args.kind==='client'?'clients':args.kind==='expenseCategory'?'expenses':'catalog');return this.saveEntity(args,user);},
      reorderProducts:()=>{this.require(user,'catalog');return this.reorderProducts(args,user);},
      archiveEntity:()=>{this.require(user,args.kind==='supplier'?'suppliers':args.kind==='client'?'clients':args.kind==='expenseCategory'?'expenses':'catalog');return this.archiveEntity(args,user);},
      openSession:()=>{this.require(user,'sell');return this.openSession(args,user);},
      sessionSummary:()=>{this.require(user,'sell');const s=this.sessionRequired(user);return this.cashSummary(s.id);},
      closeSession:()=>{this.require(user,'close');return this.closeSession(args,user);},
      sale:()=>{this.require(user,'sell');const sale=this.createSale(args,user);if(args.print??this.settings().print.autoPrint)void this.options.vfd?.total(this.settings().vfd,sale);return sale;},
      saleByRequest:()=>{this.require(user,'sell');const requestId=label(args.requestId,'Identifiant de vente',100);const row=this.db.prepare('SELECT id FROM sales WHERE request_id=?').get(requestId);return row?this.saleDetails(row.id,user):null;},
      saleDetails:()=>this.saleDetails(args.id,user),
      voidSale:()=>{this.require(user,'void');return this.voidSale(args,user);},
      expense:()=>{this.require(user,'expenses');return this.createExpense(args,user);},
      clientPayment:()=>{this.require(user,'clients');return this.clientPayment(args,user);},
      supplierPayment:()=>{this.require(user,'suppliers');return this.supplierPayment(args,user);},
      report:()=>{this.require(user,'reports');return this.report(args);},
      closures:()=>this.closures(args,user),
      previewClosure:()=>this.options.closureReceipt?.(this.closureDetails(args.id,user),this.settings()),
      printClosure:()=>this.options.printClosure?.(this.closureDetails(args.id,user)),
      saveUser:()=>{this.require(user,'users');return this.saveUser(args,user);},
      saveSettings:()=>{this.require(user,'settings');return this.saveSettings(args,user);},
      sync:()=>{this.require(user,'sync');ensure(this.options.sync,'Synchronisation indisponible.');return this.options.sync.run();},
      resolveConflict:()=>{this.require(user,'sync');return this.options.sync.resolve(args);},
      printers:()=>{this.require(user,'settings');return this.options.printers?.() || [];},
      previewReceipt:()=>this.options.receipt?.(this.saleDetails(args.id,user), args.kind || 'client', this.settings()),
      printSale:()=>{this.require(user,'sell');const sale=this.saleDetails(args.id,user);void this.options.vfd?.total(this.settings().vfd,sale);return this.options.printSale?.(sale,args.kind);},
      printReport:()=>{this.require(user,'reports');const settings={...this.settings(),filterNames:Object.fromEntries(this.db.prepare('SELECT id,data FROM entities').all().map(r=>[r.id,parse(r.data).name]).concat(this.db.prepare('SELECT id,name FROM users').all().map(r=>[r.id,r.name])))};return this.options.printReport?.(this.report(args),settings);},
      vfdPorts:()=>{this.require(user,'settings');return this.options.vfd?.ports()||[];},
      saveVfd:async()=>{this.require(user,'settings');const vfd=validateVfd(args);const settings=this.settings();settings.vfd=vfd;this.put('settings',JSON.stringify(settings));this.audit(user,'vfd.settings');await this.options.vfd?.configure();return vfd;},
      testVfd:()=>{this.require(user,'settings');ensure(this.settings().vfd.enabled,'Activez et enregistrez l’afficheur avant le test.');ensure(this.options.vfd,'Afficheur disponible uniquement dans l’application bureau.');return this.options.vfd.show(this.settings().vfd,['TEST AFFICHEUR','7.000 DT']);},
      vfdProduct:()=>{this.require(user,'sell');if(!this.settings().vfd.enabled)return this.options.vfd?.status()||{};const p=this.entity(args.productId,'product');ensure(Array.isArray(args.supplements||[])&&(args.supplements||[]).length<=30,'Suppléments invalides.');const extras=[...new Set(args.supplements||[])].map(id=>{const s=this.entity(id,'supplement');ensure(!s.productIds.length||s.productIds.includes(p.id),'Supplément incompatible.');return s.price;});return this.options.vfd?.show(this.settings().vfd,[p.name,vfdMoney(p.price+extras.reduce((a,b)=>a+b,0))])||{};},
      backup:()=>{this.require(user,'backup');ensure(this.options.backup,'Sauvegarde indisponible.');return this.options.backup();},
    };
    ensure(Object.hasOwn(actions,action),'Opération inconnue.',404);
    return await actions[action]();
  }
  setup(args) {
    ensure(!this.db.prepare('SELECT 1 FROM users LIMIT 1').get(),'L’établissement est déjà configuré.');
    const name=label(args.name,'Identifiant',60); const pin=this.validatePin(args.pin); const salt=randomBytes(24).toString('hex');
    return this.transaction(()=>{
      const id=randomUUID(); this.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(id,name,hashPin(pin,salt),salt,JSON.stringify(PERMISSIONS),1,1);
      const settings=this.settings();settings.company.name=label(args.company,'Établissement');this.put('settings',JSON.stringify(settings));
      this.emit('company',settings.company);this.audit({id},'setup'); return {ok:true};
    });
  }
  validatePin(pin) { ensure(typeof pin==='string' && /^\d{6,12}$/.test(pin),'Le code doit contenir entre 6 et 12 chiffres.'); return pin; }
  login(args) {
    const name=text(args.name,60).toLowerCase(); const attempt=this.attempts.get(name) || {count:0,until:0};
    ensure(attempt.until<Date.now(),'Trop de tentatives. Réessayez dans 5 minutes.',429);
    const row=this.db.prepare('SELECT * FROM users WHERE name=? COLLATE NOCASE AND active=1').get(name);
    const valid = row && typeof args.pin==='string' && args.pin.length<=12 && timingSafeEqual(Buffer.from(hashPin(args.pin,row.salt),'hex'),Buffer.from(row.hash,'hex'));
    if (!valid) { attempt.count++;if(attempt.count>=5){attempt.until=Date.now()+300000;attempt.count=0;}this.attempts.set(name,attempt);throw new PosError('Identifiant ou code incorrect.',401); }
    this.attempts.delete(name);const token=randomBytes(32).toString('hex');this.tokens.set(token,{id:row.id,expires:Date.now()+12*3600000});
    this.audit(safeUser(row),'login');return {token,user:safeUser(row)};
  }
  bootstrap(user) {
    const settings=this.settings();const allowed = p=>user.admin||user.permissions.includes(p);
    const session=this.currentSession(user);
    const sales=this.db.prepare(`SELECT * FROM sales ${allowed('reports')?'':'WHERE user_id=?'} ORDER BY created_at DESC LIMIT 100`).all(...(allowed('reports')?[]:[user.id])).map(r=>({...parse(r.data),voidedAt:r.voided_at,voidReason:r.void_reason}));
    return { user, settings, vfd:this.options.vfd?.status()||{connected:false,lines:['','']}, deviceId:this.get('deviceId'), testMode:!!this.options.testMode,
      catalog:Object.fromEntries(['family','product','supplement','comment','expenseCategory','client','supplier'].map(kind=>[kind,this.entities(kind)])),
      session, cash:session ? this.cashSummary(session.id):null, sales,
      expenses:allowed('expenses')?this.db.prepare('SELECT * FROM expenses ORDER BY created_at DESC LIMIT 100').all().map(r=>({...parse(r.data),id:r.id,amount:r.amount,source:r.source,createdAt:r.created_at,day:r.day})):[],
      users:allowed('users')?this.db.prepare('SELECT * FROM users ORDER BY name').all().map(safeUser):[],
      reportUsers:allowed('reports')?this.db.prepare('SELECT id,name FROM users ORDER BY name').all():[],
      sessions:allowed('reports')?this.db.prepare('SELECT * FROM sessions ORDER BY opened_at DESC LIMIT 100').all().map(r=>this.sessionData(r)):[],
      clientBalances:allowed('clients')||allowed('sell')?this.clientBalances():{},
      clientPayments:allowed('clients')?this.db.prepare('SELECT p.*,e.data client,u.name userName FROM client_payments p JOIN entities e ON p.client_id=e.id JOIN users u ON p.user_id=u.id ORDER BY p.created_at DESC LIMIT 100').all().map(r=>({id:r.id,clientId:r.client_id,clientName:parse(r.client).name,userName:r.userName,amount:r.amount,method:r.method,createdAt:r.created_at})):[],
      supplierBalances:allowed('suppliers')||allowed('expenses')?this.supplierBalances():{},
      supplierPayments:allowed('suppliers')?this.db.prepare('SELECT data FROM supplier_payments ORDER BY created_at DESC LIMIT 100').all().map(r=>parse(r.data)):[],
      sync:allowed('sync')?{pending:this.db.prepare("SELECT COUNT(*) n FROM outbox WHERE state='pending'").get().n,lastSuccess:this.get('syncLastSuccess')||null,error:this.get('syncLastError')||null,conflicts:this.db.prepare('SELECT * FROM sync_conflicts').all().map(r=>({...parse(r.data),id:r.id})),running:!!this.options.sync?.running}:null,
      printJobs:this.db.prepare("SELECT j.* FROM print_jobs j JOIN sales s ON j.sale_id=s.id WHERE s.user_id=? AND j.state!='done' ORDER BY j.created_at DESC LIMIT 30").all(user.id),
      closurePrintJobs:this.db.prepare("SELECT j.* FROM closure_print_jobs j JOIN sessions s ON j.session_id=s.id WHERE s.user_id=? AND j.state!='done' ORDER BY j.created_at DESC LIMIT 30").all(user.id),
      lastClosure:this.db.prepare('SELECT * FROM sessions WHERE user_id=? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1').all(user.id).map(r=>this.sessionData(r))[0]||null,
      supplierTotals:allowed('suppliers')?Object.fromEntries(this.db.prepare("SELECT json_extract(data,'$.supplierId') id,SUM(amount) amount FROM expenses GROUP BY id").all().filter(r=>r.id).map(r=>[r.id,r.amount])):{},
      permissions:PERMISSIONS,
    };
  }
  saveEntity(args,user) {
    ensure(['family','product','supplement','comment','expenseCategory','client','supplier'].includes(args.kind),'Type invalide.');
    const {kind}=args;const data={name:label(args.data?.name),color:text(args.data?.color,20)||'#4f46e5'};
    ensure(/^#[0-9a-f]{6}$/i.test(data.color),'Couleur invalide.');
    if(kind==='product') {data.familyId=this.entity(args.data.familyId,'family').id;data.price=integer(args.data.price,'Prix',0);data.kitchenName=text(args.data.kitchenName,120);data.sku=text(args.data.sku,60);data.emoji=text(args.data.emoji,8)||'◉';}
    if(kind==='supplement') {data.price=integer(args.data.price,'Prix',0);data.productIds=Array.isArray(args.data.productIds)?[...new Set(args.data.productIds)]:[];data.productIds.forEach(id=>this.entity(id,'product'));}
    if(kind==='comment') {data.productIds=Array.isArray(args.data.productIds)?[...new Set(args.data.productIds)]:[];data.productIds.forEach(id=>this.entity(id,'product'));data.client=!!args.data.client;data.kitchen=args.data.kitchen!==false;}
    if(kind==='supplier'){Object.assign(data,{contact:text(args.data.contact,120),phone:text(args.data.phone,40),email:text(args.data.email,150),address:text(args.data.address,300),taxId:text(args.data.taxId,60),notes:text(args.data.notes,500)});ensure(!data.email||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email),'Adresse e-mail invalide.');}
    if(kind==='client') {data.phone=text(args.data.phone,40);data.address=text(args.data.address,300);data.creditLimit=integer(args.data.creditLimit||0,'Plafond de crédit');}
    const id=args.id||randomUUID();const previous=this.db.prepare('SELECT * FROM entities WHERE id=?').get(id);
    if(kind==='product')data.sortOrder=previous?parse(previous.data).sortOrder??this.entities('product').findIndex(p=>p.id===id):Math.max(-1,...this.entities('product').map(p=>p.sortOrder??0))+1;
    ensure(!previous||previous.kind===kind,'Type de fiche incorrect.');
    return this.transaction(()=>{
      const revision=previous?.revision||0;this.db.prepare('INSERT INTO entities VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,active=1').run(id,kind,JSON.stringify(data),revision,1);
      this.emit('entity',{id,kind,data,active:true,baseRevision:revision});this.audit(user,'entity.save',{id,kind});return {...data,id,active:true,revision};
    });
  }
  reorderProducts(args,user) {
    const products=this.entities('product').filter(p=>p.active),ids=args.ids;
    ensure(Array.isArray(ids)&&ids.length===products.length&&new Set(ids).size===ids.length&&ids.every(id=>products.some(p=>p.id===id)),'La liste des produits a changé. Rouvrez le réglage de l’ordre.');
    return this.transaction(()=>{ids.forEach((id,sortOrder)=>{const row=this.db.prepare('SELECT * FROM entities WHERE id=?').get(id),data=parse(row.data);if(data.sortOrder===sortOrder)return;data.sortOrder=sortOrder;this.db.prepare('UPDATE entities SET data=? WHERE id=?').run(JSON.stringify(data),id);this.emit('entity',{id,kind:'product',data,active:true,baseRevision:row.revision});});this.audit(user,'products.reorder',{ids});return {ok:true};});
  }
  archiveEntity(args,user) {
    const entity=this.entity(args.id,args.kind);
    if(args.kind==='family') ensure(!this.entities('product').some(p=>p.active&&p.familyId===args.id),'Déplacez ou désactivez les produits de cette famille avant de la désactiver.');
    if(args.kind==='client') ensure((this.clientBalances()[args.id]||0)===0,'Ce client a encore un solde à régler.');
    if(args.kind==='supplier') ensure((this.supplierBalances()[args.id]||0)===0,'Ce fournisseur a encore un solde à régler.');
    return this.transaction(()=>{this.db.prepare('UPDATE entities SET active=0 WHERE id=?').run(args.id);const {id,kind,revision,active,...data}=entity;this.emit('entity',{id,kind,data,active:false,baseRevision:revision});this.audit(user,'entity.archive',{id,kind});return {ok:true};});
  }
  openSession(args,user) {
    const opening=integer(args.opening,'Fond de caisse');ensure(!this.currentSession(user),'Votre session est déjà ouverte.');
    return this.transaction(()=>{const id=randomUUID(),openedAt=now();const data={userName:user.name};this.db.prepare('INSERT INTO sessions(id,user_id,opened_at,opening,data) VALUES (?,?,?,?,?)').run(id,user.id,openedAt,opening,JSON.stringify(data));this.emit('session',{id,userName:user.name,openedAt,opening,closedAt:null});this.audit(user,'session.open',{id,opening});return this.currentSession(user);});
  }
  cashSummary(id) {
    const session=this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);ensure(session,'Session introuvable.');
    const sum=(sql,...args)=>this.db.prepare(sql).get(...args).n||0;
    const cashSales=sum("SELECT SUM(total) n FROM sales WHERE session_id=? AND payment='cash'",id);
    const refunds=sum("SELECT SUM(total) n FROM sales WHERE void_session_id=? AND payment='cash'",id);
    const expenses=sum("SELECT SUM(amount) n FROM expenses WHERE session_id=? AND source='cash'",id);
    const clientPayments=sum("SELECT SUM(amount) n FROM client_payments WHERE session_id=? AND method='cash'",id);
    const supplierPayments=sum("SELECT SUM(amount) n FROM supplier_payments WHERE session_id=? AND method='cash'",id);
    const card=sum("SELECT SUM(total) n FROM sales WHERE session_id=? AND payment='card' AND voided_at IS NULL",id);
    const credit=sum("SELECT SUM(total) n FROM sales WHERE session_id=? AND payment='credit' AND voided_at IS NULL",id);
    return {opening:session.opening,cashSales,refunds,expenses,clientPayments,supplierPayments,card,credit,expected:session.opening+cashSales-refunds-expenses+clientPayments-supplierPayments};
  }
  closeSession(args,user) {
    const session=this.sessionRequired(user);const closing=integer(args.closing,'Espèces comptées');const reason=text(args.reason);
    return this.transaction(()=>{const summary=this.cashSummary(session.id);const variance=closing-summary.expected;
      ensure(Math.abs(variance)<=this.settings().varianceThreshold||reason.length>=5,'Expliquez l’écart de caisse avant de clôturer.');
      const closedAt=now();this.db.prepare('UPDATE sessions SET closed_at=?,closing=?,expected=?,variance=?,data=? WHERE id=? AND closed_at IS NULL').run(closedAt,closing,summary.expected,variance,JSON.stringify({userName:user.name,reason,summary}),session.id);
      if(this.settings().print.closure)this.db.prepare('INSERT INTO closure_print_jobs(id,session_id,created_at) VALUES (?,?,?)').run(randomUUID(),session.id,closedAt);
      this.emit('session',{...session,closedAt,closing,expected:summary.expected,variance,reason,summary});this.audit(user,'session.close',{id:session.id,variance});return {...summary,id:session.id,closing,variance,closedAt};
    });
  }
  createSale(args,user) {
    const requestId=label(args.requestId,'Identifiant de vente',100);
    ensure(args.print===undefined||typeof args.print==='boolean','Choix d’impression invalide.');
    const request={items:args.items,discount:args.discount||0,payment:args.payment,received:args.received,clientId:args.clientId||'',mode:args.mode||'sur_place',note:args.note||''};if(args.print!==undefined)request.print=args.print;
    const inputHash=createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const existing=this.db.prepare('SELECT * FROM sales WHERE request_id=?').get(requestId);
    if(existing) {const sale=parse(existing.data);ensure(existing.user_id===user.id&&sale.inputHash===inputHash,'Cette demande a déjà été enregistrée avec un autre contenu. Vérifiez l’historique.',409);return {...sale,duplicate:true};}
    const session=this.sessionRequired(user);ensure(Array.isArray(args.items)&&args.items.length>0&&args.items.length<=100,'Ajoutez au moins un produit.');
    const items=args.items.map(item=>{
      const product=this.entity(item.productId,'product');const quantity=integer(item.quantity,'Quantité',1,99);
      ensure(Array.isArray(item.supplements||[])&&Array.isArray(item.comments||[]),'Options invalides.');
      const supplements=[...new Set(item.supplements||[])].map(id=>{const s=this.entity(id,'supplement');ensure(!s.productIds.length||s.productIds.includes(product.id),'Ce supplément ne correspond pas à ce produit.');return {id:s.id,name:s.name,price:s.price};});
      const comments=[...new Set(item.comments||[])].map(id=>{const c=this.entity(id,'comment');ensure(!c.productIds.length||c.productIds.includes(product.id),'Ce commentaire ne correspond pas à ce produit.');return {id:c.id,name:c.name,client:c.client,kitchen:c.kitchen};});
      ensure(supplements.length<=30&&comments.length<=30,'Trop d’options.');
      const unit=product.price+supplements.reduce((sum,s)=>sum+s.price,0);
      return {lineId:randomUUID(),productId:product.id,name:product.name,kitchenName:product.kitchenName||product.name,familyId:product.familyId,familyName:this.entity(product.familyId,'family').name,quantity,price:product.price,supplements,comments,total:unit*quantity};
    });
    const subtotal=items.reduce((sum,item)=>sum+item.total,0);integer(subtotal,'Montant de commande',0,100_000_000);
    const discount=integer(args.discount||0,'Remise',0,subtotal);if(discount){this.require(user,'discount');ensure(discount<=Math.floor(subtotal*this.settings().maxDiscountPercent/100),'Remise supérieure au plafond autorisé.');}
    const total=subtotal-discount;ensure(['cash','card','credit'].includes(args.payment),'Moyen de paiement invalide.');
    const client=args.clientId?this.entity(args.clientId,'client'):null;
    if(args.payment==='credit'){ensure(client,'Sélectionnez un client pour une vente à crédit.');ensure((this.clientBalances()[client.id]||0)+total<=client.creditLimit,'Plafond de crédit du client dépassé.');}
    const received=args.payment==='cash'?integer(args.received,'Montant reçu',total,100_000_000):total;
    return this.transaction(()=>{
      const ticket=Number(this.get('ticket'))+1;this.put('ticket',ticket);const id=randomUUID(),createdAt=now();
      const sale={id,requestId,inputHash,ticket,deviceId:this.get('deviceId'),sessionId:session.id,userId:user.id,userName:user.name,createdAt,day:dayInTunis(),items,subtotal,discount,total,payment:args.payment,received,change:received-total,client:client?{id:client.id,name:client.name,phone:client.phone}:null,mode:['sur_place','emporter','livraison'].includes(args.mode)?args.mode:'sur_place',note:text(args.note,300)};
      this.db.prepare('INSERT INTO sales(id,request_id,ticket,session_id,user_id,created_at,day,total,payment,client_id,data) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,requestId,ticket,session.id,user.id,createdAt,sale.day,total,args.payment,client?.id||null,JSON.stringify(sale));
      this.emit('sale',sale);this.audit(user,'sale.create',{id,ticket,total});
      const printRequested=args.print??this.settings().print.autoPrint;
      if(printRequested){for(const kind of args.print===true||this.settings().print.kitchen?['client','kitchen']:['client'])this.db.prepare('INSERT INTO print_jobs(id,sale_id,kind,created_at) VALUES (?,?,?,?)').run(randomUUID(),id,kind,createdAt);}
      return sale;
    });
  }
  saleDetails(id,user) {const row=this.db.prepare('SELECT * FROM sales WHERE id=?').get(id);ensure(row,'Vente introuvable.');ensure(user.admin||user.permissions.includes('reports')||row.user_id===user.id,'Accès à cette vente refusé.',403);return {...parse(row.data),voidedAt:row.voided_at,voidReason:row.void_reason};}
  voidSale(args,user) {
    const reason=label(args.reason,'Motif',300);ensure(reason.length>=5,'Précisez le motif d’annulation.');const row=this.db.prepare('SELECT * FROM sales WHERE id=?').get(args.id);ensure(row,'Vente introuvable.');ensure(!row.voided_at,'Cette vente est déjà annulée.');
    const session=this.sessionRequired(user);
    if(row.payment==='credit') ensure((this.clientBalances()[row.client_id]||0)>=row.total,'Ce crédit a déjà été réglé. Effectuez un remboursement après vérification du compte client.');
    return this.transaction(()=>{const voidedAt=now();this.db.prepare('UPDATE sales SET voided_at=?,void_reason=?,void_session_id=? WHERE id=? AND voided_at IS NULL').run(voidedAt,reason,session.id,args.id);this.emit('saleVoid',{id:args.id,voidedAt,reason,sessionId:session.id,userName:user.name});this.audit(user,'sale.void',{id:args.id,reason});return {ok:true};});
  }
  createExpense(args,user) {
    const requestId=label(args.requestId,'Identifiant de charge',100);const prior=this.db.prepare('SELECT * FROM expenses WHERE request_id=?').get(requestId);
    if(prior){const data=parse(prior.data);ensure(prior.user_id===user.id&&prior.amount===args.amount&&data.categoryId===args.categoryId&&data.description===args.description&&prior.source===args.source&&(data.supplierId||'')===(args.supplierId||''),'Demande de charge déjà utilisée.',409);return {...data,duplicate:true};}
    const category=this.entity(args.categoryId,'expenseCategory'),supplier=args.supplierId?this.entity(args.supplierId,'supplier'):null;const amount=integer(args.amount,'Montant',1);const description=label(args.description,'Description',300);ensure(['cash','bank','credit'].includes(args.source),'Source invalide.');if(args.source==='credit')ensure(supplier,'Sélectionnez un fournisseur pour une charge à crédit.');const session=args.source==='cash'?this.sessionRequired(user):null;
    return this.transaction(()=>{const id=randomUUID(),createdAt=now(),day=dayInTunis();const data={id,requestId,categoryId:category.id,category:category.name,supplierId:supplier?.id||'',supplierName:supplier?.name||'',description,amount,source:args.source,userName:user.name,sessionId:session?.id||null,createdAt,day};this.db.prepare('INSERT INTO expenses VALUES (?,?,?,?,?,?,?,?,?)').run(id,requestId,session?.id||null,user.id,day,createdAt,amount,args.source,JSON.stringify(data));this.emit('expense',data);this.audit(user,'expense.create',{id,amount});return data;});
  }
  clientBalances() {
    const balances={};for(const row of this.db.prepare("SELECT client_id,SUM(total) n FROM sales WHERE payment='credit' AND voided_at IS NULL GROUP BY client_id").all())balances[row.client_id]=row.n;
    for(const row of this.db.prepare('SELECT client_id,SUM(amount) n FROM client_payments GROUP BY client_id').all())balances[row.client_id]=(balances[row.client_id]||0)-row.n;return balances;
  }
  supplierBalances(){const balances={};for(const row of this.db.prepare("SELECT json_extract(data,'$.supplierId') id,SUM(amount) amount FROM expenses WHERE source='credit' GROUP BY id").all())if(row.id)balances[row.id]=row.amount;for(const row of this.db.prepare('SELECT supplier_id id,SUM(amount) amount FROM supplier_payments GROUP BY supplier_id').all())balances[row.id]=(balances[row.id]||0)-row.amount;return balances;}
  supplierPayment(args,user){
    const requestId=label(args.requestId,'Identifiant de règlement',100),existing=this.db.prepare('SELECT * FROM supplier_payments WHERE request_id=?').get(requestId);
    if(existing){ensure(existing.user_id===user.id&&existing.supplier_id===args.supplierId&&existing.amount===args.amount&&existing.method===args.method&&parse(existing.data).note===text(args.note,300),'Demande de règlement déjà utilisée.',409);return {...parse(existing.data),duplicate:true};}
    const supplier=this.entity(args.supplierId,'supplier'),amount=integer(args.amount,'Montant',1);ensure(['cash','bank'].includes(args.method),'Moyen de paiement invalide.');
    const session=args.method==='cash'?this.sessionRequired(user):null;ensure(amount<=(this.supplierBalances()[supplier.id]||0),'Le montant dépasse le solde du fournisseur.');
    return this.transaction(()=>{const id=randomUUID(),createdAt=now(),day=dayInTunis(),data={id,requestId,supplierId:supplier.id,supplierName:supplier.name,amount,method:args.method,sessionId:session?.id||null,userId:user.id,userName:user.name,createdAt,day,note:text(args.note,300)};this.db.prepare('INSERT INTO supplier_payments VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,requestId,supplier.id,session?.id||null,user.id,createdAt,day,amount,args.method,JSON.stringify(data));this.emit('supplierPayment',data);this.audit(user,'supplier.payment',{id,amount});return data;});
  }
  clientPayment(args,user) {
    const client=this.entity(args.clientId,'client');const amount=integer(args.amount,'Montant',1);ensure(['cash','card'].includes(args.method),'Moyen de paiement invalide.');const requestId=label(args.requestId,'Identifiant',100);const existing=this.db.prepare('SELECT * FROM client_payments WHERE request_id=?').get(requestId);if(existing){ensure(existing.user_id===user.id&&existing.client_id===client.id&&existing.amount===amount&&existing.method===args.method,'Demande de règlement déjà utilisée.',409);return {id:existing.id,duplicate:true};}
    const session=this.sessionRequired(user);ensure(amount<=(this.clientBalances()[client.id]||0),'Le montant dépasse le solde du client.');
    return this.transaction(()=>{const id=randomUUID(),createdAt=now(),day=dayInTunis();this.db.prepare('INSERT INTO client_payments VALUES (?,?,?,?,?,?,?,?,?)').run(id,requestId,client.id,session.id,user.id,createdAt,day,amount,args.method);const data={id,clientId:client.id,clientName:client.name,sessionId:session.id,userName:user.name,createdAt,day,amount,method:args.method};this.emit('clientPayment',data);this.audit(user,'client.payment',{id,amount});return data;});
  }
  report(args) {
    const filters=reportFilters(args);const parseSale=r=>({...parse(r.data),voidedAt:r.voided_at,voidReason:r.void_reason});
    return buildReport({sales:this.db.prepare('SELECT * FROM sales WHERE day BETWEEN ? AND ? ORDER BY created_at').all(filters.from,filters.to).map(parseSale),refunds:this.db.prepare('SELECT * FROM sales WHERE voided_at IS NOT NULL').all().map(parseSale),expenses:this.db.prepare('SELECT * FROM expenses WHERE day BETWEEN ? AND ?').all(filters.from,filters.to).map(r=>({...parse(r.data),amount:r.amount})),sessions:this.db.prepare('SELECT * FROM sessions ORDER BY opened_at').all().map(r=>this.sessionData(r)),clientPayments:this.db.prepare('SELECT * FROM client_payments WHERE day BETWEEN ? AND ?').all(filters.from,filters.to),supplierPayments:this.db.prepare('SELECT * FROM supplier_payments WHERE day BETWEEN ? AND ?').all(filters.from,filters.to)},filters);
  }
  closureDetails(id,user){this.requireClosureAccess(user);const row=this.db.prepare('SELECT * FROM sessions WHERE id=? AND closed_at IS NOT NULL').get(id);ensure(row,'Clôture introuvable.');ensure(user.admin||user.permissions.includes('reports')||row.user_id===user.id,'Accès à cette clôture refusé.',403);return this.sessionData(row);}
  requireClosureAccess(user){ensure(user.admin||user.permissions.includes('close')||user.permissions.includes('reports'),'Permission de clôture ou rapport requise.',403);}
  closures(args,user){this.requireClosureAccess(user);const filters=reportFilters({...args,from:args.from||'2000-01-01',to:args.to||dayInTunis()});return this.db.prepare('SELECT * FROM sessions WHERE closed_at IS NOT NULL ORDER BY closed_at DESC').all().filter(r=>{const day=dayInTunis(new Date(r.closed_at));return day>=filters.from&&day<=filters.to&&(!args.userId||r.user_id===args.userId)&&(user.admin||user.permissions.includes('reports')||r.user_id===user.id);}).map(r=>this.sessionData(r));}
  saveUser(args,user) {
    const id=args.id||randomUUID();const previous=this.db.prepare('SELECT * FROM users WHERE id=?').get(id);const name=label(args.name,'Identifiant',60);const permissions=Array.isArray(args.permissions)?[...new Set(args.permissions)]:[];ensure(permissions.every(p=>PERMISSIONS.includes(p)),'Permission invalide.');
    const admin=!!args.admin,active=args.active!==false;ensure(id!==user.id||active,'Vous ne pouvez pas désactiver votre propre compte.');
    if(previous?.admin && (!admin||!active))ensure(this.db.prepare('SELECT COUNT(*) n FROM users WHERE admin=1 AND active=1 AND id!=?').get(id).n>0,'Conservez au moins un administrateur actif.');
    const salt=args.pin?randomBytes(24).toString('hex'):previous?.salt;const hash=args.pin?hashPin(this.validatePin(args.pin),salt):previous?.hash;ensure(hash,'Un code est requis pour le nouveau compte.');
    return this.transaction(()=>{try{this.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,hash=excluded.hash,salt=excluded.salt,permissions=excluded.permissions,active=excluded.active,admin=excluded.admin').run(id,name,hash,salt,JSON.stringify(permissions),Number(active),Number(admin));}catch(e){if(e.message.includes('UNIQUE'))throw new PosError('Cet identifiant existe déjà.');throw e;}this.audit(user,'user.save',{id,name});for(const [token,s] of this.tokens)if(s.id===id)this.tokens.delete(token);return {ok:true};});
  }
  saveSettings(args,user) {
    const current=this.settings();const company={name:label(args.company?.name,'Établissement'),address:text(args.company?.address,300),phone:text(args.company?.phone,40),taxId:text(args.company?.taxId,60),footer:text(args.company?.footer,300)};
    const p=args.print||{};ensure(!p.logo||/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.logo)&&p.logo.length<500000,'Logo invalide ou trop volumineux.');
    const print={clientPrinter:text(p.clientPrinter,200),kitchenPrinter:text(p.kitchenPrinter,200),autoPrint:!!p.autoPrint,kitchen:p.kitchen!==false,closure:p.closure!==false,clientComments:!!p.clientComments,kitchenComments:p.kitchenComments!==false,showClient:p.showClient!==false,showLogo:!!p.showLogo,logo:p.logo||'',copies:integer(p.copies||1,'Copies',1,2)};
    const maxDiscountPercent=integer(args.maxDiscountPercent,'Plafond de remise',0,100),varianceThreshold=integer(args.varianceThreshold,'Seuil d’écart');
    const sync={enabled:!!args.sync?.enabled,endpoint:text(args.sync?.endpoint,500).replace(/\/$/,''),intervalMinutes:20};
    if(sync.endpoint){const url=new URL(sync.endpoint);ensure(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)),'Utilisez une adresse HTTPS pour la synchronisation.');}
    if(sync.enabled)ensure(sync.endpoint,'Adresse de synchronisation requise.');
    if(typeof args.syncToken==='string'&&args.syncToken.trim()){ensure(args.syncToken.length>=16&&args.syncToken.length<=500,'Clé de synchronisation invalide.');this.options.saveSyncToken?.(args.syncToken.trim());}
    return this.transaction(()=>{const settings={company,print,maxDiscountPercent,varianceThreshold,sync,vfd:current.vfd};this.put('settings',JSON.stringify(settings));if(sync.enabled||JSON.stringify(current.company)!==JSON.stringify(company))this.emit('company',company);this.audit(user,'settings.save');return settings;});
  }
}
