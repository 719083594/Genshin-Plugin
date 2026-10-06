import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {ConfigStore} from '../lib/config.mjs';
import {encryptJson,decryptJson} from '../lib/encrypted-json.mjs';
import {installNativeStorage,NativeStorageError,sanitizeNativeCache} from '../lib/native-storage.mjs';

const UID='123456789',QQ='987654321',VERSION='Teyvat-Plugin/native-miao-cache/v1';
const panel='/data/PlayerData/gs/'+UID+'.json',user='/data/UserData/'+UID+'.json';
function workspace(t,{migrate=true,install=true}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-native-storage-'));
  const botRoot=path.join(root,'host');fs.mkdirSync(botRoot);
  const key=new ConfigStore(root).init().credentialsKey;
  const calls=[];
  const Data={
    readJSON(...args){calls.push({method:'readJSON',args,thisValue:this});return {public:true}},
    writeJSON(...args){calls.push({method:'writeJSON',args,thisValue:this});return 'public-written'},
    delFile(...args){calls.push({method:'delFile',args,thisValue:this});return 'public-deleted'}
  };
  const original={...Data};let guard;
  const start=options=>{guard=installNativeStorage({Data,root,botRoot,...options});return guard};
  if(install)start({migrate});
  t.after(()=>{
    guard?.restore();
    const absolute=path.resolve(root);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.ok(path.basename(absolute).startsWith('teyvat-native-storage-'));
    fs.rmSync(absolute,{recursive:true,force:true});
  });
  const legacy=file=>path.join(botRoot,...file.replace(/^\//,'').split('/'));
  const target=file=>{
    const logical=file.replace(/^\//,'');const aad=VERSION+'/'+logical;
    return path.join(root,'data/native-cache/miao',createHmac('sha256',Buffer.from(key,'hex')).update(aad).digest('hex')+'.enc.json');
  };
  const writeLegacy=(file,data)=>{const location=legacy(file);fs.mkdirSync(path.dirname(location),{recursive:true});fs.writeFileSync(location,typeof data==='string'?data:JSON.stringify(data));return location};
  const cached=file=>JSON.parse(fs.readFileSync(target(file),'utf8'));
  const decoded=file=>decryptJson(cached(file),{key,aad:VERSION+'/'+file.replace(/^\//,'')});
  return {root,botRoot,key,Data,calls,start,original,legacy,target,writeLegacy,cached,decoded,get guard(){return guard}};
}
const code=expected=>error=>error instanceof NativeStorageError&&error.code===expected&&!error.message.includes(UID)&&!error.message.includes('test-private-token');

test('real credentialsKey encrypts all profile/account metadata and HMAC filenames hide UID/QQ',t=>{
  const w=workspace(t);const data={uid:UID,qq:QQ,name:'private-nickname',avatars:{10000002:{level:90}}};
  assert.equal(w.Data.writeJSON(panel,data,'root'),undefined);
  assert.deepEqual(w.Data.readJSON(panel,'root'),data);
  assert.equal(fs.existsSync(w.legacy(panel)),false);
  const content=fs.readFileSync(w.target(panel),'utf8');
  for(const secret of [UID,QQ,'private-nickname','10000002'])assert.ok(!content.includes(secret));
  assert.match(path.basename(w.target(panel)),/^[a-f\d]{64}\.enc\.json$/);
  assert.deepEqual(w.decoded(panel).data,data);assert.deepEqual(w.calls,[]);
});

test('both Data.writeJSON signatures, path/name config, aliases and sync deletion preserve return contracts',t=>{
  const w=workspace(t);
  for(const root of ['',undefined,'root','yunzai']) {
    w.Data.writeJSON({path:'/data/PlayerData/gs',name:UID+'.json',data:{uid:UID,root:root??null},root,space:0,rn:true});
    assert.equal(w.Data.readJSON('data/PlayerData/gs/'+UID+'.json',root).uid,UID);
  }
  w.Data.writeJSON(user,{chars:{10000002:{level:80}},info:{level:55}},'',4);
  assert.equal(w.Data.readJSON(user,'yunzai').chars[10000002].level,80);
  assert.equal(w.Data.delFile(user,'root'),true);assert.deepEqual(w.Data.readJSON(user,'root'),{});
  assert.equal(w.Data.delFile(user,'root'),true);
  assert.equal(w.Data.delFile(panel,'root'),true);assert.equal(fs.existsSync(w.target(panel)),false);
});

test('public resources, SR, plugin roots and unrelated cache paths delegate unchanged',t=>{
  const w=workspace(t);
  for(const [file,root] of [['resources/meta-gs/character/test/data.json','miao'],['/data/PlayerData/sr/123456.json','root'],[panel,'miao'],[user,'other-plugin'],['data/NoteData/123456789.json','root']]) {
    assert.deepEqual(w.Data.readJSON(file,root),{public:true});
    assert.equal(w.Data.writeJSON(file,{public:'value'},root,0),'public-written');
    assert.equal(w.Data.delFile(file,root),'public-deleted');
  }
  assert.equal(w.calls.length,15);assert.ok(w.calls.every(call=>call.thisValue===w.Data));
});

test('credential keys at all depths and embedded Cookie text are removed without mutating input',t=>{
  const w=workspace(t),cookie='ltuid=444444; cookie_token=test-private-token;';
  const data={uid:UID,_ck:{cookie},Cookie:cookie,avatars:[{level:90,secret:'not-persisted',nest:{cookie_token:'not-persisted',ltoken:'not-persisted',authkey:'not-persisted',safe:{attack:100}}}],_res:{headers:{Cookie:cookie}},extra:{Authorization:'Bearer secret',ckInfo:{ck:cookie},stoken:'not-persisted',ltuid:444444},texts:[cookie,'ordinary text']};
  const before=structuredClone(data);w.Data.writeJSON(panel,data,'root');
  assert.deepEqual(data,before);
  const expected={uid:UID,avatars:[{level:90,nest:{safe:{attack:100}}}],extra:{},texts:[null,'ordinary text']};
  assert.deepEqual(w.Data.readJSON(panel,'root'),expected);
  assert.deepEqual(w.decoded(panel).data,expected);
  assert.ok(!JSON.stringify(w.cached(panel)).includes('not-persisted'));
});

test('protected traversal, invalid filenames, nested paths and non-JSON paths never fall back',t=>{
  const w=workspace(t);
  const paths=['data/PlayerData/gs/../sr/'+UID+'.json','data/PlayerData/sr/../gs/'+UID+'.json','../host/data/UserData/'+UID+'.json','data/UserData/../../outside.json','data/UserData/folder/'+UID+'.json','data/UserData/'+UID+'.txt','data/UserData','data/PlayerData/gs/../gs/'+UID+'.json'];
  for(const file of paths) {
    assert.throws(()=>w.Data.readJSON(file,'root'),code('CACHE_UNSAFE_PATH'));
    assert.throws(()=>w.Data.writeJSON(file,{uid:UID},'root'),code('CACHE_UNSAFE_PATH'));
    assert.throws(()=>w.Data.delFile(file,'root'),code('CACHE_UNSAFE_PATH'));
  }
  assert.deepEqual(w.calls,[]);
});

test('separator variants canonicalize to one encrypted identity',t=>{
  const w=workspace(t);w.Data.writeJSON('\\data\\PlayerData\\gs\\'+UID+'.json',{uid:UID},'root');
  assert.deepEqual(w.Data.readJSON('/data//PlayerData/gs/'+UID+'.json','root'),{uid:UID});
  assert.deepEqual(w.Data.readJSON('./data/PlayerData/gs/'+UID+'.json','root'),{uid:UID});
});

test('startup migration encrypts both bounded legacy directories, strips CK, verifies then deletes source',t=>{
  const w=workspace(t,{install:false});
  const first=w.writeLegacy(panel,{uid:UID,_ck:'private-cookie',avatars:{10000002:{level:90}}});
  const oldUser={uid:UID,chars:{10000002:{artis:{mainId:1,attrIds:[1,2]},_level:90}},avatars:{10000003:{level:80}},_profile:123,info:{stats:{fieldExtMap:{count:42}}},nested:{Cookie:'private-cookie'}};
  const second=w.writeLegacy(user,oldUser);
  const guard=w.start();assert.equal(guard.migrations,2);assert.equal(guard.state,'installed');
  assert.equal(fs.existsSync(first),false);assert.equal(fs.existsSync(second),false);
  assert.deepEqual(w.Data.readJSON(panel,'root'),{uid:UID,avatars:{10000002:{level:90}}});
  assert.deepEqual(w.Data.readJSON(user),sanitizeNativeCache(oldUser));
  assert.equal(w.Data.readJSON(user).chars[10000002]._level,90); // Storage preserves old schema; no unsafe Trans.init.
});

test('lazy read migration and deletion migrate only the requested file',t=>{
  const w=workspace(t,{migrate:false});
  const source=w.writeLegacy(panel,{uid:UID,avatars:{}}),other=w.writeLegacy(user,{uid:UID,chars:{}});
  assert.deepEqual(w.Data.readJSON(panel,'root'),{uid:UID,avatars:{}});assert.equal(fs.existsSync(source),false);assert.equal(fs.existsSync(other),true);
  assert.equal(w.Data.delFile(user),true);assert.equal(fs.existsSync(other),false);assert.equal(fs.existsSync(w.target(user)),false);
});

test('damaged migration preserves original bytes, keeps guard active and can retry after repair',t=>{
  const w=workspace(t,{install:false});const source=w.writeLegacy(panel,'{broken');
  assert.throws(()=>w.start(),code('CACHE_INVALID_JSON'));
  assert.equal(fs.readFileSync(source,'utf8'),'{broken');
  assert.throws(()=>w.Data.readJSON(panel,'root'),code('CACHE_INVALID_JSON'));assert.deepEqual(w.calls,[]);
  fs.writeFileSync(source,JSON.stringify({uid:UID,avatars:{}}));
  const guard=w.start();assert.equal(guard.state,'installed');assert.equal(fs.existsSync(source),false);
});

test('same-data cleanup retries after unlink failure even when encrypted target already exists',t=>{
  const w=workspace(t,{migrate:false});const source=w.writeLegacy(panel,{uid:UID,avatars:{}}),original=fs.unlinkSync;
  try {
    fs.unlinkSync=function(file){if(path.resolve(file)===source){const error=new Error('injected');error.code='EACCES';throw error}return original.apply(this,arguments)};
    assert.throws(()=>w.Data.readJSON(panel,'root'),code('CACHE_MIGRATION_CLEANUP_FAILED'));
  } finally {fs.unlinkSync=original}
  assert.equal(fs.existsSync(source),true);assert.equal(fs.existsSync(w.target(panel)),true);
  assert.deepEqual(w.Data.readJSON(panel,'root'),{uid:UID,avatars:{}});assert.equal(fs.existsSync(source),false);
});

test('different existing encrypted and legacy cache payloads remain intact with a conflict',t=>{
  const w=workspace(t,{migrate:false});w.Data.writeJSON(panel,{uid:UID,avatars:{new:true}},'root');
  const encryptedBefore=fs.readFileSync(w.target(panel));const source=w.writeLegacy(panel,{uid:UID,avatars:{old:true}}),legacyBefore=fs.readFileSync(source);
  for(const run of [()=>w.Data.readJSON(panel,'root'),()=>w.Data.writeJSON(panel,{uid:UID},'root'),()=>w.Data.delFile(panel,'root')])assert.throws(run,code('CACHE_MIGRATION_CONFLICT'));
  assert.ok(fs.readFileSync(w.target(panel)).equals(encryptedBefore));assert.ok(fs.readFileSync(source).equals(legacyBefore));
});

test('tampered envelope, incorrect AAD and wrong key reject reads, writes and deletions',t=>{
  const w=workspace(t);w.Data.writeJSON(panel,{uid:UID,avatars:{}},'root');
  const valid=fs.readFileSync(w.target(panel),'utf8');
  const wrongAAD=encryptJson({storage:VERSION,family:'data/PlayerData/gs',data:{uid:UID}},{key:w.key,aad:VERSION+'/data/PlayerData/gs/other.json'});
  for(const text of [valid.replace('"tag":"','"tag":"A'),JSON.stringify(wrongAAD)]) {
    fs.writeFileSync(w.target(panel),text);
    for(const run of [()=>w.Data.readJSON(panel,'root'),()=>w.Data.writeJSON(panel,{uid:UID},'root'),()=>w.Data.delFile(panel,'root')])assert.throws(run,code('CACHE_DECRYPT_FAILED'));
    assert.equal(fs.readFileSync(w.target(panel),'utf8'),text);
  }
  fs.writeFileSync(w.target(panel),valid);
  assert.throws(()=>w.start({key:'22'.repeat(32)}),code('CACHE_DECRYPT_FAILED'));
  assert.equal(fs.readFileSync(w.target(panel),'utf8'),valid);
});

test('marker blocks wrong-key HMAC empty-store interpretation across fresh Data instances',t=>{
  const w=workspace(t);w.Data.writeJSON(panel,{uid:UID},'root');const before=fs.readFileSync(w.target(panel));w.guard.restore();
  const Data={...w.original};assert.throws(()=>installNativeStorage({Data,root:w.root,botRoot:w.botRoot,key:'22'.repeat(32)}),code('CACHE_DECRYPT_FAILED'));
  assert.throws(()=>Data.readJSON(panel,'root'),code('CACHE_NOT_READY'));assert.throws(()=>Data.writeJSON(panel,{uid:UID},'root'),code('CACHE_NOT_READY'));
  assert.deepEqual(w.calls,[]);assert.ok(fs.readFileSync(w.target(panel)).equals(before));
  const repaired=installNativeStorage({Data,root:w.root,botRoot:w.botRoot,key:w.key});assert.deepEqual(Data.readJSON(panel,'root'),{uid:UID});repaired.restore();
});

test('a missing or damaged marker rejects operations instead of initializing another cache',t=>{
  const w=workspace(t);w.Data.writeJSON(panel,{uid:UID},'root');const marker=path.join(w.root,'data/native-cache/miao/key-check.enc.json');
  fs.unlinkSync(marker);
  assert.throws(()=>w.Data.readJSON(panel,'root'),code('CACHE_KEY_CHECK_MISSING'));
  assert.throws(()=>w.Data.writeJSON(panel,{uid:UID},'root'),code('CACHE_KEY_CHECK_MISSING'));
  w.guard.restore();assert.throws(()=>w.start(),code('CACHE_KEY_CHECK_MISSING'));assert.deepEqual(w.calls,[]);
});

test('symlink/hardlink/ancestor redirection are rejected without modifying targets',t=>{
  const w=workspace(t,{migrate:false});const outside=path.join(w.root,'outside.json');fs.writeFileSync(outside,'{"secret":"outside"}');
  fs.mkdirSync(path.dirname(w.legacy(panel)),{recursive:true});
  // Hardlinks are available without developer-mode symlink privileges on Windows.
  fs.linkSync(outside,w.legacy(panel));assert.throws(()=>w.Data.readJSON(panel,'root'),code('CACHE_UNSAFE_PATH'));
  assert.equal(fs.readFileSync(outside,'utf8'),'{"secret":"outside"}');fs.unlinkSync(w.legacy(panel));
  const originalDirectory=path.dirname(w.legacy(user)),outsideDirectory=path.join(w.root,'outside-dir');fs.mkdirSync(outsideDirectory);
  fs.symlinkSync(outsideDirectory,originalDirectory,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>w.Data.writeJSON(user,{uid:UID},'root'),code('CACHE_UNSAFE_PATH'));
  assert.equal(fs.readdirSync(outsideDirectory).length,0);
});

test('encrypted storage symlink paths and non-regular sources are rejected',t=>{
  const w=workspace(t,{migrate:false});
  fs.mkdirSync(w.legacy(panel),{recursive:true});assert.throws(()=>w.Data.readJSON(panel,'root'),code('CACHE_UNSAFE_PATH'));
  fs.rmdirSync(w.legacy(panel));
  const targetDirectory=path.join(w.root,'data/native-cache/miao'),moved=targetDirectory+'-original';fs.renameSync(targetDirectory,moved);
  fs.symlinkSync(moved,targetDirectory,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>w.Data.writeJSON(panel,{uid:UID},'root'),code('CACHE_UNSAFE_PATH'));
  fs.unlinkSync(targetDirectory);fs.renameSync(moved,targetDirectory);
});

test('encryption rename failure preserves plaintext and removes only owned temporary files',t=>{
  const w=workspace(t,{migrate:false});const source=w.writeLegacy(panel,{uid:UID}),before=fs.readFileSync(source);const original=fs.renameSync;
  try {
    fs.renameSync=function(from,to){if(path.resolve(to)===w.target(panel))throw new Error('injected');return original.apply(this,arguments)};
    assert.throws(()=>w.Data.readJSON(panel,'root'),code('CACHE_WRITE_FAILED'));
  } finally {fs.renameSync=original}
  assert.ok(fs.readFileSync(source).equals(before));assert.equal(fs.existsSync(w.target(panel)),false);
  assert.ok(!fs.readdirSync(path.dirname(w.target(panel))).some(name=>name.endsWith('.tmp')||name.endsWith('.lock')));
  assert.deepEqual(w.Data.readJSON(panel,'root'),{uid:UID});
});

test('changes to the original during encrypted verification keep the changed source and report conflict',t=>{
  const w=workspace(t,{migrate:false});const source=w.writeLegacy(panel,{uid:UID,value:'before'}),original=fs.renameSync;
  try {
    fs.renameSync=function(from,to){const result=original.apply(this,arguments);if(path.resolve(to)===w.target(panel))fs.writeFileSync(source,JSON.stringify({uid:UID,value:'after'}));return result};
    assert.throws(()=>w.Data.readJSON(panel,'root'),code('CACHE_CHANGED'));
  } finally {fs.renameSync=original}
  assert.equal(JSON.parse(fs.readFileSync(source,'utf8')).value,'after');
  assert.throws(()=>w.Data.readJSON(panel,'root'),code('CACHE_MIGRATION_CONFLICT'));
});

test('cross-process lock contention fails closed without touching either source or encrypted data',t=>{
  const w=workspace(t,{migrate:false});const source=w.writeLegacy(panel,{uid:UID});const lock=w.target(panel)+'.lock';fs.writeFileSync(lock,'');
  for(const run of [()=>w.Data.readJSON(panel,'root'),()=>w.Data.writeJSON(panel,{uid:UID},'root'),()=>w.Data.delFile(panel,'root')])assert.throws(run,code('CACHE_BUSY'));
  assert.equal(fs.existsSync(source),true);assert.equal(fs.existsSync(w.target(panel)),false);assert.equal(fs.existsSync(lock),true);
  fs.unlinkSync(lock);assert.deepEqual(w.Data.readJSON(panel,'root'),{uid:UID});
});

test('oversize/cyclic payloads cannot replace prior encrypted cache and invalid config never falls back',t=>{
  const w=workspace(t,{install:false});const guard=w.start({maxBytes:1024});w.Data.writeJSON(panel,{uid:UID},'root');const before=fs.readFileSync(w.target(panel));
  assert.throws(()=>w.Data.writeJSON(panel,{large:'x'.repeat(2000)},'root'),code('CACHE_ENCRYPT_FAILED'));
  const cyclic={};cyclic.loop=cyclic;assert.throws(()=>w.Data.writeJSON(panel,cyclic,'root'),code('CACHE_INVALID_JSON'));
  assert.ok(fs.readFileSync(w.target(panel)).equals(before));guard.restore();
  assert.throws(()=>w.start({key:'bad'}),code('CACHE_INVALID_KEY'));assert.throws(()=>w.Data.readJSON(panel,'root'),code('CACHE_NOT_READY'));
  w.start();assert.deepEqual(w.Data.readJSON(panel,'root'),{uid:UID});
});

test('repeat install does not wrap twice; standalone missing Data is inert',t=>{
  const w=workspace(t),read=w.Data.readJSON,guard=w.start();assert.equal(w.Data.readJSON,read);assert.equal(guard,w.guard);
  assert.throws(()=>w.start({botRoot:path.join(w.root,'another')}),code('CACHE_ALREADY_INSTALLED'));
  assert.equal(installNativeStorage().state,'missing');
});

test('sparse arrays and normal JSON values keep compatibility while raw authkey links are discarded',t=>{
  const w=workspace(t);const sparse=[];sparse[2]=NaN;
  w.Data.writeJSON(panel,{sparse,optional:undefined,callback(){},when:new Date('2026-10-07T00:00:00Z'),url:'https://example.test/path?authkey=private-value'},'root');
  assert.deepEqual(w.Data.readJSON(panel,'root'),{sparse:[null,null,null],when:'2026-10-07T00:00:00.000Z',url:null});
});
