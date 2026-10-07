import { AccountsError, normalizeCookie, validateUid } from './accounts.mjs';

/** Read-only CN community protocol observed on 2026-10-07 in the official
 * production redemption centre. No App identity, SToken, DS or task executor.
 * https://webstatic.mihoyo.com/app/community-shop/index.html
 * https://webstatic.mihoyo.com/app/community-shop/bundle_55d0c960b52f8ee3e1c7.js
 * SHA256 fd685f1229bd40fd94389e7ec336eb20950d44c655f993b28d35e1dab83a6222
 * Modules: environment/API defaults, dealConfigsBeforeRequest, getPointInfo,
 * getMissionState and mission-list. Cookie acceptance requires separate tests
 * by the credential owner; seeing these routes is not proof of authorization.
 */
const ROUTES = Object.freeze({
  balance: 'https://bbs-api.mihoyo.com/common/homutreasure/v1/web/user/point?app_id=1&point_sn=myb',
  missions: 'https://bbs-api.mihoyo.com/apihub/wapi/getUserMissionsState?point_sn=myb'
});
const MAX_BYTES = 64 * 1024;
const fail = (code, message, retcode) => ({ ok: false, code, message, ...(Number.isSafeInteger(retcode) ? { retcode } : {}) });
const invalidResponse = () => fail('invalid_response', '官方米游币接口响应格式异常，未显示不完整数据。');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function nonnegativeInteger(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d{1,16}$/.test(value))) throw new Error('invalid integer');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('invalid integer');
  return number;
}

function project(operation, value) {
  if (!isObject(value)) throw new Error('invalid data');
  if (operation === 'balance') return { points: nonnegativeInteger(value.points) };
  if (!Array.isArray(value.states) || value.states.length > 256) throw new Error('invalid states');
  const states = value.states.map(item => {
    if (!isObject(item)) throw new Error('invalid state');
    const state = { mission_id: nonnegativeInteger(item.mission_id) };
    // Both fields are consumed by the official mission-list renderer. Do not
    // invent a default or include unobserved account/credential metadata.
    if (Object.hasOwn(item, 'process')) state.process = nonnegativeInteger(item.process);
    if (Object.hasOwn(item, 'is_get_award')) {
      if (typeof item.is_get_award !== 'boolean') throw new Error('invalid award state');
      state.is_get_award = item.is_get_award;
    }
    return state;
  });
  return {
    total_points: nonnegativeInteger(value.total_points),
    already_received_points: nonnegativeInteger(value.already_received_points),
    today_total_points: nonnegativeInteger(value.today_total_points),
    states
  };
}

function upstreamFailure(payload) {
  const retcode = payload.retcode;
  if ([1028, 1034, 5003, 10035, 10041].includes(retcode) || payload.data?.challenge || payload.data?.gt) {
    return fail('verification_required', '官方社区要求本人安全验证；米游币接口的验证状态需单独确认。', retcode);
  }
  if ([-100, -101, -2007, 10001].includes(retcode)) {
    return fail('community_auth_required', '官方社区尚未接受当前网页登录凭据；这不代表原神查询授权已经失效。', retcode);
  }
  return fail('upstream_error', '官方米游币接口暂时未返回可用结果，请稍后重试。', retcode);
}

async function readJson(response) {
  const declaredSize = response.headers?.get?.('content-length');
  if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_BYTES)) throw new Error('oversized response');
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) throw new Error('invalid response chunk');
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) throw new Error('oversized response');
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally {
      // Cancellation bounds oversized/invalid streams; no response is cached.
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('oversized response');
  return JSON.parse(text);
}

/** Receives an already selected/decrypted owner account from the caller.
 * It does not enumerate accounts, write files, log Cookie, or retain sessions.
 * Only two fixed GET destinations exist; no arbitrary route or task method.
 */
export class MiyousheCoinClient {
  constructor({ fetch = globalThis.fetch, timeoutMs = 12000 } = {}) {
    if (typeof fetch !== 'function') throw new AccountsError('missing_fetch', '需要 Node.js 22+ 的 fetch 支持。');
    this.fetch = fetch;
    this.timeoutMs = Math.max(10, Math.min(60000, Number(timeoutMs) || 12000));
  }

  balance(account) { return this.#request('balance', account); }
  missions(account) { return this.#request('missions', account); }

  async #request(operation, account) {
    let cookie;
    try {
      if (!isObject(account)) throw new AccountsError('not_bound', '请先选择本人已授权的原神账户。');
      const identity = validateUid(account.uid, account.server || account.region);
      if (account.server && account.region) validateUid(account.uid, account.region);
      if (identity.region !== 'cn') throw new AccountsError('unsupported_region', '米游币查询目前仅支持国服米游社账户。');
      if (!account.cookie) throw new AccountsError('auth_required', '该功能需要本人已授权的米游社网页 Cookie。');
      cookie = normalizeCookie(account.cookie);
    } catch (error) {
      return error instanceof AccountsError ? fail(error.code, error.message) : fail('invalid_account', '账户格式无效。');
    }
    const endpoint = ROUTES[operation];
    const controller = new AbortController();
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(fail('timeout', '官方米游币接口响应超时，请稍后重试。'));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([(async () => {
        let response;
        try {
          response = await this.fetch(endpoint, {
            method: 'GET', redirect: 'error', signal: controller.signal,
            headers: { Cookie: cookie, Accept: 'application/json', 'User-Agent': `Genshin-Plugin (Node.js/${process.versions.node})` }
          });
        } catch {
          return fail(controller.signal.aborted ? 'timeout' : 'network_error', controller.signal.aborted ? '官方米游币接口响应超时，请稍后重试。' : '官方米游币接口连接失败，请稍后重试。');
        }
        if (response?.redirected) return fail('redirect_rejected', '官方米游币接口返回了不受信任的跳转。');
        if (response?.url) {
          try { if (new URL(response.url).href !== endpoint) return fail('redirect_rejected', '官方米游币接口返回了不受信任的跳转。'); }
          catch { return fail('redirect_rejected', '官方米游币接口返回了不受信任的跳转。'); }
        }
        if (!response?.ok) return fail(response?.status === 429 ? 'rate_limited' : 'http_error', response?.status === 429 ? '官方米游币接口限流，请稍后重试。' : '官方米游币接口连接失败，请稍后重试。');
        let payload;
        try { payload = await readJson(response); } catch { return invalidResponse(); }
        if (!isObject(payload) || !Number.isSafeInteger(payload.retcode)) return invalidResponse();
        if (payload.retcode !== 0 || payload.data?.challenge || payload.data?.gt) return upstreamFailure(payload);
        try { return { ok: true, data: project(operation, payload.data) }; } catch { return invalidResponse(); }
      })(), timeout]);
    } finally { clearTimeout(timer); }
  }
}
