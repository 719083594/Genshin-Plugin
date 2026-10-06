import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHmac,randomUUID} from 'node:crypto';
import {ConfigStore} from './config.mjs';
import {encryptJson,decryptJson} from './encrypted-json.mjs';

// miao-plugin b01d77483268eb2236876ad0995fab27052c09ad:
// components/Data.js readJSON(file,root), writeJSON(file,data,root,space) or
// writeJSON({path,name,data,root,space,rn}), delFile(file,root).
// models/Player.js uses /data/PlayerData/gs/<UID>.json with root='root'.
// This guard does not run tools/trans.js or modify public resources, SR files,
// ProfileRank/User/ProfileReq Redis, other native plugins or their filesystem.
const installed=new WeakMap();
const FAMILIES=['data/PlayerData/gs','data/UserData'];
const VERSION='Teyvat-Plugin/native-miao-cache/v1';
const MARKER_AAD=VERSION+'/key-check';
const rootDefault=fileURLToPath(new URL('..',import.meta.url));

export class NativeStorageError extends Error {
  constructor(code,message='原生缓存未完成加密或完整性核验；已保留源数据，请检查配置与迁移状态。') {
    super(message);this.name='NativeStorageError';this.code=code;
  }
}
const fail=code=>{throw new NativeStorageError(code)};
const isObject=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const inside=(base,file)=>{const relative=path.relative(base,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))};

function forbiddenKey(key) {
  const name=key.toLowerCase().replace(/[^a-z0-9]/g,'');
  return key==='_res'||['ck','ckinfo','ckdata','authorization','passwd','ltuid','ltuidv2','ltmid','ltmidv2','accountmidv2'].includes(name)||['cookie','token','authkey','password','secret','credential'].some(part=>name.includes(part));
}
const cookieText=/(?:^|[;\s?&])(?:cookie[_-]?token(?:_v2)?|[ls]token(?:_v2)?|ltuid(?:_v2)?|authkey)\s*=/i;

/** Clone JSON-compatible cache data and discard credentials at every depth. */
export function sanitizeNativeCache(value) {
  const parents=new Set();let count=0;
  const visit=(item,depth,arrayItem=false)=>{
    if(++count>250000||depth>64)fail('CACHE_TOO_COMPLEX');
    if(item===null)return null;
    if(typeof item==='string')return cookieText.test(item)?null:item;
    if(typeof item==='number')return Number.isFinite(item)?item:null;
    if(typeof item==='boolean')return item;
    if(['undefined','function','symbol'].includes(typeof item))return arrayItem?null:undefined;
    if(typeof item==='bigint')fail('CACHE_INVALID_JSON');
    if(typeof item!=='object')fail('CACHE_INVALID_JSON');
    if(parents.has(item))fail('CACHE_INVALID_JSON');
    if(item instanceof Date)return Number.isFinite(item.getTime())?item.toISOString():null;
    parents.add(item);
    try {
      if(Array.isArray(item)){if(item.length>250000)fail('CACHE_TOO_COMPLEX');return Array.from(item,child=>visit(child,depth+1,true))}
      const result={};
      for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if(!descriptor.enumerable||forbiddenKey(key)||!('value'in descriptor))continue;
        const child=visit(descriptor.value,depth+1);
        if(child!==undefined)Object.defineProperty(result,key,{value:child,enumerable:true,writable:true,configurable:true});
      }
      return result;
    } finally {parents.delete(item)}
  };
  try {const result=visit(value,0);if(!isObject(result)&&!Array.isArray(result))fail('CACHE_INVALID_JSON');return result}
  catch(error){if(error instanceof NativeStorageError)throw error;fail('CACHE_INVALID_JSON')}
}

function classification(file,root,botRoot) {
  if(root&&root!=='root'&&root!=='yunzai')return null;
  if(typeof file!=='string')return null;
  const raw=file.replace(/\\/g,'/').replace(/^\/+|^\.\//g,'').replace(/\/{2,}/g,'/');
  const normalized=path.posix.normalize(raw);
  const familyOf=text=>FAMILIES.find(base=>text.toLowerCase()===base.toLowerCase()||text.toLowerCase().startsWith(base.toLowerCase()+'/'));
  const physical=botRoot?path.relative(botRoot,path.resolve(botRoot,raw)).replace(/\\/g,'/'):'';
  const family=familyOf(raw)||familyOf(normalized)||familyOf(physical);
  if(!family)return null;
  // Never fall back to the original Data implementation for malformed paths
  // into either protected family (including traversal arriving via SR).
  if(file.length>4096||file.includes('\0')||raw.split('/').some(part=>part==='..'||part==='.')||normalized!==raw)fail('CACHE_UNSAFE_PATH');
  const suffix=raw.slice(family.length+1);
  if(!/^[a-zA-Z0-9_-]{1,128}\.json$/.test(suffix))fail('CACHE_UNSAFE_PATH');
  return {family,file:suffix,logical:family+'/'+suffix};
}

function checkPath(base,file,{directory=false,missing=true}={}) {
  if(!inside(base,file))fail('CACHE_UNSAFE_PATH');
  const relative=path.relative(base,file),parts=relative?relative.split(path.sep):[];
  let candidate=base;
  for(let i=0;i<=parts.length;i++) {
    if(i)candidate=path.join(candidate,parts[i-1]);
    let stat;try{stat=fs.lstatSync(candidate)}catch(error){if(error.code==='ENOENT'&&missing)return null;fail('CACHE_PATH_FAILED')}
    if(stat.isSymbolicLink())fail('CACHE_UNSAFE_PATH');
    if(i<parts.length||directory){if(!stat.isDirectory())fail('CACHE_UNSAFE_PATH')}
    else if(!stat.isFile()||stat.nlink!==1)fail('CACHE_UNSAFE_PATH');
  }
  return fs.lstatSync(file);
}

function readSnapshot(base,file,limit) {
  const previous=checkPath(base,file);if(!previous)return null;
  if(previous.size>limit)fail('CACHE_SIZE_LIMIT');
  let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    const first=fs.fstatSync(fd);
    if(!first.isFile()||first.nlink!==1||!same(previous,first))fail('CACHE_CHANGED');
    const raw=Buffer.alloc(first.size+1);let length=0;
    while(length<raw.length){const got=fs.readSync(fd,raw,length,raw.length-length,null);if(!got)break;length+=got}
    const last=fs.fstatSync(fd);
    if(length!==first.size||!same(first,last)||!same(last,fs.lstatSync(file)))fail('CACHE_CHANGED');
    return {file,stat:last,raw:raw.subarray(0,length)};
  } catch(error){if(error instanceof NativeStorageError)throw error;fail('CACHE_READ_FAILED')}
  finally{if(fd!==undefined)fs.closeSync(fd)}
}

function unchanged(base,snapshot,limit) {
  const fresh=readSnapshot(base,snapshot.file,limit);
  if(!fresh||!same(fresh.stat,snapshot.stat)||!fresh.raw.equals(snapshot.raw))fail('CACHE_CHANGED');
}

class MiaoCacheStore {
  constructor({root,botRoot,key,maxBytes}) {
    this.root=path.resolve(root);this.botRoot=path.resolve(botRoot);
    this.directory=path.join(this.root,'data/native-cache/miao');
    this.key=typeof key==='string'&&/^[a-f\d]{64}$/i.test(key)?Buffer.from(key,'hex'):Buffer.isBuffer(key)?Buffer.from(key):null;
    if(!this.key||this.key.length!==32)fail('CACHE_INVALID_KEY');
    if(!Number.isInteger(maxBytes)||maxBytes<1024||maxBytes>32*1024*1024)fail('CACHE_SIZE_LIMIT');
    this.maxBytes=maxBytes;this.envelopeLimit=Math.ceil(maxBytes*4/3)+4096;
    checkPath(this.root,this.directory,{directory:true});
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    checkPath(this.root,this.directory,{directory:true,missing:false});
    this.marker=path.join(this.directory,'key-check.enc.json');
    this.migrations=0;this.ensureMarker();
  }
  options(aad){return {key:this.key,aad,maxBytes:this.maxBytes}}
  identity(entry) {
    const aad=VERSION+'/'+entry.logical;
    const name=createHmac('sha256',this.key).update(aad).digest('hex')+'.enc.json';
    return {aad,target:path.join(this.directory,name),legacy:path.join(this.botRoot,...entry.logical.split('/')),lock:path.join(this.directory,name+'.lock')};
  }
  parse(snapshot) {try{return JSON.parse(snapshot.raw.toString('utf8'))}catch{fail('CACHE_INVALID_JSON')}}
  decode(snapshot,aad) {try{return decryptJson(this.parse(snapshot),this.options(aad))}catch(error){if(error instanceof NativeStorageError)throw error;fail('CACHE_DECRYPT_FAILED')}}
  ensureMarker() {
    const snapshot=readSnapshot(this.root,this.marker,this.envelopeLimit);
    if(!snapshot) {
      if(fs.readdirSync(this.directory).some(name=>name!==path.basename(this.marker)))fail('CACHE_KEY_CHECK_MISSING');
      this.atomic(this.marker,{storage:VERSION,kind:'key-check'},MARKER_AAD,{exclusive:true});
    }
    this.verifyMarker();
  }
  verifyMarker() {
    const snapshot=readSnapshot(this.root,this.marker,this.envelopeLimit);if(!snapshot)fail('CACHE_KEY_CHECK_MISSING');
    const payload=this.decode(snapshot,MARKER_AAD);
    if(payload?.storage!==VERSION||payload?.kind!=='key-check')fail('CACHE_DECRYPT_FAILED');
  }
  atomic(file,payload,aad,{exclusive=false}={}) {
    checkPath(this.root,this.directory,{directory:true,missing:false});
    checkPath(this.root,file);
    const temp=file+'.'+randomUUID()+'.tmp';let fd;
    try {
      let envelope;try{envelope=encryptJson(payload,this.options(aad))}catch{fail('CACHE_ENCRYPT_FAILED')}
      fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(envelope)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      const staged=readSnapshot(this.root,temp,this.envelopeLimit);
      if(JSON.stringify(this.decode(staged,aad))!==JSON.stringify(payload))fail('CACHE_VERIFY_FAILED');
      checkPath(this.root,file);
      if(exclusive&&fs.existsSync(file))fail('CACHE_BUSY');
      fs.renameSync(temp,file);
      const saved=readSnapshot(this.root,file,this.envelopeLimit);
      if(JSON.stringify(this.decode(saved,aad))!==JSON.stringify(payload))fail('CACHE_VERIFY_FAILED');
    } catch(error){if(error instanceof NativeStorageError)throw error;fail('CACHE_WRITE_FAILED')}
    finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp)){checkPath(this.root,temp);fs.unlinkSync(temp)}}
  }
  payload(entry,data){return {storage:VERSION,family:entry.family,data}}
  targetData(entry,identity) {
    const snapshot=readSnapshot(this.root,identity.target,this.envelopeLimit);if(!snapshot)return null;
    const payload=this.decode(snapshot,identity.aad);
    if(payload?.storage!==VERSION||payload.family!==entry.family||(!isObject(payload.data)&&!Array.isArray(payload.data)))fail('CACHE_INVALID_JSON');
    const data=sanitizeNativeCache(payload.data);
    return {snapshot,data,needsRewrite:JSON.stringify(data)!==JSON.stringify(payload.data)};
  }
  migrate(entry,identity) {
    const old=readSnapshot(this.botRoot,identity.legacy,this.maxBytes);
    let target=this.targetData(entry,identity);
    if(old) {
      const data=sanitizeNativeCache(this.parse(old));
      if(target&&JSON.stringify(target.data)!==JSON.stringify(data))fail('CACHE_MIGRATION_CONFLICT');
      if(!target||target.needsRewrite)this.atomic(identity.target,this.payload(entry,data),identity.aad);
      target=this.targetData(entry,identity);
      if(!target||JSON.stringify(target.data)!==JSON.stringify(data))fail('CACHE_VERIFY_FAILED');
      unchanged(this.botRoot,old,this.maxBytes);
      unchanged(this.root,target.snapshot,this.envelopeLimit);
      try{fs.unlinkSync(identity.legacy)}catch{fail('CACHE_MIGRATION_CLEANUP_FAILED')}
      this.migrations++;
    } else if(target?.needsRewrite) {
      this.atomic(identity.target,this.payload(entry,target.data),identity.aad);
      target=this.targetData(entry,identity);
    }
    return target;
  }
  access(entry,action,data) {
    this.verifyMarker();const identity=this.identity(entry);
    checkPath(this.root,identity.lock);let fd;
    try {
      try{fd=fs.openSync(identity.lock,'wx',0o600)}catch(error){if(error.code==='EEXIST')fail('CACHE_BUSY');fail('CACHE_LOCK_FAILED')}
      this.verifyMarker();
      const current=this.migrate(entry,identity);
      if(action==='read')return current?current.data:{};
      if(action==='write') {
        const clean=sanitizeNativeCache(data);
        this.atomic(identity.target,this.payload(entry,clean),identity.aad);
        return undefined;
      }
      if(action==='delete') {
        if(current){unchanged(this.root,current.snapshot,this.envelopeLimit);fs.unlinkSync(identity.target)}
        return true;
      }
      fail('CACHE_INVALID_OPERATION');
    } catch(error){if(error instanceof NativeStorageError)throw error;fail('CACHE_OPERATION_FAILED')}
    finally{if(fd!==undefined){fs.closeSync(fd);checkPath(this.root,identity.lock);fs.unlinkSync(identity.lock)}}
  }
  migrateLegacy() {
    this.verifyMarker();
    for(const family of FAMILIES) {
      const directory=path.join(this.botRoot,...family.split('/'));
      if(!checkPath(this.botRoot,directory,{directory:true}))continue;
      const files=fs.readdirSync(directory,{withFileTypes:true});if(files.length>100000)fail('CACHE_TOO_COMPLEX');
      for(const file of files) {
        if(!file.isFile()||!file.name.endsWith('.json'))fail('CACHE_MIGRATION_LAYOUT_UNSUPPORTED');
        const entry=classification(family+'/'+file.name,'root');
        this.access(entry,'read');
      }
    }
    return this.migrations;
  }
}

/** Install before loading native message classes. A failed eager migration keeps
 * the guard installed and throws; do not restore it to obtain a plaintext fallback.
 * restore is intended for tests or an explicitly disabled native provider.
 */
export function installNativeStorage({Data,root=rootDefault,botRoot=path.resolve(root,'../..'),key,maxBytes=16*1024*1024,migrate=true}={}) {
  if(!Data)return {state:'missing',migrations:0,restore(){}};
  if(!['readJSON','writeJSON','delFile'].every(name=>typeof Data[name]==='function'))fail('CACHE_INCOMPATIBLE_DATA');
  const previous=installed.get(Data);
  if(previous) {
    if(path.resolve(root)!==previous.root||path.resolve(botRoot)!==previous.botRoot)fail('CACHE_ALREADY_INSTALLED');
    previous.initialize(key,migrate);
    return previous;
  }
  let store=null;
  const requireStore=()=>{if(!store)fail('CACHE_NOT_READY');return store};
  const originals=Object.fromEntries(['readJSON','writeJSON','delFile'].map(name=>[name,Data[name]]));
  const wrappers={
    readJSON(file='',root='') {const entry=classification(file,root,path.resolve(botRoot));return entry?requireStore().access(entry,'read'):originals.readJSON.apply(this,arguments)},
    writeJSON(cfg,data,root='',space=2) {
      const objectForm=arguments.length===1&&isObject(cfg);
      const file=objectForm?(cfg.path?cfg.path+'/'+cfg.name:cfg.name):cfg;
      const entry=classification(file,objectForm?cfg.root:root,path.resolve(botRoot));
      return entry?requireStore().access(entry,'write',objectForm?cfg.data:data):originals.writeJSON.apply(this,arguments);
    },
    delFile(file,root='') {const entry=classification(file,root,path.resolve(botRoot));return entry?requireStore().access(entry,'delete'):originals.delFile.apply(this,arguments)}
  };
  const guard={state:'initializing',root:path.resolve(root),botRoot:path.resolve(botRoot),get migrations(){return store?.migrations||0},
    initialize(value,shouldMigrate=true){
      try {
        const actualKey=value??new ConfigStore(root).read().credentialsKey;
        if(store)guard.verifyKey(actualKey);
        else store=new MiaoCacheStore({root,botRoot,key:actualKey,maxBytes});
        guard.state='installed';if(shouldMigrate)guard.migrateLegacy();
      } catch(error){if(guard.state!=='migration_error')guard.state='initialization_error';if(error instanceof NativeStorageError)throw error;fail('CACHE_INVALID_KEY')}
      return guard;
    },
    migrateLegacy(){try{store.migrateLegacy();guard.state='installed';return store.migrations}catch(error){guard.state='migration_error';throw error}},
    verifyKey(value){const active=requireStore();const candidate=typeof value==='string'&&/^[a-f\d]{64}$/i.test(value)?Buffer.from(value,'hex'):Buffer.isBuffer(value)?value:null;if(!candidate||!candidate.equals(active.key))fail('CACHE_DECRYPT_FAILED');active.verifyMarker()},
    restore(){for(const [name,wrapper]of Object.entries(wrappers))if(Data[name]===wrapper)Data[name]=originals[name];installed.delete(Data);store?.key.fill(0);store=null;guard.state='restored'}
  };
  for(const [name,wrapper]of Object.entries(wrappers))Data[name]=wrapper;
  installed.set(Data,guard);
  return guard.initialize(key,migrate);
}

export const nativeStorageSource=Object.freeze({miaoCommit:'b01d77483268eb2236876ad0995fab27052c09ad',protectedFamilies:[...FAMILIES],limitations:['只钩Data的文件API，不钩全局fs或Redis','旧UserData只加密保存，不执行格式转换或明文备份','ProfileRank、User偏好、ProfileReq冷却及其他原生缓存需分别适配']});
