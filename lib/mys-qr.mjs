import crypto from 'node:crypto';
import { AccountsStore, AccountsError, normalizeCookie, validateUid } from './accounts.mjs';
import { HoyolabClient } from './hoyolab.mjs';

// Checked 2026-10-07 against genshin.py routes.py, utility/auth.py,
// auth/subclients/app.py and models/auth/cookie.py, and the official mobile
// page's status enum. Real no-credential create/status calls returned Created.
// Modern web QR returns the six v2 cookies via Set-Cookie. It does not require
// the older hk4e-sdk GameToken -> SToken exchange, and never stores an SToken.
const CREATE = 'https://passport-api.miyoushe.com/account/ma-cn-passport/web/createQRLogin';
const QUERY = 'https://passport-api.miyoushe.com/account/ma-cn-passport/web/queryQRLoginStatus';
const REQUIRED_COOKIES = ['cookie_token_v2', 'account_mid_v2', 'account_id_v2', 'ltoken_v2', 'ltmid_v2', 'ltuid_v2'];
const fail = (code, message, retcode) => ({ ok: false, code, message, ...(Number.isSafeInteger(retcode) ? { retcode } : {}) });
class QrError extends Error { constructor(code, message, retcode) { super(message); this.code = code; this.retcode = retcode; } }
function errorResult(error) {
  if (error instanceof QrError || error instanceof AccountsError) return fail(error.code, error.message, error.retcode);
  return fail('login_failed', '扫码登录未完成，请重新创建二维码；没有报告或保存未经验证的登录成功。');
}
function ownerId(owner) {
  const id = String(owner ?? '');
  if (!/^[1-9]\d{4,14}$/.test(id)) throw new QrError('invalid_owner', '需要有效的QQ用户标识。');
  return id;
}
function privateOnly(options) {
  if (!options || options.privateChat !== true) throw new QrError('private_only', '米游社扫码登录、状态查询与取消只能在机器人私聊中操作。');
}
function safeRole(role) {
  const valid = validateUid(role.uid, role.server || role.region || 'cn');
  if (role.region) validateUid(role.uid, role.region);
  if (role.game_biz !== undefined && role.game_biz !== 'hk4e_cn') throw new QrError('wrong_game', '二维码授权角色不是国服原神角色。');
  if (valid.region !== 'cn') throw new QrError('wrong_region', '米游社二维码只支持国服原神账户。');
  return { ...valid, nickname: String(role.nickname ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 40), level: Number.isSafeInteger(role.level) ? role.level : null };
}
function readCookies(headers, data) {
  if (typeof headers?.getSetCookie !== 'function') throw new QrError('unsupported_response', '当前运行环境无法安全读取登录Set-Cookie；需要Node.js 22或更新版本。');
  const entries = new Map();
  for (const raw of headers.getSetCookie()) {
    if (typeof raw !== 'string') continue;
    const pair = raw.split(';', 1)[0], at = pair.indexOf('=');
    if (at < 1) continue;
    const name = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim();
    if (!REQUIRED_COOKIES.includes(name)) continue;
    if (entries.has(name) && entries.get(name) !== value) throw new QrError('conflicting_identity', '扫码返回了冲突的账户字段，请重新登录。');
    entries.set(name, value);
  }
  if (REQUIRED_COOKIES.some(key => !entries.get(key))) throw new QrError('unsupported_response', '官方已确认扫码，但没有返回完整v2登录Cookie；未保存账户，请重新扫码或使用私聊Cookie绑定。');
  if (entries.get('account_mid_v2') !== entries.get('ltmid_v2') || entries.get('account_id_v2') !== entries.get('ltuid_v2'))
    throw new QrError('conflicting_identity', '扫码返回的账户标识不一致，未保存账户。');
  if (data.user_info?.aid !== undefined && String(data.user_info.aid) !== entries.get('account_id_v2'))
    throw new QrError('conflicting_identity', '扫码账户与登录凭据归属不一致，未保存账户。');
  if (data.user_info?.mid !== undefined && String(data.user_info.mid) !== entries.get('account_mid_v2'))
    throw new QrError('conflicting_identity', '扫码账户与登录凭据归属不一致，未保存账户。');
  return normalizeCookie(REQUIRED_COOKIES.map(key => key + '=' + entries.get(key)).join('; ') + ';');
}
async function defaultEncoder(url) {
  const module = await import('qrcode');
  return (module.default ?? module).toBuffer(url, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 360 });
}
const waitFor = (delay, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new QrError('cancelled', '扫码登录已取消。')); return; }
  const timer = setTimeout(done, delay);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new QrError('cancelled', '扫码登录已取消。')); }
  signal?.addEventListener('abort', abort, { once: true });
});

export class MysQrLogin {
  #sessions = new Map();
  #owners = new Map();
  #starting = new Set();
  constructor(root, { accounts, mys, fetch = globalThis.fetch, timeoutMs = 12000, now = () => Date.now(),
    encodeQr = defaultEncoder, key, ttlMs = 180000, pollMs = 2000, maxSessions = 50 } = {}) {
    if (typeof fetch !== 'function' || typeof now !== 'function' || typeof encodeQr !== 'function') throw new QrError('invalid_options', '扫码登录模块依赖配置无效。');
    this.accounts = accounts ?? new AccountsStore(root, { key });
    this.mys = mys ?? new HoyolabClient({ fetch, timeoutMs });
    this.fetch = fetch;
    this.now = now;
    this.encodeQr = encodeQr;
    this.timeoutMs = Math.max(1000, Math.min(60000, Number(timeoutMs) || 12000));
    this.ttlMs = Math.max(1000, Math.min(300000, Number(ttlMs) || 180000));
    this.pollMs = Math.max(0, Math.min(10000, Number(pollMs) || 0));
    this.maxSessions = Math.max(1, Math.min(100, Number(maxSessions) || 50));
  }
  #active(session) { return this.#sessions.get(session.id) === session && !session.closed && Number(this.now()) < session.expiresAt; }
  #close(session, result) {
    session.closed = true;
    session.cookie = undefined; session.ticket = undefined; session.url = undefined;
    session.result = result;
    session.controller.abort();
    return result;
  }
  #clean() {
    const now = Number(this.now());
    for (const [id, session] of this.#sessions) {
      if (now >= session.expiresAt) {
        if (!session.closed) this.#close(session, fail('expired', '扫码二维码已过期，请重新创建。'));
        this.#sessions.delete(id);
        if (this.#owners.get(session.owner) === id) this.#owners.delete(session.owner);
      }
    }
  }
  #find(owner, id) {
    owner = ownerId(owner);
    const session = this.#sessions.get(String(id ?? ''));
    if (!session || session.owner !== owner) throw new QrError('session_missing', '没有找到此QQ用户的扫码会话，请重新创建二维码。');
    if (Number(this.now()) >= session.expiresAt && !session.closed) this.#close(session, fail('expired', '扫码二维码已过期，请重新创建。'));
    return session;
  }
  async #request(url, session, body) {
    if (![CREATE, QUERY].includes(url)) throw new QrError('unsupported_endpoint', '不支持此登录地址。');
    const controller = new AbortController();
    let timer, onAbort;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new QrError('timeout', '米游社登录请求超时，请稍后重试。')); }, this.timeoutMs);
      onAbort = () => { controller.abort(); reject(new QrError('cancelled', '扫码登录已取消或被新的二维码替换。')); };
      session.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (session.controller.signal.aborted) onAbort();
    });
    const operation = (async () => {
      const response = await this.fetch(url, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'x-rpc-app_id': 'bll8iq97cem8', 'x-rpc-client_type': '4', 'x-rpc-game_biz': 'bbs_cn',
          'x-rpc-device_id': session.deviceId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.url && response.url !== url) throw new QrError('unsafe_redirect', '登录接口返回了非预期地址，已停止。');
      if (response.status >= 300 && response.status < 400) throw new QrError('unsafe_redirect', '登录接口要求跳转，已停止。');
      if (response.status === 429) throw new QrError('rate_limited', '米游社请求过于频繁，请稍后重新扫码。');
      if (!response.ok) throw new QrError('http_error', '米游社登录接口暂时不可用，请稍后重试。');
      const text = await response.text();
      if (Buffer.byteLength(text) > 1024 * 1024) throw new QrError('unsupported_response', '米游社登录响应过大，已停止。');
      let payload;
      try { payload = JSON.parse(text); } catch { throw new QrError('unsupported_response', '米游社登录接口返回格式无法识别。'); }
      if (!payload || !Number.isSafeInteger(payload.retcode)) throw new QrError('unsupported_response', '米游社登录响应缺少有效返回码。');
      if ([-3101, 1034, 10035, 10041, 5003].includes(payload.retcode) || payload.data?.need_realperson ||
          payload.data?.gt || payload.data?.challenge || response.headers.get('x-rpc-aigis'))
        throw new QrError('verification_required', '米游社要求安全或实名验证，请在官方App完成验证后重新扫码。', payload.retcode);
      if (payload.retcode !== 0) throw new QrError('upstream_error', '米游社未完成扫码登录，请重新创建二维码或在官方App检查登录状态。', payload.retcode);
      if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) throw new QrError('unsupported_response', '米游社登录响应缺少有效数据。');
      return { data: payload.data, headers: response.headers };
    })();
    try { return await Promise.race([operation, deadline]); }
    catch (error) { if (error instanceof QrError) throw error; throw new QrError('network_error', '米游社登录网络请求失败，请稍后重试。'); }
    finally { clearTimeout(timer); session.controller.signal.removeEventListener('abort', onAbort); }
  }
  async start(owner, options = {}) {
    let session, id, started = false;
    try {
      privateOnly(options); id = ownerId(owner);
      if (Object.keys(options).some(key => !['privateChat', 'uid', 'region', 'label'].includes(key))) throw new QrError('invalid_options', '扫码登录只接受国服UID和账户备注，不接受账号密码或凭据。');
      if (options.region !== undefined && options.region !== 'cn') throw new QrError('unsupported_region', '米游社扫码目前仅支持国服；国际服请私聊绑定HoYoLAB Cookie。');
      const expectedUid = options.uid === undefined ? undefined : validateUid(options.uid, 'cn').uid;
      const label = String(options.label ?? '').trim();
      if (label.length > 40 || /[\x00-\x1f\x7f]/.test(label) || /(?:cookie|token|password|ltuid|account_id|authkey)\s*=/i.test(label)) throw new QrError('invalid_label', '账户备注格式无效。');
      this.accounts.list(id); // Verify readable encryption storage before requesting login.
      this.#clean();
      if (this.#starting.has(id)) throw new QrError('busy', '该QQ用户正在创建扫码二维码，请稍后。');
      const previous = this.#sessions.get(this.#owners.get(id));
      if (previous) { this.#close(previous, fail('cancelled', '旧扫码会话已被新的二维码替换。')); this.#sessions.delete(previous.id); }
      if (this.#sessions.size >= this.maxSessions) throw new QrError('busy', '扫码会话数量已达上限，请稍后重试。');
      this.#starting.add(id);
      started = true;
      session = { id: crypto.randomBytes(16).toString('hex'), owner: id, expectedUid, label, deviceId: crypto.randomUUID(),
        expiresAt: Number(this.now()) + this.ttlMs, controller: new AbortController(), state: 'Starting', polls: 0, nextPollAt: 0, closed: false };
      this.#sessions.set(session.id, session); this.#owners.set(id, session.id);
      const response = await this.#request(CREATE, session);
      const { ticket, url } = response.data;
      if (typeof ticket !== 'string' || !/^[a-zA-Z0-9_-]{1,512}$/.test(ticket) || typeof url !== 'string' || url.length > 4096) throw new QrError('unsupported_response', '米游社未返回有效扫码票据。');
      let target;
      try { target = new URL(url); } catch { throw new QrError('unsupported_response', '米游社二维码地址格式无效。'); }
      if (target.origin !== 'https://user.mihoyo.com' || target.pathname !== '/login-platform/mobile.html' || target.username || target.password)
        throw new QrError('unsafe_qr_url', '米游社返回了非预期二维码地址，已停止。');
      if (!this.#active(session)) throw new QrError('cancelled', '扫码会话已取消或过期。');
      session.ticket = ticket; session.url = url;
      let qrPng;
      try { qrPng = await this.encodeQr(url); } catch { throw new QrError('qr_renderer_unavailable', '二维码图片生成失败，请检查qrcode依赖后重新创建。'); }
      if (!Buffer.isBuffer(qrPng) || qrPng.length < 8 || qrPng.length > 1024 * 1024 || !qrPng.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new QrError('qr_renderer_unavailable', '二维码渲染器未返回有效PNG数据。');
      if (!this.#active(session)) throw new QrError('cancelled', '扫码会话已取消或过期。');
      session.state = 'Created';
      return { ok: true, status: 'Created', sessionId: session.id, expiresAt: session.expiresAt, qrUrl: url, qrPng };
    } catch (error) {
      const result = errorResult(error);
      if (session && !session.closed) this.#close(session, result);
      return result;
    } finally { if (started) this.#starting.delete(id); }
  }
  async #roles(session) {
    let timer, onAbort;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new QrError('timeout', '原神角色归属核验超时，账户尚未保存，请稍后查询状态重试。')), this.timeoutMs);
      onAbort = () => reject(new QrError('cancelled', '扫码会话已取消或被新的二维码替换。'));
      session.controller.signal.addEventListener('abort', onAbort, { once: true });
      if (session.controller.signal.aborted) onAbort();
    });
    try { return await Promise.race([Promise.resolve().then(() => this.mys.roles(session.cookie, 'cn')), deadline]); }
    finally { clearTimeout(timer); session.controller.signal.removeEventListener('abort', onAbort); }
  }
  async #complete(session, response) {
    if (!session.cookie) session.cookie = readCookies(response.headers, response.data);
    session.state = 'Verifying';
    const found = await this.#roles(session);
    if (!this.#active(session)) return session.result ?? fail('expired', '扫码会话已取消或过期。');
    if (!found?.ok) {
      if (found?.code === 'verification_required') return this.#close(session, fail('verification_required', '米游社要求安全验证，请在官方App完成后重新扫码。'));
      return fail('roles_check_failed', '官方已确认扫码，但原神角色归属尚未核验成功；账户未作为登录成功保存，可稍后查询扫码状态重试。');
    }
    if (!Array.isArray(found.data)) throw new QrError('unsupported_response', '原神角色列表格式无法识别，未保存账户。');
    const unique = new Map();
    for (const role of found.data) {
      try { const safe = safeRole(role); unique.set(safe.uid, safe); } catch { /* Exclude all foreign/invalid game roles. */ }
    }
    const roles = [...unique.values()];
    if (!roles.length) return this.#close(session, fail('no_genshin_roles', '此米游社账户没有可验证的国服原神角色，未保存登录。'));
    if (session.expectedUid && !unique.has(session.expectedUid)) return this.#close(session, fail('wrong_account', '扫码账户不拥有指定原神UID，原有账户未更改，请使用本人米游社账户重新扫码。'));
    const chosen = session.expectedUid ? [unique.get(session.expectedUid)] : roles;
    const existing = this.accounts.list(session.owner);
    const count = new Set([...existing.map(x => x.uid), ...chosen.map(x => x.uid)]).size;
    if (count > (this.accounts.maxAccounts ?? 20)) return this.#close(session, fail('account_limit', '本QQ用户账户数量达到上限，请先解绑不需要的账户再重新扫码。'));
    if (!this.#active(session)) return session.result ?? fail('expired', '扫码会话已取消或过期。');
    const bound = chosen.map(role => this.accounts.bind(session.owner, { uid: role.uid, server: role.server, region: 'cn',
      cookie: session.cookie, privateChat: true, ...(session.label ? { label: session.label } : {}) }));
    const preferred = session.expectedUid ?? existing.find(x => x.selected && chosen.some(role => role.uid === x.uid))?.uid ?? chosen[0].uid;
    this.accounts.select(session.owner, preferred);
    return this.#close(session, { ok: true, status: 'Confirmed', sessionId: session.id, accounts: bound.map(account => ({...account, selected: account.uid === preferred})), roles, selectedUid: preferred,
      message: '米游社扫码登录已完成，原神角色归属已验证，账户凭据已加密保存。' });
  }
  async poll(owner, sessionId, options = {}) {
    let session;
    try {
      privateOnly(options); session = this.#find(owner, sessionId);
      if (session.closed) return session.result;
      if (session.pending) return await session.pending;
      if (session.state === 'Starting') return { ok: true, status: 'Starting', sessionId: session.id, expiresAt: session.expiresAt };
      if (Number(this.now()) < session.nextPollAt) return { ok: true, status: session.state, sessionId: session.id, expiresAt: session.expiresAt, retryAfterMs: session.nextPollAt - Number(this.now()) };
      if (session.polls >= 180) return this.#close(session, fail('expired', '扫码状态检查达到上限，请重新创建二维码。'));
      session.polls++; session.nextPollAt = Number(this.now()) + this.pollMs;
      const pending = (async () => {
        if (session.cookie) return this.#complete(session, null);
        const response = await this.#request(QUERY, session, { ticket: session.ticket });
        if (!this.#active(session)) return session.result ?? fail('expired', '扫码会话已取消或过期。');
        if (response.data.status === 'Confirmed') return this.#complete(session, response);
        if (!['Created', 'Scanned'].includes(response.data.status)) return this.#close(session, fail('unsupported_response', '米游社返回了无法识别的扫码状态，请重新创建二维码。'));
        session.state = response.data.status;
        return { ok: true, status: session.state, sessionId: session.id, expiresAt: session.expiresAt };
      })();
      session.pending = pending;
      try { return await pending; } finally { session.pending = undefined; }
    } catch (error) {
      const result = errorResult(error);
      if (session && !['timeout', 'network_error', 'http_error', 'rate_limited'].includes(result.code) && !session.closed) this.#close(session, result);
      return result;
    }
  }
  cancel(owner, sessionId, options = {}) {
    try { privateOnly(options); const session = this.#find(owner, sessionId); return session.closed ? session.result : this.#close(session, { ok: true, status: 'Cancelled', sessionId: session.id }); }
    catch (error) { return errorResult(error); }
  }
  async wait(owner, sessionId, { privateChat, signal, onStatus } = {}) {
    try {
      privateOnly({ privateChat });
      let lastStatus, notificationFailed = false;
      while (!signal?.aborted) {
        const result = await this.poll(owner, sessionId, { privateChat: true });
        const status = result.status ?? result.code;
        if (onStatus && status !== lastStatus) {
          lastStatus = status;
          try { await onStatus(result); } catch { notificationFailed = true; }
        }
        if (!result.ok || result.status === 'Confirmed' || result.status === 'Cancelled') return notificationFailed ? {...result, notificationFailed: true} : result;
        await waitFor(Math.max(1000, this.pollMs, result.retryAfterMs ?? 0), signal);
      }
      return this.cancel(owner, sessionId, { privateChat: true });
    } catch (error) {
      if (signal?.aborted) return this.cancel(owner, sessionId, { privateChat: true });
      return errorResult(error);
    }
  }
  stop() { for (const session of this.#sessions.values()) this.#close(session, fail('cancelled', '扫码登录已停止。')); this.#sessions.clear(); this.#owners.clear(); }
}
