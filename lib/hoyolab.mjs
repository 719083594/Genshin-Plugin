import crypto from 'node:crypto';
import { validateUid, normalizeCookie, AccountsError } from './accounts.mjs';

/** Protocol sources, checked 2026-10-07:
 * xhh-TL commit 1b5e5644c9351fcfd950acabf2c791060a7c44b6 utils/mysClient.js,
 * plus https://github.com/seriaati/genshin.py (routes.py, utility/ds.py,
 * constants.py, chronicle/genshin.py, diary.py, calculator/client.py and calculator.py),
 * Yunzai-genshin commit 4a2e1fb8f094b2a8f039ce0768773701718b60b9,
 * model/mys/apiTool.js and model/blueprint.js for deck/card statistics.
 * These are community-observed interfaces, not a published official API contract.
 * CN and OS credentials never cross domains; unknown operations stay unsupported.
 */
const ROUTES = Object.freeze({
  cn: { record: 'https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/', roles: 'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie', calculator: 'https://api-takumi.mihoyo.com/event/e20200928calculate/', ledger: 'https://hk4e-api.mihoyo.com/event/ys_ledger/monthInfo', sign: 'https://api-takumi.mihoyo.com/event/luna/hk4e/', actId: 'e202311201442471', gameBiz: 'hk4e_cn' },
  os: { record: 'https://sg-public-api.hoyolab.com/event/game_record/genshin/api/', roles: 'https://api-os-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie', calculator: 'https://sg-public-api.hoyolab.com/event/e20200928calculate/', ledger: 'https://sg-hk4e-api.hoyolab.com/event/ysledgeros/month_info', sign: 'https://sg-hk4e-api.hoyolab.com/event/sol/', actId: 'e202102251931481', gameBiz: 'hk4e_global' }
});
const CN_SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs';
const OS_SALT = '6s25p5ox5y14umn1p61aqyyvbvvl3lrt';
const CN_SIGN_SALT = 'LyD1rXqMv2GJhnwdvCBjFOKGiKuLY3aO';
const RECORD_PATHS = ['index', 'dailyNote', 'spiralAbyss', 'role_combat', 'hard_challenge', 'hard_challenge/popularity', 'character/list', 'character/detail', 'act_calendar', 'activities', 'gcg/basicInfo', 'gcg/matchList', 'gcg/deckList', 'gcg/cardList', 'char_master'];
const CALCULATOR_PATHS = ['v1/sync/avatar/detail', 'v1/avatarSkill/list', 'v2/compute', 'v1/furniture/blueprint', 'v1/furniture/compute'];
const ALLOWED_ENDPOINTS = new Set(Object.values(ROUTES).flatMap(route => [route.roles, route.ledger, ...RECORD_PATHS.map(endpoint => route.record + endpoint), ...CALCULATOR_PATHS.map(endpoint => route.calculator + endpoint), ...['info', 'home', 'sign'].map(endpoint => route.sign + endpoint)]));
const ALIASES = Object.freeze({ profile: 'index', notes: 'dailyNote', resin: 'dailyNote', abyss: 'spiralAbyss', theater: 'role_combat', hardChallenge: 'hard_challenge', hardChallengePopularity: 'hard_challenge/popularity', hard_challenge_popularity: 'hard_challenge/popularity', characters: 'character', characterDetail: 'characterDetail', calendar: 'act_calendar', cultivation: 'detail', ys_ledger: 'ledger', tcg: 'gcg/basicInfo', basicInfo: 'gcg/basicInfo', tcgStats: 'gcg/basicInfo', tcgMatches: 'gcg/matchList', deckList: 'gcg/deckList', tcgDecks: 'gcg/deckList', tcgCards: 'gcg/cardList' });
const fail = (code, message, retcode) => ({ ok: false, code, message, ...(Number.isFinite(retcode) ? { retcode } : {}) });
const md5 = value => crypto.createHash('md5').update(value).digest('hex');

/** Sign exactly the transmitted query string and body, not an independent serialization. */
export function dynamicSecret({ region = 'cn', query = '', body = '', time = Math.floor(Date.now() / 1000), random, sign = false } = {}) {
  if (!['cn', 'os'].includes(region)) throw new AccountsError('region_mismatch', '不支持的米游社区域。');
  const simple = region === 'os' || sign;
  const nonce = random ?? (simple ? crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z]/g, '').padEnd(6, 'a').slice(0, 6) : String(crypto.randomInt(100001, 200001)));
  const salt = sign && region === 'cn' ? CN_SIGN_SALT : region === 'cn' ? CN_SALT : OS_SALT;
  const content = `salt=${salt}&t=${time}&r=${nonce}` + (simple ? '' : `&b=${body}&q=${query}`);
  return `${time},${nonce},${md5(content)}`;
}

function queryString(values) {
  return new URLSearchParams(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, String(value)])).toString();
}

function integer(value, min, max, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new AccountsError('invalid_parameters', `${name}超出有效范围。`);
  return result;
}

function decimalInteger(value, min, max, name) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) {
    throw new AccountsError('invalid_parameters', `${name}必须为整数。`);
  }
  return integer(value, min, max, name);
}

function flag(value, fallback, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new AccountsError('invalid_parameters', `${name}必须为布尔值。`);
  return value;
}

function safeParameters(params, allowed) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !allowed.includes(key))) {
    throw new AccountsError('invalid_parameters', '包含不支持的接口参数。');
  }
}

function accountInfo(account) {
  if (!account || typeof account !== 'object') throw new AccountsError('not_bound', '请先绑定原神 UID。');
  const valid = validateUid(account.uid, account.server || account.region);
  if (account.server && account.region) validateUid(account.uid, account.region);
  if (!account.cookie) throw new AccountsError('auth_required', '该功能需要本人米游社/HoYoLAB Cookie，请在私聊中绑定。');
  return { ...valid, cookie: normalizeCookie(account.cookie) };
}

function sanitize(value, cookie, depth = 0) {
  if (depth > 35) return null;
  if (typeof value === 'string') {
    let text = value.replaceAll(cookie, '[凭据已隐藏]');
    for (const field of cookie.split(';')) {
      const at = field.indexOf('=');
      if (at > 0 && /token/i.test(field.slice(0, at))) {
        const token = field.slice(at + 1).trim();
        if (token.length >= 4) text = text.replaceAll(token, '[凭据已隐藏]');
      }
    }
    return text;
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, cookie, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/(cookie|password|passwd|authkey|stoken|ltoken|secret|authorization|account_mid|ltmid)/i.test(key)).map(([key, item]) => [key, sanitize(item, cookie, depth + 1)]));
  return value;
}

function upstreamFailure(retcode, data, signing = false) {
  const risk = data?.gt_result || data;
  if ([1034, 5003, 10035, 10041].includes(retcode) || risk?.challenge || risk?.gt || risk?.risk_code === 375) return fail('verification_required', '米游社/HoYoLAB 要求安全验证，请在官方 App 完成验证后重试。', retcode);
  if ([-100, -101, 10001].includes(retcode)) return fail('expired_cookie', '登录凭据已失效，请在私聊重新绑定官方 App 的 Cookie。', retcode);
  if (retcode === -10001) return fail('request_rejected', '官方接口拒绝请求，可能为签名协议变更或登录失效；请更新凭据后重试。', retcode);
  if (retcode === 10102) return fail('private_data', '官方数据未公开或实时便笺未启用，请在官方 App 开启对应权限。', retcode);
  if (retcode === 10103) return fail('community_not_bound', 'Cookie 对应账号尚未绑定米游社/HoYoLAB 社区，请先登录官方社区。', retcode);
  if ([-10002, 1008, 1009].includes(retcode)) return fail('no_role', '该登录凭据下没有所请求的原神角色。', retcode);
  if (retcode === 10104) return fail('not_owned', '实时便笺仅允许查询 Cookie 所属账号的角色，请核对绑定。', retcode);
  if ([10101, -110, 1028, -500004].includes(retcode)) return fail('rate_limited', '已达到官方查询限制，请稍后重试。', retcode);
  if (retcode === -502002) return fail('sync_disabled', '请在官方养成计算器中手动开启游戏数据同步。', retcode);
  if (retcode === -502001) return fail('character_not_owned', '该账号没有所请求的角色。', retcode);
  if (retcode === -500001) return fail('invalid_parameters', '官方养成接口拒绝了当前参数，请核对等级与物品 ID。', retcode);
  if (retcode === -5003 && signing) return { ok: true, status: 'already', code: 'already', message: '今日已经签到。', data: {} };
  return fail('upstream_error', '官方接口暂时未返回可用结果，请稍后重试。', retcode);
}

export class HoyolabClient {
  constructor({ fetch = globalThis.fetch, timeoutMs = 12000, deviceId, deviceFp, now = Date.now } = {}) {
    if (typeof fetch !== 'function') throw new AccountsError('missing_fetch', '需要 Node.js 20+ 的 fetch 支持。');
    this.fetch = fetch;
    this.timeoutMs = Math.max(10, Math.min(60000, Number(timeoutMs) || 12000));
    this.deviceId = deviceId;
    this.deviceFp = deviceFp;
    this.now = now;
  }

  #headers(account, query, body, signing = false, calculator = false) {
    const cn = account.region === 'cn';
    const device = typeof this.deviceId === 'string' && /^[a-zA-Z\d_-]{6,128}$/.test(this.deviceId) ? this.deviceId : crypto.createHash('sha256').update(`Teyvat-Plugin:${account.uid || 'roles'}`).digest('hex').slice(0, 32);
    const headers = {
      Cookie: account.cookie,
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      Referer: cn ? (calculator ? 'https://webstatic.mihoyo.com/ys/event/e20200923adopt_calculator/index.html' : 'https://webstatic.mihoyo.com/') : 'https://act.hoyolab.com/',
      'x-rpc-app_version': cn ? (signing ? '2.70.1' : '2.40.1') : '1.5.0',
      'x-rpc-client_type': '5',
      'x-rpc-device_id': device,
      DS: dynamicSecret({ region: account.region, query, body, time: Math.floor(this.now() / 1000), sign: signing })
    };
    if (!cn) { headers['x-rpc-language'] = 'zh-cn'; headers['x-rpc-lang'] = 'zh-cn'; }
    if (this.deviceFp && /^[a-zA-Z\d_-]{6,128}$/.test(this.deviceFp)) headers['x-rpc-device_fp'] = this.deviceFp;
    if (signing) {
      headers['x-rpc-signgame'] = 'hk4e'; headers.Origin = cn ? 'https://act.mihoyo.com' : 'https://act.hoyolab.com';
      if (cn) { headers['x-rpc-sys_version'] = '12'; headers['x-rpc-platform'] = 'android'; headers['x-rpc-channel'] = 'miyousheluodi'; }
    }
    return headers;
  }

  async #request(endpoint, account, { query = {}, body, signing = false } = {}) {
    if (!ALLOWED_ENDPOINTS.has(endpoint)) return fail('unsupported', '未启用该官方接口。');
    const queryText = queryString(query);
    const bodyText = body === undefined ? '' : JSON.stringify(body);
    const url = endpoint + (queryText ? `?${queryText}` : '');
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.timeoutMs); });
    try {
      const payload = await Promise.race([(async () => {
        const response = await this.fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: this.#headers(account, queryText, bodyText, signing, endpoint.startsWith(ROUTES[account.region].calculator)), ...(body === undefined ? {} : { body: bodyText }), signal: controller.signal });
        if (!response?.ok || response.redirected) return fail(response?.status === 429 ? 'rate_limited' : 'http_error', response?.status === 429 ? '官方接口限流，请稍后重试。' : '官方接口连接失败，请稍后重试。');
        if (response.url && new URL(response.url).origin !== new URL(endpoint).origin) return fail('redirect_rejected', '官方接口返回了不受信任的跳转。');
        let result;
        if (typeof response.text === 'function') {
          const content = await response.text();
          if (Buffer.byteLength(content) > 4 * 1024 * 1024) return fail('invalid_response', '官方接口响应过大。');
          result = JSON.parse(content);
        } else result = await response.json();
        if (!result || typeof result !== 'object' || !Number.isInteger(result.retcode)) return fail('invalid_response', '官方接口响应格式异常。');
        if (result.retcode !== 0) return upstreamFailure(result.retcode, result.data, signing);
        const risk = result.data?.gt_result || result.data;
        if (risk?.challenge || risk?.gt || risk?.risk_code === 375) return upstreamFailure(1034, result.data, signing);
        return { ok: true, code: 'ok', retcode: 0, data: sanitize(result.data ?? {}, account.cookie), source: new URL(endpoint).host };
      })(), timeout]);
      return payload;
    } catch { return fail(controller.signal.aborted ? 'timeout' : 'network_error', controller.signal.aborted ? '官方接口响应超时，请稍后重试。' : '官方接口网络或响应异常，请稍后重试。'); }
    finally { clearTimeout(timer); }
  }

  async roles(cookie, region = 'cn') {
    try {
      if (!['cn', 'os'].includes(region)) throw new AccountsError('region_mismatch', '请选择国服 cn 或国际服 os。');
      const account = { region, cookie: normalizeCookie(cookie) };
      const response = await this.#request(ROUTES[region].roles, account, { query: { game_biz: ROUTES[region].gameBiz } });
      if (!response.ok) return response;
      if (!Array.isArray(response.data.list)) return fail('invalid_response', '官方角色列表响应格式异常。');
      const data = response.data.list.filter(role => !role.game_biz || role.game_biz === ROUTES[region].gameBiz).map(role => ({ ...validateUid(role.game_uid, role.region), nickname: String(role.nickname || ''), level: Number(role.level) || 0 }));
      if (data.some(role => role.region !== region)) return fail('invalid_response', '官方角色列表的区域不一致。');
      return { ...response, data };
    } catch (error) { return error instanceof AccountsError ? fail(error.code, error.message) : fail('invalid_response', '官方角色列表响应格式异常。'); }
  }

  async query(kind, account, params = {}) {
    try {
      const type = ALIASES[kind] || kind;
      const info = accountInfo(account);
      const route = ROUTES[info.region];
      const base = { role_id: info.uid, server: info.server };
      let endpoint, query = base, body;
      if (['index', 'dailyNote', 'activities', 'gcg/basicInfo', 'gcg/matchList', 'gcg/deckList', 'char_master', 'hard_challenge/popularity'].includes(type)) {
        safeParameters(params, []); endpoint = route.record + type;
      } else if (['gcg/cardList', 'avatar_cardList', 'action_cardList'].includes(type)) {
        const preset = type !== 'gcg/cardList';
        safeParameters(params, preset ? ['offset', 'limit', 'need_stats'] : ['offset', 'limit', 'need_avatar', 'need_action', 'need_stats']);
        const need_avatar = preset ? type === 'avatar_cardList' : flag(params.need_avatar, true, 'need_avatar');
        const need_action = preset ? type === 'action_cardList' : flag(params.need_action, true, 'need_action');
        if (!need_avatar && !need_action) throw new AccountsError('invalid_parameters', '请至少选择一种七圣卡牌类型。');
        endpoint = route.record + 'gcg/cardList';
        query = { ...base, offset: decimalInteger(params.offset === undefined ? 0 : params.offset, 0, 100000, '分页偏移'), limit: decimalInteger(params.limit === undefined ? 999 : params.limit, 1, 999, '分页数量'), need_avatar: String(need_avatar), need_action: String(need_action), need_stats: String(flag(params.need_stats, true, 'need_stats')) };
      } else if (type === 'ledger') {
        safeParameters(params, ['month']);
        const defaultMonth = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', month: 'numeric' }).format(new Date(this.now())));
        const month = decimalInteger(params.month === undefined ? defaultMonth : params.month, 1, 12, '札记月份');
        endpoint = route.ledger;
        query = info.region === 'cn' ? { month, bind_uid: info.uid, bind_region: info.server, lang: 'zh-cn' } : { month, uid: info.uid, region: info.server, lang: 'zh-cn' };
      } else if (type === 'blueprint') {
        safeParameters(params, ['share_code']);
        const code = params.share_code;
        if (!((typeof code === 'string' || (typeof code === 'number' && Number.isSafeInteger(code))) && /^[1-9]\d{9,14}$/.test(String(code)))) {
          throw new AccountsError('invalid_parameters', '尘歌壶模数必须为 10 至 15 位数字。');
        }
        endpoint = route.calculator + 'v1/furniture/blueprint';
        query = { share_code: String(code), region: info.server, lang: 'zh-cn' };
      } else if (type === 'blueprintCompute') {
        safeParameters(params, ['list']);
        if (!Array.isArray(params.list) || !params.list.length || params.list.length > 1000) throw new AccountsError('invalid_parameters', '请提供 1 至 1000 项家具及所需数量。');
        const items = new Map();
        for (const row of params.list) {
          safeParameters(row, ['id', 'cnt']);
          const id = decimalInteger(row.id, 1, 999999999, '家具 ID');
          const cnt = decimalInteger(row.cnt, 1, 10000, '家具数量');
          const combined = (items.get(id) || 0) + cnt;
          if (combined > 10000) throw new AccountsError('invalid_parameters', '单种家具数量不能超过 10000。');
          items.set(id, combined);
        }
        endpoint = route.calculator + 'v1/furniture/compute'; query = {};
        body = { list: [...items].map(([id, cnt]) => ({ id, cnt })), lang: 'zh-cn' };
      } else if (type === 'spiralAbyss') {
        safeParameters(params, ['schedule_type']); endpoint = route.record + type; query = { ...base, schedule_type: integer(params.schedule_type ?? 1, 1, 2, '深渊期数') };
      } else if (['role_combat', 'hard_challenge'].includes(type)) {
        safeParameters(params, ['need_detail']);
        if (params.need_detail != null && typeof params.need_detail !== 'boolean') throw new AccountsError('invalid_parameters', 'need_detail 必须为布尔值。');
        endpoint = route.record + type; query = { ...base, need_detail: params.need_detail !== false ? 'true' : 'false' };
      } else if (['character', 'characterDetail', 'act_calendar'].includes(type)) {
        safeParameters(params, type === 'characterDetail' ? ['character_ids'] : []);
        endpoint = route.record + (type === 'character' ? 'character/list' : type === 'characterDetail' ? 'character/detail' : type);
        body = { role_id: Number(info.uid), server: info.server }; query = {};
        if (type === 'characterDetail') {
          if (!Array.isArray(params.character_ids) || !params.character_ids.length || params.character_ids.length > 200) throw new AccountsError('invalid_parameters', '请提供 1 至 200 个角色 ID。');
          body.character_ids = [...new Set(params.character_ids.map(id => integer(id, 10000000, 19999999, '角色 ID')))];
        }
      } else if (['detail', 'avatarSkill'].includes(type)) {
        safeParameters(params, ['avatar_id']);
        const avatar_id = integer(params.avatar_id, 10000000, 19999999, '角色 ID');
        endpoint = route.calculator + (type === 'detail' ? 'v1/sync/avatar/detail' : 'v1/avatarSkill/list');
        query = type === 'detail' ? { avatar_id, uid: info.uid, region: info.server, lang: 'zh-cn' } : { avatar_id, lang: 'zh-cn' };
      } else if (type === 'compute') {
        safeParameters(params, ['avatar_id', 'avatar_level_current', 'avatar_level_target', 'element_attr_id', 'weapon', 'skill_list', 'reliquary_list']);
        body = { avatar_id: integer(params.avatar_id, 10000000, 19999999, '角色 ID'), avatar_level_current: integer(params.avatar_level_current, 1, 100, '当前等级'), avatar_level_target: integer(params.avatar_level_target, 1, 100, '目标等级'), lang: 'zh-cn' };
        if (body.avatar_level_target < body.avatar_level_current) throw new AccountsError('invalid_parameters', '目标等级不能低于当前等级。');
        if (params.element_attr_id != null) body.element_attr_id = integer(params.element_attr_id, 1, 7, '元素 ID');
        for (const [name, maxLevel, maxCount] of [['weapon', 100, 1], ['skill_list', 15, 4], ['reliquary_list', 20, 5]]) {
          if (params[name] == null) continue;
          const rows = name === 'weapon' ? [params[name]] : params[name];
          if (!Array.isArray(rows) || rows.length > maxCount) throw new AccountsError('invalid_parameters', '养成物品参数格式无效。');
          const cleaned = rows.map(row => {
            safeParameters(row, ['id', 'level_current', 'level_target']);
            const result = { id: integer(row.id, 1, 999999999, '物品 ID'), level_current: integer(row.level_current, name === 'reliquary_list' ? 0 : 1, maxLevel, '当前等级'), level_target: integer(row.level_target, name === 'reliquary_list' ? 0 : 1, maxLevel, '目标等级') };
            if (result.level_target < result.level_current) throw new AccountsError('invalid_parameters', '目标等级不能低于当前等级。');
            return result;
          });
          body[name] = name === 'weapon' ? cleaned[0] : cleaned;
        }
        endpoint = route.calculator + 'v2/compute'; query = {};
      } else return fail('unsupported', '该查询尚无经过核对的官方协议，暂不支持。');
      if (info.region === 'os' && body === undefined) query = { ...query, lang: 'zh-cn' };
      return { ...(await this.#request(endpoint, info, { query, body })), kind: type };
    } catch (error) { return error instanceof AccountsError ? fail(error.code, error.message) : fail('invalid_parameters', '查询参数无效。'); }
  }

  async sign(account) {
    try {
      const info = accountInfo(account);
      const route = ROUTES[info.region];
      const params = { act_id: route.actId, lang: 'zh-cn', ...(info.region === 'cn' ? { uid: info.uid, region: info.server } : {}) };
      const status = await this.#request(route.sign + 'info', info, { query: params, signing: true });
      if (!status.ok) return status;
      if (status.data.first_bind) return fail('first_bind', '请先在官方 App 手动签到一次，完成首次绑定。');
      if (status.data.is_sign) return { ...status, status: 'already', message: '今日已经签到。' };
      const response = await this.#request(route.sign + 'sign', info, { query: params, body: params, signing: true });
      return response.ok ? { ...response, status: response.status || 'signed', message: response.status === 'already' ? '今日已经签到。' : '原神签到成功。' } : response;
    } catch (error) { return error instanceof AccountsError ? fail(error.code, error.message) : fail('invalid_parameters', '签到参数无效。'); }
  }
}
