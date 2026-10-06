import fs from 'node:fs';
import path from 'node:path';
import { atomic,ConfigStore } from './config.mjs';
import {encryptJson,decryptJson} from './encrypted-json.mjs';
import {createHmac} from 'node:crypto';
import { validateUid } from './accounts.mjs';

// Protocol sources: https://uigf.org/zh/standards/uigf.html and
// uigf-legacy-v2.2.html / uigf-legacy-v2.3.html / uigf-legacy-v3.0.html.
// This implementation is not a claim of UIGF certification.
const VERSIONS = new Set(['v2.2', 'v2.3', 'v2.4', 'v3.0', 'v4.0', 'v4.1', 'v4.2']);
const LANGUAGES = new Set(['de-de', 'en-us', 'es-es', 'fr-fr', 'id-id', 'it-it', 'ja-jp', 'ko-kr', 'pt-pt', 'ru-ru', 'th-th', 'tr-tr', 'vi-vn', 'zh-cn', 'zh-tw']);
const POOLS = { '100': '新手', '200': '常驻', '301': '角色活动', '302': '武器活动', '500': '集录祈愿' };
const FIELDS = ['uigf_gacha_type', 'gacha_type', 'item_id', 'time', 'id', 'count', 'name', 'item_type', 'rank_type'];
const MAX_RECORDS = 100000, MAX_BYTES = 5 * 1024 * 1024;
const OLD_ID_CEILING = 1612303200000000000n, MAX_ID = 9999999999999999999n;
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const compareIds = (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
const canonicalPool = raw => raw === '400' ? '301' : raw;
function ownerId(owner) {
  const value = String(owner);
  if (!/^\d{5,15}$/.test(value)) throw new Error('用户标识无效');
  return value;
}
function inferredTimezone(id) { return id[0] === '6' ? -5 : id[0] === '7' ? 1 : 8; }
function timezone(value, fallback, integer = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 24 || (integer && !Number.isInteger(value)))
    throw new Error('祈愿时区无效；UIGF v4 要求整数时区，旧版允许数值时区');
  return value;
}
function language(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !LANGUAGES.has(value)) throw new Error('祈愿语言代码无效');
  return value;
}
function validTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return false;
  const parsed = new Date(value.replace(' ', 'T') + 'Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19).replace('T', ' ') === value;
}
function convertTime(value, source, target) {
  if (source === target) return value;
  const converted = new Date(Date.parse(value.replace(' ', 'T') + 'Z') + (target - source) * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  if (!validTime(converted)) throw new Error('祈愿时区转换后时间无效');
  return converted;
}
function decodeInput(input) {
  let serialized;
  try { serialized = typeof input === 'string' ? input : JSON.stringify(input); } catch { throw new Error('祈愿文件不是有效JSON'); }
  if (typeof serialized !== 'string') throw new Error('祈愿文件不是有效JSON');
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('祈愿文件超过5MiB');
  try { return JSON.parse(serialized); } catch { throw new Error('祈愿文件不是有效JSON'); }
}
function metadata(input, id) {
  // Explicitly UID-bearing local/API lists remain compatible with the original CLI.
  if (Array.isArray(input)) {
    if (!input.length || input.some(x => !isObject(x) || x.uid === undefined)) throw new Error('未知祈愿结构或缺少UID；请使用UIGF文件');
    return { list: input, version: 'local', timezone: inferredTimezone(id), lang: language(input[0].lang) };
  }
  if (!isObject(input) || !isObject(input.info)) throw new Error('未知祈愿结构或缺少UID；请使用UIGF文件');
  const info = input.info;
  if (info.version !== undefined) {
    if (!VERSIONS.has(info.version) || !info.version.startsWith('v4.')) throw new Error('不支持此UIGF版本或版本字段错误');
    if (info.uigf_version !== undefined) throw new Error('UIGF版本字段冲突');
    if (!['string', 'number'].includes(typeof info.export_timestamp) ||
        (typeof info.export_timestamp === 'number' && !Number.isSafeInteger(info.export_timestamp)) ||
        typeof info.export_app !== 'string' || typeof info.export_app_version !== 'string') throw new Error('UIGF v4 导出信息缺少必要字段或字段类型错误');
    if (!Array.isArray(input.hk4e)) throw new Error('UIGF文件没有原神hk4e数据；其他游戏记录不能导入');
    const matches = input.hk4e.filter(x => isObject(x) && String(x.uid) === id);
    if (!matches.length) throw new Error('UIGF文件没有目标UID的原神记录');
    if (matches.length !== 1) throw new Error('UIGF包含重复的目标UID账户，无法确定账户时区');
    const account = matches[0];
    if ((typeof account.uid !== 'string' && !Number.isSafeInteger(account.uid)) || account.timezone === undefined) throw new Error('UIGF原神账户缺少有效UID或时区');
    return { list: account.list, version: info.version, timezone: timezone(account.timezone, undefined, true), lang: language(account.lang) };
  }
  if (typeof info.uid !== 'string') throw new Error('祈愿文件缺少有效UID');
  if (validateUid(info.uid).uid !== id) throw new Error('文件UID与当前账户不一致');
  const version = info.uigf_version === undefined ? 'local' : info.uigf_version;
  if (version !== 'local' && (!VERSIONS.has(version) || version.startsWith('v4.'))) throw new Error('不支持此UIGF版本或版本字段错误');
  for (const field of ['export_app', 'export_app_version', 'export_time']) {
    if (info[field] !== undefined && typeof info[field] !== 'string') throw new Error('UIGF导出信息字段类型错误');
  }
  if (info.export_timestamp !== undefined && (typeof info.export_timestamp !== 'number' || !Number.isFinite(info.export_timestamp))) throw new Error('UIGF旧版export_timestamp必须为数值');
  if (input.hk4e !== undefined || input.hkrpg !== undefined || input.nap !== undefined ||
      (input.game !== undefined && input.game !== 'hk4e')) throw new Error('未知祈愿结构；仅支持原神记录');
  const lang = language(info.lang ?? (version === 'v2.2' ? 'zh-cn' : undefined));
  if (version === 'v2.2' && lang !== 'zh-cn') throw new Error('UIGF v2.2 仅支持简体中文');
  return { list: input.list, version, timezone: timezone(info.region_time_zone, inferredTimezone(id)), lang };
}
function normalizeRecord(record, id, meta, stored = false) {
  if (!isObject(record)) throw new Error('祈愿记录不是对象');
  if (record.uid !== undefined && String(record.uid) !== id) throw new Error('记录UID与当前账户不一致');
  if (record.game !== undefined && record.game !== 'hk4e') throw new Error('记录不是原神祈愿');
  if (record.gacha_id !== undefined || record.timestamp !== undefined) throw new Error('记录不是原神祈愿格式');
  const local = meta.version === 'local', rawPool = record.gacha_type;
  if (typeof rawPool !== 'string' || !POOLS[canonicalPool(rawPool)]) throw new Error('记录含无效原神卡池');
  let sharedPool = record.uigf_gacha_type;
  if (sharedPool === undefined && local) sharedPool = canonicalPool(rawPool);
  // Migrate incorrect uigf_gacha_type=400 from the initial local implementation.
  if (stored && sharedPool === '400' && rawPool === '400') sharedPool = '301';
  if (sharedPool !== canonicalPool(rawPool)) throw new Error('uigf_gacha_type与原神卡池的共享保底映射不一致');
  if (rawPool === '500' && ['v2.2', 'v2.3', 'v2.4'].includes(meta.version)) throw new Error('集录祈愿需要UIGF v3.0或更高版本');
  const missingId = record.id === undefined || record.id === null || record.id === '';
  if (missingId && (local || meta.version.startsWith('v4.'))) throw new Error('记录缺少有效ID');
  const idPattern = meta.version.startsWith('v4.') ? /^\d{1,19}$/ : /^\d{1,64}$/;
  if (!missingId && (typeof record.id !== 'string' || !idPattern.test(record.id))) throw new Error('记录ID必须是数字字符串，UIGF v4 限1至19位，不能使用浮点数');
  if (!validTime(record.time)) throw new Error('记录含无效时间');
  const itemId = record.item_id ?? (local || meta.version === 'v2.2' ? '' : undefined);
  if (typeof itemId !== 'string' || !/^\d{0,30}$/.test(itemId)) throw new Error('记录缺少有效字符串item_id');
  const out = { uid: id, gacha_type: rawPool, uigf_gacha_type: sharedPool, item_id: itemId, time: record.time, id: missingId ? null : record.id };
  for (const field of ['count', 'name', 'item_type', 'rank_type']) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== 'string' || record[field].length > 200 || /[\u0000-\u001f]/.test(record[field])) throw new Error('祈愿记录字段类型或长度无效');
    out[field] = record[field];
  }
  if (out.rank_type && !['3', '4', '5'].includes(out.rank_type)) throw new Error('记录含无效原神星级');
  if (out.count && (!/^\d{1,6}$/.test(out.count) || Number(out.count) < 1)) throw new Error('物品数量无效');
  if (record.lang !== undefined && meta.lang !== undefined && record.lang !== meta.lang) throw new Error('记录语言与文件语言不一致');
  if (stored && record.synthetic_id === true) out.synthetic_id = true;
  if (stored && record.order_uncertain === true) out.order_uncertain = true;
  return out;
}
function assignLegacyIds(rows, version) {
  if (!rows.some(x => x.id === null)) return 0;
  // Same-second ordering of records without official IDs cannot be recovered.
  const ordered = rows.map((row, index) => ({ row, index })).sort((a, b) => a.row.time.localeCompare(b.row.time) ||
    (a.row.id !== null && b.row.id !== null ? compareIds(a.row, b.row) : a.index - b.index));
  const ceiling = version === 'v2.2' ? OLD_ID_CEILING : MAX_ID;
  let cursor = ceiling + 1n, generated = 0;
  const used = new Set(rows.filter(x => x.id !== null).map(x => x.id));
  for (let i = ordered.length - 1; i >= 0; i--) {
    const row = ordered[i].row;
    if (row.id !== null) { cursor = BigInt(row.id); continue; }
    cursor = (cursor > ceiling + 1n ? ceiling + 1n : cursor) - 1n;
    if (cursor < 0n || used.has(cursor.toString())) throw new Error('无法安全补全旧祈愿ID；生成ID与已有记录冲突');
    row.id = cursor.toString();
    row.synthetic_id = true;
    row.order_uncertain = true;
    used.add(row.id);
    generated++;
  }
  return generated;
}
function mergeRecord(old, incoming, translated) {
  for (const field of ['time', 'gacha_type', 'uigf_gacha_type']) {
    if (old[field] !== incoming[field]) throw new Error('相同祈愿ID存在冲突的时间或卡池；原记录未更改');
  }
  const merged = { ...old };
  for (const field of ['item_id', 'rank_type', 'count', 'name', 'item_type']) {
    const a = old[field], b = incoming[field];
    if (a && b && a !== b && !((field === 'name' || field === 'item_type') && translated)) throw new Error('相同祈愿ID存在冲突的物品或星级；原记录未更改');
    if ((!a && b) || (a === undefined && b === '')) merged[field] = b;
  }
  if (incoming.synthetic_id) merged.synthetic_id = true;
  if (incoming.order_uncertain) merged.order_uncertain = true;
  return merged;
}
function sortRecords(rows) {
  if (rows.some(x => x.synthetic_id)) return rows.sort((a, b) => a.time.localeCompare(b.time) || compareIds(a, b));
  return rows.sort(compareIds);
}
function protocolRecord(row) { return Object.fromEntries(FIELDS.filter(k => row[k] !== undefined).map(k => [k, row[k]])); }

export class GachaStore {
  constructor(root, { now = () => Date.now(),key } = {}) { this.root = path.resolve(root); this.now = now;this.key=key||new ConfigStore(root).init().credentialsKey;const folder=path.join(this.root,'data/gacha');if(fs.existsSync(folder)){this.checkKey();for(const owner of fs.readdirSync(folder)){if(!/^[1-9]\d{4,14}$/.test(owner))continue;const dir=path.join(folder,owner);if(fs.lstatSync(dir).isSymbolicLink()||!fs.lstatSync(dir).isDirectory())throw new Error('旧祈愿目录不安全');for(const file of fs.readdirSync(dir))if(/^\d{9,10}\.json$/.test(file))this.read(owner,file.slice(0,-5));}} }
  checkKey(create=false){
    const directory=path.join(this.root,'data/gacha'),file=path.join(directory,'.key-check.enc.json');
    for(const item of [this.root,path.join(this.root,'data'),directory,file])if(fs.existsSync(item)&&fs.lstatSync(item).isSymbolicLink())throw new Error('祈愿文件路径不能是符号链接');
    if(fs.existsSync(file)){const value=decryptJson(JSON.parse(fs.readFileSync(file,'utf8')),{key:this.key,aad:'Teyvat-Plugin/gacha/key-check/v1'});if(value.storage!=='gacha')throw new Error('祈愿密钥检查失败');}
    else{if(fs.existsSync(directory)&&fs.readdirSync(directory).some(name=>/^[a-f0-9]{64}\.enc\.json$/.test(name)&&JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'))?.algorithm==='aes-256-gcm'))throw new Error('祈愿密钥校验文件缺失，请保留原密钥及数据');if(create){fs.mkdirSync(directory,{recursive:true,mode:0o700});const envelope=encryptJson({storage:'gacha'},{key:this.key,aad:'Teyvat-Plugin/gacha/key-check/v1'});try{fs.writeFileSync(file,JSON.stringify(envelope),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;this.checkKey();}}}
  }
  aad(owner,id){return 'Teyvat-Plugin/gacha/v1/'+ownerId(owner)+'/'+validateUid(id).uid}
  legacyFile(owner,id){const file=path.join(this.root,'data/gacha',ownerId(owner),validateUid(id).uid+'.json');for(const part of [path.join(this.root,'data'),path.join(this.root,'data/gacha'),path.dirname(file),file])if(fs.existsSync(part)&&fs.lstatSync(part).isSymbolicLink())throw new Error('祈愿文件路径不能是符号链接');return file}
  file(owner, id) {
    const name=createHmac('sha256',this.key).update(this.aad(owner,id)).digest('hex')+'.enc.json';
    const file = path.join(this.root, 'data', 'gacha', name);
    for (const part of [path.join(this.root, 'data'), path.join(this.root, 'data', 'gacha'), path.dirname(file), file]) {
      try { if (fs.lstatSync(part).isSymbolicLink()) throw new Error('祈愿文件路径不能是符号链接'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return file;
  }
  decode(file,owner,id,{encryptedOnly=false}={}) {
    id = validateUid(id).uid;
    let input;
    try {if(fs.statSync(file).size>12*1024*1024)throw new Error(); input = JSON.parse(fs.readFileSync(file, 'utf8'));if(encryptedOnly&&input?.algorithm!=='aes-256-gcm')throw new Error();if(input?.algorithm==='aes-256-gcm')input=decryptJson(input,{key:this.key,aad:this.aad(owner,id)}); }
    catch (e) { if (e.code === 'ENOENT') return { uid: id, timezone: inferredTimezone(id), records: [] }; throw new Error('祈愿文件损坏或路径不安全'); }
    const legacy = Array.isArray(input);
    if (!legacy && (!isObject(input) || input.storage_version !== 1 || input.uid !== id || !Array.isArray(input.records))) throw new Error('祈愿文件损坏或UID不一致');
    const meta = { version: 'local', timezone: timezone(legacy ? undefined : input.timezone, inferredTimezone(id)), lang: language(legacy ? input[0]?.lang : input.lang) };
    const records = legacy ? input : input.records;
    if (records.length > MAX_RECORDS) throw new Error('祈愿记录数量超限');
    const normalized = records.map(x => normalizeRecord(x, id, meta, true));
    if (new Set(normalized.map(x => x.id)).size !== normalized.length) throw new Error('祈愿文件存在重复ID');
    return { uid: id, timezone: meta.timezone, ...(meta.lang ? { lang: meta.lang } : {}), records: sortRecords(normalized) };
  }
  readEncrypted(owner,id){
    this.checkKey();id=validateUid(id).uid;
    const file=this.file(owner,id);
    if(!fs.existsSync(file)&&fs.existsSync(this.legacyFile(owner,id)))throw new Error('祈愿记录尚未完成加密迁移，请先检查核心存储状态。');
    return this.decode(file,owner,id,{encryptedOnly:true});
  }
  read(owner,id,{migrate=true}={}){
    this.checkKey();id=validateUid(id).uid;const current=this.file(owner,id),legacy=this.legacyFile(owner,id);
    const file=fs.existsSync(current)?current:legacy;const value=this.decode(file,owner,id);
    if(!migrate||!fs.existsSync(file))return value;
    const raw=fs.readFileSync(file,'utf8');const plain=JSON.parse(raw)?.algorithm!=='aes-256-gcm';const legacyExists=legacy!==file&&fs.existsSync(legacy);
    if(!plain&&!legacyExists){this.checkKey(true);return value;}
    fs.mkdirSync(path.dirname(current),{recursive:true,mode:0o700});const lockFile=current+'.lock';let lock;
    try{lock=fs.openSync(lockFile,'wx',0o600)}catch(error){if(error.code==='EEXIST')throw new Error('祈愿记录正在迁移，请稍后重试');throw error;}
    try{
      const fresh=this.decode(fs.existsSync(current)?current:legacy,owner,id);let oldRaw=null;
      if(fs.existsSync(legacy)){oldRaw=fs.readFileSync(legacy,'utf8');const old=this.decode(legacy,owner,id);if(old.records.length&&fresh.records.length&&(old.timezone!==fresh.timezone||old.lang!==fresh.lang))throw new Error('旧祈愿记录与加密记录不一致，请保留文件人工核对');const known=new Map(fresh.records.map(x=>[x.id,x]));for(const row of old.records)known.set(row.id,known.has(row.id)?mergeRecord(known.get(row.id),row,false):row);fresh.records=sortRecords([...known.values()]);}
      this.checkKey(true);atomic(current,encryptJson({storage_version:1,...fresh},{key:this.key,aad:this.aad(owner,id)}));
      const verified=this.decode(current,owner,id);if(JSON.stringify(verified)!==JSON.stringify(fresh))throw new Error('祈愿加密迁移验证失败');
      if(oldRaw!==null){this.legacyFile(owner,id);if(fs.readFileSync(legacy,'utf8')!==oldRaw)throw new Error('旧祈愿文件已变化，请保留原文件');fs.unlinkSync(legacy);}
      return verified;
    }finally{fs.closeSync(lock);fs.unlinkSync(lockFile);}
  }
  load(owner, id) { return this.read(owner, id).records; }
  import(owner, id, input) {
    id = validateUid(id).uid;
    const file = this.file(owner, id), source = metadata(decodeInput(input), id);
    if (!Array.isArray(source.list) || source.list.length > MAX_RECORDS) throw new Error('祈愿记录格式或数量不合法');
    const incoming = source.list.map(x => normalizeRecord(x, id, source));
    const generated = assignLegacyIds(incoming, source.version);
    this.read(owner,id);this.checkKey(true);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lockFile = file + '.lock';
    let lock;
    try { lock = fs.openSync(lockFile, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('祈愿记录正在导入，请稍后重试'); throw e; }
    try {
      const previous = this.read(owner, id,{migrate:false});
      if (previous.records.length && previous.lang && source.lang && previous.lang !== source.lang) throw new Error('已有祈愿记录语言不同；请先导出备份并使用相同语言导入');
      const targetTimezone = previous.records.length ? previous.timezone : source.timezone;
      const targetLang = previous.records.length ? (previous.lang === source.lang ? previous.lang : undefined) : source.lang;
      const known = new Map(previous.records.map(x => [x.id, x]));
      let added = 0;
      for (const row of incoming) {
        row.time = convertTime(row.time, source.timezone, targetTimezone);
        const old = known.get(row.id);
        if (old) known.set(row.id, mergeRecord(old, row, false));
        else { known.set(row.id, row); added++; }
      }
      if (known.size > MAX_RECORDS) throw new Error('合并后的祈愿记录超过100000条');
      const records = sortRecords([...known.values()]);
      atomic(file, encryptJson({ storage_version: 1, uid: id, timezone: targetTimezone, ...(targetLang ? { lang: targetLang } : {}), records },{key:this.key,aad:this.aad(owner,id)}));
      return { imported: incoming.length, added, duplicates: incoming.length - added, generated, total: records.length,
        warnings: generated ? ['旧记录缺失的ID已补全；同秒抽取顺序无法确认，相关区间不计入平均出金抽数。'] : [] };
    } finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
  }
  export(owner, id, options = {}) {
    const version = typeof options === 'string' ? options : options.version ?? 'v4.2';
    if (!VERSIONS.has(version)) throw new Error('不支持此UIGF导出版本');
    const data = this.read(owner, id), modern = version.startsWith('v4.');
    if (modern && data.records.some(x => x.id.length > 19)) throw new Error('此旧版记录含超过19位的ID，UIGF v4 无法完整表示；请导出原旧版格式');
    if (modern && !Number.isInteger(data.timezone)) throw new Error('此记录使用非整数时区；请导出UIGF v3.0以完整保留时区');
    if (['v2.2', 'v2.3', 'v2.4'].includes(version) && data.records.some(x => x.gacha_type === '500')) throw new Error('UIGF v2.x 无法表示集录祈愿，请使用v3.0或更高版本');
    if (['v2.2', 'v2.3'].includes(version) && data.timezone !== inferredTimezone(data.uid)) throw new Error('此UIGF旧版本无法完整保留当前时区，请使用v3.0或更高版本');
    if (version === 'v2.2' && data.lang !== 'zh-cn') throw new Error('UIGF v2.2 仅支持简体中文；请使用v2.3或更高版本');
    if (version === 'v2.2' && data.records.some(x => x.synthetic_id && BigInt(x.id) > OLD_ID_CEILING)) throw new Error('旧记录补全ID超出v2.2允许范围；请使用v2.3或更高版本');
    const info = { export_timestamp: Math.floor(Number(this.now()) / 1000), export_app: 'Teyvat-Plugin', export_app_version: '0.1.0' };
    const list = data.records.map(protocolRecord);
    if (modern) return { info: { ...info, version }, hk4e: [{ uid: data.uid, timezone: data.timezone, ...(data.lang ? { lang: data.lang } : {}), list }] };
    return { info: { ...info, uid: data.uid, ...(data.lang ? { lang: data.lang } : {}), uigf_version: version,
      ...(['v2.4', 'v3.0'].includes(version) ? { region_time_zone: data.timezone } : {}) }, list };
  }
  analyze(owner, id) {
    const data = this.read(owner, id);
    const result = { uid: data.uid, timezone: data.timezone, total: data.records.length, historyComplete: false, pools: [] };
    const groups = new Map();
    for (const row of data.records) {
      const group = groups.get(row.uigf_gacha_type) ?? [];
      group.push(row);
      groups.set(row.uigf_gacha_type, group);
    }
    for (const [key, rows] of groups) {
      let pity = 0, suffix = 0, priorFive = false, uncertainRank = false, uncertainOrder = false;
      const five = [];
      for (const row of rows) {
        pity++; suffix++;
        if (row.order_uncertain) uncertainOrder = true;
        if (!row.rank_type) { uncertainRank = true; suffix = 0; }
        if (row.rank_type === '5') {
          const intervalKnown = priorFive && !uncertainRank && !uncertainOrder;
          five.push({ id: row.id, item_id: row.item_id, name: row.name || '物品 ' + (row.item_id || '未知'), pulls: pity, time: row.time,
            firstObserved: !priorFive, intervalKnown, incomplete: !intervalKnown,
            minPulls: uncertainRank ? suffix : pity, maxPulls: priorFive ? pity : null });
          pity = 0; suffix = 0; priorFive = true; uncertainRank = false; uncertainOrder = row.order_uncertain === true;
        }
      }
      const intervals = five.filter(x => x.intervalKnown);
      result.pools.push({ type: key, name: POOLS[key], total: rows.length,
        five: five.length, four: rows.filter(x => x.rank_type === '4').length, three: rows.filter(x => x.rank_type === '3').length,
        unknownRank: rows.filter(x => !x.rank_type).length, syntheticIds: rows.filter(x => x.synthetic_id).length,
        currentPity: pity, currentPityKnown: priorFive && !uncertainRank && !uncertainOrder,
        currentPityRange: { min: uncertainRank ? suffix : pity, max: priorFive ? pity : null },
        fiveStarHistory: five, lastFive: five.slice(-8), completeIntervals: intervals.length,
        average: intervals.length ? intervals.reduce((n, x) => n + x.pulls, 0) / intervals.length : null,
        observedAverage: five.length ? five.reduce((n, x) => n + x.pulls, 0) / five.length : null });
    }
    return result;
  }
}

export function formatGacha(analysis) {
  const lines = ['UID ' + analysis.uid + ' · 本地记录 ' + analysis.total + ' 抽'];
  for (const pool of analysis.pools) {
    lines.push(pool.name + '：' + pool.total + ' 抽 / 已知五星 ' + pool.five + ' / 四星 ' + pool.four + ' / 记录内垫抽 ' + pool.currentPity);
    if (pool.unknownRank) lines.push('其中 ' + pool.unknownRank + ' 条缺少星级；五星数量、垫抽和区间不能完全确认。');
    if (pool.average !== null) lines.push('已知五星之间的平均记录间隔 ' + pool.average.toFixed(2) + ' 抽（' + pool.completeIntervals + ' 段）');
    for (const row of pool.lastFive) lines.push(row.name + ' · ' + row.pulls + ' 抽' + (row.incomplete ? '（不完整或顺序不确定）' : '') + ' · ' + row.time);
    if (pool.fiveStarHistory.length > pool.lastFive.length) lines.push('完整导入历史含 ' + pool.fiveStarHistory.length + ' 个已知五星；此处展示最近8个。');
  }
  lines.push('记录可能不完整；所有统计仅覆盖已导入记录，首个五星区间不计入平均。', '格式规范：UIGF https://uigf.org/');
  return lines.join('\n');
}
