/** Reviewed native Redis namespaces. Their keys, members, scores and values never
 * go to Redis after interception. This is a compatibility store, not a Redis sandbox. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { encryptJson, decryptJson } from './encrypted-json.mjs';

export const NATIVE_REDIS_PREFIXES = Object.freeze([
  'miao:rank:', 'miao:role-card:', 'miao:user-cfg:', 'miao:profile-cd:',
  'FanSky:Teyvet:', 'FanSky:SmallFunctions:ChestTop:', 'FanSky:SmallFunctions:AchieveTop:',
  'xhh:show_', 'xhh:hide_', 'xhh:transformer_'
]);
const AAD = 'Teyvat-Plugin/native-redis/v1', CHECK_AAD = AAD + '/key-check';
const MAX_BYTES = 32 * 1024 * 1024, MAX_KEYS = 20000, MAX_TEXT = 4 * 1024 * 1024;
const installed = new WeakMap();
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => Object.hasOwn(obj, key);
const put = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
const deniedField = /(?:cookie|token|credential|password|passwd|authorization|authkey|secret)|^_?ck$|^pwd$|^ticket$/i;
const credentialText = /(?:^|[;\s?&])(?:ltoken|stoken|cookie_token|authkey|password|access_token|refresh_token)(?:_v2)?\s*=|\bBearer\s+[A-Za-z0-9._~-]+/i;
const credentialKey = key => /^xhh:transformer_ck:/.test(key);

export class NativeRedisError extends Error {
  constructor(code, message) { super(message); this.name = 'NativeRedisError'; this.code = code; }
}
const fail = (code, message) => { throw new NativeRedisError(code, message); };

/** Sanitizes JSON inside Redis strings too; does not mutate caller data. */
function clean(value, depth = 0, seen = new WeakSet()) {
  if (depth > 80) fail('INVALID_VALUE', '原生缓存嵌套过深。');
  if (typeof value === 'string') return credentialText.test(value) ? '' : value;
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) fail('INVALID_VALUE', '原生缓存必须为有效 JSON 数据。');
  seen.add(value);
  const result = Array.isArray(value) ? [] : Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(value) || !deniedField.test(key)) put(result, key, clean(item, depth + 1, seen));
  }
  seen.delete(value); return result;
}
function textValue(value) {
  if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) fail('INVALID_VALUE', 'Redis 缓存值需为字符串或有效数值。');
  let text = String(value);
  if (Buffer.byteLength(text) > MAX_TEXT) fail('SIZE_LIMIT', '原生缓存值超过大小上限。');
  try { text = JSON.stringify(clean(JSON.parse(text))); }
  catch (error) { if (error instanceof NativeRedisError) throw error; text = clean(text); }
  return text;
}
function stringKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > 2048 || /[\x00-\x1f\x7f]/.test(key)) fail('INVALID_KEY', 'Redis 缓存键无效。');
  if (credentialText.test(key)) fail('CREDENTIAL_CACHE_FORBIDDEN', '缓存键或成员中不接受凭据。');
  return key;
}
const controlled = key => typeof key === 'string' && NATIVE_REDIS_PREFIXES.some(prefix => key.startsWith(prefix));
function parseKey(key) {
  let bytes;
  if (Buffer.isBuffer(key) || key instanceof Uint8Array) bytes = Buffer.from(key);
  else if (typeof key === 'string' && /^[a-f\d]{64}$/i.test(key)) bytes = Buffer.from(key, 'hex');
  else if (typeof key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(key)) { bytes = Buffer.from(key, 'base64'); if (bytes.toString('base64') !== key) bytes = null; }
  if (bytes?.length !== 32) fail('INVALID_KEY', '原生缓存需使用现有的 32 字节账户加密密钥。');
  return bytes;
}
function safeAncestors(target, directory = false) {
  let current = path.resolve(target), first = true;
  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (!first || directory ? !stat.isDirectory() : !stat.isFile()) || (first && !directory && stat.nlink !== 1)) fail('UNSAFE_STORAGE', '原生缓存不接受链接或异常目录/文件。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break;
    current = parent; first = false;
  }
}
function glob(pattern) {
  stringKey(pattern); let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') result += '.*';
    else if (char === '?') result += '.';
    else if (char === '\\' && i + 1 < pattern.length) result += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (char === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) result += '\\[';
      else { let bracket = pattern.slice(i + 1, close); if (bracket.startsWith('!')) bracket = '^' + bracket.slice(1); result += '[' + bracket.replace(/\\/g, '\\\\') + ']'; i = close; }
    } else result += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(result + '$', 's'); } catch { fail('INVALID_PATTERN', 'Redis 键匹配表达式无效。'); }
}
function relevantPattern(pattern) {
  let literal='';
  for(let i=0;i<pattern.length;i++){if(pattern[i]==='\\'&&i+1<pattern.length)literal+=pattern[++i];else if('*?['.includes(pattern[i]))break;else literal+=pattern[i];}
  return NATIVE_REDIS_PREFIXES.some(prefix=>prefix.startsWith(literal)||literal.startsWith(prefix));
}

// Redis >= 7 supplies exact absolute expiry for atomic migration. Older Redis
// can migrate persistent keys; expiring keys remain untouched with an error.
export const NATIVE_REDIS_SNAPSHOT_LUA = `-- teyvat-native-redis-snapshot-v1
local key=KEYS[1]
local kind=redis.call('TYPE',key).ok
if kind=='none' then return cjson.encode({type='none'}) end
if kind~='string' and kind~='hash' and kind~='zset' then return cjson.encode({error='unsupported_type'}) end
local expiry=redis.pcall('PEXPIRETIME',key)
if type(expiry)=='table' then
  if redis.call('PTTL',key)~=-1 then return cjson.encode({error='expiry_atomic_required'}) end
  expiry=-1
end
if expiry==-2 then return cjson.encode({type='none'}) end
local items
if kind=='string' then items={redis.call('GET',key)}
elseif kind=='hash' then items=redis.call('HGETALL',key)
else items=redis.call('ZRANGE',key,0,-1,'WITHSCORES') end
local tm=redis.call('TIME')
return cjson.encode({type=kind,items=items,expireAt=expiry,serverNow=tonumber(tm[1])*1000+math.floor(tonumber(tm[2])/1000)})`;
export const NATIVE_REDIS_DELETE_LUA = `-- teyvat-native-redis-delete-v1
local key=KEYS[1]
local expected=cjson.decode(ARGV[1])
local kind=redis.call('TYPE',key).ok
if kind=='none' then return 2 end
if kind~=expected.type then return 0 end
local expiry=redis.pcall('PEXPIRETIME',key)
if type(expiry)=='table' then
  if expected.expireAt~=-1 or redis.call('PTTL',key)~=-1 then return 0 end
  expiry=-1
end
if expiry~=expected.expireAt then return 0 end
local items=expected.items
if kind=='string' then
  if redis.call('GET',key)~=items[1] then return 0 end
elseif kind=='hash' then
  if redis.call('HLEN',key)~=#items/2 then return 0 end
  for i=1,#items,2 do if redis.call('HGET',key,items[i])~=items[i+1] then return 0 end end
elseif kind=='zset' then
  local actual=redis.call('ZRANGE',key,0,-1,'WITHSCORES')
  if #actual~=#items then return 0 end
  for i=1,#items do if actual[i]~=items[i] then return 0 end end
else return 0 end
return redis.call('DEL',key)`;

function snapshot(value) {
  let source; try { source = typeof value === 'string' ? JSON.parse(value) : value; } catch { fail('MIGRATION_FAILED', '旧 Redis 快照格式无效，原数据已保留。'); }
  if (source?.error === 'expiry_atomic_required') fail('MIGRATION_ATOMIC_REQUIRED', '旧 Redis 缺少绝对到期时间的原子迁移能力，原数据已保留。');
  if (source?.error || !isObject(source)) fail('MIGRATION_FAILED', '旧 Redis 数据类型不支持安全迁移，原数据已保留。');
  if (source.type === 'none') return source;
  if (!['string', 'hash', 'zset'].includes(source.type) || !Array.isArray(source.items) || source.items.some(v => typeof v !== 'string') || (source.type === 'string' ? source.items.length !== 1 : source.items.length % 2 !== 0) || !Number.isSafeInteger(source.expireAt) || source.expireAt < -1 || !Number.isSafeInteger(source.serverNow)) fail('MIGRATION_FAILED', '旧 Redis 快照无法校验，原数据已保留。');
  if (Buffer.byteLength(JSON.stringify(source)) > MAX_BYTES) fail('SIZE_LIMIT', '旧 Redis 数据超过安全迁移上限，原数据已保留。');
  return source;
}
function sourceHash(source) {
  const pairs = source.type === 'hash' ? Array.from({length:source.items.length/2}, (_, i) => source.items.slice(i*2,i*2+2)).sort((a,b) => Buffer.compare(Buffer.from(a[0]),Buffer.from(b[0]))).flat() : source.items;
  return createHash('sha256').update(JSON.stringify([source.type, source.expireAt, pairs])).digest('hex');
}
function sourceEntry(key, source, startedAt) {
  const entry = { type: source.type, value: null, expiresAt: source.expireAt === -1 ? null : startedAt + Math.max(0, source.expireAt - source.serverNow) };
  if (entry.type === 'string') entry.value = credentialKey(key) ? '' : textValue(source.items[0]);
  else {
    entry.value = Object.create(null);
    for (let i=0;i<source.items.length;i+=2) {
      const member = stringKey(source.items[i]);
      if (entry.type === 'hash') { if (!deniedField.test(member)) put(entry.value, member, textValue(source.items[i+1])); }
      else { const score = Number(source.items[i+1]); if (!Number.isFinite(score)) fail('INVALID_SCORE', '旧排行榜分数无效，原数据已保留。'); put(entry.value, member, score); }
    }
  }
  entry.migration = sourceHash(source); return entry;
}
function validateState(state) {
  if (!isObject(state) || state.version !== 1 || !isObject(state.entries) || Object.keys(state.entries).length > MAX_KEYS) fail('INVALID_STORE', '原生缓存结构无法校验，请保留原文件与密钥。');
  for (const [key, entry] of Object.entries(state.entries)) {
    stringKey(key);
    if (!controlled(key) || !isObject(entry) || !['string','hash','zset'].includes(entry.type) || !(entry.expiresAt === null || Number.isSafeInteger(entry.expiresAt)) || (entry.migration !== undefined && !/^[a-f0-9]{64}$/.test(entry.migration))) fail('INVALID_STORE', '原生缓存记录无法校验，请保留原文件。');
    if (entry.type === 'string') { if (typeof entry.value !== 'string') fail('INVALID_STORE', '原生缓存字符串无效。'); }
    else if (!isObject(entry.value) || Object.entries(entry.value).some(([member,value]) => !member.length || member.length > 2048 || (entry.type === 'hash' ? typeof value !== 'string' : !Number.isFinite(value)))) fail('INVALID_STORE', '原生缓存集合无效。');
  }
  return state;
}
function sorted(entry, reverse = false) {
  const values = Object.entries(entry?.value ?? {}).map(([value,score]) => ({value,score}));
  values.sort((a,b) => a.score-b.score || Buffer.compare(Buffer.from(a.value),Buffer.from(b.value)));
  return reverse ? values.reverse() : values;
}
function range(values, start, stop) {
  if (!/^-?\d+$/.test(String(start)) || !/^-?\d+$/.test(String(stop))) fail('INVALID_RANGE', '排行榜下标需为整数。');
  start=Number(start);stop=Number(stop);
  if (!Number.isSafeInteger(start)||!Number.isSafeInteger(stop)) fail('INVALID_RANGE', '排行榜下标超过安全范围。');
  if(start<0)start+=values.length;if(stop<0)stop+=values.length;
  return values.slice(Math.max(0,start),Math.max(0,Math.min(values.length,stop+1)));
}

export function installNativeRedis({ redis, root, key, lockTimeoutMs = 2000 } = {}) {
  if (!redis || (typeof redis !== 'object' && typeof redis !== 'function') || typeof root !== 'string' || !root) fail('INVALID_OPTIONS', '需提供原 Redis、插件目录和现有账户密钥。');
  const secret = parseKey(key), base = path.resolve(root);
  const signature = createHash('sha256').update(secret).digest('hex');
  if (installed.has(redis)) {
    const previous=installed.get(redis); secret.fill(0);
    if(previous.root!==base||previous.signature!==signature) fail('INSTALL_CONFLICT','同一 Redis 已安装其他目录或密钥的适配器。');
    return previous.status;
  }
  lockTimeoutMs = Math.min(5000,Math.max(50,Number(lockTimeoutMs)||2000));
  const directory=path.join(base,'data','native-cache'),file=path.join(directory,'redis.enc.json'),check=path.join(directory,'redis-key-check.enc.json'),lock=path.join(directory,'.redis.lock');
  const names=['get','set','del','exists','expire','ttl','keys','hGet','hSet','hGetAll','hDel','zAdd','zRange','zRangeWithScores','zRevRank','zRank','zScore','zRem','zCard'];
  const original=Object.fromEntries([...names,'eval'].map(name=>[name,typeof redis[name]==='function'?redis[name].bind(redis):null]));
  const call = (name,...args) => { if(!original[name])fail('UNSUPPORTED_REDIS','原 Redis 缺少所需接口。'); return original[name](...args); };
  const codec = aad => ({ key:secret,aad,maxBytes:MAX_BYTES });
  function ensurePaths(){safeAncestors(base,true);safeAncestors(directory,true);fs.mkdirSync(directory,{recursive:true,mode:0o700});safeAncestors(directory,true);for(const target of[file,check,lock])safeAncestors(target);}
  function readEncrypted(target,aad){safeAncestors(target);if(fs.statSync(target).size>MAX_BYTES*1.5)fail('SIZE_LIMIT','原生加密缓存超过大小上限。');return decryptJson(JSON.parse(fs.readFileSync(target,'utf8')),codec(aad));}
  function writeEncrypted(target,value,aad){
    ensurePaths();const tmp=path.join(directory,`.redis-${randomBytes(12).toString('hex')}.tmp`);let fd;
    try{fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(encryptJson(value,codec(aad)))+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;safeAncestors(target);fs.renameSync(tmp,target);fs.chmodSync(target,0o600);}
    finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  }
  function read(){
    ensurePaths();const haveFile=fs.existsSync(file),haveCheck=fs.existsSync(check);
    if(!haveFile&&!haveCheck){writeEncrypted(file,{version:1,entries:{}},AAD);writeEncrypted(check,{version:1,marker:AAD},CHECK_AAD);}
    else if(!haveFile||!haveCheck)fail('STORAGE_METADATA_MISSING','原生缓存或密钥校验文件缺失，请保留现有文件。');
    const marker=readEncrypted(check,CHECK_AAD);if(marker?.version!==1||marker.marker!==AAD)fail('INVALID_STORE','原生缓存密钥校验失败。');
    return validateState(readEncrypted(file,AAD));
  }
  function write(state,verify=false){validateState(state);writeEncrypted(file,state,AAD);if(verify&&JSON.stringify(readEncrypted(file,AAD))!==JSON.stringify(state))fail('MIGRATION_VERIFY_FAILED','加密缓存回读校验失败，旧 Redis 数据已保留。');}
  async function locked(fn){
    const started=Date.now();let fd;
    try{
      while(fd===undefined){ensurePaths();try{fd=fs.openSync(lock,'wx',0o600);}catch(error){if(error.code!=='EEXIST')throw error;if(Date.now()-started>=lockTimeoutMs)fail('STORAGE_BUSY','原生缓存正在更新或存在遗留锁，请稍后重试。');await new Promise(resolve=>setTimeout(resolve,15));}}
      return await fn(read());
    }catch(error){if(error instanceof NativeRedisError)throw error;if(error?.name==='EncryptedJsonError')fail('DECRYPT_FAILED','原生缓存无法解密或校验，请保留原密钥与文件。');fail('STORAGE_FAILED','原生缓存操作失败，请保留原文件与旧 Redis 数据。');}
    finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
  }
  async function migrate(state,key){
    stringKey(key);let source;const started=Date.now();
    if(!original.eval){if(await call('exists',key))fail('MIGRATION_ATOMIC_REQUIRED','旧 Redis 缺少原子迁移接口，原数据已保留。');source={type:'none'};}
    else source=snapshot(await original.eval(NATIVE_REDIS_SNAPSHOT_LUA,{keys:[key],arguments:[]}));
    const entry=own(state.entries,key)?state.entries[key]:null;
    if(source.type==='none'){if(entry?.migration){delete entry.migration;write(state);}return;}
    if(entry){if(!entry.migration||entry.migration!==sourceHash(source))fail('MIGRATION_CONFLICT','旧 Redis 与加密缓存存在变更冲突，双方数据已保留。');}
    else{if(Object.keys(state.entries).length>=MAX_KEYS)fail('SIZE_LIMIT','原生缓存键数量超过上限。');put(state.entries,key,sourceEntry(key,source,started));write(state,true);}
    const removed=Number(await original.eval(NATIVE_REDIS_DELETE_LUA,{keys:[key],arguments:[JSON.stringify(source)]}));
    if(![1,2].includes(removed))fail('MIGRATION_CHANGED','旧 Redis 在迁移期间发生变化，原数据已保留。');
    delete state.entries[key].migration;write(state);
  }
  const live=(state,key)=>{const entry=own(state.entries,key)?state.entries[key]:null;if(entry&&entry.expiresAt!==null&&entry.expiresAt<=Date.now()){delete state.entries[key];return null;}return entry;};
  const typed=(state,key,type,create=false)=>{let entry=live(state,key);if(entry&&entry.type!==type)fail('WRONGTYPE','Redis 缓存类型与命令不匹配。');if(!entry&&create){entry={type,value:type==='string'?'':Object.create(null),expiresAt:null};put(state.entries,key,entry);}return entry;};
  async function one(key,fn,mutates=false){return locked(async state=>{await migrate(state,key);const result=fn(state);if(mutates)write(state);return result;});}
  function setOptions(args){
    let options={};if(args.length===1&&isObject(args[0]))options=args[0];
    else for(let i=0;i<args.length;i++){const option=String(args[i]).toUpperCase();if(['EX','PX','EXAT','PXAT'].includes(option))options[option]=args[++i];else if(['NX','XX','GET','KEEPTTL'].includes(option))options[option]=true;else fail('INVALID_OPTIONS','Redis SET 选项不支持。');}
    if(Object.keys(options).some(k=>!['EX','PX','EXAT','PXAT','NX','XX','GET','KEEPTTL'].includes(k))||(options.NX&&options.XX))fail('INVALID_OPTIONS','Redis SET 选项无效。');
    const expiryKeys=['EX','PX','EXAT','PXAT'].filter(k=>options[k]!==undefined);if(expiryKeys.length>1||(expiryKeys.length&&options.KEEPTTL))fail('INVALID_OPTIONS','Redis SET 到期选项冲突。');
    let expiresAt=null;for(const name of expiryKeys){const value=Number(options[name]);if(!Number.isSafeInteger(value)||value<=0)fail('INVALID_EXPIRY','Redis 到期时间需为正整数。');expiresAt=name==='EX'?Date.now()+value*1000:name==='PX'?Date.now()+value:name==='EXAT'?value*1000:value;if(!Number.isSafeInteger(expiresAt))fail('INVALID_EXPIRY','Redis 到期时间超过安全范围。');}
    return{...options,expiresAt};
  }
  const wrappers={
    get:(key)=>one(key,state=>typed(state,key,'string')?.value??null),
    set:(key,value,...args)=>{if(credentialKey(key))fail('CREDENTIAL_CACHE_FORBIDDEN','原生凭据缓存已停用，请使用加密账户库。');const text=textValue(value),options=setOptions(args);return one(key,state=>{const previous=live(state,key);if(options.GET&&previous&&previous.type!=='string')fail('WRONGTYPE','Redis GET SET 需要字符串缓存。');if((options.NX&&previous)||(options.XX&&!previous))return options.GET?previous?.value??null:null;put(state.entries,key,{type:'string',value:text,expiresAt:options.KEEPTTL?previous?.expiresAt??null:options.expiresAt});return options.GET?previous?.value??null:'OK';},true);},
    expire:(key,seconds,options)=>{const value=Number(seconds);if(!Number.isSafeInteger(value))fail('INVALID_EXPIRY','Redis 到期秒数需为整数。');if(options!==undefined)fail('INVALID_OPTIONS','Redis EXPIRE 条件选项暂不支持。');return one(key,state=>{const entry=live(state,key);if(!entry)return 0;if(value<=0)delete state.entries[key];else{const expiresAt=Date.now()+value*1000;if(!Number.isSafeInteger(expiresAt))fail('INVALID_EXPIRY','Redis 到期时间超过安全范围。');entry.expiresAt=expiresAt;}return 1;},true);},
    ttl:key=>one(key,state=>{const entry=live(state,key);return !entry?-2:entry.expiresAt===null?-1:Math.max(0,Math.round((entry.expiresAt-Date.now())/1000));}),
    hGet:(key,field)=>{field=stringKey(field);return one(key,state=>{const entry=typed(state,key,'hash');return entry&&own(entry.value,field)?entry.value[field]:null;});},
    hGetAll:key=>one(key,state=>Object.fromEntries(Object.entries(typed(state,key,'hash')?.value??{}))),
    hSet:(key,field,value)=>{const pairs=isObject(field)?Object.entries(field):[[field,value]];const values=pairs.filter(([name])=>!deniedField.test(String(name))).map(([name,item])=>[stringKey(name),textValue(item)]);return one(key,state=>{if(!values.length)return 0;const entry=typed(state,key,'hash',true);let added=0;for(const[name,item]of values){if(!own(entry.value,name))added++;put(entry.value,name,item);}return added;},true);},
    hDel:(key,...fields)=>{fields=fields.flat().map(stringKey);return one(key,state=>{const entry=typed(state,key,'hash');if(!entry)return 0;let deleted=0;for(const field of fields){if(own(entry.value,field)){delete entry.value[field];deleted++;}}if(!Object.keys(entry.value).length)delete state.entries[key];return deleted;},true);},
    zAdd:(key,members,options={})=>{if(!isObject(options)||Object.keys(options).some(k=>!['NX','XX','CH','LT','GT'].includes(k))||(options.NX&&options.XX)||(options.LT&&options.GT)||(options.NX&&(options.LT||options.GT)))fail('INVALID_OPTIONS','Redis ZADD 选项无效。');const values=(Array.isArray(members)?members:[members]).map(item=>{if(!isObject(item)||String(item.score).trim()===''||!Number.isFinite(Number(item.score)))fail('INVALID_SCORE','排行榜分数需为有限数值。');return{value:stringKey(item.value),score:Number(item.score)};});return one(key,state=>{let entry=typed(state,key,'zset');let added=0,changed=0;for(const item of values){const had=entry&&own(entry.value,item.value),old=had?entry.value[item.value]:null;if((options.NX&&had)||(options.XX&&!had)||(had&&options.LT&&item.score>=old)||(had&&options.GT&&item.score<=old))continue;entry??=typed(state,key,'zset',true);if(!had)added++;if(!had||old!==item.score)changed++;put(entry.value,item.value,item.score);}return options.CH?changed:added;},true);},
    zRange:(key,start,stop,options={})=>one(key,state=>{if(!isObject(options)||Object.keys(options).some(k=>k!=='REV'))fail('INVALID_OPTIONS','排行榜仅支持下标范围和 REV。');return range(sorted(typed(state,key,'zset'),options.REV),start,stop).map(row=>row.value);}),
    zRangeWithScores:(key,start,stop,options={})=>one(key,state=>{if(!isObject(options)||Object.keys(options).some(k=>k!=='REV'))fail('INVALID_OPTIONS','排行榜仅支持下标范围和 REV。');return range(sorted(typed(state,key,'zset'),options.REV),start,stop);}),
    zRank:(key,member)=>one(key,state=>{const position=sorted(typed(state,key,'zset')).findIndex(row=>row.value===String(member));return position<0?null:position;}),
    zRevRank:(key,member)=>one(key,state=>{const position=sorted(typed(state,key,'zset'),true).findIndex(row=>row.value===String(member));return position<0?null:position;}),
    zScore:(key,member)=>one(key,state=>{const entry=typed(state,key,'zset');return entry&&own(entry.value,String(member))?entry.value[String(member)]:null;}),
    zCard:key=>one(key,state=>Object.keys(typed(state,key,'zset')?.value??{}).length),
    zRem:(key,...members)=>{members=members.flat().map(stringKey);return one(key,state=>{const entry=typed(state,key,'zset');if(!entry)return 0;let removed=0;for(const member of members){if(own(entry.value,member)){delete entry.value[member];removed++;}}if(!Object.keys(entry.value).length)delete state.entries[key];return removed;},true);}
  };
  wrappers.keys=async pattern=>{
    const matcher=glob(pattern),raw=await call('keys',pattern);if(!Array.isArray(raw)||raw.length>MAX_KEYS)fail('SIZE_LIMIT','原生 Redis 键枚举超过上限。');if(!relevantPattern(pattern))return raw;
    return locked(async state=>{for(const key of raw)if(controlled(key))await migrate(state,key);const values=raw.filter(key=>!controlled(key));for(const key of Object.keys(state.entries))if(matcher.test(key)&&live(state,key))values.push(key);return [...new Set(values)].sort();});
  };
  for(const name of ['del','exists'])wrappers[name]=async(...args)=>{
    const keys=args.flat();const selected=keys.filter(controlled).map(stringKey),other=keys.filter(key=>!controlled(key));let count=0;
    if(selected.length)count=await locked(async state=>{for(const key of new Set(selected))await migrate(state,key);let result=0;for(const key of selected){if(live(state,key)){result++;if(name==='del')delete state.entries[key];}}if(name==='del')write(state);return result;});
    if(other.length)count+=Number(await call(name,other));return count;
  };
  const replacements=[];
  try{for(const name of names){const previous=Object.getOwnPropertyDescriptor(redis,name);const wrapper=async(...args)=>{if(name==='keys')return wrappers.keys(...args);if(name==='del'||name==='exists'){if(!args.flat().some(controlled))return call(name,...args);return wrappers[name](...args);}if(!controlled(args[0]))return call(name,...args);stringKey(args[0]);return wrappers[name](...args);};Object.defineProperty(redis,name,{value:wrapper,writable:true,configurable:true,enumerable:previous?.enumerable??true});replacements.push([name,previous]);}}
  catch{for(const[name,previous]of replacements.reverse()){if(previous)Object.defineProperty(redis,name,previous);else delete redis[name];}secret.fill(0);fail('INSTALL_FAILED','原 Redis 无法安装加密适配器。');}
  const status=Object.freeze({installed:true,prefixes:NATIVE_REDIS_PREFIXES,backend:'aes-256-gcm-file',atomicLegacyMigration:Boolean(original.eval)});
  installed.set(redis,{root:base,signature,status});return status;
}
