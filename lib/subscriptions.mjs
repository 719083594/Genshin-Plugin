import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ConfigStore} from './config.mjs';import {encryptJson,decryptJson} from './encrypted-json.mjs';
import { validateUid } from './accounts.mjs';

const HASH = /^[a-f\d]{64}$/;
const KINDS = ['resin', 'version'];
const ownerId = value => {
  const id = String(value ?? '');
  if (!/^[1-9]\d{4,14}$/.test(id)) throw new SubscriptionError('invalid_owner', '需要有效的 QQ 用户标识。');
  return id;
};
const optionalId = value => value == null || value === '' ? null : ownerId(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const timestamp = value => Number.isFinite(value) && value >= 0 ? value : 0;

export class SubscriptionError extends Error {
  constructor(code, message) { super(message); this.name = 'SubscriptionError'; this.code = code; }
}

function summary(row) {
  return { owner: row.owner, uid: row.uid, kind: row.kind, enabled: row.enabled, botId: row.botId, groupId: row.groupId, threshold: row.threshold };
}

function stateFor(input = {}) {
  return {
    noteNextAt: timestamp(input.noteNextAt),
    flags: { resin: input.flags?.resin === true, transformer: input.flags?.transformer === true, home: input.flags?.home === true },
    versionKey: HASH.test(input.versionKey ?? '') ? input.versionKey : ''
  };
}

function versionFor(value) {
  if (!value || typeof value !== 'object') return null;
  const current = String(value.current ?? '');
  const preDownload = String(value.preDownload ?? '');
  if (!/^[a-zA-Z\d._+-]{1,40}$/.test(current) || !/^[a-zA-Z\d._+-]{0,40}$/.test(preDownload)) return null;
  return { current, preDownload, key: hash(JSON.stringify([current, preDownload])) };
}

/** Opt-in scheduler. No subscriptions means no upstream queries and no messages.
 * A resin subscription captures one owned UID; select another and opt in again
 * to schedule multiple accounts. A disabled subscription never sends a message.
 * send receives {owner, botId, groupId}; only resin and version reads are supported.
 * Persistent state contains routing/UID metadata and dedup markers, never Cookie/key.
 */
export class Subscriptions {
  #inFlight = false;
  #timer = null;
  constructor(root, { accounts, mys, publicData, publicVersion, send, config = {}, now = Date.now, clock = {} } = {}) {
    this.directory = path.join(path.resolve(root), 'data');
    this.file = path.join(this.directory, 'subscriptions.json');
    this.lockFile = path.join(this.directory, '.subscriptions.lock');
    this.tickLockFile = path.join(this.directory, '.subscriptions.tick.lock');
    this.accounts = accounts; this.mys = mys; this.publicData = publicData; this.publicVersion = publicVersion; this.send = send; this.config = config;
    this.storageKey=this.#config()?.credentialsKey||new ConfigStore(root).init().credentialsKey;
    this.now = typeof clock.now === 'function' ? () => clock.now() : now;
    this.clock = { setInterval: clock.setInterval?.bind(clock) || setInterval, clearInterval: clock.clearInterval?.bind(clock) || clearInterval };
    if(fs.existsSync(this.file))this.#read();
  }

  #config() {
    return typeof this.config === 'function' ? this.config() : typeof this.config?.read === 'function' ? this.config.read() : this.config;
  }

  #interval(config) {
    const minutes = Number(config?.notifications?.intervalMinutes);
    return (Number.isFinite(minutes) ? Math.max(1, Math.min(1440, minutes)) : 15) * 60000;
  }

  #directory() {
    for (const file of [this.directory, this.file]) {
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new SubscriptionError('unsafe_storage', '订阅存储位置不能为符号链接。');
    }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  #read(migrate=true) {
    this.#directory();
    if (!fs.existsSync(this.file)) return { version: 1, subscriptions: {}, cursor: 0, versionSnapshot: null, versionNextAt: 0 };
    try {
      if (fs.statSync(this.file).size > 6 * 1024 * 1024) throw new Error();
      let value = JSON.parse(fs.readFileSync(this.file, 'utf8'));const encrypted=value.algorithm==='aes-256-gcm';if(encrypted)value=decryptJson(value,{key:this.storageKey,aad:'Teyvat-Plugin/subscriptions/v1',maxBytes:4*1024*1024});
      if (value.version !== 1 || !value.subscriptions || typeof value.subscriptions !== 'object' || Array.isArray(value.subscriptions)) throw new Error();
      const subscriptions = {};
      let needsCleanup = false;
      for (const [id, row] of Object.entries(value.subscriptions)) {
        const owner = ownerId(row.owner);
        // Retired jobs are validated and removed without reading credentials or
        // making a network call. A malformed legacy row preserves the source.
        if (!KINDS.includes(row.kind) && row.kind !== 'sign') throw new Error();
        const uid = row.kind === 'version' ? null : validateUid(row.uid).uid;
        if (id !== hash(`${owner}:${row.kind}:${uid || ''}`)) throw new Error();
        if (row.kind === 'sign') { needsCleanup = true; continue; }
        subscriptions[id] = { owner, uid, kind: row.kind, enabled: row.enabled === true, botId: optionalId(row.botId), groupId: optionalId(row.groupId), threshold: Number.isInteger(row.threshold) && row.threshold > 0 && row.threshold <= 1000 ? row.threshold : 180, revision: Number.isInteger(row.revision) ? row.revision : 1, state: stateFor(row.state) };
        if (JSON.stringify(row) !== JSON.stringify(subscriptions[id])) needsCleanup = true;
      }
      const result={ version: 1, subscriptions, cursor: Number.isInteger(value.cursor) ? Math.max(0, value.cursor) : 0, versionSnapshot: versionFor(value.versionSnapshot), versionNextAt: timestamp(value.versionNextAt) };
      return migrate && (!encrypted || needsCleanup) ? this.#change(state=>structuredClone(state)) : result;
    } catch { throw new SubscriptionError('invalid_storage', '订阅状态文件无效，请保留原文件并检查格式。'); }
  }

  #deadLock(file) {
    try {
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) return false;
      const content = fs.readFileSync(file, 'utf8');
      const record = JSON.parse(content);
      if (record.lockVersion !== 1 || !Number.isInteger(record.pid) || record.pid <= 0) return false;
      try { process.kill(record.pid, 0); return false; }
      catch (error) { if (error.code !== 'ESRCH') return false; }
      return fs.readFileSync(file, 'utf8') === content;
    } catch { return false; }
  }

  #lock(file) {
    const create = () => {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ lockVersion: 1, pid: process.pid, token: crypto.randomUUID() })); }
      catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
      return fd;
    };
    try { return create(); }
    catch (error) {
      if (error.code !== 'EEXIST' || !this.#deadLock(file)) throw error;
      // Serialize normal stale-lock reclamation across concurrently restarted workers.
      const guardFile = file + '.reclaim';
      let guard;
      try {
        try { guard = fs.openSync(guardFile, 'wx', 0o600); }
        catch (failure) {
          if (failure.code !== 'EEXIST' || !this.#deadLock(guardFile)) throw failure;
          fs.unlinkSync(guardFile);
          guard = fs.openSync(guardFile, 'wx', 0o600);
        }
        fs.writeFileSync(guard, JSON.stringify({ lockVersion: 1, pid: process.pid, token: crypto.randomUUID() }));
        if (!this.#deadLock(file)) throw error;
        fs.unlinkSync(file);
        return create();
      } finally {
        if (guard !== undefined) { fs.closeSync(guard); fs.unlinkSync(guardFile); }
      }
    }
  }

  #change(operation) {
    this.#directory();
    let lock;
    try { lock = this.#lock(this.lockFile); }
    catch { throw new SubscriptionError('storage_busy', '订阅状态正在更新，请稍后重试。'); }
    const temporary = path.join(this.directory, `.subscriptions-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      const state = this.#read(false);
      const result = operation(state);
      fs.writeFileSync(temporary, JSON.stringify(encryptJson(state,{key:this.storageKey,aad:'Teyvat-Plugin/subscriptions/v1',maxBytes:4*1024*1024}), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
      return result;
    } catch (error) {
      if (error instanceof SubscriptionError) throw error;
      throw new SubscriptionError('storage_failed', '无法保存订阅状态，请检查目录权限和磁盘空间。');
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      fs.closeSync(lock); fs.unlinkSync(this.lockFile);
    }
  }

  #owned(row) {
    const account = this.accounts?.get?.(row.owner, row.uid);
    if (!account || account.uid !== row.uid || !account.hasCookie || !account.cookie) return null;
    return account;
  }

  #active(id, row) {
    const current = this.#read().subscriptions[id];
    const config = this.#config() || {};
    const globalEnabled = config.enabled !== false && config.notifications?.enabled === true;
    return current?.enabled && current.revision === row.revision && globalEnabled;
  }

  #update(id, row, patch) {
    return this.#change(state => {
      const current = state.subscriptions[id];
      if (!current?.enabled || current.revision !== row.revision) return false;
      Object.assign(current.state, patch);
      return true;
    });
  }

  set(owner, input) {
    const id = ownerId(owner);
    if (!input || !KINDS.includes(input.kind) || typeof input.enabled !== 'boolean') throw new SubscriptionError('invalid_parameters', '需要订阅类型 resin/version 和 enabled 布尔值。');
    if (Object.keys(input).some(key => !['kind', 'enabled', 'uid', 'botId', 'groupId', 'threshold'].includes(key))) throw new SubscriptionError('invalid_parameters', '包含不支持的订阅参数；订阅配置不接收 Cookie 或密钥。');
    if (!input.enabled && input.uid == null) return this.#change(state => {
      let count = 0;
      for (const row of Object.values(state.subscriptions)) if (row.owner === id && row.kind === input.kind) { row.enabled = false; row.revision++; count++; }
      return { owner: id, kind: input.kind, enabled: false, count };
    });
    const uid = input.kind === 'version' ? null : input.uid == null ? this.accounts?.selected?.(id)?.uid : validateUid(input.uid).uid;
    const row = { owner: id, uid, kind: input.kind };
    if (input.enabled && input.kind !== 'version' && !this.#owned(row)) throw new SubscriptionError('not_authorized', '请先为当前 QQ 用户绑定并授权该 UID，再主动开启订阅。');
    if (input.kind !== 'version' && !uid) throw new SubscriptionError('not_bound', '请先绑定当前账户。');
    const threshold = input.threshold ?? this.#config()?.notifications?.resinThreshold ?? 180;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 1000) throw new SubscriptionError('invalid_threshold', '树脂阈值应为 1 至 1000 的整数。');
    const botId = optionalId(input.botId);
    const groupId = optionalId(input.groupId);
    return this.#change(state => {
      const key = hash(`${id}:${input.kind}:${uid || ''}`);
      const previous = state.subscriptions[key];
      if (!previous && Object.keys(state.subscriptions).length >= 2000) throw new SubscriptionError('subscription_limit', '已达到实例订阅数量上限。');
      const next = { ...row, enabled: input.enabled, botId, groupId, threshold, revision: (previous?.revision || 0) + 1, state: stateFor(previous?.state) };
      if (previous && (previous.threshold !== threshold || previous.groupId !== groupId || previous.botId !== botId)) next.state.flags = { resin: false, transformer: false, home: false };
      state.subscriptions[key] = next;
      return summary(next);
    });
  }

  list(owner) { const id = ownerId(owner); return Object.values(this.#read().subscriptions).filter(row => row.owner === id).map(summary); }

  async #send(target, text, stats) {
    if (typeof this.send !== 'function') { stats.failed++; return false; }
    try {
      if (await this.send(target, text) === false) { stats.failed++; return false; }
      stats.sent++; return true;
    } catch { stats.failed++; return false; }
  }

  async #notes(id, row, account, config, now, stats) {
    const response = await this.mys.query('dailyNote', account);
    stats.checked++;
    if (!response?.ok || !response.data || typeof response.data !== 'object') { stats.failed++; this.#update(id, row, { noteNextAt: now + this.#interval(config) }); return; }
    const data = response.data;
    const number = (value, cap = 1e9) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= cap;
    const flags = { ...row.state.flags };
    const lines = [];
    const numeric = number(data.current_resin, 1000) && number(data.max_resin, 1000) && data.max_resin > 0;
    if (numeric) {
      flags.resin = data.current_resin >= row.threshold;
      if (flags.resin && !row.state.flags.resin) {
        const recovery = Number(data.resin_recovery_time);
        lines.push(`树脂 ${data.current_resin}/${data.max_resin}，已达到提醒阈值 ${row.threshold}` + (Number.isFinite(recovery) && recovery >= 0 ? `；回满剩余约 ${Math.ceil(recovery / 60)} 分钟` : ''));
      }
    }
    if (config?.notifications?.transformer !== false && data.transformer && typeof data.transformer.obtained === 'boolean') {
      if (!data.transformer.obtained) flags.transformer = false;
      else if (typeof data.transformer.recovery_time?.reached === 'boolean') flags.transformer = data.transformer.recovery_time.reached;
      if (flags.transformer && !row.state.flags.transformer) lines.push('参量质变仪已恢复，可以使用。');
    }
    if (config?.notifications?.homeCoin !== false && number(data.current_home_coin) && number(data.max_home_coin) && data.max_home_coin > 0) {
      flags.home = data.current_home_coin >= data.max_home_coin;
      if (flags.home && !row.state.flags.home) lines.push('洞天宝钱已达到存储上限，请领取。');
    }
    if (!this.#active(id, row) || !this.#owned(row)) return;
    let delivered = false;
    if (lines.length) delivered = await this.#send({ owner: row.owner, botId: row.botId, groupId: row.groupId }, '原神提醒\n' + lines.join('\n'), stats);
    // Failed sends retain unacknowledged rising edges; a restart can retry on next poll.
    const savedFlags = lines.length && !delivered ? Object.fromEntries(Object.entries(flags).map(([key, value]) => [key, value && row.state.flags[key]])) : flags;
    this.#update(id, row, { flags: savedFlags, noteNextAt: now + this.#interval(config) });
  }

  async tick() {
    const stats = { calls: 0, checked: 0, sent: 0, failed: 0, skipped: 0, busy: false };
    if (this.#inFlight) return { ...stats, busy: true };
    this.#inFlight = true;
    let lock;
    try {
      this.#directory();
      try { lock = this.#lock(this.tickLockFile); }
      catch { return { ...stats, busy: true }; }
      const config = this.#config() || {};
      const stored = this.#read();
      const rows = Object.entries(stored.subscriptions).filter(([, row]) => row.enabled);
      if (!rows.length || config.enabled === false) return stats;
      const now = this.now();
      let version = stored.versionSnapshot;
      let versionFetched = false;
      const start = stored.cursor % rows.length;
      let end = start;
      for (let offset = 0; offset < rows.length; offset++) {
        const index = (start + offset) % rows.length;
        const [id, row] = rows[index];
        end = (index + 1) % rows.length;
        if (!this.#active(id, row)) { stats.skipped++; continue; }
        if (row.kind === 'version') {
          if (config.notifications?.enabled !== true) { stats.skipped++; continue; }
          if (!versionFetched && now >= stored.versionNextAt) {
            if (stats.calls >= 50) { end = index; break; }
            stats.calls++; versionFetched = true;
            try {
              const provider = this.publicVersion || (typeof this.publicData === 'function' ? this.publicData : this.publicData?.version?.bind(this.publicData));
              version = typeof provider === 'function' ? versionFor(await provider()) : null;
            } catch { version = null; }
            if (version) this.#change(state => { state.versionSnapshot = version; state.versionNextAt = now + this.#interval(config); });
            else stats.failed++;
          }
          if (!version) continue;
          if (!row.state.versionKey) this.#update(id, row, { versionKey: version.key });
          else if (row.state.versionKey !== version.key && this.#active(id, row)) {
            const sent = await this.#send({ owner: row.owner, botId: row.botId, groupId: row.groupId }, `原神国服 PC 版本有变化\n当前版本 ${version.current}\n预下载 ${version.preDownload || '尚未开放'}\n来源：米哈游 HoYoPlay 启动器。`, stats);
            if (sent) this.#update(id, row, { versionKey: version.key });
          }
          continue;
        }
        const account = this.#owned(row);
        if (!account) { stats.skipped++; continue; }
        if (row.kind === 'resin') {
          if (config.notifications?.enabled !== true || now < row.state.noteNextAt) { stats.skipped++; continue; }
          const noteBudget=Math.min(2,Math.max(1,Number(this.mys.maxRecordRequests?.(account))||1));
          if (stats.calls + noteBudget > 50) { end = index; break; }
          stats.calls+=noteBudget;
          try { await this.#notes(id, row, account, config, now, stats); }
          catch { stats.failed++; this.#update(id, row, { noteNextAt: now + this.#interval(config) }); }
        }
      }
      this.#change(state => { state.cursor = end; });
      return stats;
    } catch { stats.failed++; return stats; }
    finally {
      if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(this.tickLockFile); }
      this.#inFlight = false;
    }
  }

  start() {
    if (this.#timer !== null) return false;
    this.#timer = this.clock.setInterval(() => { void this.tick().catch(() => {}); }, this.#interval(this.#config()));
    this.#timer?.unref?.();
    return true;
  }

  stop() {
    if (this.#timer === null) return false;
    this.clock.clearInterval(this.#timer); this.#timer = null;
    return true;
  }
}
