import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MysQrLogin } from '../lib/mys-qr.mjs';
import { AccountsStore } from '../lib/accounts.mjs';

const OWNER = '100000001', OTHER = '100000002', UID = '100000001', BUID = '500000001';
const PRIVATE = { privateChat: true }, PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const CREATE = 'https://passport-api.miyoushe.com/account/ma-cn-passport/web/createQRLogin';
const QUERY = 'https://passport-api.miyoushe.com/account/ma-cn-passport/web/queryQRLoginStatus';
const cookies = { cookie_token_v2: 'v2_cookie_synthetic_ABC123', account_mid_v2: 'synthetic-mid', account_id_v2: '12345',
  ltoken_v2: 'v2_ltoken_synthetic_ABC456', ltmid_v2: 'synthetic-mid', ltuid_v2: '12345' };
const role = (uid = UID) => ({ uid, region: 'cn', server: uid[0] === '5' ? 'cn_qd01' : 'cn_gf01', nickname: '旅行者', level: 60 });
const reply = (data, extra = {}) => new Response(JSON.stringify({ retcode: 0, message: 'OK', data }), extra);
function create(ticket = 'synthetic-ticket') { return reply({ ticket, url: 'https://user.mihoyo.com/login-platform/mobile.html?ticket=' + ticket }); }
function confirmed(changes = {}, omitted = [], data = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const [key, value] of Object.entries({ ...cookies, ...changes })) {
    if (!omitted.includes(key)) headers.append('Set-Cookie', key + '=' + value + '; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/; Secure; HttpOnly');
  }
  headers.append('Set-Cookie', 'stoken=never-save-this-stoken; Path=/;');
  headers.append('Set-Cookie', 'aliyungf_tc=tracking-data; Path=/;');
  return reply({ status: 'Confirmed', user_info: { aid: '12345', mid: 'synthetic-mid' }, need_realperson: false, ...data }, { headers });
}
async function workspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teyvat-mysqr-'));
  const accounts = new AccountsStore(root, { key: Buffer.alloc(32, 41) });
  try { return await fn(root, accounts); }
  finally {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('teyvat-mysqr-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
function harness(root, accounts, queue, extra = {}) {
  let now = 1791331200000;
  const calls = [], roleCalls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift();
    if (typeof next === 'function') return next(url, options);
    if (!next) throw new Error('Unexpected fixture request');
    return next;
  };
  const mys = { roles: async (cookie, region) => { roleCalls.push({ cookie, region }); return { ok: true, data: [role()] }; } };
  const qr = new MysQrLogin(root, { accounts, mys, fetch, now: () => now, encodeQr: async () => PNG, pollMs: 0, ...extra });
  return { qr, calls, roleCalls, advance: delta => { now += delta; } };
}
test('private-only start, poll and cancel refuse group credentials before any upstream request', () => workspace(async (root, accounts) => {
  const h = harness(root, accounts, []);
  assert.equal((await h.qr.start(OWNER)).code, 'private_only');
  assert.equal((await h.qr.start(OWNER, { privateChat: false })).code, 'private_only');
  assert.equal((await h.qr.poll(OWNER, 'unknown', { privateChat: false })).code, 'private_only');
  assert.equal(h.qr.cancel(OWNER, 'unknown').code, 'private_only');
  assert.equal(h.calls.length, 0);
}));
test('CN-only UID, owner, password and bad labels are rejected before QR creation', () => workspace(async (root, accounts) => {
  const h = harness(root, accounts, []);
  for (const [owner, options] of [['../bad', PRIVATE], [OWNER, { ...PRIVATE, uid: '600000001' }],
    [OWNER, { ...PRIVATE, region: 'os' }], [OWNER, { ...PRIVATE, password: 'not-accepted' }],
    [OWNER, { ...PRIVATE, label: 'cookie_token=synthetic' }]]) assert.equal((await h.qr.start(owner, options)).ok, false);
  assert.equal(h.calls.length, 0);
}));
test('start and Created/Scanned polls use exactly the verified web endpoints, same web device and ticket', () => workspace(async (root, accounts) => {
  const h = harness(root, accounts, [create(), reply({ status: 'Created' }), reply({ status: 'Scanned' })]);
  const start = await h.qr.start(OWNER, PRIVATE);
  assert.equal(start.ok, true); assert.equal(start.status, 'Created'); assert.ok(Buffer.isBuffer(start.qrPng));
  assert.match(start.qrUrl, /^https:\/\/user\.mihoyo\.com\/login-platform\/mobile.html/);
  assert.equal((await h.qr.poll(OWNER, start.sessionId, PRIVATE)).status, 'Created');
  assert.equal((await h.qr.poll(OWNER, start.sessionId, PRIVATE)).status, 'Scanned');
  assert.deepEqual(h.calls.map(x => x.url), [CREATE, QUERY, QUERY]);
  assert.equal(h.calls[0].options.body, undefined);
  assert.deepEqual(JSON.parse(h.calls[1].options.body), { ticket: 'synthetic-ticket' });
  for (const call of h.calls) {
    assert.equal(call.options.redirect, 'error'); assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers['x-rpc-app_id'], 'bll8iq97cem8');
    assert.equal(call.options.headers['x-rpc-client_type'], '4');
    assert.equal(call.options.headers['x-rpc-game_biz'], 'bbs_cn');
    assert.equal(call.options.headers['x-rpc-device_id'], h.calls[0].options.headers['x-rpc-device_id']);
    assert.equal(call.options.headers['x-rpc-device_fp'], undefined);
    assert.equal(call.options.headers.Cookie, undefined);
  }
  assert.equal(accounts.list(OWNER).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')), []);
}));
test('confirmed v2 Set-Cookie is verified with roles then saved solely in encrypted accounts and backups', () => workspace(async (root, accounts) => {
  const h = harness(root, accounts, [create(), confirmed()]);
  const start = await h.qr.start(OWNER, PRIVATE);
  const result = await h.qr.poll(OWNER, start.sessionId, PRIVATE);
  assert.equal(result.ok, true); assert.equal(result.status, 'Confirmed'); assert.equal(result.selectedUid, UID);
  assert.equal(result.accounts[0].hasCookie, true); assert.equal(result.accounts[0].selected, true);
  assert.equal(h.roleCalls.length, 1); assert.equal(h.roleCalls[0].region, 'cn');
  for (const value of [result, result.roles, result.accounts, JSON.parse(JSON.stringify(h.qr))]) {
    const text = JSON.stringify(value);
    for (const secret of Object.values(cookies)) assert.equal(text.includes(secret), false);
    assert.equal(text.includes('synthetic-ticket'), false);
  }
  const stored = accounts.get(OWNER, UID).cookie;
  assert.match(stored, /ltoken_v2=/); assert.match(stored, /cookie_token_v2=/);
  assert.equal(stored.includes('stoken='), false); assert.equal(stored.includes('tracking-data'), false);
  assert.equal(accounts.list(OTHER).length, 0);
  const files = fs.readdirSync(path.join(root, 'data'));
  assert.deepEqual(files.sort(), ['accounts.enc.json', 'accounts.enc.json.bak']);
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, 'data', file), 'utf8');
    for (const secret of [...Object.values(cookies), OWNER, 'synthetic-ticket', 'never-save-this-stoken']) assert.equal(text.includes(secret), false);
    assert.equal(JSON.parse(text).algorithm, 'aes-256-gcm');
  }
  assert.equal((await h.qr.poll(OWNER, start.sessionId, PRIVATE)).status, 'Confirmed');
  assert.equal(h.qr.cancel(OWNER, start.sessionId, PRIVATE).status, 'Confirmed');
  assert.equal(h.calls.length, 2); assert.equal(h.roleCalls.length, 1);
}));
test('roles from only the scanned CN account are bound and foreign/invalid roles are excluded', () => workspace(async (root, accounts) => {
  const mys = { roles: async () => ({ ok: true, data: [role(), role(BUID), { uid: '600000001', region: 'os', server: 'os_usa' }, { uid: 'bad' }] }) };
  const h = harness(root, accounts, [create(), confirmed()], { mys });
  const start = await h.qr.start(OWNER, PRIVATE), done = await h.qr.poll(OWNER, start.sessionId, PRIVATE);
  assert.equal(done.ok, true); assert.deepEqual(done.accounts.map(x => x.uid), [UID, BUID]);
  assert.deepEqual(accounts.list(OWNER).map(x => x.uid), [UID, BUID]);
  assert.equal(accounts.get(OWNER, '600000001'), null);
}));
test('an explicit expected UID selects only that owned role and never binds a mismatched account', () => workspace(async (root, accounts) => {
  const mys = { roles: async () => ({ ok: true, data: [role(), role(BUID)] }) };
  const h = harness(root, accounts, [create(), confirmed()], { mys });
  const start = await h.qr.start(OWNER, { ...PRIVATE, uid: BUID, label: '哔服角色' });
  const done = await h.qr.poll(OWNER, start.sessionId, PRIVATE);
  assert.equal(done.selectedUid, BUID); assert.deepEqual(accounts.list(OWNER).map(x => x.uid), [BUID]);
  assert.equal(accounts.get(OWNER, BUID).label, '哔服角色');
  const wrong = harness(root, accounts, [create('second-ticket'), confirmed()], { mys: { roles: async () => ({ ok: true, data: [role()] }) } });
  const before = fs.readFileSync(accounts.file, 'utf8'), attempt = await wrong.qr.start(OWNER, { ...PRIVATE, uid: BUID });
  assert.equal((await wrong.qr.poll(OWNER, attempt.sessionId, PRIVATE)).code, 'wrong_account');
  assert.equal(fs.readFileSync(accounts.file, 'utf8'), before);
}));
test('empty or foreign-only role lists do not produce false login success', () => workspace(async (root, accounts) => {
  for (const data of [[], [{ uid: '600000001', region: 'os', server: 'os_usa' }]]) {
    const h = harness(root, accounts, [create(), confirmed()], { mys: { roles: async () => ({ ok: true, data }) } });
    const start = await h.qr.start(OWNER, PRIVATE);
    assert.equal((await h.qr.poll(OWNER, start.sessionId, PRIVATE)).code, 'no_genshin_roles');
    assert.equal(accounts.list(OWNER).length, 0);
  }
}));
test('roles temporarily unavailable retry from the private cookie without re-querying the confirmed ticket', () => workspace(async (root, accounts) => {
  let attempts = 0;
  const mys = { roles: async () => ++attempts === 1 ? { ok: false, message: 'do-not-echo raw credential', code: 'network_error' } : { ok: true, data: [role()] } };
  const h = harness(root, accounts, [create(), confirmed()], { mys });
  const start = await h.qr.start(OWNER, PRIVATE);
  const first = await h.qr.poll(OWNER, start.sessionId, PRIVATE);
  assert.equal(first.code, 'roles_check_failed'); assert.equal(accounts.list(OWNER).length, 0);
  assert.equal(JSON.stringify(first).includes('do-not-echo'), false);
  assert.equal((await h.qr.poll(OWNER, start.sessionId, PRIVATE)).status, 'Confirmed');
  assert.equal(h.calls.length, 2); assert.equal(attempts, 2);
}));
test('partial or conflicting Set-Cookie and unverified JSON token shapes fail without a token exchange guess', () => workspace(async (root, accounts) => {
  for (const fixture of [confirmed({}, ['ltoken_v2']), confirmed({ ltuid_v2: '99999' }),
    confirmed({ ltmid_v2: 'other-mid' }), confirmed({}, [], { user_info: { aid: '99999' } }),
    reply({ status: 'Confirmed', tokens: [{ token_type: 2, token: 'not-used-json-token' }], user_info: { aid: '12345' } })]) {
    const h = harness(root, accounts, [create(), fixture]);
    const start = await h.qr.start(OWNER, PRIVATE), done = await h.qr.poll(OWNER, start.sessionId, PRIVATE);
    assert.equal(done.ok, false); assert.equal(accounts.list(OWNER).length, 0);
    assert.equal(h.roleCalls.length, 0); assert.equal(h.calls.length, 2);
    assert.equal(JSON.stringify(done).includes('not-used-json-token'), false);
  }
}));
test('verification challenges stop immediately, even with retcode zero or full cookies', () => workspace(async (root, accounts) => {
  for (const fixture of [confirmed({}, [], { need_realperson: true }),
    new Response(JSON.stringify({ retcode: -3101, message: 'secret', data: {} })),
    confirmed({}, [], { challenge: 'secret-geetest-challenge' }),
    reply({ status: 'Confirmed' }, { headers: { 'x-rpc-aigis': 'secret-aigis' } })]) {
    const h = harness(root, accounts, [create(), fixture]);
    const start = await h.qr.start(OWNER, PRIVATE), done = await h.qr.poll(OWNER, start.sessionId, PRIVATE);
    assert.equal(done.code, 'verification_required'); assert.equal(h.roleCalls.length, 0);
    assert.equal(JSON.stringify(done).includes('secret'), false); assert.equal(accounts.list(OWNER).length, 0);
  }
}));
test('cross-QQ session polling/cancellation cannot access or cancel another owner login', () => workspace(async (root, accounts) => {
  const h = harness(root, accounts, [create(), reply({ status: 'Created' })]), start = await h.qr.start(OWNER, PRIVATE);
  assert.equal((await h.qr.poll(OTHER, start.sessionId, PRIVATE)).code, 'session_missing');
  assert.equal(h.qr.cancel(OTHER, start.sessionId, PRIVATE).code, 'session_missing');
  assert.equal((await h.qr.poll(OWNER, start.sessionId, PRIVATE)).status, 'Created');
  assert.equal(h.calls.length, 2);
}));
test('expiry and cancellation stop further upstream calls and restarting cannot recover an old challenge', () => workspace(async (root, accounts) => {
  const h = harness(root, accounts, [create()]), start = await h.qr.start(OWNER, PRIVATE);
  h.advance(180001);
  assert.equal((await h.qr.poll(OWNER, start.sessionId, PRIVATE)).code, 'expired');
  assert.equal(h.calls.length, 1);
  const restart = harness(root, accounts, []);
  assert.equal((await restart.qr.poll(OWNER, start.sessionId, PRIVATE)).code, 'session_missing');
  const second = harness(root, accounts, [create('new-ticket')]), next = await second.qr.start(OWNER, PRIVATE);
  assert.equal(second.qr.cancel(OWNER, next.sessionId, PRIVATE).status, 'Cancelled');
  assert.equal((await second.qr.poll(OWNER, next.sessionId, PRIVATE)).status, 'Cancelled');
  assert.equal(second.calls.length, 1);
}));
test('the default polling interval coalesces early status requests and concurrent polls share one request', () => workspace(async (root, accounts) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness(root, accounts, [create(), () => pending, confirmed()], { pollMs: 2000 });
  const start = await h.qr.start(OWNER, PRIVATE);
  const a = h.qr.poll(OWNER, start.sessionId, PRIVATE), b = h.qr.poll(OWNER, start.sessionId, PRIVATE);
  release(reply({ status: 'Created' }));
  assert.deepEqual(await a, await b); assert.equal(h.calls.length, 2);
  assert.equal((await h.qr.poll(OWNER, start.sessionId, PRIVATE)).retryAfterMs, 2000);
  assert.equal(h.calls.length, 2);
  h.advance(2001);
  assert.equal((await h.qr.poll(OWNER, start.sessionId, PRIVATE)).status, 'Confirmed');
}));
test('replacing a QR or cancelling during role verification prevents late login persistence', () => workspace(async (root, accounts) => {
  let release, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const mys = { roles: async () => { enter(); return new Promise(resolve => { release = resolve; }); } };
  const h = harness(root, accounts, [create('old-ticket'), confirmed(), create('new-ticket')], { mys });
  const old = await h.qr.start(OWNER, PRIVATE), poll = h.qr.poll(OWNER, old.sessionId, PRIVATE);
  await entered;
  const next = await h.qr.start(OWNER, PRIVATE); assert.equal(next.ok, true);
  release({ ok: true, data: [role()] });
  assert.equal((await poll).ok, false); assert.equal(accounts.list(OWNER).length, 0);
  assert.equal((await h.qr.poll(OWNER, old.sessionId, PRIVATE)).code, 'session_missing');
  h.qr.cancel(OWNER, next.sessionId, PRIVATE);
}));
test('concurrent starts remain locked after a second busy call and issue only one QR request', () => workspace(async (root, accounts) => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const h = harness(root, accounts, [() => pending]);
  const first = h.qr.start(OWNER, PRIVATE);
  assert.equal((await h.qr.start(OWNER, PRIVATE)).code, 'busy');
  assert.equal((await h.qr.start(OWNER, PRIVATE)).code, 'busy');
  assert.equal(h.calls.length, 1);
  release(create());
  assert.equal((await first).ok, true);
}));
test('unsafe upstream QR URLs, unknown states, malformed responses and exception text never leak credentials', () => workspace(async (root, accounts) => {
  for (const fixture of [reply({ ticket: 'a', url: 'https://evil.example/login-platform/mobile.html' }),
    reply({ ticket: 'a', url: 'https://user.mihoyo.com/qr_code_in_game.html' }),
    new Response('<html>secret-token</html>'),
    () => { throw new Error('cookie_token_v2=' + cookies.cookie_token_v2); }]) {
    const h = harness(root, accounts, [fixture]), result = await h.qr.start(OWNER, PRIVATE);
    assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes(cookies.cookie_token_v2), false);
    assert.equal(JSON.stringify(result).includes('secret-token'), false);
  }
  const h = harness(root, accounts, [create(), reply({ status: 'unexpected', tokens: 'secret-token' })]);
  const start = await h.qr.start(OWNER, PRIVATE);
  assert.equal((await h.qr.poll(OWNER, start.sessionId, PRIVATE)).code, 'unsupported_response');
}));
test('redirects, HTTP rate limits and oversized responses fail without saving login', () => workspace(async (root, accounts) => {
  for (const fixture of [new Response('', { status: 302, headers: { Location: 'https://evil.example/' } }),
    new Response('', { status: 429 }), new Response('', { status: 503 }),
    new Response('x'.repeat(1024 * 1024 + 1))]) {
    const h = harness(root, accounts, [fixture]), result = await h.qr.start(OWNER, PRIVATE);
    assert.equal(result.ok, false); assert.equal(accounts.list(OWNER).length, 0);
  }
}));
test('rendering failure does not report a created QR and the renderer never persists challenge files', () => workspace(async (root, accounts) => {
  for (const encodeQr of [async () => { throw new Error('synthetic-ticket'); }, async () => Buffer.from('not a PNG')]) {
    const h = harness(root, accounts, [create()], { encodeQr });
    const result = await h.qr.start(OWNER, PRIVATE);
    assert.equal(result.code, 'qr_renderer_unavailable'); assert.equal(JSON.stringify(result).includes('synthetic-ticket'), false);
    assert.deepEqual(fs.readdirSync(path.join(root, 'data')), []);
  }
}));
test('unreadable encryption store prevents QR creation, and full account capacity prevents partial binding', () => workspace(async (root, accounts) => {
  accounts.bind(OWNER, { uid: UID });
  const wrong = new AccountsStore(root, { key: Buffer.alloc(32, 42) });
  const h = harness(root, wrong, []);
  assert.equal((await h.qr.start(OWNER, PRIVATE)).code, 'decrypt_failed'); assert.equal(h.calls.length, 0);
  const limited = new AccountsStore(root, { key: Buffer.alloc(32, 41), maxAccounts: 1 });
  const next = harness(root, limited, [create(), confirmed()], { mys: { roles: async () => ({ ok: true, data: [role(), role(BUID)] }) } });
  const start = await next.qr.start(OWNER, PRIVATE);
  assert.equal((await next.qr.poll(OWNER, start.sessionId, PRIVATE)).code, 'account_limit');
  assert.equal(limited.get(OWNER, UID).hasCookie, false);
  assert.equal(limited.get(OWNER, BUID), null);
}));
test('fetch that ignores abort still times out and an abandoned late response cannot save an account', () => workspace(async (root, accounts) => {
  const h = harness(root, accounts, [() => new Promise(() => {})], { timeoutMs: 1000 });
  const result = await h.qr.start(OWNER, PRIVATE);
  assert.equal(result.code, 'timeout'); assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(accounts.list(OWNER).length, 0);
}));
test('unresponsive injected role validation also has a deadline and saves no false success', () => workspace(async (root, accounts) => {
  const h = harness(root, accounts, [create(), confirmed()], { timeoutMs: 1000, mys: { roles: () => new Promise(() => {}) } });
  const start = await h.qr.start(OWNER, PRIVATE);
  assert.equal((await h.qr.poll(OWNER, start.sessionId, PRIVATE)).code, 'timeout');
  assert.equal(accounts.list(OWNER).length, 0);
  h.qr.stop();
}));
test('wait preserves confirmed success even if delivery fails; an aborted wait cancels safely', () => workspace(async (root, accounts) => {
  const h = harness(root, accounts, [create(), confirmed()]), start = await h.qr.start(OWNER, PRIVATE);
  const done = await h.qr.wait(OWNER, start.sessionId, { ...PRIVATE, onStatus: async () => { throw new Error('delivery unavailable'); } });
  assert.equal(done.status, 'Confirmed'); assert.equal(done.ok, true); assert.equal(done.notificationFailed, true);
  assert.equal(accounts.get(OWNER, UID).hasCookie, true);
  const second = harness(root, accounts, [create()]), next = await second.qr.start(OWNER, PRIVATE);
  const controller = new AbortController(); controller.abort();
  assert.equal((await second.qr.wait(OWNER, next.sessionId, { ...PRIVATE, signal: controller.signal })).status, 'Cancelled');
  assert.equal(second.calls.length, 1);
}));
