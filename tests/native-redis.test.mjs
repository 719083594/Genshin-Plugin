import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installNativeRedis, NATIVE_REDIS_PREFIXES, NATIVE_REDIS_SNAPSHOT_LUA, NATIVE_REDIS_DELETE_LUA } from '../lib/native-redis.mjs';
import { encryptJson, decryptJson } from '../lib/encrypted-json.mjs';

const AAD='Teyvat-Plugin/native-redis/v1';
const cacheFile=root=>path.join(root,'data','native-cache','redis.enc.json');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-redis-test-')),key=randomBytes(32);t.after(()=>{const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.match(path.basename(target),/^native-redis-test-/);fs.rmSync(target,{recursive:true,force:true});});return{root,key};}
function read(root,key){return decryptJson(JSON.parse(fs.readFileSync(cacheFile(root),'utf8')),{key,aad:AAD,maxBytes:32*1024*1024});}
const order=entry=>Object.entries(entry.value).sort((a,b)=>a[1]-b[1]||Buffer.compare(Buffer.from(a[0]),Buffer.from(b[0])));
function mockRedis({lua=true,expiryAtomic=true}={}){
  const raw=new Map(),calls=[];let beforeDelete;
  const live=key=>{const entry=raw.get(key);if(entry?.expiresAt!==null&&entry?.expiresAt<=Date.now()){raw.delete(key);return null;}return entry??null;};
  const api={
    raw,calls,setBeforeDelete:fn=>{beforeDelete=fn;},
    async get(key){calls.push(['get',key]);return live(key)?.value??null;},
    async set(key,value,...args){calls.push(['set',key,value,...args]);raw.set(key,{type:'string',value:String(value),expiresAt:null});return'OK';},
    async del(...args){calls.push(['del',...args]);let n=0;for(const key of args.flat())if(raw.delete(key))n++;return n;},
    async exists(...args){calls.push(['exists',...args]);return args.flat().filter(key=>live(key)).length;},
    async expire(key,s){calls.push(['expire',key,s]);const entry=live(key);if(!entry)return 0;entry.expiresAt=Date.now()+Number(s)*1000;return 1;},
    async ttl(key){const entry=live(key);return !entry?-2:entry.expiresAt===null?-1:Math.round((entry.expiresAt-Date.now())/1000);},
    async keys(pattern){calls.push(['keys',pattern]);const re=new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*').replaceAll('?','.')+'$');return [...raw.keys()].filter(key=>live(key)&&re.test(key));},
    async hGet(){return null;},async hSet(){return 77;},async hGetAll(){return{};},async hDel(){return 0;},
    async zAdd(){return 77;},async zRange(){return[];},async zRangeWithScores(){return[];},async zRevRank(){return null;},async zRank(){return null;},async zScore(){return null;},async zRem(){return 0;},async zCard(){return 0;}
  };
  if(lua)api.eval=async(script,{keys,arguments:args})=>{
    const key=keys[0];calls.push(['eval',script===NATIVE_REDIS_SNAPSHOT_LUA?'snapshot':'delete',key]);
    if(script===NATIVE_REDIS_SNAPSHOT_LUA){const entry=live(key);if(!entry)return JSON.stringify({type:'none'});if(!['string','hash','zset'].includes(entry.type))return JSON.stringify({error:'unsupported_type'});if(!expiryAtomic&&entry.expiresAt!==null)return JSON.stringify({error:'expiry_atomic_required'});const items=entry.type==='string'?[entry.value]:entry.type==='hash'?Object.entries(entry.value).flat():order(entry).flatMap(([member,score])=>[member,String(score)]);return JSON.stringify({type:entry.type,items,expireAt:entry.expiresAt??-1,serverNow:Date.now()});}
    assert.equal(script,NATIVE_REDIS_DELETE_LUA);if(beforeDelete){const hook=beforeDelete;beforeDelete=null;hook(key,raw);}
    const expected=JSON.parse(args[0]),entry=live(key);if(!entry)return 2;
    if(entry.type!==expected.type||(entry.expiresAt??-1)!==expected.expireAt)return 0;
    if(entry.type==='string'){if(entry.value!==expected.items[0])return 0;}
    else if(entry.type==='hash'){const pairs=Object.fromEntries(Array.from({length:expected.items.length/2},(_,i)=>expected.items.slice(i*2,i*2+2)));if(JSON.stringify(Object.entries(entry.value).sort())!==JSON.stringify(Object.entries(pairs).sort()))return 0;}
    else if(JSON.stringify(order(entry).flatMap(([member,score])=>[member,String(score)]))!==JSON.stringify(expected.items))return 0;
    raw.delete(key);return 1;
  };
  return api;
}
function install(t,options={}){const f=fixture(t),redis=mockRedis(options);installNativeRedis({redis,...f,...options});return{...f,redis};}
const rejects=(promise,code)=>assert.rejects(promise,error=>error.code===code);

test('source-reviewed namespaces only; unrelated calls delegate without creating cache',async t=>{
  const{root,redis}=install(t);
  assert.deepEqual(NATIVE_REDIS_PREFIXES,['miao:rank:','miao:role-card:','miao:user-cfg:','miao:profile-cd:','FanSky:Teyvet:','FanSky:SmallFunctions:ChestTop:','FanSky:SmallFunctions:AchieveTop:','xhh:show_','xhh:hide_','xhh:transformer_']);
  assert.equal(await redis.set('bot:ordinary','hello',{EX:9}),'OK');assert.equal(await redis.get('bot:ordinary'),'hello');assert.deepEqual(await redis.keys('bot:*'),['bot:ordinary']);
  assert.equal(fs.existsSync(cacheFile(root)),false);assert.equal(await redis.zAdd('ordinary:z',{value:'a',score:1}),77);
});
test('strings, set options, duplicates, TTL, mixed DEL/EXISTS and keys retain node-redis shape',async t=>{
  const{root,key,redis}=install(t);const id='xhh:show_uid:123456';
  assert.equal(await redis.get(id),null);assert.equal(await redis.ttl(id),-2);assert.equal(await redis.set(id,1),'OK');assert.equal(await redis.get(id),'1');assert.equal(await redis.ttl(id),-1);
  assert.equal(await redis.set(id,2,{NX:true}),null);assert.equal(await redis.set(id,2,{XX:true,GET:true}),'1');assert.equal(await redis.get(id),'2');
  assert.equal(await redis.set('miao:profile-cd:100000007','3','EX',3),'OK');assert.ok([2,3].includes(await redis.ttl('miao:profile-cd:100000007')));
  await redis.set('ordinary:key','4');assert.equal(await redis.exists([id,id,'ordinary:key','missing']),3);
  assert.deepEqual(await redis.keys('*'),['miao:profile-cd:100000007','ordinary:key',id].sort());assert.deepEqual(await redis.keys('xhh:show_?id:*'),[id]);
  assert.equal(await redis.expire(id,0),1);assert.equal(await redis.get(id),null);assert.equal(await redis.expire(id,2),0);
  assert.equal(await redis.del('miao:profile-cd:100000007','miao:profile-cd:100000007','ordinary:key'),2);
  assert.deepEqual(read(root,key).entries,{});assert.ok(!redis.calls.some(([name,target])=>name==='set'&&NATIVE_REDIS_PREFIXES.some(prefix=>target.startsWith(prefix))));
});
test('hash exchange format, absent members, delete counts and own prototype-named fields',async t=>{
  const{redis}=install(t);const id='miao:role-card:exchange:v2:654321';
  assert.equal(await redis.hGet(id,'123456'),null);assert.deepEqual(await redis.hGetAll(id),{});
  assert.equal(await redis.hSet(id,'123456',JSON.stringify({uid:'100000007',cards:[1,2]})),1);
  assert.equal(await redis.hSet(id,{'123456':'updated','888888':'second'}),1);assert.equal(await redis.hSet(id,'__proto__','own'),1);
  const hash=await redis.hGetAll(id);assert.equal(hash.__proto__,'own');assert.equal(Object.getPrototypeOf(hash),Object.prototype);assert.equal({}.polluted,undefined);
  assert.equal(await redis.hDel(id,['888888','888888','missing']),1);assert.equal(await redis.hDel(id,'123456','__proto__'),2);assert.equal(await redis.ttl(id),-2);
});
test('group ranks use numeric scores, UTF8 ties, negative ranges, reverse ranks and counts',async t=>{
  const{redis}=install(t);const id='miao:rank:654321:dmg:10000002';
  assert.equal(await redis.zAdd(id,[{value:'100000009',score:'12.5'},{value:'100000007',score:5},{value:'100000008',score:12.5}]),3);
  assert.deepEqual(await redis.zRange(id,0,-1),['100000007','100000008','100000009']);assert.deepEqual(await redis.zRangeWithScores(id,-2,-1),[{value:'100000008',score:12.5},{value:'100000009',score:12.5}]);
  assert.deepEqual(await redis.zRange(id,0,1,{REV:true}),['100000009','100000008']);assert.deepEqual(await redis.zRange(id,8,9),[]);assert.deepEqual(await redis.zRange(id,0,-9),[]);
  assert.equal(await redis.zRevRank(id,'100000009'),0);assert.equal(await redis.zRank(id,'100000008'),1);assert.equal(await redis.zScore(id,'100000008'),12.5);assert.equal(await redis.zRevRank(id,'missing'),null);assert.equal(await redis.zCard(id),3);
  assert.equal(await redis.zAdd(id,{value:'100000007',score:20}),0);assert.equal(await redis.zAdd(id,{value:'100000007',score:30},{NX:true}),0);assert.equal(await redis.zAdd(id,{value:'100000007',score:19},{LT:true,CH:true}),1);
  assert.equal(await redis.zRem(id,['100000007','100000007']),1);assert.equal(await redis.zRem(id,'100000008','100000009'),2);assert.equal(await redis.ttl(id),-2);
  await rejects(redis.zAdd(id,{value:'one',score:Infinity}),'INVALID_SCORE');
});
test('credential fields inside JSON strings are recursively removed without mutating input; credential cache refused',async t=>{
  const{root,key,redis}=install(t);const input={uid:'100000007',_ck:'private-cookie',nested:[{cookie_token:'SECRET_A',value:'yes'},{credential:{secret:'SECRET_B'},token:'SECRET_C'}],safe:{score:9}};
  await redis.set('FanSky:Teyvet:100000007:rolesData',JSON.stringify(input));assert.equal(input._ck,'private-cookie');assert.deepEqual(JSON.parse(await redis.get('FanSky:Teyvet:100000007:rolesData')),{uid:'100000007',nested:[{value:'yes'},{}],safe:{score:9}});
  await redis.set('miao:user-cfg:123456','ltuid=123; ltoken=SECRET_TOKEN;');assert.equal(await redis.get('miao:user-cfg:123456'),'');
  assert.equal(await redis.hSet('miao:role-card:one',{'cookie':'SECRET_D','safe':'normal'}),1);
  await rejects(redis.set('xhh:transformer_ck:123','ltuid=123; cookie_token=SECRET_E;'),'CREDENTIAL_CACHE_FORBIDDEN');
  const plain=JSON.stringify(read(root,key));for(const value of ['private-cookie','SECRET_A','SECRET_B','SECRET_C','SECRET_D','SECRET_E','SECRET_TOKEN'])assert.ok(!plain.includes(value));
  for(const name of fs.readdirSync(path.dirname(cacheFile(root)))){assert.ok(!/100000007|123456/.test(name));assert.ok(!fs.readFileSync(path.join(path.dirname(cacheFile(root)),name),'utf8').includes('100000007'));}
});
test('legacy string, hash and sorted set migrate only after verified encrypted copy and atomic compare-delete',async t=>{
  const{root,key,redis}=install(t);const expiry=Date.now()+5000;
  redis.raw.set('miao:rank:uid-info:100000007',{type:'string',value:JSON.stringify({qq:'123456',cookie:'SECRET',totalCount:20}),expiresAt:null});
  redis.raw.set('miao:role-card:exchange:v2:654321',{type:'hash',value:{'123456':JSON.stringify({uid:'100000007',token:'SECRET'})},expiresAt:expiry});
  redis.raw.set('miao:rank:654321:mark:10000002',{type:'zset',value:{'100000007':123.45,'100000008':5},expiresAt:null});
  assert.deepEqual(await redis.keys('miao:*'),['miao:rank:654321:mark:10000002','miao:rank:uid-info:100000007','miao:role-card:exchange:v2:654321']);
  assert.equal(redis.raw.size,0);assert.equal(redis.calls.filter(c=>c[0]==='eval'&&c[1]==='delete').length,3);
  assert.deepEqual(JSON.parse(await redis.get('miao:rank:uid-info:100000007')),{qq:'123456',totalCount:20});assert.deepEqual(JSON.parse(await redis.hGet('miao:role-card:exchange:v2:654321','123456')),{uid:'100000007'});
  assert.ok((await redis.ttl('miao:role-card:exchange:v2:654321'))<=5);assert.equal(await redis.zScore('miao:rank:654321:mark:10000002','100000007'),123.45);
  assert.ok(!JSON.stringify(read(root,key)).includes('SECRET'));assert.ok(!JSON.stringify(read(root,key)).includes('migration'));
});
test('legacy credential string is discarded after AES verification, never persisted',async t=>{
  const{root,key,redis}=install(t);const id='xhh:transformer_ck:123';redis.raw.set(id,{type:'string',value:'ltuid=123; cookie_token=SECRET_A;',expiresAt:null});
  assert.equal(await redis.get(id),'');assert.equal(redis.raw.has(id),false);assert.ok(!JSON.stringify(read(root,key)).includes('SECRET_A'));
});
test('legacy value change or TTL extension during copy prevents deletion and exposes conflict',async t=>{
  for(const change of ['value','ttl']){
    const{root,key,redis}=install(t);const id='miao:rank:uid-info:100000007';redis.raw.set(id,{type:'string',value:'old',expiresAt:Date.now()+10000});redis.setBeforeDelete((name,raw)=>{if(change==='value')raw.get(name).value='new';else raw.get(name).expiresAt+=5000;});
    await rejects(redis.get(id),'MIGRATION_CHANGED');assert.equal(redis.raw.has(id),true);assert.equal(read(root,key).entries[id].value,'old');assert.match(read(root,key).entries[id].migration,/^[a-f0-9]{64}$/);
    await rejects(redis.get(id),'MIGRATION_CONFLICT');assert.equal(redis.raw.has(id),true);
  }
});
test('missing Lua and unsupported old types keep raw data and report explicit errors',async t=>{
  const{redis}=install(t,{lua:false});const id='miao:rank:uid-info:100000007';redis.raw.set(id,{type:'string',value:'old',expiresAt:null});await rejects(redis.get(id),'MIGRATION_ATOMIC_REQUIRED');assert.equal(redis.raw.get(id).value,'old');
  const next=install(t);next.redis.raw.set(id,{type:'list',value:['a'],expiresAt:null});await rejects(next.redis.get(id),'MIGRATION_FAILED');assert.equal(next.redis.raw.has(id),true);
});
test('new Redis source reappearing beside completed encrypted entry is not silently ignored',async t=>{
  const{redis}=install(t);const id='miao:user-cfg:123456';await redis.set(id,'own');redis.raw.set(id,{type:'string',value:'external',expiresAt:null});await rejects(redis.get(id),'MIGRATION_CONFLICT');assert.equal(redis.raw.has(id),true);
});
test('wrong key, wrong AAD, tampering and missing metadata preserve original cache bytes',async t=>{
  const{root,key,redis}=install(t);const id='xhh:show_uid:123456';await redis.set(id,'1');const original=fs.readFileSync(cacheFile(root));
  const wrong=mockRedis();installNativeRedis({redis:wrong,root,key:randomBytes(32)});await rejects(wrong.get(id),'DECRYPT_FAILED');assert.deepEqual(fs.readFileSync(cacheFile(root)),original);
  const envelope=JSON.parse(original);envelope.tag=Buffer.alloc(16).toString('base64');fs.writeFileSync(cacheFile(root),JSON.stringify(envelope));const tampered=fs.readFileSync(cacheFile(root));await rejects(redis.set(id,'2'),'DECRYPT_FAILED');await rejects(redis.del(id),'DECRYPT_FAILED');assert.deepEqual(fs.readFileSync(cacheFile(root)),tampered);
  fs.writeFileSync(cacheFile(root),JSON.stringify(encryptJson({version:1,entries:{}},{key,aad:'wrong'})));await rejects(redis.get(id),'DECRYPT_FAILED');
  fs.writeFileSync(cacheFile(root),original);fs.unlinkSync(path.join(root,'data','native-cache','redis-key-check.enc.json'));await rejects(redis.get(id),'STORAGE_METADATA_MISSING');assert.deepEqual(fs.readFileSync(cacheFile(root)),original);
});
test('cross-process lock uses bounded asynchronous waits, and same-object install is idempotent',async t=>{
  const{root,key,redis}=install(t,{lockTimeoutMs:70});const first=installNativeRedis({redis,root,key});assert.equal(first,installNativeRedis({redis,root,key}));assert.throws(()=>installNativeRedis({redis,root,key:randomBytes(32)}),error=>error.code==='INSTALL_CONFLICT');
  await redis.get('xhh:show_uid:123456');const lock=path.join(root,'data','native-cache','.redis.lock');fs.writeFileSync(lock,'');let progressed=false;const timer=setTimeout(()=>{progressed=true;},5);await rejects(redis.set('xhh:show_uid:123456','1'),'STORAGE_BUSY');clearTimeout(timer);assert.equal(progressed,true);fs.unlinkSync(lock);assert.equal(await redis.get('xhh:show_uid:123456'),null);
});
test('two independent processes update distinct keys without losing whole-file changes',async t=>{
  const{root,key}=fixture(t),modulePath=fileURLToPath(new URL('../lib/native-redis.mjs',import.meta.url));
  const script=`import {pathToFileURL} from 'node:url';const{installNativeRedis}=await import(pathToFileURL(process.argv[1]));const redis={exists:async()=>0};installNativeRedis({redis,root:process.argv[2],key:process.argv[3],lockTimeoutMs:5000});for(let i=0;i<8;i++)await redis.set('miao:profile-cd:'+process.argv[4]+i,String(i));`;
  const launch=name=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',script,modulePath,root,key.toString('hex'),name],{windowsHide:true});let error='';child.stderr.on('data',data=>{error+=data;});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(error)));});
  await Promise.all([launch('a'),launch('b')]);const state=read(root,key);assert.equal(Object.keys(state.entries).length,16);for(const name of ['a','b'])for(let i=0;i<8;i++)assert.equal(state.entries['miao:profile-cd:'+name+i].value,String(i));
});
test('linked storage ancestry is refused without writing the linked target',async t=>{
  const first=fixture(t),second=fixture(t);const link=path.join(first.root,'data');try{fs.symlinkSync(second.root,link,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Host does not permit directory links');return;}throw error;}
  const redis=mockRedis();installNativeRedis({redis,...first});await rejects(redis.set('xhh:show_uid:123456','1'),'UNSAFE_STORAGE');assert.equal(fs.readdirSync(second.root).length,0);
});
test('expired cache and wrong type errors do not delegate plaintext writes',async t=>{
  const{redis}=install(t);const id='miao:rank:654321:mark:10000002';await redis.set(id,'plain',{PX:10});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(await redis.get(id),null);assert.equal(await redis.ttl(id),-2);
  await redis.hSet(id,'one','1');await rejects(redis.get(id),'WRONGTYPE');await rejects(redis.zAdd(id,{value:'a',score:2}),'WRONGTYPE');assert.deepEqual(await redis.hGetAll(id),{one:'1'});
});
test('unrelated KEYS queries still delegate when private cache has a wrong key or stale lock',async t=>{
  const{root,redis}=install(t);await redis.set('xhh:show_uid:123456','1');await redis.set('ordinary:value','kept');fs.writeFileSync(path.join(root,'data','native-cache','.redis.lock'),'');
  assert.deepEqual(await redis.keys('ordinary:*'),['ordinary:value']);const wrong=mockRedis();wrong.raw.set('Yz:entry',{type:'string',value:'unrelated',expiresAt:null});installNativeRedis({redis:wrong,root,key:randomBytes(32)});assert.deepEqual(await wrong.keys('Yz:*'),['Yz:entry']);
});
test('all mutations of transformer credential cache are refused and every old type becomes a credential-free tombstone',async t=>{
  const{root,key,redis}=install(t);const id='xhh:transformer_ck:123';for(const action of [()=>redis.set(id,'value'),()=>redis.expire(id,30),()=>redis.hSet(id,'field','secret'),()=>redis.hDel(id,'field'),()=>redis.zAdd(id,{value:'secret',score:1}),()=>redis.zRem(id,'secret')])await rejects(action(),'CREDENTIAL_CACHE_FORBIDDEN');
  for(const type of ['hash','zset']){const id='xhh:transformer_ck:'+type;redis.raw.set(id,{type,value:type==='hash'?{cookie:'SECRET_COOKIE'}:{SECRET_MEMBER:20},expiresAt:null});assert.equal(await redis.get(id),'');assert.equal(redis.raw.has(id),false);assert.equal(read(root,key).entries[id].type,'string');}
  assert.ok(!JSON.stringify(read(root,key)).includes('SECRET'));assert.equal(await redis.del('xhh:transformer_ck:hash','xhh:transformer_ck:zset'),2);
});
test('failed atomic file replacement leaves original Redis and encrypted file intact',async t=>{
  const{root,redis}=install(t);await redis.get('xhh:show_uid:123456');const before=fs.readFileSync(cacheFile(root)),id='miao:rank:uid-info:100000007';redis.raw.set(id,{type:'string',value:'legacy',expiresAt:null});
  const original=fs.renameSync;try{fs.renameSync=(source,target)=>{if(target===cacheFile(root))throw Object.assign(new Error('simulated write failure'),{code:'EIO'});return original(source,target);};await rejects(redis.get(id),'STORAGE_FAILED');}finally{fs.renameSync=original;}
  assert.equal(redis.raw.get(id).value,'legacy');assert.deepEqual(fs.readFileSync(cacheFile(root)),before);assert.equal(await redis.get(id),'legacy');assert.equal(redis.raw.has(id),false);
});
test('failed encrypted readback preserves raw source and resumable encrypted pending record',async t=>{
  const{root,key,redis}=install(t);await redis.get('xhh:show_uid:123456');const id='miao:rank:uid-info:100000007';redis.raw.set(id,{type:'string',value:'legacy',expiresAt:null});
  const original=fs.readFileSync;let reads=0;try{fs.readFileSync=(target,...args)=>{if(target===cacheFile(root)&&++reads===2)throw Object.assign(new Error('simulated verification failure'),{code:'EIO'});return original(target,...args);};await rejects(redis.get(id),'STORAGE_FAILED');}finally{fs.readFileSync=original;}
  assert.equal(redis.raw.get(id).value,'legacy');assert.match(read(root,key).entries[id].migration,/^[a-f0-9]{64}$/);assert.equal(await redis.get(id),'legacy');assert.equal(redis.raw.has(id),false);assert.equal(read(root,key).entries[id].migration,undefined);
});
test('Redis without exact expiry support keeps expiring legacy records but can migrate persistent ones',async t=>{
  const{redis}=install(t,{expiryAtomic:false});const id='miao:rank:uid-info:100000007';redis.raw.set(id,{type:'string',value:'legacy',expiresAt:Date.now()+10000});await rejects(redis.get(id),'MIGRATION_ATOMIC_REQUIRED');assert.equal(redis.raw.has(id),true);
  redis.raw.get(id).expiresAt=null;assert.equal(await redis.get(id),'legacy');assert.equal(redis.raw.has(id),false);
});
