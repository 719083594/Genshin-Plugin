import test from 'node:test';
import assert from 'node:assert/strict';
import { MiyousheCoinClient } from '../lib/miyoushe-coins.mjs';

// Synthetic values only. No test contacts the network or uses a real account.
const cookie = 'ltoken_v2=synthetic-web-token; ltuid_v2=12345; ltmid_v2=synthetic-mid; cookie_token_v2=synthetic-cookie-token; account_id_v2=12345; account_mid_v2=synthetic-mid;';
const account = Object.freeze({ uid: '100000001', region: 'cn', server: 'cn_gf01', cookie });
const missions = () => ({ total_points: 100, already_received_points: 20, today_total_points: 90,
  states: [{ mission_id: 59, process: 2, is_get_award: false }, { mission_id: 58, process: 1, is_get_award: true }] });
const response = (payload, options = {}) => new Response(JSON.stringify(payload), { status: 200, ...options });
const clientReturning = payload => new MiyousheCoinClient({ fetch: async () => response(payload) });

test('balance uses only the fixed official GET with the normalized web Cookie', async () => {
  const requests = [];
  const client = new MiyousheCoinClient({ fetch: async (url, options) => {
    requests.push({ url, options });
    return response({ retcode: 0, data: { points: 123, direct_shop: true, private_account: 'ignored' } });
  } });
  assert.deepEqual(await client.balance(account), { ok: true, data: { points: 123 } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://bbs-api.mihoyo.com/common/homutreasure/v1/web/user/point?app_id=1&point_sn=myb');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.body, undefined);
  assert.equal(requests[0].options.headers.Cookie, cookie);
  assert.equal(requests[0].options.headers.DS, undefined);
  assert.equal(requests[0].options.headers['x-rpc-client_type'], undefined);
  assert.equal(requests[0].options.headers['x-rpc-app_id'], undefined);
  assert.doesNotMatch(requests[0].options.headers['User-Agent'], /Android|miHoYoBBS/);
  assert.doesNotMatch(requests[0].url, /100000001|12345|token/);
  assert.equal(client.cookie, undefined);
  assert.doesNotMatch(JSON.stringify(client), /synthetic|12345|100000001/);
});

test('missions returns only source-confirmed fields and uses no other route', async () => {
  const requests = [];
  const data = missions();
  data.cookie = cookie;
  data.states[0].stoken = 'must-not-escape';
  data.states[0].uid = 'private-identifier';
  const client = new MiyousheCoinClient({ fetch: async (url, options) => {
    requests.push({ url, options }); return response({ retcode: 0, data });
  } });
  assert.deepEqual(await client.missions(account), { ok: true, data: missions() });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://bbs-api.mihoyo.com/apihub/wapi/getUserMissionsState?point_sn=myb');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(client.sign, undefined);
  assert.equal(client.like, undefined);
  assert.equal(client.share, undefined);
  assert.equal(client.history, undefined);
  assert.equal(client.request, undefined);
});

test('zero amounts are real values; omitted optional state fields are not invented', async () => {
  const client = clientReturning({ retcode: 0, data: { total_points: 0, already_received_points: 0,
    today_total_points: 0, states: [{ mission_id: 58 }] } });
  assert.deepEqual(await client.missions(account), { ok: true, data: { total_points: 0,
    already_received_points: 0, today_total_points: 0, states: [{ mission_id: 58 }] } });
  assert.deepEqual(await clientReturning({ retcode: 0, data: { points: 0 } }).balance(account), { ok: true, data: { points: 0 } });
});

test('decimal integer strings normalize without calculating an unsupported remaining balance', async () => {
  const result = await clientReturning({ retcode: 0, data: { total_points: '100', already_received_points: '20',
    today_total_points: '90', states: [{ mission_id: '59', process: '2', is_get_award: false }] } }).missions(account);
  assert.deepEqual(result, { ok: true, data: { total_points: 100, already_received_points: 20,
    today_total_points: 90, states: [{ mission_id: 59, process: 2, is_get_award: false }] } });
  assert.equal(result.data.can_get_points, undefined);
});

test('missing authorization and overseas or mismatched accounts never send a request', async t => {
  let count = 0;
  const client = new MiyousheCoinClient({ fetch: async () => { count++; throw new Error('not reached'); } });
  for (const [name, value, code] of [
    ['anonymous', null, 'not_bound'],
    ['UID only', { uid: '100000001', region: 'cn' }, 'auth_required'],
    ['overseas', { ...account, uid: '600000001', region: 'os', server: 'os_usa' }, 'unsupported_region'],
    ['mismatched region', { ...account, region: 'os' }, 'region_mismatch'],
    ['header injection', { ...account, cookie: cookie + '\r\nAuthorization: secret' }, 'invalid_cookie'],
    ['SToken only', { ...account, cookie: 'stuid=12345; stoken=synthetic-stoken;' }, 'incomplete_cookie'],
    ['mismatched identity', { ...account, cookie: 'ltuid_v2=1; account_id_v2=2; ltoken_v2=synthetic;' }, 'invalid_cookie']
  ]) await t.test(name, async () => assert.equal((await client.balance(value)).code, code));
  assert.equal(count, 0);
});

test('a server-declined web Cookie is reported without claiming original Genshin authorization expired', async t => {
  for (const retcode of [-100, -2007]) await t.test(String(retcode), async () => {
    const result = await clientReturning({ retcode, message: cookie, data: { points: 500, cookie } }).balance(account);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'community_auth_required');
    assert.equal(result.retcode, retcode);
    assert.equal(result.data, undefined);
    assert.doesNotMatch(JSON.stringify(result), /synthetic|12345|重新扫码/);
  });
});

test('verification results stay safe and are never interpreted as success', async t => {
  for (const payload of [{ retcode: 1034, data: {} }, { retcode: 1028, data: {} },
    { retcode: 0, data: { points: 1, challenge: 'private-challenge', gt: 'private-gt' } }]) {
    await t.test(String(payload.retcode), async () => {
      const result = await clientReturning(payload).balance(account);
      assert.equal(result.code, 'verification_required');
      assert.doesNotMatch(JSON.stringify(result), /private-challenge|private-gt/);
      assert.equal(result.data, undefined);
    });
  }
});

test('nonzero status with usable-looking data never becomes success', async () => {
  const result = await clientReturning({ retcode: -999, message: cookie, data: { points: 100 } }).balance(account);
  assert.deepEqual(result, { ok: false, code: 'upstream_error', message: '官方米游币接口暂时未返回可用结果，请稍后重试。', retcode: -999 });
});

test('malformed and incomplete envelopes fail closed', async t => {
  for (const payload of [null, [], {}, { retcode: '0', data: { points: 1 } }, { retcode: 0, data: null },
    { retcode: 0, data: {} }, { retcode: 0, data: { points: -1 } }, { retcode: 0, data: { points: 0.5 } },
    { retcode: 0, data: { points: Number.MAX_SAFE_INTEGER + 1 } }, { retcode: 0, data: { points: cookie } }]) {
    await t.test(JSON.stringify(payload)?.slice(0, 70) || 'null', async () => {
      const result = await clientReturning(payload).balance(account);
      assert.equal(result.code, 'invalid_response');
      assert.doesNotMatch(JSON.stringify(result), /synthetic/);
    });
  }
});

test('task response bounds and individual field types are validated', async t => {
  for (const patch of [{ states: {} }, { states: [null] }, { states: Array(257).fill({ mission_id: 58 }) },
    { states: [{ mission_id: -1 }] }, { states: [{ mission_id: 58, process: true }] },
    { states: [{ mission_id: 58, is_get_award: 'false' }] }, { today_total_points: null }, { total_points: undefined }]) {
    await t.test(JSON.stringify(patch).slice(0, 60), async () => {
      assert.equal((await clientReturning({ retcode: 0, data: { ...missions(), ...patch } }).missions(account)).code, 'invalid_response');
    });
  }
});

test('redirects, altered destinations and HTTP failures cannot expose credentials or forward success', async t => {
  for (const [name, value, code] of [
    ['redirect flag', { ok: true, redirected: true }, 'redirect_rejected'],
    ['destination changed', { ok: true, url: 'https://example.invalid/?token=synthetic' }, 'redirect_rejected'],
    ['same host other route', { ok: true, url: 'https://bbs-api.mihoyo.com/mission/wapi/getAward' }, 'redirect_rejected'],
    ['invalid destination', { ok: true, url: 'not a url' }, 'redirect_rejected'],
    ['rate limited', { ok: false, status: 429 }, 'rate_limited'],
    ['HTTP error', { ok: false, status: 503 }, 'http_error']
  ]) await t.test(name, async () => {
    const client = new MiyousheCoinClient({ fetch: async () => value });
    const result = await client.balance(account);
    assert.equal(result.code, code);
    assert.doesNotMatch(JSON.stringify(result), /example|synthetic|getAward/);
  });
});

test('a real Response carrying the exact destination is accepted', async () => {
  const value = response({ retcode: 0, data: { points: 1 } });
  Object.defineProperty(value, 'url', { value: 'https://bbs-api.mihoyo.com/common/homutreasure/v1/web/user/point?app_id=1&point_sn=myb' });
  assert.equal((await new MiyousheCoinClient({ fetch: async () => value }).balance(account)).ok, true);
});

test('malformed JSON and an oversized declared response are rejected', async t => {
  for (const [name, value] of [ ['invalid JSON', new Response('{bad JSON ' + cookie)],
    ['oversized declared body', new Response('{}', { headers: { 'content-length': '65537' } })] ]) {
    await t.test(name, async () => assert.equal((await new MiyousheCoinClient({ fetch: async () => value }).balance(account)).code, 'invalid_response'));
  }
});

test('an oversized stream is cancelled without returning partial or secret data', async () => {
  let cancelled = false;
  const value = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(65537)); },
    cancel() { cancelled = true; }
  }));
  const result = await new MiyousheCoinClient({ fetch: async () => value }).balance(account);
  assert.equal(result.code, 'invalid_response');
  assert.equal(cancelled, true);
});

test('a response-text-only adapter is size bounded too', async () => {
  const value = { ok: true, text: async () => 'x'.repeat(65537) };
  assert.equal((await new MiyousheCoinClient({ fetch: async () => value }).balance(account)).code, 'invalid_response');
});

test('transport exceptions never echo requests or server text', async () => {
  const client = new MiyousheCoinClient({ fetch: async () => { throw new Error(cookie); } });
  const result = await client.balance(account);
  assert.equal(result.code, 'network_error');
  assert.doesNotMatch(JSON.stringify(result), /synthetic|ltuid|token/);
});

test('timeout is bounded even when an injected transport ignores abort', async () => {
  let signal;
  const client = new MiyousheCoinClient({ timeoutMs: 10, fetch: async (_url, options) => {
    signal = options.signal; return new Promise(() => {});
  } });
  const result = await client.balance(account);
  assert.equal(result.code, 'timeout');
  assert.equal(signal.aborted, true);
});

test('timeout also bounds an unfinished response body', async () => {
  let signal;
  const client = new MiyousheCoinClient({ timeoutMs: 10, fetch: async (_url, options) => {
    signal = options.signal; return { ok: true, text: async () => new Promise(() => {}) };
  } });
  assert.equal((await client.missions(account)).code, 'timeout');
  assert.equal(signal.aborted, true);
});

test('constructor rejects a missing transport without inspecting credentials', () => {
  assert.throws(() => new MiyousheCoinClient({ fetch: null }), error => error.code === 'missing_fetch');
});
