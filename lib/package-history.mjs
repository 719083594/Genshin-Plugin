import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const HISTORY_SOURCE = 'https://cnb.cool/rainbowwarmth/resources/-/git/raw/main/GamePush-Plugin/GamePush-Plugin.db';
const MAX_BYTES = 1024 * 1024;
const UPDATING = new Set();
const VERSION = /^\d{1,2}\.\d{1,2}\.\d{1,2}$/;
const fail = () => new Error('版本历史数据无效或存储路径不安全；未替换已有数据。');

function ordinary(file, directory = false) {
  for (let current = path.resolve(file);;) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw fail(); }
    if (stat && (stat.isSymbolicLink() || (current === path.resolve(file) && !directory ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()))) throw fail();
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function removeOwned(file, identity) {
  if(!identity)return;
  ordinary(path.dirname(file),true);ordinary(file);
  let current;try{current=fs.lstatSync(file)}catch(error){if(error.code==='ENOENT')return;throw fail()}
  if(current.dev!==identity.dev||current.ino!==identity.ino)throw fail();
  fs.unlinkSync(file);
}
function text(value, limit) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw fail();
  return value;
}
function record(row, pre = false) {
  const version = row?.version ?? row?.ver;
  if (!VERSION.test(version || '') || (pre && !VERSION.test(row.oldver || ''))) throw fail();
  return { version, ...(pre ? { oldVersion: row.oldVersion ?? row.oldver } : {}), size: text(row.size, 100), time: text(row.time, 100) };
}
export function validateHistory(value) {
  if (value?.schema !== 1 || value.source !== HISTORY_SOURCE || !/^[a-f\d]{64}$/.test(value.sourceSha256 || '') ||
      !Number.isFinite(Date.parse(value.observedAt)) || !Array.isArray(value.main) || !Array.isArray(value.pre) ||
      value.main.length > 500 || value.pre.length > 1000 || !value.main.length) throw fail();
  const main = value.main.map(row => record(row));
  const pre = value.pre.map(row => record({ ...row, oldver: row.oldVersion ?? row.oldver }, true));
  for (const rows of [main, pre]) {
    const keys = rows.map(row => row.version + '/' + (row.oldVersion || ''));
    if (new Set(keys).size !== keys.length) throw fail();
  }
  return { schema: 1, source: HISTORY_SOURCE, sourceSha256: value.sourceSha256, observedAt: value.observedAt, main, pre };
}
export function mergeHistory(previous, incoming) {
  const old = validateHistory(previous), next = validateHistory(incoming);
  let added = 0, conflicts = 0;
  for (const kind of ['main', 'pre']) {
    const key = row => row.version + '/' + (row.oldVersion || '');
    const rows = new Map(old[kind].map(row => [key(row), row]));
    for (const row of next[kind]) {
      if (!rows.has(key(row))) { rows.set(key(row), row); added++; }
      else if (JSON.stringify(rows.get(key(row))) !== JSON.stringify(row)) conflicts++;
    }
    next[kind] = [...rows.values()];
  }
  return { history: validateHistory(next), added, conflicts };
}
export async function readHistoryDatabase(file, { now = () => new Date() } = {}) {
  ordinary(file);
  const stat = fs.statSync(file);
  if (stat.size > MAX_BYTES || stat.size < 16) throw fail();
  const bytes = fs.readFileSync(file);
  if (!bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) throw fail();
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(file, { readOnly: true, enableLoadExtension: false });
  try {
    database.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA mmap_size=0');
    for (const name of ['main', 'pre']) {
      const row = database.prepare("SELECT type,sql FROM sqlite_master WHERE name=?").get(name);
      if (row?.type !== 'table' || !/^CREATE\s+TABLE\b/i.test(row.sql || '')) throw fail();
      const columns=database.prepare(`PRAGMA table_xinfo("${name}")`).all();
      const expected=new Set(name==='main'?['game','version','size','time']:['game','ver','oldver','size','time']);
      for(const column of columns){
        // Ordinary text columns only: downloaded generated expressions must
        // never execute in the bot, even when trusted_schema is disabled.
        if(column.hidden!==0||!expected.has(column.name)&&column.name!=='id'||
           !(column.name==='id'?/^INTEGER$/i:/^(?:TEXT|VARCHAR\(255\))$/i).test(column.type))throw fail();
        expected.delete(column.name);
      }
      if(expected.size)throw fail();
    }
    const main = database.prepare('SELECT version,size,time FROM "main" NOT INDEXED WHERE game=? LIMIT 501').all('ys');
    const pre = database.prepare('SELECT ver,oldver,size,time FROM pre NOT INDEXED WHERE game=? LIMIT 1001').all('ys');
    return validateHistory({ schema: 1, source: HISTORY_SOURCE, sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      observedAt: now().toISOString(), main, pre });
  } finally { database.close(); }
}

export class PackageHistory {
  constructor(root, { fetch = globalThis.fetch, timeoutMs = 12000, now = () => new Date() } = {}) {
    this.root = path.resolve(root); this.fetch = fetch; this.timeoutMs = timeoutMs; this.now = now;
    this.directory = path.join(this.root, 'data'); this.file = path.join(this.directory, 'package-history.json');
    this.snapshot = path.join(this.root, 'resources', 'package-history.json');
  }
  read() {
    ordinary(this.root, true); ordinary(this.directory, true);ordinary(this.file);
    const file = fs.existsSync(this.file) ? this.file : this.snapshot;
    ordinary(path.dirname(file), true); ordinary(file);
    if (fs.statSync(file).size > MAX_BYTES) throw fail();
    return validateHistory(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  list(version) {
    if (version && !VERSION.test(version)) throw new Error('版本号格式：7.1.0');
    const history = this.read();
    return { ...history, main: history.main.filter(row => !version || row.version === version), pre: history.pre.filter(row => !version || row.version === version) };
  }
  async update() {
    if (UPDATING.has(this.file)) throw new Error('版本历史正在更新，请稍后。');
    UPDATING.add(this.file);
    let temporary,temporaryIdentity;
    try {
      ordinary(this.root, true); ordinary(this.directory, true);
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 }); ordinary(this.file);
      const response = await this.fetch(HISTORY_SOURCE, { redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok || response.redirected || (response.url && response.url !== HISTORY_SOURCE) || Number(response.headers?.get('content-length')) > MAX_BYTES) throw fail();
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.byteLength; if (size > MAX_BYTES) { await response.body.cancel?.().catch(() => {}); throw fail(); } chunks.push(Buffer.from(chunk)); }
      if (!size) throw fail();
      // Network/stream awaits can span a local directory replacement. Recheck
      // immediately before writing; never clean up through a changed path.
      ordinary(this.root,true);ordinary(this.directory,true);
      temporary = path.join(this.directory, '.history-' + crypto.randomUUID() + '.db');
      fs.writeFileSync(temporary, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
      temporaryIdentity=fs.lstatSync(temporary);
      const incoming = await readHistoryDatabase(temporary, { now: this.now });
      const result = mergeHistory(this.read(), incoming);
      const output = this.file + '.' + crypto.randomUUID() + '.tmp';
      let outputIdentity;
      try {
        ordinary(this.root,true);ordinary(this.directory,true);ordinary(this.file);
        fs.writeFileSync(output, JSON.stringify(result.history, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        outputIdentity=fs.lstatSync(output);
        ordinary(this.file); fs.renameSync(output, this.file);
      } finally { removeOwned(output,outputIdentity); }
      return result;
    } finally { try{if(temporary)removeOwned(temporary,temporaryIdentity)}finally{UPDATING.delete(this.file)} }
  }
}

export function formatHistory(history) {
  const lines = ['原神 PC 历史包体 · GamePush 作者资料', '这些是作者记录的大小，统计口径可能与当前启动器资源大小不同。'];
  for (const [kind, label] of [['main', '正式版本'], ['pre', '预下载版本']]) {
    if (history[kind].length) lines.push(label + '：', ...history[kind].map(row => `${row.version}${row.oldVersion ? ' ← ' + row.oldVersion : ''}：${row.size || '未记录大小'}${row.time ? ' · ' + row.time : ''}`));
  }
  if (!history.main.length && !history.pre.length) lines.push('该来源未收录此版本。');
  lines.push('来源：' + HISTORY_SOURCE, '资料同步时间：' + history.observedAt);
  return lines.join('\n');
}
