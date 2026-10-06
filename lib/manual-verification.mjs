import crypto from 'node:crypto';
import { validateUid, normalizeCookie } from './accounts.mjs';

/** Human-only GeeTest v3 integration, checked against official documentation:
 * https://docs.geetest.com/2.0/sections/idx-client-sdk.html (HTTPS gt.js)
 * https://docs.geetest.com/captcha/apirefer/api/web (onSuccess/getValidate)
 * https://docs.geetest.com/captcha/deploy/client/web/ (SDK resource domains)
 * No solver, browser automation, Cookie-bearing HTML, or filesystem output.
 * The trusted Mys client owns official create/submit endpoints and device grants.
 */
const TTL_MS = 300000;
const COOLDOWN_MS = 15000;
const MAX_SESSIONS = 256;
const PROOF_KEYS = ['geetest_challenge', 'geetest_validate', 'geetest_seccode'];
const GT = /^[a-f\d]{32}$/i;
const INITIAL_CHALLENGE = /^[a-z\d]{32,64}$/i;
const PROOF_CHALLENGE = /^[a-z\d_-]{32,64}$/i;
const VALIDATE = /^[a-z\d_-]{16,256}$/i;
const NONCE = /^[a-z\d_-]{32}$/i;
const result = (ok, code, text, extra = {}) => ({ ok, code, text, message: text, ...extra });
const fail = (code, text, extra) => result(false, code, text, extra);
class VerificationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function reject(code, message) { throw new VerificationError(code, message); }
function ownerId(owner) {
  if (!['string', 'number'].includes(typeof owner)) reject('invalid_owner', '需要有效的 QQ 用户标识。');
  const value = String(owner);
  if (!/^[1-9]\d{4,14}$/.test(value)) reject('invalid_owner', '需要有效的 QQ 用户标识。');
  return value;
}
function privateOnly(options) {
  if (options?.privateChat !== true) reject('private_only', '安全验证和回执提交仅限本人在机器人私聊中操作。');
}
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exactKeys(value, allowed) {
  return plain(value) && Reflect.ownKeys(value).length === allowed.length
    && allowed.every(key => Object.hasOwn(value, key));
}
function accountInfo(account) {
  if (!plain(account) || typeof account.cookie !== 'string') reject('not_logged_in', '请先私聊登录并选中本人原神账户。');
  let identity, cookie;
  try {
    identity = validateUid(account.uid, account.server || account.region || 'cn');
    if (account.region != null) validateUid(account.uid, account.region);
    cookie = normalizeCookie(account.cookie);
  } catch { reject('invalid_account', '当前账户信息无效，请检查本人登录和所选账户。'); }
  if (identity.region !== 'cn' || (account.game_biz != null && account.game_biz !== 'hk4e_cn'))
    reject('unsupported_region', '人工验证目前仅支持国服原神；国际服请在 HoYoLAB 完成验证。');
  return { ...identity, cookie };
}
const cookieHash = cookie => crypto.createHash('sha256').update(cookie, 'utf8').digest();
const same = (left, right) => Buffer.isBuffer(left) && Buffer.isBuffer(right)
  && left.length === right.length && crypto.timingSafeEqual(left, right);
function challengeData(data) {
  if (!exactKeys(data, ['gt', 'challenge', 'new_captcha']) || typeof data.gt !== 'string' || !GT.test(data.gt)
    || typeof data.challenge !== 'string' || !INITIAL_CHALLENGE.test(data.challenge) || typeof data.new_captcha !== 'boolean')
    reject('invalid_response', '官方验证挑战格式无法识别，请重新发起安全验证。');
  return { gt: data.gt, challenge: data.challenge, new_captcha: data.new_captcha };
}
function deviceData(device) {
  if (!exactKeys(device, ['deviceId', 'fingerprint']) || ['deviceId', 'fingerprint'].some(key =>
    typeof device[key] !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(device[key])))
    reject('invalid_response', '官方验证设备格式无法识别，请重新发起安全验证。');
  return Object.freeze({ deviceId: device.deviceId, fingerprint: device.fingerprint });
}
function parseProof(encoded) {
  if (typeof encoded !== 'string' || !/^[a-z\d_-]{1,1536}$/i.test(encoded))
    reject('invalid_proof', '验证回执格式不正确，请完整复制页面生成的命令。');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length > 1024 || bytes.toString('base64url') !== encoded)
    reject('invalid_proof', '验证回执编码不正确，请完整复制页面生成的命令。');
  let proof;
  try { proof = JSON.parse(bytes.toString('utf8')); } catch { reject('invalid_proof', '验证回执不是有效 JSON，请复制页面生成的命令。'); }
  if (!exactKeys(proof, PROOF_KEYS) || typeof proof.geetest_challenge !== 'string' || !PROOF_CHALLENGE.test(proof.geetest_challenge)
    || typeof proof.geetest_validate !== 'string' || !VALIDATE.test(proof.geetest_validate)
    || typeof proof.geetest_seccode !== 'string' || proof.geetest_seccode !== proof.geetest_validate + '|jordan')
    reject('invalid_proof', '验证回执字段不正确，请完整复制页面生成的命令。');
  return Object.fromEntries(PROOF_KEYS.map(key => [key, proof[key]]));
}
function safeError(error) {
  return error instanceof VerificationError ? fail(error.code, error.message)
    : fail('verification_failed', '安全验证未完成，请稍后重新发起；未报告验证成功。');
}
function upstreamError(response, submitting = false) {
  const messages = {
    timeout: '官方验证接口超时，请稍后重新发起。',
    network_error: '官方验证接口网络异常，请稍后重新发起。',
    rate_limited: '官方验证请求过于频繁，请稍后重新发起。',
    not_logged_in: '本人登录已失效，请重新登录后发起安全验证。',
    verification_required: '官方尚未接受安全验证，请检查官方 App 或重新发起本人验证。',
    fingerprint_unavailable: '官方设备标识暂时不可用，请稍后重新发起。',
    invalid_response: '官方验证响应格式已变化，请稍后重试。',
    unsupported: '当前账户不支持此人工验证入口。',
    expired: '官方验证挑战已过期，请重新发起。',
    used: '官方验证挑战已使用，请重新发起。'
  };
  const code = Object.hasOwn(messages, response?.code) ? response.code : 'verification_failed';
  return fail(code, messages[code] || (submitting ? '官方未接受验证回执，请重新发起本人验证。' : '官方未创建验证挑战，请稍后重新发起。'));
}
function safeJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}
function verificationHtml(data, nonce, prefix, remainingMs) {
  const scriptNonce = crypto.randomBytes(18).toString('base64');
  const sources = 'https://*.geetest.com https://*.geevisit.com https://*.gsensebot.com';
  const csp = `default-src 'none'; script-src 'nonce-${scriptNonce}' ${sources}; style-src 'unsafe-inline' ${sources}; img-src data: ${sources}; connect-src ${sources}; frame-src ${sources}; font-src ${sources}; object-src 'none'; base-uri 'none'; form-action 'none'`;
  const config = safeJson({ ...data, nonce, prefix, remainingMs });
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}">
<title>米游社本人安全验证</title><style>body{font-family:system-ui,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;line-height:1.6}textarea{box-sizing:border-box;width:100%;min-height:9rem}button{padding:.7rem 1rem}#status{min-height:2rem}</style></head>
<body><h1>米游社本人安全验证</h1><p>下方是官方极验，仅供本人手动操作。成功后，将页面生成的整条命令复制到创建此验证的同一 QQ 机器人私聊。本页面不含账户登录凭据，不会自动向机器人提交。</p>
<p>QQ 内置浏览器若无法加载，请下载此 HTML，使用系统浏览器打开，再复制完整生成命令回同一 QQ 私聊。</p>
<p>挑战从创建起五分钟有效。请保持原先所选账户，勿将页面或回执转发给他人。</p><div id="captcha"></div><p id="status" role="status">正在加载官方验证…</p>
<label for="receipt">本人私聊回执命令</label><textarea id="receipt" readonly autocomplete="off" spellcheck="false"></textarea><button id="copy" type="button" disabled>复制回执命令</button>
<noscript>请在启用 JavaScript 的浏览器中打开，亲自完成官方验证。</noscript>
<script id="verification-config" type="application/json">${config}</script>
<script src="https://static.geetest.com/static/tools/gt.js" referrerpolicy="no-referrer"></script>
<script nonce="${scriptNonce}">
'use strict';
const config=JSON.parse(document.getElementById('verification-config').textContent);
const status=document.getElementById('status'),receipt=document.getElementById('receipt'),copy=document.getElementById('copy');
let expired=false,widget;
setTimeout(function(){expired=true;receipt.value='';copy.disabled=true;status.textContent='挑战已过期，请私聊机器人重新发起。';if(widget&&typeof widget.destroy==='function')widget.destroy();},config.remainingMs);
copy.addEventListener('click',async function(){if(expired||!receipt.value)return;try{await navigator.clipboard.writeText(receipt.value);status.textContent='命令已复制，请发送到原机器人私聊。';}catch{receipt.focus();receipt.select();status.textContent='请手动复制已选中的整条命令，发送到原机器人私聊。';}});
if(typeof initGeetest!=='function'){status.textContent='官方验证 SDK 未能加载，请检查网络或重新发起。';}else{
initGeetest({gt:config.gt,challenge:config.challenge,new_captcha:config.new_captcha,offline:false,https:true,product:'embed',width:'100%',lang:'zh-cn'},function(captcha){
widget=captcha;if(expired){if(typeof captcha.destroy==='function')captcha.destroy();return;}captcha.appendTo('#captcha');
captcha.onReady(function(){if(!expired)status.textContent='请亲自操作官方验证。';});
captcha.onError(function(){if(!expired)status.textContent='官方验证出现错误，请重新发起或在官方 App 检查。';});
captcha.onSuccess(function(){
if(expired)return;const value=captcha.getValidate();
if(!value||typeof value.geetest_challenge!=='string'||!/^[a-z\\d_-]{32,64}$/i.test(value.geetest_challenge)||value.geetest_challenge.slice(0,32)!==config.challenge.slice(0,32)||typeof value.geetest_validate!=='string'||!/^[a-z\\d_-]{16,256}$/i.test(value.geetest_validate)||value.geetest_seccode!==value.geetest_validate+'|jordan'){status.textContent='官方回执格式不匹配，请重新发起。';return;}
const proof={geetest_challenge:value.geetest_challenge,geetest_validate:value.geetest_validate,geetest_seccode:value.geetest_seccode};
const encoded=btoa(JSON.stringify(proof)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
receipt.value=config.prefix+'提交验证 '+config.nonce+' '+encoded;copy.disabled=false;status.textContent='本人操作已完成，请复制整条命令到原机器人私聊；最终结果以官方接受及查询响应为准。';
});});}
</script></body></html>`;
}

export class ManualVerification {
  #mys;
  #now;
  #prefix;
  #sessions = new Map();
  #cooldowns = new Map();
  constructor({ mys, now = Date.now, prefix = '#原神' } = {}) {
    if (typeof mys?.createVerification !== 'function' || typeof mys?.submitVerification !== 'function'
      || typeof now !== 'function' || typeof prefix !== 'string' || !prefix || prefix.length > 128 || /[\x00-\x1f\x7f]/.test(prefix))
      reject('invalid_options', '人工验证模块依赖或命令前缀无效。');
    this.#mys = mys; this.#now = now; this.#prefix = prefix;
  }
  #time() {
    const time = Number(this.#now());
    if (!Number.isSafeInteger(time) || time < 0) reject('invalid_clock', '验证会话时钟无效，请稍后重试。');
    return time;
  }
  #destroy(session, code) {
    if (!session) return;
    if (this.#sessions.get(session.owner) === session) this.#sessions.delete(session.owner);
    session.closed = code; session.device = undefined; session.data = undefined; session.cookieHash = undefined;
  }
  #clean(time) {
    for (const session of this.#sessions.values()) if (time >= session.expiresAt || time < session.startedAt) this.#destroy(session, 'expired');
    for (const [owner, until] of this.#cooldowns) if (time >= until) this.#cooldowns.delete(owner);
  }
  async start(owner, account, options = {}) {
    let session;
    try {
      privateOnly(options); const id = ownerId(owner), info = accountInfo(account), time = this.#time();
      this.#clean(time);
      const existing = this.#sessions.get(id);
      if (existing?.creating) return fail('busy', '本人验证挑战正在创建，请稍后。');
      const until = this.#cooldowns.get(id) || 0;
      if (time < until) return fail('cooldown', '请等待十五秒后再创建本人验证。', { retryAfterMs: until - time });
      if (existing) this.#destroy(existing, 'cancelled');
      if (this.#sessions.size >= MAX_SESSIONS || this.#cooldowns.size >= MAX_SESSIONS) return fail('busy', '人工验证会话已达上限，请稍后重试。');
      session = { owner: id, uid: info.uid, server: info.server, cookieHash: cookieHash(info.cookie), nonce: crypto.randomBytes(24).toString('base64url'),
        startedAt: time, expiresAt: time + TTL_MS, creating: true, closed: undefined };
      this.#sessions.set(id, session); this.#cooldowns.set(id, time + COOLDOWN_MS);
      const response = await this.#mys.createVerification(info);
      if (this.#sessions.get(id) !== session || session.closed) return fail(session.closed === 'expired' ? 'expired' : 'cancelled', '验证会话已取消或过期，请重新发起。');
      const readyTime = this.#time();
      if (readyTime >= session.expiresAt || readyTime < session.startedAt) { this.#destroy(session, 'expired'); return fail('expired', '验证挑战已过期，请重新发起。'); }
      if (response?.ok !== true) { this.#destroy(session, 'failed'); return upstreamError(response); }
      session.data = challengeData(response.data); session.device = deviceData(response.device); session.creating = false;
      const text = '请用浏览器打开此内存生成的 HTML，亲自完成官方极验，再复制完整生成命令回同一 QQ 的机器人私聊。QQ 浏览器若不支持，可下载 HTML 用系统浏览器打开。五分钟内有效，请保持当前账户；此页面没有 Cookie、UID 或设备标识。';
      return result(true, 'verification_created', text, { nonce: session.nonce, expiresAt: session.expiresAt,
        file: { name: 'Miyoushe-Verification.html', data: verificationHtml(session.data, session.nonce, this.#prefix, session.expiresAt - readyTime) } });
    } catch (error) { if (session) this.#destroy(session, 'failed'); return safeError(error); }
  }
  async finish(owner, arg, currentAccount, options = {}) {
    let session;
    try {
      privateOnly(options); const id = ownerId(owner), time = this.#time(); session = this.#sessions.get(id);
      if (!session) return fail('session_missing', '没有找到本人有效验证会话，请重新发起。');
      if (time >= session.expiresAt || time < session.startedAt) { this.#destroy(session, 'expired'); return fail('expired', '验证挑战已过期，请重新发起。'); }
      if (session.creating) return fail('busy', '本人验证挑战正在创建，请稍后。');
      if (typeof arg !== 'string' || arg.length > 2048 || /[\x00-\x1f\x7f]/.test(arg)) reject('invalid_proof', '验证命令格式不正确，请完整复制页面生成的命令。');
      let input = arg.trim(); const command = this.#prefix + '提交验证 ';
      if (input.startsWith(command)) input = input.slice(command.length);
      const parts = /^(\S+) +(\S+)$/.exec(input);
      if (!parts || !NONCE.test(parts[1])) reject('invalid_nonce', '验证会话标识无效，请复制本人页面生成的完整命令。');
      if (!same(Buffer.from(parts[1]), Buffer.from(session.nonce))) reject('invalid_nonce', '验证会话标识不匹配，请使用本人最新验证页面。');
      let info;
      try { info = accountInfo(currentAccount); }
      catch { this.#destroy(session, 'account_changed'); return fail('account_changed', '当前账户或登录已变化，请重新发起本人验证。'); }
      if (info.uid !== session.uid || info.server !== session.server || !same(cookieHash(info.cookie), session.cookieHash)) {
        this.#destroy(session, 'account_changed'); return fail('account_changed', '当前账户或登录已变化，请重新发起本人验证。');
      }
      const proof = parseProof(parts[2]);
      if (proof.geetest_challenge.slice(0, 32) !== session.data.challenge.slice(0, 32)) reject('challenge_mismatch', '验证挑战不匹配，请使用本人最新页面生成的命令。');
      const device = session.device;
      // Consume before awaiting the official submit: concurrent/repeated receipts
      // cannot submit twice. Network errors are never retried automatically.
      this.#destroy(session, 'used');
      const response = await this.#mys.submitVerification(info, proof, device);
      if (response?.ok !== true) return upstreamError(response, true);
      return result(true, 'verified', '官方已接受本人验证回执，请稍候重试查询；是否放行以实际查询响应为准。');
    } catch (error) { return safeError(error); }
  }
  stop(owner) {
    try {
      const id = ownerId(owner); this.#destroy(this.#sessions.get(id), 'cancelled');
      return result(true, 'cancelled', '本人的人工验证会话已清理。');
    } catch (error) { return safeError(error); }
  }
  cancel(owner) { return this.stop(owner); }
}

export const manualVerificationSource = Object.freeze({ sdk: 'https://static.geetest.com/static/tools/gt.js',
  clientDocs: 'https://docs.geetest.com/2.0/sections/idx-client-sdk.html', apiDocs: 'https://docs.geetest.com/captcha/apirefer/api/web',
  ttlMs: TTL_MS, cooldownMs: COOLDOWN_MS, maxSessions: MAX_SESSIONS, persistence: 'none', automation: 'none' });
