/** Original Genshin-only client for the public MoAn protocol, without local storage. */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { validateUid } from './accounts.mjs';

const GAME = 'gs', GAME_BIZ = 'hk4e_cn';
const MAX_BYTES = 8 * 1024 * 1024, MAX_RECORDS = 100000;
const ENDPOINTS = new Set(['analysis', 'query', 'gacha/export-json', 'gacha/import-json', 'gacha/verify-link', 'gacha/import-link']);
const LINK_ROUTES = new Map([
  ['public-operation-hk4e.mihoyo.com', new Set(['/gacha_info/api/getGachaLog'])],
  ['webstatic.mihoyo.com', new Set(['/hk4e/event/e20190909gacha/index.html', '/hk4e/event/e20190909gacha-v3/index.html'])]
]);
const LINK_PARAMS = new Set(['authkey', 'authkey_ver', 'sign_type', 'auth_appid', 'init_type', 'gacha_id', 'timestamp', 'region',
  'default_gacha_type', 'lang', 'device_type', 'game_biz', 'plat_type', 'page', 'size', 'end_id', 'gacha_type', 'biz_key', 'game', 'uid']);
const POOLS = new Set(['100', '200', '301', '302', '400', '500']);
const SENSITIVE_FIELD = /(?:api[_-]?key|authkey|token|password|passwd|cookie|authorization|secret|x-api-key|(?:^|_)(?:key|accesskey|link)(?:$|_)|^(?:phone|mobile|email|realname|real_name|idcard|ip|ip_address|qq|user_id|account_id|owner_qq)$)/i;
const FORBIDDEN_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class CloudError extends Error {
  constructor(code, message, { status, upstreamCode } = {}) {
    super(message); this.name = 'CloudError'; this.code = code;
    if (Number.isInteger(status)) this.status = status;
    if (Number.isSafeInteger(upstreamCode)) this.upstreamCode = upstreamCode;
  }
}
function cnUid(value) {
  try { return validateUid(value, 'cn').uid; }
  catch { throw new CloudError('INVALID_UID', '墨安客户端仅接受受支持的原神国服 UID。'); }
}

/** Deny private, loopback, link-local, multicast and reserved literal addresses. */
export function isPublicCloudAddress(value) {
  let address = String(value).replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) address = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  // Only global-unicast IPv6; mapped IPv4 and documentation ranges are excluded.
  return family === 6 && /^[23][0-9a-f]{0,3}:/.test(address) && !/^2001:db8(?::|$)/.test(address);
}

export function validateCloudBaseUrl(value) {
  let parsed, decodedPath;
  try { parsed = new URL(value); decodedPath = decodeURIComponent(parsed.pathname); }
  catch { throw new CloudError('CLOUD_NOT_CONFIGURED', '请先配置经过核验的 HTTPS 墨安服务地址。'); }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const literal = isIP(host);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
    !host || (literal ? !isPublicCloudAddress(host) : !/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(host)) ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host) ||
    /%(?:2f|5c|00)|[\\\u0000-\u001f]/i.test(parsed.pathname) || /[\\\u0000-\u001f]/.test(decodedPath)) {
    throw new CloudError('UNSAFE_SERVICE', '云服务必须使用 HTTPS 公网地址，不接受本机、私网、凭据或重定向参数。');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/';
  return parsed.href;
}

/** Returns the official URL internally; callers should never log this object. */
function officialLink(value) {
  if (typeof value !== 'string' || value.length > 16384 || !value || /[\s\u0000-\u001f\u007f]/.test(value))
    throw new CloudError('INVALID_LINK', '请提供单条完整的官方原神国服祈愿链接。');
  let parsed; try { parsed = new URL(value); } catch { throw new CloudError('INVALID_LINK', '祈愿链接格式无效。'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
    !LINK_ROUTES.get(parsed.hostname)?.has(parsed.pathname) || (parsed.hash && !['#/', '#/log'].includes(parsed.hash)))
    throw new CloudError('UNTRUSTED_LINK', '只接受已核验的米哈游原神国服祈愿页面或历史记录 API 链接。');
  const seen = new Set();
  for (const [name, val] of parsed.searchParams) {
    if (!LINK_PARAMS.has(name) || seen.has(name) || /[\u0000-\u001f\u007f]/.test(val))
      throw new CloudError('INVALID_LINK', '祈愿链接参数重复、含有未知参数或格式无效。');
    seen.add(name);
  }
  const authkey = parsed.searchParams.get('authkey');
  if (!authkey || authkey.length > 12000) throw new CloudError('INVALID_LINK', '官方祈愿链接缺少有效 authkey。');
  if ((seen.has('game_biz') && parsed.searchParams.get('game_biz') !== GAME_BIZ) ||
    (seen.has('game') && !['hk4e', GAME].includes(parsed.searchParams.get('game'))) ||
    (seen.has('region') && !['cn_gf01', 'cn_qd01'].includes(parsed.searchParams.get('region'))))
    throw new CloudError('GAME_MISMATCH', '云链接仅支持原神国服 hk4e_cn，不接受其他游戏或国际服。');
  const uid = seen.has('uid') ? cnUid(parsed.searchParams.get('uid')) : undefined;
  parsed.hash = '';
  return { link: parsed.href, authkey, uid };
}

function checkDataScope(value, expectedUid, depth = 0) {
  if (depth > 24) throw new CloudError('INVALID_RESPONSE', '云服务数据层级过深。');
  if (Array.isArray(value)) { for (const item of value) checkDataScope(item, expectedUid, depth + 1); return; }
  if (!isObject(value)) return;
  for (const [name, item] of Object.entries(value)) {
    if (name === 'uid' && cnUid(item) !== expectedUid) throw new CloudError('UID_MISMATCH', '云服务返回了不属于当前 UID 的记录，已拒绝接收。');
    if (name === 'game_biz' && item !== GAME_BIZ) throw new CloudError('GAME_MISMATCH', '云服务返回了其他游戏或国际服资料，已拒绝接收。');
    if (name === 'game' && ![GAME, 'hk4e'].includes(item)) throw new CloudError('GAME_MISMATCH', '云服务返回了其他游戏资料，已拒绝接收。');
    if (['hkrpg', 'nap'].includes(name)) {
      if (item != null && (!Array.isArray(item) || item.length)) throw new CloudError('GAME_MISMATCH', '云服务返回了其他游戏的记录，已拒绝接收。');
      continue;
    }
    if (['total_starrail', 'total_zzz'].includes(name) && Number(item) !== 0)
      throw new CloudError('GAME_MISMATCH', '云服务返回了其他游戏的导入结果，已拒绝接收。');
    checkDataScope(item, expectedUid, depth + 1);
  }
}

function safeData(value, secrets, depth = 0) {
  if (depth > 24) throw new CloudError('INVALID_RESPONSE', '云服务数据层级过深。');
  if (Array.isArray(value)) return value.map(item => safeData(item, secrets, depth + 1));
  if (isObject(value)) return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !FORBIDDEN_FIELDS.has(name) && !SENSITIVE_FIELD.test(name) && !['hkrpg', 'nap', 'total_starrail', 'total_zzz'].includes(name))
    .map(([name, item]) => [name, safeData(item, secrets, depth + 1)]));
  if (typeof value === 'string') {
    if (secrets.some(secret => secret && value.includes(secret)) || /(?:authkey|api[_-]?key|authorization|cookie)\s*(?:=|:|%3d)/i.test(value)) return '[敏感内容已隐藏]';
    // Keep public image/source paths, discard query strings and embedded complete URLs.
    if (/^https?:\/\//i.test(value)) {
      try { const url = new URL(value); validateCloudBaseUrl(url.origin + url.pathname); return url.origin + url.pathname; }
      catch { return '[链接已隐藏]'; }
    }
    return value.replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  }
  return value;
}
function normalizeUpload(records, uid) {
  if (!Array.isArray(records) || !records.length || records.length > MAX_RECORDS) throw new CloudError('INVALID_RECORDS', '上传需要 1 至 100000 条原神祈愿记录。');
  checkDataScope(records, uid);
  const ids = new Set();
  const list = records.map(row => {
    if (!isObject(row) || typeof row.id !== 'string' || !/^\d{1,19}$/.test(row.id) || ids.has(row.id) || !POOLS.has(row.gacha_type) ||
      typeof row.time !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.time))
      throw new CloudError('INVALID_RECORDS', '祈愿记录的 ID、原神卡池、时间或重复情况无效。');
    const time = new Date(row.time.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(time.getTime()) || time.toISOString().slice(0, 19).replace('T', ' ') !== row.time)
      throw new CloudError('INVALID_RECORDS', '祈愿记录时间无效。');
    ids.add(row.id);
    const out = { id: row.id, uid, gacha_type: row.gacha_type, time: row.time };
    const canonicalPool = row.gacha_type === '400' ? '301' : row.gacha_type;
    if (row.uigf_gacha_type !== undefined && row.uigf_gacha_type !== canonicalPool)
      throw new CloudError('INVALID_RECORDS', '原神 UIGF 卡池映射无效。');
    out.uigf_gacha_type = canonicalPool;
    for (const name of ['item_id', 'name', 'item_type', 'rank_type', 'count', 'lang']) {
      if (row[name] === undefined) continue;
      if (typeof row[name] !== 'string' || row[name].length > 200 || /[\u0000-\u001f\u007f]/.test(row[name]) ||
        (name === 'rank_type' && !['3', '4', '5'].includes(row[name])) || (name === 'item_id' && !/^\d{0,30}$/.test(row[name])) ||
        (name === 'count' && !/^[1-9]\d{0,5}$/.test(row[name])))
        throw new CloudError('INVALID_RECORDS', '祈愿记录字段类型、物品或星级无效。');
      out[name] = row[name];
    }
    return out;
  });
  if (Buffer.byteLength(JSON.stringify(list)) > 5 * 1024 * 1024) throw new CloudError('INVALID_RECORDS', '上传记录超过 5 MiB。');
  return list;
}

async function boundedText(response) {
  if (Number(response.headers?.get?.('content-length') || 0) > MAX_BYTES) throw new CloudError('RESPONSE_TOO_LARGE', '云服务响应超过 8 MiB。');
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new CloudError('RESPONSE_TOO_LARGE', '云服务响应超过 8 MiB。'); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new CloudError('RESPONSE_TOO_LARGE', '云服务响应超过 8 MiB。');
  return text;
}

// Default production transport pins the previously checked public address while
// retaining the original hostname for HTTPS certificate checks (no DNS rebinding).
async function pinnedHttps(url, init, address) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: init.method, headers: init.headers, signal: init.signal, agent: false, rejectUnauthorized: true,
      lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family) }, res => {
      const status = Number(res.statusCode);
      if (status >= 300 && status < 400) { res.destroy(); reject(new CloudError('UNSAFE_REDIRECT', '云服务发生未经允许的重定向，已拒绝请求。')); return; }
      const headers = new Headers();
      for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(res);
      resolve(new Response(body, { status, headers }));
    });
    req.once('error', reject);
    req.end(init.body);
  });
}
async function resolvedAddresses(resolveHost, host, signal) {
  let abort;
  const expired = new Promise((_, reject) => {
    abort = () => reject(new CloudError('TIMEOUT', '云服务请求超时，请稍后重试。'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([resolveHost(host, { all: true, verbatim: true }), expired]); }
  finally { signal.removeEventListener('abort', abort); }
}

export class CloudClient {
  #base; #key; #fetch; #lookup; #timeoutMs; #nativeTransport;
  constructor({ baseUrl, key = '', fetch = globalThis.fetch, timeoutMs = 20000, resolveHost = dnsLookup } = {}) {
    this.#base = validateCloudBaseUrl(baseUrl);
    if (typeof fetch !== 'function' || typeof resolveHost !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000)
      throw new CloudError('INVALID_CONFIGURATION', '云请求实现或超时配置无效，超时范围为 1000 至 120000 毫秒。');
    if (typeof key !== 'string' || key.length > 4096 || /[^\x21-\x7e]/.test(key))
      throw new CloudError('INVALID_KEY', '云服务 Key 格式无效。');
    if (key && (this.#base.includes(key) || decodeURIComponent(this.#base).includes(key))) throw new CloudError('UNSAFE_SERVICE', '云服务地址不能包含 Key。');
    this.#key = key; this.#fetch = fetch; this.#lookup = resolveHost; this.#timeoutMs = timeoutMs; this.#nativeTransport = fetch === globalThis.fetch;
  }
  async #request(endpoint, { uid, body, requiresKey = false, secrets = [] } = {}) {
    if (!ENDPOINTS.has(endpoint)) throw new CloudError('UNSUPPORTED_ENDPOINT', '未接入此云接口。');
    if (requiresKey && !this.#key) throw new CloudError('KEY_REQUIRED', '此操作需要本人云服务 Key，请先在私聊授权配置。');
    const url = new URL(endpoint, this.#base);
    if (uid) { url.searchParams.set('uid', uid); url.searchParams.set('game', GAME); }
    const headers = { Accept: 'application/json', 'User-Agent': 'Teyvat-Plugin/0.1.0' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (requiresKey) headers['X-API-Key'] = this.#key;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      let addresses = [{ address: host, family: isIP(host) }];
      if (!isIP(host)) {
        addresses = await resolvedAddresses(this.#lookup, host, controller.signal);
        if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isPublicCloudAddress(item.address)))
          throw new CloudError('UNSAFE_SERVICE', '云服务域名解析到本机、私网或保留地址，已拒绝请求。');
      }
      if (controller.signal.aborted) throw new CloudError('TIMEOUT', '云服务请求超时，请稍后重试。');
      const request = { method: body === undefined ? 'GET' : 'POST', headers, redirect: 'error', signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      const response = await (this.#nativeTransport ? pinnedHttps(url.href, request, addresses[0]) : this.#fetch(url.href, request));
      if (response.redirected || (response.url && new URL(response.url).origin !== url.origin)) throw new CloudError('UNSAFE_REDIRECT', '云服务发生未经允许的重定向，已拒绝请求。');
      if (!response.ok) throw new CloudError('HTTP_ERROR', `云服务请求失败（HTTP ${Number(response.status) || 0}）。`, { status: response.status });
      let payload;
      try { payload = JSON.parse(await boundedText(response)); }
      catch (error) { if (error instanceof CloudError) throw error; throw new CloudError('INVALID_RESPONSE', '云服务未返回有效 JSON。'); }
      if (!isObject(payload) || !Number.isSafeInteger(payload.code)) throw new CloudError('INVALID_RESPONSE', '云服务响应结构发生变化。');
      if (payload.code !== 0) throw new CloudError('UPSTREAM_ERROR', `云服务未完成操作（代码 ${payload.code}）。`, { upstreamCode: payload.code });
      if (payload.data === undefined || payload.data === null) throw new CloudError('INVALID_RESPONSE', '云服务未返回操作数据。');
      return { data: payload.data, sourceUrl: url.origin + url.pathname, secrets: [this.#key, ...secrets].flatMap(value => value ? [value, encodeURIComponent(value)] : []) };
    } catch (error) {
      if (error instanceof CloudError) throw error;
      if (controller.signal.aborted) throw new CloudError('TIMEOUT', '云服务请求超时，请稍后重试。');
      throw new CloudError('NETWORK_ERROR', '暂时无法连接 HTTPS 云服务，请确认服务可用后重试。');
    } finally { clearTimeout(timer); }
  }
  #result(result, uid, extra = {}) {
    checkDataScope(result.data, uid);
    return { uid, game: GAME, game_biz: GAME_BIZ, data: safeData(result.data, result.secrets), sourceUrl: result.sourceUrl, ...extra };
  }
  async analysis(uid) { uid = cnUid(uid); return this.#result(await this.#request('analysis', { uid }), uid); }
  async query(uid) { uid = cnUid(uid); return this.#result(await this.#request('query', { uid }), uid); }
  async export(uid, { format = 'v42' } = {}) {
    uid = cnUid(uid);
    if (!['v42', 'v22'].includes(format)) throw new CloudError('INVALID_FORMAT', '云导出格式仅支持 v42 或 v22。');
    return this.#result(await this.#request('gacha/export-json', { requiresKey: true, body: { uid, game_biz: GAME_BIZ, format } }), uid, { format });
  }
  async upload(uid, records) {
    uid = cnUid(uid); const list = normalizeUpload(records, uid);
    const result = await this.#request('gacha/import-json', { requiresKey: true, body: { uid, game_biz: GAME_BIZ, records: list } });
    const safe = this.#result(result, uid);
    const imported = Number(result.data?.total_genshin ?? result.data?.imported ?? 0);
    if (!Number.isSafeInteger(imported) || imported < 0) throw new CloudError('INVALID_RESPONSE', '云服务导入数量无效。');
    return { ...safe, imported };
  }
  async #verify(parsed, expectedUid) {
    const result = await this.#request('gacha/verify-link', { requiresKey: true, body: { link: parsed.link }, secrets: [parsed.authkey, parsed.link] });
    if (!isObject(result.data) || result.data.game_biz !== GAME_BIZ || result.data.uid === undefined)
      throw new CloudError('LINK_UNVERIFIED', '云服务未证明此链接属于原神国服及具体 UID，已拒绝后续操作。');
    const uid = cnUid(result.data.uid);
    if ((parsed.uid && uid !== parsed.uid) || (expectedUid && uid !== cnUid(expectedUid)))
      throw new CloudError('UID_MISMATCH', '官方链接与当前选择的原神 UID 不一致，已拒绝后续操作。');
    return { uid, game: GAME, game_biz: GAME_BIZ, verified: true, data: { uid, game_biz: GAME_BIZ }, sourceUrl: result.sourceUrl };
  }
  async verifyLink(link, expectedUid) { expectedUid = cnUid(expectedUid); return this.#verify(officialLink(link), expectedUid); }
  async importLink(link, expectedUid) {
    expectedUid = cnUid(expectedUid);
    const parsed = officialLink(link), verified = await this.#verify(parsed, expectedUid);
    const result = await this.#request('gacha/import-link', { requiresKey: true, body: { link: parsed.link }, secrets: [parsed.authkey, parsed.link] });
    // This is checked after upstream import too; never report a different game/UID as success.
    if (!isObject(result.data) || String(result.data.uid) !== verified.uid || result.data.game_biz !== GAME_BIZ)
      throw new CloudError('IMPORT_MISMATCH', '云服务导入结果与已验证的原神 UID/游戏不一致，不能确认成功。');
    const safe = this.#result(result, verified.uid), imported = Number(result.data.total_genshin ?? 0);
    if (!Number.isSafeInteger(imported) || imported < 0) throw new CloudError('INVALID_RESPONSE', '云服务导入数量无效。');
    return { ...safe, imported, verified: true };
  }
}
