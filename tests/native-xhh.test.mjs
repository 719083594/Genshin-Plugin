import test from 'node:test';
import assert from 'node:assert/strict';
import { HoyolabClient } from '../lib/hoyolab.mjs';
import { configureNativeAccounts, runNativeScope } from '../lib/native-accounts.mjs';
import { installNativeXhhGuard } from '../lib/native-xhh.mjs';

const OWNER = '12345678', OTHER = '87654321';
const UID = '100000001', OTHER_UID = '100000002';
const COOKIE = 'ltuid=123456; ltoken=synthetic-xhh-owner-token;';
const OTHER_COOKIE = 'ltuid=654321; ltoken=synthetic-xhh-other-token;';

function fixture(t) {
  const original = [], requests = [];
  // Mirrors the audited constructor and getData interface. No external plugin,
  // node-fetch, Redis, FP request or account persistence is executed in tests.
  class LiteMysApi {
    constructor(uid, cookie, option = {}) { this.uid = String(uid); this.cookie = cookie; this.game = option.game || 'gs'; this._device_fp = null; }
    async getData(api) { original.push(api); return { retcode: 0, data: { nativeFetch: true } }; }
  }
  const rows = new Map([
    [OWNER, [{ uid: UID, server: 'cn_gf01', region: 'cn', selected: true, cookie: COOKIE }]],
    [OTHER, [{ uid: OTHER_UID, server: 'cn_gf01', region: 'cn', selected: true, cookie: OTHER_COOKIE }]]
  ]);
  const accounts = {
    list: owner => (rows.get(owner) || []).map(({ cookie, ...row }) => ({ ...row, hasCookie: Boolean(cookie) })),
    get: (owner, uid) => rows.get(owner)?.find(row => row.uid === uid) || null,
    selected: owner => rows.get(owner)?.find(row => row.selected) || null
  };
  const mys = new HoyolabClient({ fetch: async (url, init) => {
    requests.push({ url: new URL(url), init });
    return { ok: true, url, text: async () => JSON.stringify({ retcode: 0, data: { current_resin: 88 } }) };
  } });
  configureNativeAccounts({ accounts, query: (api, account, params) => mys.query(api, account, params) });
  const guard = installNativeXhhGuard({ LiteMysApi });
  t.after(() => { guard.restore(); configureNativeAccounts(); });
  const event = owner => ({ user_id: owner, msg: '#原神体力', game: 'gs', isGroup: false, runtime: { MysInfo: { init() { throw new Error('original initialization forbidden'); } } } });
  return { LiteMysApi, guard, original, requests, accounts, event };
}

test('LiteMysApi Cookie assignment is discarded and an absent scope never falls back to native HTTP', async t => {
  const { LiteMysApi, original, requests } = fixture(t);
  const client = new LiteMysApi(UID, COOKIE);
  assert.equal(client.cookie, ''); assert.equal(Object.hasOwn(client, 'cookie'), false);
  client.cookie = OTHER_COOKIE; assert.equal(client.cookie, '');
  assert.doesNotMatch(JSON.stringify(client), /synthetic/);
  assert.equal((await client.getData('dailyNote')).retcode, -1);
  assert.deepEqual(original, []); assert.deepEqual(requests, []);
});

test('a private owner read uses only reviewed core headers and own encrypted-account Cookie', async t => {
  const { LiteMysApi, event, original, requests } = fixture(t);
  await runNativeScope(event(OWNER), async () => {
    const client = new LiteMysApi(UID, 'ignored-native-credential');
    const result = await client.getData('dailyNote', { headers: { Cookie: OTHER_COOKIE }, Getfp: true }, true);
    assert.equal(result.retcode, 0); assert.equal(result.data.current_resin, 88);
    assert.equal(client._device_fp, null);
    for (const api of ['getFp', 'bbs_sign', 'useCdk', 'UserGame', 'https://evil.example/api']) assert.equal((await client.getData(api)).retcode, -1);
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.origin + requests[0].url.pathname, 'https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/dailyNote');
  assert.equal(requests[0].url.searchParams.get('role_id'), UID);
  assert.equal(requests[0].init.headers.Cookie, COOKIE);
  assert.equal(requests[0].init.redirect, 'error'); assert.deepEqual(original, []);
});

test('other QQ accounts, foreign games and caller UID overrides cannot borrow authorization', async t => {
  const { LiteMysApi, event, requests, original } = fixture(t);
  await runNativeScope(event(OWNER), async () => {
    assert.equal((await new LiteMysApi(OTHER_UID, OTHER_COOKIE).getData('dailyNote')).retcode, -1);
    for (const game of ['sr', 'zzz', 'ww']) assert.equal((await new LiteMysApi(UID, COOKIE, { game }).getData('index')).retcode, -1);
    assert.equal((await new LiteMysApi(UID, COOKIE).getData('dailyNote', { role_id: OTHER_UID })).retcode, -1);
  });
  assert.deepEqual(requests, []); assert.deepEqual(original, []);
});

test('groups remain UID-only by default and explicit group authorization remains owner isolated', async t => {
  const { LiteMysApi, event, requests } = fixture(t);
  const group = { ...event(OWNER), isGroup: true, group_id: '23456789' };
  await runNativeScope(group, async () => assert.equal((await new LiteMysApi(UID, COOKIE).getData('index')).retcode, -1));
  assert.equal(requests.length, 0);
  await runNativeScope(group, async () => {
    assert.equal((await new LiteMysApi(UID, COOKIE).getData('index')).retcode, 0);
    assert.equal((await new LiteMysApi(OTHER_UID, OTHER_COOKIE).getData('index')).retcode, -1);
  }, { allowGroupCookie: true });
  assert.equal(requests.length, 1); assert.equal(requests[0].init.headers.Cookie, COOKIE);
});

test('retained Lite clients cannot query after their event scope ends', async t => {
  const { LiteMysApi, event, requests } = fixture(t); let retained;
  await runNativeScope(event(OWNER), async () => {
    retained = new LiteMysApi(UID, COOKIE); assert.equal((await retained.getData('index')).retcode, 0);
  });
  assert.equal((await retained.getData('index')).retcode, -1);
  assert.equal(retained.cookie, ''); assert.equal(requests.length, 1);
});

test('overlapping owners retain their independent ALS authorization and original client remains unused', async t => {
  const { LiteMysApi, event, requests, original } = fixture(t); let resume;
  const pending = new Promise(resolve => { resume = resolve; });
  const first = runNativeScope(event(OWNER), async () => { const client = new LiteMysApi(UID, OTHER_COOKIE); await pending; assert.equal((await client.getData('dailyNote')).retcode, 0); });
  await runNativeScope(event(OTHER), async () => assert.equal((await new LiteMysApi(OTHER_UID, COOKIE).getData('dailyNote')).retcode, 0));
  resume(); await first;
  assert.deepEqual(requests.map(row => row.url.searchParams.get('role_id')), [OTHER_UID, UID]);
  assert.deepEqual(requests.map(row => row.init.headers.Cookie), [OTHER_COOKIE, COOKIE]); assert.deepEqual(original, []);
});

test('guarded runtime is marked to skip xhh Lite injection and its scope methods cannot be overwritten', async t => {
  const { event } = fixture(t);
  await runNativeScope(event(OWNER), async () => {
    // ensureRuntime checks exactly this marker and typeof MysInfo.init before
    // installing its Lite methods. The reviewed runtime must preserve both.
  });
  const current = event(OWNER);
  await runNativeScope(current, async () => {
    assert.equal(current.runtime._xhhLiteMysApi, true);
    assert.equal(typeof current.runtime.MysInfo.init, 'function');
    assert.equal(Reflect.set(current.runtime, 'getMysApi', () => assert.fail('native injection')), false);
    assert.equal(Reflect.set(current.runtime, 'createMysApi', () => assert.fail('native injection')), false);
  });
});

test('exceptions and malformed failures cannot echo raw credentials or claim success', async t => {
  const { LiteMysApi, event } = fixture(t);
  await runNativeScope(event(OWNER), async () => {
    for (const queryScoped of [async () => { throw new Error(COOKIE); }, async () => ({ retcode: -100, message: COOKIE, data: { cookie: COOKIE } }), async () => ({ retcode: '0', data: {} }), async () => ({ retcode: 0 })]) {
      installNativeXhhGuard({ LiteMysApi, queryScoped });
      const result = await new LiteMysApi(UID, COOKIE).getData('dailyNote');
      assert.equal(result.retcode, -1); assert.doesNotMatch(JSON.stringify(result), /synthetic/);
    }
  });
});

test('installation is idempotent, restoration is exact, and unsafe descriptors fail before patching', async t => {
  const { LiteMysApi, guard, original } = fixture(t);
  const wrapped = LiteMysApi.prototype.getData;
  assert.equal(installNativeXhhGuard({ LiteMysApi }).installed, 0);
  assert.equal(LiteMysApi.prototype.getData, wrapped);
  guard.restore(); guard.restore();
  const restored = new LiteMysApi(UID, COOKIE);
  assert.equal(restored.cookie, COOKIE); assert.equal((await restored.getData('index')).retcode, 0);
  assert.deepEqual(original, ['index']);
  class Unsafe { async getData() { return 'original'; } }
  const previous = Unsafe.prototype.getData;
  Object.defineProperty(Unsafe.prototype, 'cookie', { configurable: false, value: COOKIE });
  assert.throws(() => installNativeXhhGuard({ LiteMysApi: Unsafe }), TypeError);
  assert.equal(Unsafe.prototype.getData, previous);
});
