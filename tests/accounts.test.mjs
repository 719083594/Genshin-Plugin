import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { AccountsStore, AccountsError, validateUid, normalizeCookie } from '../lib/accounts.mjs';
import { HoyolabClient, dynamicSecret } from '../lib/hoyolab.mjs';
import { Teyvat } from '../lib/core.mjs';

const OWNER = '12345678';
const OTHER = '87654321';
// Test-only invented tokens. No network calls or user credentials are used.
const COOKIE = 'ltuid=123456; ltoken=synthetic-test-token; cookie_token=synthetic-cookie-token; account_id=123456;';
const CN = { uid: '100000001', region: 'cn', server: 'cn_gf01', cookie: COOKIE };
const OS = { uid: '1800000001', region: 'os', server: 'os_asia', cookie: COOKIE };

function storeFor(t, options = {}) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'teyvat-accounts-test-'));
  t.after(() => {
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(base + path.sep) && path.basename(absolute).startsWith('teyvat-accounts-test-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const key = crypto.randomBytes(32);
  return { store: new AccountsStore(root, { key, ...options }), key, root };
}

function mockClient(responses = [{ retcode: 0, data: {} }], options = {}) {
  const requests = [];
  const queue = [...responses];
  const fetch = async (url, init) => {
    requests.push({ url: new URL(url), init });
    if (!queue.length) throw new Error('Unexpected mock request: ' + url);
    const result = queue.shift();
    if (result instanceof Error) throw result;
    return { ok: true, status: 200, url, text: async () => JSON.stringify(result) };
  };
  return { client: new HoyolabClient({ fetch, now: () => 1700000000000, deviceFp: 'synthetic-fixed-test-fp', ...options }), requests };
}

test('UID recognition validates all servers, including the extended Asia range', () => {
  for (const [uid, server] of [['100000001', 'cn_gf01'], ['200000001', 'cn_gf01'], ['300000001', 'cn_gf01'], ['500000001', 'cn_qd01'], ['600000001', 'os_usa'], ['700000001', 'os_euro'], ['800000001', 'os_asia'], ['1800000001', 'os_asia'], ['900000001', 'os_cht']]) {
    assert.equal(validateUid(uid).server, server);
  }
  for (const uid of ['100', '000000001', '400000001', '1000000001', '99999999999', '100000001&server=os_usa']) assert.throws(() => validateUid(uid), AccountsError);
  assert.throws(() => validateUid('1800000001', 'cn'), { code: 'region_mismatch' });
  assert.throws(() => validateUid('100000001', 'cn_qd01'), { code: 'region_mismatch' });
});

test('Cookie parser rejects passwords, header injection, incomplete or conflicting credentials', () => {
  for (const cookie of ['password=secret; account_id=123456;', COOKIE + '\r\nHost: evil.example', 'stuid=123456; stoken=test;', COOKIE + 'ltuid=987654;', COOKIE + 'account_id_v2=987654;', 'ltuid=123456; ltoken=;']) assert.throws(() => normalizeCookie(cookie), AccountsError);
  const value = normalizeCookie('tracking=unrelated; ltuid_v2=123456; ltoken_v2=v2_synthetic; ltmid_v2=synthetic-mid;');
  assert.ok(!value.includes('tracking'));
  assert.ok(value.includes('ltmid_v2=synthetic-mid'));
});

test('Cookie binding requires private chat; UID-only binding is permitted', t => {
  const { store } = storeFor(t);
  assert.throws(() => store.bind(OWNER, { ...CN }), { code: 'private_only' });
  assert.throws(() => store.bind(OWNER, { uid: CN.uid, password: 'do-not-save' }), { code: 'password_forbidden' });
  const uidOnly = store.bind(OWNER, { uid: CN.uid });
  assert.equal(uidOnly.hasCookie, false);
  assert.equal(store.selected(OWNER).server, 'cn_gf01');
  assert.ok(!Object.hasOwn(store.selected(OWNER), 'cookie'));
  store.bind(OWNER, { ...CN, privateChat: true });
  assert.equal(store.get(OWNER).cookie, normalizeCookie(COOKIE));
});

test('QQ owners have independent bindings, selection and deletion', t => {
  const { store } = storeFor(t);
  store.bind(OWNER, { ...CN, privateChat: true });
  store.bind(OWNER, { uid: OS.uid, label: '国际服' });
  store.bind(OTHER, { uid: '500000001', label: '另一个人' });
  assert.equal(store.list(OWNER).length, 2);
  assert.equal(store.list(OTHER).length, 1);
  assert.equal(store.get(OTHER, CN.uid), null);
  assert.throws(() => store.select(OTHER, CN.uid), { code: 'not_bound' });
  store.select(OWNER, OS.uid);
  assert.equal(store.selected(OWNER).uid, OS.uid);
  assert.equal(store.selected(OTHER).uid, '500000001');
  assert.equal(store.remove(OWNER, OS.uid), true);
  assert.equal(store.selected(OWNER).uid, CN.uid);
  assert.equal(store.remove(OWNER, OS.uid), false);
  assert.equal(store.remove(OWNER, CN.uid), true);
  assert.equal(store.selected(OWNER), null);
  assert.equal(store.selected(OTHER).uid, '500000001');
});

test('database and rolling backup contain no plaintext secrets or account metadata', t => {
  const { store, key, root } = storeFor(t);
  store.bind(OWNER, { ...CN, privateChat: true, label: '我的测试备注' });
  store.bind(OWNER, { uid: OS.uid });
  for (const file of [store.file, store.backupFile]) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(content).algorithm, 'aes-256-gcm');
    for (const value of [COOKIE, 'synthetic-test-token', CN.uid, OWNER, '我的测试备注', key.toString('hex')]) assert.ok(!content.includes(value));
  }
  assert.equal(new AccountsStore(root, { key: key.toString('base64') }).get(OWNER, CN.uid).cookie, normalizeCookie(COOKIE));
  const listed = JSON.stringify(store.list(OWNER));
  assert.ok(!listed.includes('synthetic'));
  assert.ok(!listed.includes('"cookie"'));
});

test('wrong key or tampering fails closed and does not overwrite ciphertext', t => {
  const { store, root, key } = storeFor(t);
  store.bind(OWNER, { ...CN, privateChat: true });
  const original = fs.readFileSync(store.file, 'utf8');
  const wrong = new AccountsStore(root, { key: crypto.randomBytes(32) });
  assert.throws(() => wrong.bind(OWNER, { uid: OS.uid }), { code: 'decrypt_failed' });
  assert.equal(fs.readFileSync(store.file, 'utf8'), original);
  const envelope = JSON.parse(original);
  const tag = Buffer.from(envelope.tag, 'base64'); tag[0] ^= 1;
  envelope.tag = tag.toString('base64');
  fs.writeFileSync(store.file, JSON.stringify(envelope));
  assert.throws(() => new AccountsStore(root, { key }).get(OWNER), { code: 'decrypt_failed' });
});

test('missing key, account limits and exclusive mutation lock are enforced', t => {
  const { store, root } = storeFor(t, { maxAccounts: 1 });
  assert.throws(() => new AccountsStore(root, { key: '' }), { code: 'missing_key' });
  store.bind(OWNER, { uid: CN.uid });
  assert.throws(() => store.bind(OWNER, { uid: OS.uid }), { code: 'account_limit' });
  fs.writeFileSync(store.lockFile, 'test-lock');
  assert.throws(() => store.remove(OWNER, CN.uid), { code: 'storage_busy' });
  assert.equal(store.list(OWNER).length, 1);
});

test('two store instances preserve each other updates and UID rebind preserves credential', t => {
  const { store, root, key } = storeFor(t);
  const second = new AccountsStore(root, { key });
  store.bind(OWNER, { ...CN, privateChat: true });
  second.bind(OTHER, { uid: OS.uid });
  store.bind(OWNER, { uid: CN.uid, label: '更新备注' });
  assert.equal(second.get(OWNER).cookie, normalizeCookie(COOKIE));
  assert.equal(store.get(OTHER).uid, OS.uid);
  store.bind(OWNER, { uid: CN.uid, cookie: '' });
  assert.equal(second.get(OWNER).hasCookie, false);
});

test('DS fixed vectors distinguish CN full request signing and OS simple signing', () => {
  const digest = value => crypto.createHash('md5').update(value).digest('hex');
  const cn = dynamicSecret({ time: 1700000000, random: '123456', query: 'role_id=100000001&server=cn_gf01', body: '' });
  assert.equal(cn, '1700000000,123456,' + digest('salt=xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs&t=1700000000&r=123456&b=&q=role_id=100000001&server=cn_gf01'));
  const os = dynamicSecret({ region: 'os', time: 1700000000, random: 'AbcDef', query: 'ignored=yes', body: 'ignored' });
  assert.equal(os, '1700000000,AbcDef,' + digest('salt=6s25p5ox5y14umn1p61aqyyvbvvl3lrt&t=1700000000&r=AbcDef'));
  const signin = dynamicSecret({ region: 'cn', sign: true, time: 1700000000, random: 'AbcDef' });
  assert.equal(signin, '1700000000,AbcDef,' + digest('salt=LyD1rXqMv2GJhnwdvCBjFOKGiKuLY3aO&t=1700000000&r=AbcDef'));
});

test('record queries use the verified CN and OS domains and never follow redirects', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: { current_resin: 100 } }, { retcode: 0, data: { current_resin: 120 } }]);
  assert.equal((await client.query('resin', CN)).data.current_resin, 100);
  assert.equal((await client.query('dailyNote', OS)).data.current_resin, 120);
  assert.equal(requests[0].url.origin + requests[0].url.pathname, 'https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/dailyNote');
  assert.equal(requests[1].url.origin + requests[1].url.pathname, 'https://sg-public-api.hoyolab.com/event/game_record/genshin/api/dailyNote');
  assert.equal(requests[1].url.searchParams.get('server'), 'os_asia');
  assert.equal(requests[1].url.searchParams.get('lang'), 'zh-cn');
  assert.ok(requests.every(request => request.init.redirect === 'error'));
  const [time, random] = requests[0].init.headers.DS.split(',');
  assert.equal(requests[0].init.headers.DS, dynamicSecret({ time: Number(time), random, query: requests[0].url.search.slice(1) }));
});

test('abyss period, theater details, characters and event calendar send correct methods and payloads', async () => {
  const { client, requests } = mockClient(Array.from({ length: 5 }, () => ({ retcode: 0, data: {} })));
  await client.query('abyss', CN, { schedule_type: 2 });
  await client.query('theater', CN, { need_detail: false });
  await client.query('character', CN);
  await client.query('characterDetail', CN, { character_ids: [10000002, 10000002, 10000003] });
  await client.query('calendar', CN);
  assert.equal(requests[0].url.searchParams.get('schedule_type'), '2');
  assert.equal(requests[1].url.searchParams.get('need_detail'), 'false');
  assert.ok(requests.slice(2).every(request => request.init.method === 'POST'));
  assert.deepEqual(JSON.parse(requests[3].init.body), { role_id: 100000001, server: 'cn_gf01', character_ids: [10000002, 10000003] });
  const [time, random] = requests[3].init.headers.DS.split(',');
  assert.equal(requests[3].init.headers.DS, dynamicSecret({ time: Number(time), random, body: requests[3].init.body }));
});

test('role discovery uses game_biz and returns only safe matching Genshin roles', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: { list: [ { game_biz: 'hk4e_cn', game_uid: CN.uid, region: 'cn_gf01', nickname: '旅行者', level: 60 }, { game_biz: 'hkrpg_cn', game_uid: '100000002', region: 'prod_gf_cn' } ] } }, { retcode: 0, data: { list: [{ game_biz: 'hk4e_global', game_uid: OS.uid, region: 'os_asia', nickname: 'Traveler', level: 30 }] } }]);
  const cn = await client.roles(COOKIE);
  assert.deepEqual(cn.data, [{ uid: CN.uid, region: 'cn', server: 'cn_gf01', nickname: '旅行者', level: 60 }]);
  const os = await client.roles(COOKIE, 'os');
  assert.equal(os.data[0].uid, OS.uid);
  assert.equal(requests[0].url.searchParams.get('game_biz'), 'hk4e_cn');
  assert.equal(requests[1].url.hostname, 'api-os-takumi.mihoyo.com');
  assert.equal(requests[1].url.searchParams.get('game_biz'), 'hk4e_global');
});

test('invalid region, parameters, endpoint names or missing credentials do not cause requests', async () => {
  const { client, requests } = mockClient([]);
  const cases = [
    ['dailyNote', { ...CN, cookie: undefined }, {}, 'auth_required'],
    ['dailyNote', { ...CN, region: 'os' }, {}, 'region_mismatch'],
    ['https://evil.example/api', CN, {}, 'unsupported'],
    ['dailyNote', CN, { endpoint: 'https://evil.example' }, 'invalid_parameters'],
    ['dailyNote', CN, { headers: { Cookie: 'other' } }, 'invalid_parameters'],
    ['abyss', CN, { schedule_type: 3 }, 'invalid_parameters'],
    ['theater', CN, { need_detail: 'false' }, 'invalid_parameters'],
    ['characterDetail', CN, { character_ids: ['1&server=evil'] }, 'invalid_parameters']
  ];
  for (const [kind, account, params, code] of cases) assert.equal((await client.query(kind, account, params)).code, code);
  assert.equal(requests.length, 0);
});

test('cultivation detail and material calculator use verified endpoints and bounded payload', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: {} }, { retcode: 0, data: {} }]);
  await client.query('cultivation', CN, { avatar_id: 10000002 });
  const result = await client.query('compute', CN, { avatar_id: 10000002, avatar_level_current: 80, avatar_level_target: 90, weapon: { id: 11501, level_current: 80, level_target: 90 }, skill_list: [{ id: 10021, level_current: 8, level_target: 10 }] });
  assert.equal(result.ok, true);
  assert.ok(requests[0].url.pathname.endsWith('/v1/sync/avatar/detail'));
  assert.ok(requests[1].url.pathname.endsWith('/v2/compute'));
  assert.equal(JSON.parse(requests[1].init.body).lang, 'zh-cn');
  assert.equal((await client.query('compute', CN, { avatar_id: 10000002, avatar_level_current: 90, avatar_level_target: 80 })).code, 'invalid_parameters');
  assert.equal(requests.length, 2);
});

test('ledger uses separate verified regional URLs and the bound UID/server only', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: { month: 9, month_data: { current_primogems: 1234 } } }, { retcode: 0, data: { month: 10 } }]);
  const cn = await client.query('ledger', CN, { month: 9 });
  const os = await client.query('ys_ledger', OS, { month: '10' });
  assert.equal(cn.data.month_data.current_primogems, 1234);
  assert.equal(os.kind, 'ledger');
  assert.equal(requests[0].url.origin + requests[0].url.pathname, 'https://hk4e-api.mihoyo.com/event/ys_ledger/monthInfo');
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), { bind_region: 'cn_gf01', bind_uid: CN.uid, lang: 'zh-cn', month: '9' });
  assert.equal(requests[1].url.origin + requests[1].url.pathname, 'https://sg-hk4e-api.hoyolab.com/event/ysledgeros/month_info');
  assert.deepEqual(Object.fromEntries(requests[1].url.searchParams), { lang: 'zh-cn', month: '10', region: 'os_asia', uid: OS.uid });
  assert.ok(requests.every(({ init }) => init.method === 'GET' && !Object.hasOwn(init, 'body')));
  const [time, random] = requests[0].init.headers.DS.split(',');
  assert.equal(requests[0].init.headers.DS, dynamicSecret({ time: Number(time), random, query: requests[0].url.search.slice(1) }));
});

test('ledger month defaults to Asia/Shanghai and rejects invalid month or identity overrides', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: {} }], { now: () => Date.parse('2026-09-30T17:00:00Z') });
  assert.equal((await client.query('ledger', CN)).ok, true);
  assert.equal(requests[0].url.searchParams.get('month'), '10');
  for (const month of [0, 13, 1.5, 202609, null, true, [], [9], {}, '9&bind_uid=100000002', '']) {
    assert.equal((await client.query('ledger', CN, { month })).code, 'invalid_parameters');
  }
  for (const params of [{ uid: '100000002', month: 9 }, { bind_region: 'os_usa', month: 9 }, { cookie: 'other', month: 9 }, { year: 2025, month: 9 }, { endpoint: 'https://evil.example', month: 9 }]) {
    assert.equal((await client.query('ledger', CN, params)).code, 'invalid_parameters');
  }
  assert.equal((await client.query('ledger', { ...CN, region: 'os' }, { month: 9 })).code, 'region_mismatch');
  assert.equal(requests.length, 1);
});

test('blueprints use calculator furniture routes, preserve the replica code, and fix the account region', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: { list: [{ id: 361001, num: 3 }] } }, { retcode: 0, data: {} }]);
  const code = '123456789012345';
  assert.equal((await client.query('blueprint', CN, { share_code: code })).data.list[0].num, 3);
  assert.equal((await client.query('blueprint', OS, { share_code: 12345678901 })).ok, true);
  assert.equal(requests[0].url.origin + requests[0].url.pathname, 'https://api-takumi.mihoyo.com/event/e20200928calculate/v1/furniture/blueprint');
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), { lang: 'zh-cn', region: 'cn_gf01', share_code: code });
  assert.equal(requests[1].url.origin + requests[1].url.pathname, 'https://sg-public-api.hoyolab.com/event/e20200928calculate/v1/furniture/blueprint');
  assert.equal(requests[1].url.searchParams.get('region'), 'os_asia');
  assert.equal(requests[0].init.headers.Referer, 'https://webstatic.mihoyo.com/ys/event/e20200923adopt_calculator/index.html');
  assert.equal(requests[1].init.headers.Referer, 'https://act.hoyolab.com/');
  for (const share_code of ['123', '0123456789', '1234567890123456', '1234567890&region=os_usa', null, {}, [], true, 12345678901.1]) {
    assert.equal((await client.query('blueprint', CN, { share_code })).code, 'invalid_parameters');
  }
  assert.equal((await client.query('blueprint', CN, { share_code: code, region: 'os_usa' })).code, 'invalid_parameters');
  assert.equal(requests.length, 2);
});

test('furniture computation uses isolated bounded id/cnt lists and signs the actual POST body', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: { list: [{ id: 101315, num: 12 }] } }, { retcode: 0, data: {} }]);
  const params = Object.freeze({ list: Object.freeze([Object.freeze({ id: 361001, cnt: 2 }), Object.freeze({ id: '361001', cnt: '3' }), Object.freeze({ id: 361002, cnt: 1 })]) });
  const cn = await client.query('blueprintCompute', CN, params);
  const os = await client.query('blueprintCompute', OS, { list: [{ id: 361003, cnt: 7 }] });
  assert.equal(cn.data.list[0].num, 12);
  assert.equal(os.ok, true);
  assert.deepEqual(JSON.parse(requests[0].init.body), { list: [{ id: 361001, cnt: 5 }, { id: 361002, cnt: 1 }], lang: 'zh-cn' });
  assert.deepEqual(JSON.parse(requests[1].init.body), { list: [{ id: 361003, cnt: 7 }], lang: 'zh-cn' });
  assert.equal(params.list[0].cnt, 2);
  assert.equal(requests[0].url.origin + requests[0].url.pathname, 'https://api-takumi.mihoyo.com/event/e20200928calculate/v1/furniture/compute');
  assert.equal(requests[1].url.origin + requests[1].url.pathname, 'https://sg-public-api.hoyolab.com/event/e20200928calculate/v1/furniture/compute');
  assert.ok(requests.every(({ url, init }) => url.search === '' && init.method === 'POST' && !init.body.includes('cookie') && !init.body.includes('uid')));
  const [time, random] = requests[0].init.headers.DS.split(',');
  assert.equal(requests[0].init.headers.DS, dynamicSecret({ time: Number(time), random, body: requests[0].init.body }));
});

test('furniture computation rejects malformed, excessive, injected or coercible parameters without requests', async () => {
  const { client, requests } = mockClient([]);
  const cases = [
    {}, { list: [] }, { list: Array.from({ length: 1001 }, () => ({ id: 361001, cnt: 1 })) },
    { list: [null] }, { list: [{ id: null, cnt: 1 }] }, { list: [{ id: [361001], cnt: 1 }] },
    { list: [{ id: 0, cnt: 1 }] }, { list: [{ id: 361001, cnt: true }] }, { list: [{ id: 361001, cnt: 0 }] },
    { list: [{ id: 361001, cnt: 1.5 }] }, { list: [{ id: 361001, cnt: 10001 }] },
    { list: [{ id: 361001, cnt: 6000 }, { id: 361001, cnt: 6000 }] },
    { list: [{ id: 361001, cnt: 1, uid: '100000002' }] },
    { list: [{ id: 361001, cnt: 1 }], body: { uid: '100000002' } },
    { list: [{ id: 361001, cnt: 1 }], endpoint: 'https://evil.example/' }
  ];
  for (const params of cases) assert.equal((await client.query('blueprintCompute', CN, params)).code, 'invalid_parameters');
  assert.equal(requests.length, 0);
});

test('TCG deck lists, card statistics and existing challenge statistics stay on Genshin record routes', async () => {
  const { client, requests } = mockClient(Array.from({ length: 7 }, () => ({ retcode: 0, data: {} })));
  assert.equal((await client.query('deckList', CN)).ok, true);
  assert.equal((await client.query('tcgDecks', OS)).ok, true);
  assert.equal((await client.query('tcgCards', CN, { offset: 32, limit: 32, need_avatar: false, need_action: true, need_stats: false })).ok, true);
  assert.equal((await client.query('avatar_cardList', CN)).ok, true);
  assert.equal((await client.query('action_cardList', OS)).ok, true);
  assert.equal((await client.query('hardChallenge', CN)).ok, true);
  assert.equal((await client.query('hardChallengePopularity', OS)).ok, true);
  assert.equal(requests[0].url.pathname, '/game_record/app/genshin/api/gcg/deckList');
  assert.equal(requests[1].url.pathname, '/event/game_record/genshin/api/gcg/deckList');
  assert.deepEqual(Object.fromEntries(requests[2].url.searchParams), { limit: '32', need_action: 'true', need_avatar: 'false', need_stats: 'false', offset: '32', role_id: CN.uid, server: 'cn_gf01' });
  assert.equal(requests[3].url.searchParams.get('need_avatar'), 'true');
  assert.equal(requests[3].url.searchParams.get('need_action'), 'false');
  assert.equal(requests[3].url.searchParams.get('need_stats'), 'true');
  assert.equal(requests[3].url.searchParams.get('limit'), '999');
  assert.equal(requests[4].url.searchParams.get('need_avatar'), 'false');
  assert.equal(requests[4].url.searchParams.get('need_action'), 'true');
  assert.equal(requests[4].url.searchParams.get('role_id'), OS.uid);
  assert.equal(requests[5].url.searchParams.get('need_detail'), 'true');
  assert.ok(requests[6].url.pathname.endsWith('/hard_challenge/popularity'));
  assert.ok(requests.every(({ init }) => init.method === 'GET' && !Object.hasOwn(init, 'body')));
});

test('TCG pagination, flags, preset types and forbidden game operations cannot override the request', async () => {
  const { client, requests } = mockClient([]);
  for (const params of [{ offset: -1 }, { offset: [32] }, { offset: null }, { limit: 0 }, { limit: 1000 }, { limit: true }, { need_avatar: 'false' }, { need_stats: null }, { need_avatar: false, need_action: false }, { role_id: '100000002' }, { server: 'os_asia' }, { endpoint: 'https://evil.example/' }]) {
    assert.equal((await client.query('tcgCards', CN, params)).code, 'invalid_parameters');
  }
  assert.equal((await client.query('avatar_cardList', CN, { need_action: true })).code, 'invalid_parameters');
  assert.equal((await client.query('deckList', CN, { uid: '100000002' })).code, 'invalid_parameters');
  for (const kind of ['challenge', 'hkrpg/challenge', 'useCdk', 'genAuthKey', 'avatar/auth', 'https://evil.example/api']) {
    assert.equal((await client.query(kind, CN)).code, 'unsupported');
  }
  assert.equal(requests.length, 0);
});

test('new personal APIs preserve independent account payloads and scrub all upstream error details', async () => {
  const otherCookie = 'ltuid=654321; ltoken=another-synthetic-token;';
  const { client, requests } = mockClient([{ retcode: 0, data: {} }, { retcode: 0, data: {} }, { retcode: -100, message: COOKIE, data: { cookie: COOKIE } }, { retcode: 10102, message: COOKIE }, { retcode: 0, data: { list: [], secret: COOKIE, note: 'echo synthetic-test-token' } }]);
  await client.query('ledger', CN, { month: 9 });
  await client.query('ledger', { ...CN, uid: '100000002', cookie: otherCookie }, { month: 8 });
  assert.equal(requests[0].url.searchParams.get('bind_uid'), CN.uid);
  assert.equal(requests[1].url.searchParams.get('bind_uid'), '100000002');
  assert.ok(requests[0].init.headers.Cookie.includes('synthetic-test-token'));
  assert.ok(requests[1].init.headers.Cookie.includes('another-synthetic-token'));
  const expired = await client.query('ledger', CN, { month: 9 });
  const privateDeck = await client.query('deckList', CN);
  const blueprint = await client.query('blueprint', CN, { share_code: '12345678901' });
  assert.equal(expired.code, 'expired_cookie');
  assert.equal(privateDeck.code, 'private_data');
  assert.equal(blueprint.ok, true);
  for (const result of [expired, privateDeck, blueprint]) assert.ok(!JSON.stringify(result).includes('synthetic'));
});

test('sign queries status first and avoids mutations on already-signed or first-bind accounts', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: { is_sign: true, total_sign_day: 3 } }, { retcode: 0, data: { first_bind: true } }]);
  assert.equal((await client.sign(CN)).status, 'already');
  assert.equal((await client.sign(OS)).code, 'first_bind');
  assert.ok(requests.every(request => request.init.method === 'GET'));
});

test('CN and OS sign use distinct activity IDs and payloads with no cross-region UID', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: { is_sign: false } }, { retcode: 0, data: {} }, { retcode: 0, data: { is_sign: false } }, { retcode: -5003, message: COOKIE }]);
  assert.equal((await client.sign(CN)).status, 'signed');
  assert.equal((await client.sign(OS)).status, 'already');
  assert.equal(requests[1].url.pathname, '/event/luna/hk4e/sign');
  assert.equal(requests[1].url.searchParams.get('act_id'), 'e202311201442471');
  assert.equal(JSON.parse(requests[1].init.body).uid, CN.uid);
  assert.equal(requests[3].url.pathname, '/event/sol/sign');
  assert.equal(requests[3].url.searchParams.get('act_id'), 'e202102251931481');
  assert.ok(!Object.hasOwn(JSON.parse(requests[3].init.body), 'uid'));
  assert.equal(requests[1].init.headers['x-rpc-signgame'], 'hk4e');
});

test('upstream failures are classified correctly and cannot echo credentials', async () => {
  const responses = [-100, -10001, 10101, 10102, 10103, 10104, 1034, -502002, -10002, -502001, -500001, 999999].map(retcode => ({ retcode, message: COOKIE, data: { secret: COOKIE } }));
  const { client } = mockClient(responses);
  for (const code of ['expired_cookie', 'request_rejected', 'rate_limited', 'private_data', 'community_not_bound', 'not_owned', 'verification_required', 'sync_disabled', 'no_role', 'character_not_owned', 'invalid_parameters', 'upstream_error']) {
    const result = await client.query('dailyNote', CN);
    assert.equal(result.code, code);
    assert.ok(!JSON.stringify(result).includes('synthetic'));
  }
});

test('captcha with retcode zero blocks sign; successful payloads are also scrubbed', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: { is_sign: false } }, { retcode: 0, data: { gt_result: { risk_code: 375, gt: 'test', challenge: 'test' } } }, { retcode: 0, data: { cookie: COOKIE, ltoken: 'synthetic-test-token', innocuous: 'echo synthetic-cookie-token', current_resin: 100 } }]);
  assert.equal((await client.sign(CN)).code, 'verification_required');
  const result = await client.query('dailyNote', CN);
  assert.ok(!JSON.stringify(result).includes('synthetic'));
  assert.equal(result.data.current_resin, 100);
  assert.equal(requests.length, 3);
});

test('timeout aborts even an injected fetch that ignores its signal and errors are safe', async () => {
  let signal;
  const client = new HoyolabClient({ timeoutMs: 10, deviceFp: 'synthetic-fixed-test-fp', fetch: (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  assert.equal((await client.query('dailyNote', CN)).code, 'timeout');
  assert.equal(signal.aborted, true);
  const { client: broken } = mockClient([new Error(COOKIE)]);
  const result = await broken.query('dailyNote', CN);
  assert.equal(result.code, 'network_error');
  assert.ok(!JSON.stringify(result).includes('synthetic'));
});

test('HTTP redirects, rate limits and malformed JSON produce safe failures', async () => {
  const statuses = [302, 429];
  const client = new HoyolabClient({ deviceFp: 'synthetic-fixed-test-fp', fetch: async () => ({ ok: false, status: statuses.shift() }) });
  assert.equal((await client.query('dailyNote', CN)).code, 'http_error');
  assert.equal((await client.query('dailyNote', CN)).code, 'rate_limited');
  const malformed = new HoyolabClient({ deviceFp: 'synthetic-fixed-test-fp', fetch: async () => ({ ok: true, text: async () => COOKIE }) });
  assert.equal((await malformed.query('dailyNote', CN)).code, 'network_error');
  const redirected = new HoyolabClient({ deviceFp: 'synthetic-fixed-test-fp', fetch: async () => ({ ok: true, redirected: false, url: 'https://evil.example/api', text: async () => '{}' }) });
  assert.equal((await redirected.query('dailyNote', CN)).code, 'redirect_rejected');
});

test('bot binds an international UID and verifies its Cookie on the international domain', async t => {
  const { root } = storeFor(t);
  const { client, requests } = mockClient([{ retcode: 0, data: { list: [{ game_biz: 'hk4e_global', game_uid: OS.uid, region: 'os_asia', nickname: 'Traveler', level: 30 }] } }]);
  const bot = new Teyvat(root, { fetch: client.fetch });
  const event = { owner: OWNER, privateChat: true };
  assert.match((await bot.handle({ ...event, text: '#原神绑定 ' + OS.uid })).text, /os_asia/);
  assert.equal(bot.accounts.selected(OWNER).region, 'os');
  const reply = await bot.handle({ ...event, text: `#原神绑定Cookie ${OS.uid} ${COOKIE}` });
  assert.match(reply.text, /已验证并加密保存/);
  assert.equal(requests[0].url.hostname, 'api-os-takumi.mihoyo.com');
  assert.equal(bot.accounts.selected(OWNER).hasCookie, true);
  assert.ok(!reply.text.includes('synthetic'));
});

test('bot rejects Cookie ownership mismatch without storing the credentials', async t => {
  const { root } = storeFor(t);
  const { client, requests } = mockClient([{ retcode: 0, data: { list: [{ game_biz: 'hk4e_cn', game_uid: '100000002', region: 'cn_gf01', nickname: 'Other', level: 30 }] } }]);
  const bot = new Teyvat(root, { fetch: client.fetch });
  const reply = await bot.handle({ owner: OWNER, privateChat: true, text: `#原神绑定Cookie ${CN.uid} ${COOKIE}` });
  assert.match(reply.text, /不拥有该UID/);
  assert.equal(bot.accounts.selected(OWNER), null);
  assert.equal(requests.length, 1);
});

const FP_ENDPOINT = 'https://public-data-api.mihoyo.com/device-fp/api/getFp';
const FP_A = '38d7eeaaaa001';
const FP_B = '38d7eeaaaa002';
const fpResponse = fingerprint => ({ retcode: 0, data: { code: 200, device_fp: fingerprint } });
const jsonResponse = (url, data) => ({ ok: true, status: 200, url, text: async () => JSON.stringify(data) });

test('record budget includes a cold CN FP request while injected and international requests use one', () => {
  const { client, requests } = mockClient([], { deviceFp: undefined });
  assert.equal(client.maxRecordRequests(CN), 2);
  assert.equal(client.maxRecordRequests(OS), 1);
  const { client: provided } = mockClient([]);
  assert.equal(provided.maxRecordRequests(CN), 1);
  assert.equal(requests.length, 0);
});

test('CN record preflight obtains an official Web FP with no credentials or fabricated hardware', async () => {
  const { client, requests } = mockClient([fpResponse(FP_A), { retcode: 0, data: { current_resin: 100, device_fp: FP_A, device_id: 'ignored-device', note: `echo ${FP_A} synthetic-test-token` } }], { deviceFp: undefined });
  const result = await client.query('dailyNote', CN);
  assert.equal(result.ok, true);
  assert.equal(result.data.current_resin, 100);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.href, FP_ENDPOINT);
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(Object.keys(requests[0].init.headers).sort(), ['Content-Type', 'User-Agent']);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.platform, '4');
  assert.equal(body.app_name, 'bbs_cn');
  assert.match(body.device_fp, /^\d{10}$/);
  assert.match(body.seed_id, /^[a-f0-9]{16}$/);
  assert.equal(body.seed_time, '1700000000000');
  assert.match(body.device_id, /^[a-f0-9]{32}$/);
  assert.equal(body.device_id, requests[1].init.headers['x-rpc-device_id']);
  assert.equal(requests[1].init.headers['x-rpc-device_fp'], FP_A);
  assert.ok(requests[1].init.headers.Cookie.includes('synthetic-test-token'));
  const fields = JSON.parse(body.ext_fields);
  assert.equal(Object.keys(fields).length, 28);
  assert.equal(fields.userAgent, `Node.js/${process.versions.node}`);
  assert.equal(fields.browserTimeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.ok(Object.entries(fields).every(([key, value]) => ['userAgent', 'browserTimeZone'].includes(key) || value === 'unknown'));
  for (const field of ['model', 'IDFV', 'accelerometer', 'gyroscope', 'magnetometer']) assert.ok(!Object.hasOwn(fields, field));
  for (const secret of [COOKIE, 'synthetic-test-token', CN.uid]) assert.ok(!requests[0].init.body.includes(secret));
  assert.ok(!JSON.stringify(result).includes(FP_A));
  assert.ok(!JSON.stringify(result).includes('synthetic-test-token'));
  assert.ok(!Object.hasOwn(result.data, 'device_id'));
  assert.ok(!JSON.stringify(client).includes(FP_A));
});

test('FPs are scoped to deterministic UID devices and expire in memory without persistence', async t => {
  let current = 1700000000000;
  const { store, root } = storeFor(t);
  store.bind(OWNER, { ...CN, privateChat: true });
  const before = fs.readFileSync(store.file, 'utf8');
  const { client, requests } = mockClient([fpResponse(FP_A), { retcode: 0, data: {} }, { retcode: 0, data: {} }, fpResponse(FP_B), { retcode: 0, data: {} }, fpResponse('38d7eeaaaa003'), { retcode: 0, data: {} }], { deviceFp: undefined, now: () => current, fingerprintTtlMs: 1000 });
  assert.equal((await client.query('index', store.get(OWNER))).ok, true);
  assert.equal((await client.query('abyss', CN)).ok, true);
  assert.equal((await client.query('index', { ...CN, uid: '100000002' })).ok, true);
  current += 1001;
  assert.equal((await client.query('dailyNote', CN)).ok, true);
  const fpRequests = requests.filter(({ url }) => url.href === FP_ENDPOINT);
  assert.equal(fpRequests.length, 3);
  const devices = fpRequests.map(({ init }) => JSON.parse(init.body).device_id);
  assert.notEqual(devices[0], devices[1]);
  assert.equal(devices[0], devices[2]);
  assert.equal(requests[2].init.headers['x-rpc-device_fp'], FP_A);
  assert.equal(requests[4].init.headers['x-rpc-device_fp'], FP_B);
  assert.equal(requests[6].init.headers['x-rpc-device_fp'], '38d7eeaaaa003');
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')).sort(), [path.basename(store.file)]);
});

test('overlapping queries share only the same UID FP request and preserve their own account headers', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const requests = [];
  let fpCalls = 0;
  const other = { ...CN, uid: '100000002', cookie: 'ltuid=654321; ltoken=other-synthetic-token;' };
  const devices = new Map();
  const client = new HoyolabClient({ fetch: async (url, init) => {
    requests.push({ url: new URL(url), init });
    if (url === FP_ENDPOINT) {
      const number = ++fpCalls;
      const device = JSON.parse(init.body).device_id;
      const fp = number === 1 ? FP_A : FP_B;
      devices.set(device, fp);
      await gate;
      return jsonResponse(url, fpResponse(fp));
    }
    assert.equal(init.headers['x-rpc-device_fp'], devices.get(init.headers['x-rpc-device_id']));
    const uid = new URL(url).searchParams.get('role_id');
    assert.equal(init.headers.Cookie, normalizeCookie(uid === CN.uid ? COOKIE : other.cookie));
    return jsonResponse(url, { retcode: 0, data: { uid } });
  } });
  const operations = [client.query('dailyNote', CN), client.query('index', CN), client.query('index', other)];
  assert.equal(fpCalls, 2);
  assert.equal(requests.length, 2);
  finish();
  const results = await Promise.all(operations);
  assert.ok(results.every(result => result.ok));
  assert.equal(requests.length, 5);
});

test('nested FP failure codes and bootstrap echoes never authorize a personal record request', async () => {
  for (const code of [403, undefined, '200']) {
    const { client, requests } = mockClient([{ retcode: 0, data: { code, device_fp: FP_A, cookie: COOKIE, message: COOKIE } }], { deviceFp: undefined });
    const result = await client.query('index', CN);
    assert.equal(result.code, 'fingerprint_unavailable');
    assert.equal(requests.length, 1);
    assert.ok(!JSON.stringify(result).includes('synthetic'));
  }
  const client = new HoyolabClient({ fetch: async (url, init) => jsonResponse(url, fpResponse(JSON.parse(init.body).device_fp)) });
  assert.equal((await client.query('dailyNote', CN)).code, 'fingerprint_unavailable');
  for (const fingerprint of ['', null, 'x', 'fp\r\nCookie: leaked', 'a'.repeat(129)]) {
    const { client: invalid, requests } = mockClient([fpResponse(fingerprint)], { deviceFp: undefined });
    assert.equal((await invalid.query('index', CN)).code, 'fingerprint_unavailable');
    assert.equal(requests.length, 1);
  }
});

test('FP failures cool down repeated commands then permit another explicit attempt', async () => {
  let current = 1700000000000;
  const { client, requests } = mockClient([{ retcode: 0, data: { code: 403, device_fp: FP_A } }, fpResponse(FP_B), { retcode: 0, data: {} }], { deviceFp: undefined, now: () => current, fingerprintFailureTtlMs: 1000 });
  assert.equal((await client.query('dailyNote', CN)).code, 'fingerprint_unavailable');
  assert.equal((await client.query('index', CN)).code, 'fingerprint_unavailable');
  assert.equal(requests.length, 1);
  current += 1001;
  assert.equal((await client.query('index', CN)).ok, true);
  assert.equal(requests.length, 3);
});

test('international requests and CN login/ledger/calculator/sign operations do not call the CN FP endpoint', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: {} }, { retcode: 0, data: { list: [] } }, { retcode: 0, data: {} }, { retcode: 0, data: {} }, { retcode: 0, data: { is_sign: true } }], { deviceFp: undefined });
  assert.equal((await client.query('dailyNote', OS)).ok, true);
  assert.equal((await client.roles(COOKIE)).ok, true);
  assert.equal((await client.query('ledger', CN, { month: 9 })).ok, true);
  assert.equal((await client.query('detail', CN, { avatar_id: 10000002 })).ok, true);
  assert.equal((await client.sign(CN)).status, 'already');
  assert.equal(requests.length, 5);
  assert.ok(requests.every(({ url, init }) => url.href !== FP_ENDPOINT && !Object.hasOwn(init.headers, 'x-rpc-device_fp')));
});

test('FP HTTP errors, unsafe redirects, malformed and oversized responses stay safe and fixed-domain', async () => {
  const cases = [
    [() => ({ ok: false, status: 429 }), 'rate_limited'],
    [() => ({ ok: false, status: 502 }), 'http_error'],
    [() => ({ ok: true, redirected: true }), 'http_error'],
    [() => jsonResponse('https://evil.example/device-fp/api/getFp', fpResponse(FP_A)), 'redirect_rejected'],
    [() => ({ ok: true, text: async () => COOKIE }), 'network_error'],
    [() => ({ ok: true, text: async () => 'x'.repeat(65537) }), 'invalid_response'],
    [() => jsonResponse(FP_ENDPOINT, {}), 'invalid_response'],
    [() => { throw new Error(COOKIE); }, 'network_error']
  ];
  for (const [response, code] of cases) {
    let calls = 0;
    const client = new HoyolabClient({ fetch: async (url, init) => {
      ++calls;
      assert.equal(url, FP_ENDPOINT);
      assert.ok(!Object.hasOwn(init.headers, 'Cookie'));
      return response();
    } });
    const result = await client.query('index', CN);
    assert.equal(result.code, code);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes('synthetic'));
  }
});

test('FP challenges stop before game requests and do not trigger external verification or retries', async () => {
  const { client, requests } = mockClient([{ retcode: 0, data: { code: 200, device_fp: FP_A, gt_result: { risk_code: 375, gt: 'test-challenge' }, cookie: COOKIE } }], { deviceFp: undefined });
  const result = await client.query('index', CN);
  assert.equal(result.code, 'verification_required');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.href, FP_ENDPOINT);
  assert.ok(!JSON.stringify(result).includes('test-challenge'));
  assert.ok(!JSON.stringify(result).includes('synthetic'));
});

test('FP acquisition and body parsing have deadlines even for a fetch ignoring abort', async () => {
  for (const hangOnBody of [false, true]) {
    let signal;
    let calls = 0;
    const client = new HoyolabClient({ timeoutMs: 10, fetch: async (url, init) => {
      ++calls; signal = init.signal;
      assert.equal(url, FP_ENDPOINT);
      if (hangOnBody) return { ok: true, text: () => new Promise(() => {}) };
      return new Promise(() => {});
    } });
    const result = await client.query('index', CN);
    assert.equal(result.code, 'timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
  }
});

test('one query deadline includes FP preflight plus the personal record request', async () => {
  let recordSignal;
  const client = new HoyolabClient({ timeoutMs: 40, fetch: async (url, init) => {
    if (url === FP_ENDPOINT) {
      await new Promise(resolve => setTimeout(resolve, 20));
      return jsonResponse(url, fpResponse(FP_A));
    }
    recordSignal = init.signal;
    return new Promise(() => {});
  } });
  const result = await client.query('dailyNote', CN);
  assert.equal(result.code, 'timeout');
  assert.equal(recordSignal.aborted, true);
});

test('a game 5003 response invalidates issued FP without an automatic security-check retry', async () => {
  let current = 1700000000000;
  const { client, requests } = mockClient([fpResponse(FP_A), { retcode: 5003, message: COOKIE, data: {} }, fpResponse(FP_B), { retcode: 0, data: {} }], { deviceFp: undefined, now: () => current, fingerprintFailureTtlMs: 1000 });
  assert.equal((await client.query('index', CN)).code, 'verification_required');
  assert.equal(requests.length, 2);
  assert.equal((await client.query('dailyNote', CN)).code, 'verification_required');
  assert.equal(requests.length, 2);
  current += 1001;
  assert.equal((await client.query('index', CN)).ok, true);
  assert.equal(requests.length, 4);
  assert.equal(requests[3].init.headers['x-rpc-device_fp'], FP_B);
});
