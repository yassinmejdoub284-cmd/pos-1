export async function seedDemo(service){
  if(service.db.prepare('SELECT 1 FROM users LIMIT 1').get())return;
  await service.call('setup',{company:'Samurai Food',name:'admin',pin:'246810'});const {token}=await service.call('login',{name:'admin',pin:'246810'});
  const save=(kind,data)=>service.call('saveEntity',{kind,data},token);
  const chapati=await save('family',{name:'Chapati',color:'#df9650'}),chawarma=await save('family',{name:'Chawarma',color:'#8d74be'}),burgers=await save('family',{name:'Burgers',color:'#bd7376'}),boissons=await save('family',{name:'Boissons',color:'#68a494'});
  const products=[['Chapati chawarma',7000,chapati.id,'🥙'],['Chapati poulet',6500,chapati.id,'🫓'],['Chapati thon',5500,chapati.id,'🥙'],['Chawarma classique',8000,chawarma.id,'🌯'],['Chawarma fromage',9500,chawarma.id,'🌯'],['Cheeseburger',8500,burgers.id,'🍔'],['Double burger',12000,burgers.id,'🍔'],['Coca-Cola',2500,boissons.id,'🥤'],['Eau minérale',1500,boissons.id,'💧'],['Chapati merguez',7500,chapati.id,'🫓'],['Burger poulet',8000,burgers.id,'🍔'],['Fanta orange',2500,boissons.id,'🥤'],['Jus frais',4000,boissons.id,'🍊']];
  for(const [name,price,familyId,emoji] of products)await save('product',{name,price,familyId,emoji});
  for(const [name,price] of [['Fromage',1000],['Œuf',1000],['Viande',2500],['Frites',1500]])await save('supplement',{name,price,productIds:[]});
  for(const name of ['Sans oignon','Sauce à part','Bien cuit','Sans harissa'])await save('comment',{name,productIds:[],kitchen:true,client:false});
  for(const name of ['Achats','Entretien','Transport'])await save('expenseCategory',{name,color:'#7455d9'});
  await save('client',{name:'Ahmed Ben Ali',phone:'22 123 456',creditLimit:200000});
  await save('supplier',{name:'Marché & Frais',contact:'Sami',phone:'71 234 567',email:'',address:'Tunis',taxId:'',notes:'Produits frais et boissons'});
  await service.call('openSession',{opening:50000},token);
}
