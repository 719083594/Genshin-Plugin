import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const AAD = Buffer.from('Teyvat-Plugin/accounts/v1', 'utf8');
const TOKEN_KEYS = new Set(['ltoken', 'ltoken_v2', 'cookie_token', 'cookie_token_v2']);
const COOKIE_KEYS = new Set([...TOKEN_KEYS, 'ltuid', 'ltuid_v2', 'account_id', 'account_id_v2', 'ltmid_v2', 'account_mid_v2', 'mi18nLang', 'DEVICEFP', 'DEVICEID']);
const SERVER_PREFIX = Object.freeze({ '1': 'cn_gf01', '2': 'cn_gf01', '3': 'cn_gf01', '5': 'cn_qd01', '6': 'os_usa', '7': 'os_euro', '8': 'os_asia', '18': 'os_asia', '9': 'os_cht' });

export class AccountsError extends Error {
  constructor(code, message) { super(message); this.name = 'AccountsError'; this.code = code; }
}

/** Recognizes the prefix preceding the last eight digits, including 18xxxxxxxx. */
export function validateUid(uid, region) {
  const value = String(uid ?? '').trim();
  if (!/^\d{9,10}$/.test(value)) throw new AccountsError('invalid_uid', '原神 UID 应为 9 位或受支持的 10 位数字。');
  const server = SERVER_PREFIX[value.slice(0, -8)];
  if (!server) throw new AccountsError('invalid_uid', '该 UID 前缀不属于受支持的原神服务器。');
  const zone = server.startsWith('cn_') ? 'cn' : 'os';
  const input = region == null || region === '' ? zone : String(region).toLowerCase();
  if (![zone, server].includes(input)) throw new AccountsError('region_mismatch', 'UID 与所选国服/国际服或服务器不一致。');
  return { uid: value, region: zone, server };
}

export function normalizeCookie(cookie) {
  if (typeof cookie !== 'string' || !cookie || cookie.length > 16384 || /[\r\n\x00-\x1f\x7f]/.test(cookie)) {
    throw new AccountsError('invalid_cookie', 'Cookie 格式无效；请在私聊中提交米游社或 HoYoLAB Cookie。');
  }
  const entries = new Map();
  for (const item of cookie.split(';')) {
    const part = item.trim();
    if (!part) continue;
    const at = part.indexOf('=');
    if (at <= 0) throw new AccountsError('invalid_cookie', 'Cookie 必须为 key=value 格式。');
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (/^(password|passwd|pwd)$/i.test(name)) throw new AccountsError('password_forbidden', '不接受或保存账号密码，请使用 Cookie 绑定。');
    if (!COOKIE_KEYS.has(name)) continue;
    if (!value || !/^[\x21-\x7e]+$/.test(value) || value.includes(',')) throw new AccountsError('invalid_cookie', 'Cookie 字段格式无效。');
    if (entries.has(name) && entries.get(name) !== value) throw new AccountsError('invalid_cookie', 'Cookie 包含相互冲突的重复字段。');
    entries.set(name, value);
  }
  if (![...TOKEN_KEYS].some(key => entries.has(key)) || !['ltuid', 'ltuid_v2', 'account_id', 'account_id_v2'].some(key => /^\d+$/.test(entries.get(key) ?? ''))) {
    throw new AccountsError('incomplete_cookie', 'Cookie 需包含 ltoken 或 cookie_token，以及匹配的 ltuid/account_id（含 v2 形式）。仅 stoken 暂不支持。');
  }
  const identities = ['ltuid', 'ltuid_v2', 'account_id', 'account_id_v2'].filter(key => entries.has(key)).map(key => entries.get(key));
  if (identities.some(value => !/^\d+$/.test(value)) || new Set(identities).size > 1) throw new AccountsError('invalid_cookie', 'Cookie 中的账号标识不一致，请从同一登录账号重新获取。');
  return [...entries].map(([name, value]) => `${name}=${value}`).join('; ') + ';';
}

function ownerId(owner) {
  const value = String(owner ?? '');
  if (!/^[1-9]\d{4,14}$/.test(value)) throw new AccountsError('invalid_owner', '需要有效的 QQ 用户标识。');
  return value;
}

function parseKey(key) {
  let bytes;
  if (Buffer.isBuffer(key) || key instanceof Uint8Array) bytes = Buffer.from(key);
  else if (typeof key === 'string' && /^[a-f\d]{64}$/i.test(key)) bytes = Buffer.from(key, 'hex');
  else if (typeof key === 'string' && /^[a-z\d+/]{43}=$/i.test(key)) bytes = Buffer.from(key, 'base64');
  if (!bytes || bytes.length !== 32) throw new AccountsError('missing_key', '账户加密密钥必须为 32 字节，保存于环境变量或被 Git 忽略的本地配置。');
  return bytes;
}

function publicAccount(account, chosen) {
  return { uid: account.uid, server: account.server, region: account.region, label: account.label, hasCookie: Boolean(account.cookie), selected: chosen === account.uid, createdAt: account.createdAt, updatedAt: account.updatedAt };
}

function noLink(file, directory = false) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new AccountsError('unsafe_storage', '账户存储位置必须为普通目录/文件，不接受符号链接。');
  }
}

/** Entire database and rolling backup are encrypted, including QQ owners and UID metadata.
 * root is the plugin root. Never store the encryption key under data/ or in a backup.
 * Mutations are synchronous and protected by an exclusive cross-process lock.
 */
export class AccountsStore {
  #key;
  constructor(root, { key = process.env.TEYVAT_ACCOUNT_KEY, maxAccounts = 20 } = {}) {
    this.root = path.resolve(root);
    this.directory = path.join(this.root, 'data');
    this.file = path.join(this.directory, 'accounts.enc.json');
    this.backupFile = this.file + '.bak';
    this.lockFile = path.join(this.directory, '.accounts.lock');
    this.#key = parseKey(key);
    this.maxAccounts = Math.max(1, Math.min(100, Number(maxAccounts) || 20));
  }

  #checkDirectory() {
    noLink(this.root, true);
    noLink(this.directory, true);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    noLink(this.directory, true);
    noLink(this.file);
    noLink(this.backupFile);
  }

  #read() {
    this.#checkDirectory();
    if (!fs.existsSync(this.file)) return { version: 1, owners: {} };
    try {
      if (fs.statSync(this.file).size > 8 * 1024 * 1024) throw new Error();
      const envelope = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error();
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.#key, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
      const value = JSON.parse(plaintext.toString('utf8'));
      plaintext.fill(0);
      if (value.version !== 1 || !value.owners || typeof value.owners !== 'object' || Array.isArray(value.owners)) throw new Error();
      return value;
    } catch {
      throw new AccountsError('decrypt_failed', '账户数据无法解密或完整性校验失败；请检查原加密密钥，勿覆盖原文件及加密备份。');
    }
  }

  #write(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(value));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    plaintext.fill(0);
    const envelope = { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    const temporary = path.join(this.directory, `.accounts-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(envelope) + '\n', { flag: 'wx', mode: 0o600 });
      if (fs.existsSync(this.file)) {
        fs.copyFileSync(this.file, this.backupFile);
        fs.chmodSync(this.backupFile, 0o600);
      }
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  #mutate(operation) {
    this.#checkDirectory();
    let lock;
    try { lock = fs.openSync(this.lockFile, 'wx', 0o600); }
    catch { throw new AccountsError('storage_busy', '账户存储正在更新或存在遗留锁，请稍后重试。'); }
    try {
      const state = this.#read();
      const result = operation(state);
      this.#write(state);
      return result;
    } catch (error) {
      if (error instanceof AccountsError) throw error;
      throw new AccountsError('storage_failed', '账户存储操作失败，请检查目录权限和磁盘空间。');
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(this.lockFile);
    }
  }

  list(owner) {
    const entry = this.#read().owners[ownerId(owner)];
    return Object.values(entry?.accounts ?? {}).map(account => publicAccount(account, entry.selected));
  }

  bind(owner, input) {
    const id = ownerId(owner);
    if (!input || Object.hasOwn(input, 'password')) throw new AccountsError('password_forbidden', '不接受账号密码，请使用 UID 或私聊 Cookie 绑定。');
    const valid = validateUid(input.uid, input.server || input.region);
    if (input.region && input.server) validateUid(input.uid, input.region);
    const supplied = Object.hasOwn(input, 'cookie');
    const cookie = supplied && input.cookie ? normalizeCookie(input.cookie) : '';
    if (cookie && input.privateChat !== true) throw new AccountsError('private_only', 'Cookie 绑定仅允许在机器人私聊中操作。');
    const label = String(input.label ?? '').trim();
    if (label.length > 40 || /[\x00-\x1f\x7f]/.test(label) || /(?:cookie|token|password|ltuid|account_id|authkey)\s*=/i.test(label)) {
      throw new AccountsError('invalid_label', '账户备注最多 40 字符，不能包含控制字符或登录凭据。');
    }
    return this.#mutate(state => {
      const entry = state.owners[id] ??= { selected: null, accounts: {} };
      const previous = entry.accounts[valid.uid];
      if (!previous && Object.keys(entry.accounts).length >= this.maxAccounts) throw new AccountsError('account_limit', '已达到该 QQ 用户的账户数量上限。');
      const now = new Date().toISOString();
      const account = { ...valid, label: label || previous?.label || '', cookie: supplied ? cookie : previous?.cookie || '', createdAt: previous?.createdAt || now, updatedAt: now };
      entry.accounts[valid.uid] = account;
      entry.selected ||= valid.uid;
      return publicAccount(account, entry.selected);
    });
  }

  select(owner, uid) {
    const id = ownerId(owner);
    const valid = validateUid(uid);
    return this.#mutate(state => {
      const entry = state.owners[id];
      if (!entry?.accounts[valid.uid]) throw new AccountsError('not_bound', '该 QQ 用户尚未绑定此 UID。');
      entry.selected = valid.uid;
      return publicAccount(entry.accounts[valid.uid], valid.uid);
    });
  }

  get(owner, uid) {
    const entry = this.#read().owners[ownerId(owner)];
    const target = uid == null ? entry?.selected : validateUid(uid).uid;
    const account = entry?.accounts[target];
    return account ? { ...publicAccount(account, entry.selected), ...(account.cookie ? { cookie: account.cookie } : {}) } : null;
  }

  selected(owner) { return this.get(owner); }

  remove(owner, uid) {
    const id = ownerId(owner);
    const valid = validateUid(uid);
    return this.#mutate(state => {
      const entry = state.owners[id];
      if (!entry?.accounts[valid.uid]) return false;
      delete entry.accounts[valid.uid];
      if (entry.selected === valid.uid) entry.selected = Object.keys(entry.accounts)[0] ?? null;
      if (!Object.keys(entry.accounts).length) delete state.owners[id];
      return true;
    });
  }
}
