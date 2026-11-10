import { connectDatabase } from './config/database.js';
import { auth, authMongoClient, connectAuthDatabase, toMongoId } from './lib/auth.js';
import { Category, Item } from './models/index.js';

const categories: [string,string,string][] = [ ['electronics','Electronics','📱'],['cameras','Cameras','📷'],['tools','Tools','🛠️'],['sports','Sports & Outdoors','⚽'],['home','Home & Garden','🏠'],['fashion','Fashion','👗'],['vehicles','Vehicles','🚲'],['music','Music','🎸'],['gaming','Gaming','🎮'],['events','Events','🎉'],['travel','Travel','🧳'],['other','Other','📦'] ];
async function run(): Promise<void> {
  await connectDatabase();
  await connectAuthDatabase();
  const users = [ {name:'BorrowHub Admin',email:'admin@borrowhub.example',password:'ChangeMe_Admin_2026!',role:'admin'}, {name:'Ayesha Rahman',email:'ayesha@borrowhub.example',password:'ChangeMe_Owner_2026!',role:'owner'}, {name:'Rahim Ahmed',email:'rahim@borrowhub.example',password:'ChangeMe_Renter_2026!',role:'renter'}, {name:'Nadia Islam',email:'nadia@borrowhub.example',password:'ChangeMe_Both_2026!',role:'owner'} ];
  const ids = new Map<string,string>();
  for (const user of users) { const existing = await authMongoClient.db().collection('user').findOne({email:user.email}); if (existing) { ids.set(user.email,String(existing._id)); continue; } const result=await auth.api.signUpEmail({body:{name:user.name,email:user.email,password:user.password}}); if (result.user?.id) { ids.set(user.email,result.user.id); await authMongoClient.db().collection('user').updateOne({_id:toMongoId(result.user.id)},{$set:{role:user.role,canList:user.role==='owner',canRent:true,trustScore:50}}); } }
  await Category.bulkWrite(categories.map(([slug,name,icon])=>({updateOne:{filter:{slug},update:{$set:{name,icon}},upsert:true}})));
  const owner = ids.get('ayesha@borrowhub.example');
  if(owner){const samples: [string,string,number,number,number,boolean,number][]=[['Canon EOS 80D Camera','cameras',1200,7000,25000,true,10],['Makita Cordless Drill','tools',500,3000,11000,false,0],['Mountain Bike','vehicles',800,4500,16000,true,8],['JBL Party Speaker','electronics',900,5200,19000,true,6],['Projector Full HD','electronics',1500,8500,30000,false,0],['Camping Tent for 4','travel',600,3500,12500,false,0],['Acoustic Guitar','music',400,2200,8000,false,0],['PlayStation 5','gaming',1800,10000,36000,true,12],['DSLR Tripod','cameras',250,1400,5000,false,0],['Lawn Mower','home',1000,5700,21000,false,0],['Football Kit','sports',200,1100,4000,false,0],['Wedding Sound System','events',2500,14000,50000,true,4]];for(const [name,category,daily,weekly,monthly,isFeatured,featuredOrder] of samples){await Item.updateOne({name,owner},{$setOnInsert:{owner,name,category,description:`Rent ${name} in Dhaka. Well maintained and ready to use.`,condition:'Excellent',pricing:{daily,weekly,monthly},deposit:daily*2,location:{area:'Dhanmondi',city:'Dhaka',coordinates:{type:'Point',coordinates:[90.3742,23.7461]}},pickupOption:'both',status:'approved',images:[],includes:[],isFeatured,featuredOrder}}, {upsert:true});}}
  console.info('Seed complete'); await authMongoClient.close(); process.exit(0);
}
void run().catch(error=>{console.error('Seed failed',error);process.exitCode=1;});
