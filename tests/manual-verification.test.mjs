import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { ManualVerification, manualVerificationSource } from '../lib/manual-verification.mjs';

const OWNER = '987654321', OTHER = '987654322', UID = '112233445';
const PRIVATE = { privateChat: true };
const COOKIE = 'ltuid=11111; ltoken=synthetic-private-token-ABC123;';
const ACCOUNT = Object.freeze({ uid: UID, region: 'cn', server: 'cn_gf01', cookie: COOKIE, label: 'private-account-label' });
const GT = '0123456789abcdef0123456789abcdef';
const BASE = 'abcdef0123456789abcdef0123456789';
const CHALLENGE = BASE + '01';
const DEVICE = { deviceId: 'synthetic-web-device-private', fingerprint: 'synthetic-private-fingerprint' };
const VALIDATE = 'synthetic-human-validation-proof';
const PROOF = { geetest_challenge: BASE + 'xy', geetest_validate: VALIDATE, geetest_seccode: VALIDATE + '|jordan' };
const response = () => ({ ok: true, data: { gt: GT, challenge: CHALLENGE, new_captcha: true }, device: { ...DEVICE } });
const encode = data => Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8').toString('base64url');
const arg = (start, proof = PROOF) => start.nonce + ' ' + encode(proof);
function harness(options = {}) {
  let time = 1700000000000;
  const creates = [], submits = [];
  const mys = {
    async createVerification(account) { creates.push(account); return options.create ? options.create(account) : response(); },
    async submitVerification(account, proof, device) { submits.push({ account, proof, device }); return options.submit ? options.submit(account, proof, device) : { ok: true }; }
  };
  const manual = new ManualVerification({ mys, now: () => time, prefix: options.prefix ?? '#原神' });
  return { manual, creates, submits, advance(delta) { time += delta; }, setTime(value) { time = value; } };
}
function config(start) {
  const match = /<script id="verification-config" type="application\/json">([\s\S]*?)<\/script>/.exec(start.file.data);
  assert.ok(match); return JSON.parse(match[1]);
}
function browser(start, value = PROOF) {
  const nodes = Object.fromEntries(['verification-config', 'status', 'receipt', 'copy'].map(id => [id, { textContent: '', value: '', disabled: id === 'copy', events: {},
    addEventListener(name, handler) { this.events[name] = handler; }, focus() { this.focused = true; }, select() { this.selected = true; } }]));
  nodes['verification-config'].textContent = JSON.stringify(config(start));
  const callbacks = {}, clipboard = [], timers = [];
  const widget = { appendTo(selector) { this.selector = selector; }, onReady(fn) { callbacks.ready = fn; }, onError(fn) { callbacks.error = fn; },
    onSuccess(fn) { callbacks.success = fn; }, getValidate() { return value; }, destroy() { this.destroyed = true; } };
  let initialized;
  const context = vm.createContext({ document: { getElementById(id) { return nodes[id]; } },
    navigator: { clipboard: { async writeText(text) { clipboard.push(text); } } },
    setTimeout(fn, delay) { timers.push({ fn, delay }); },
    btoa(text) { return Buffer.from(text, 'binary').toString('base64'); },
    initGeetest(options, callback) { initialized = options; callback(widget); } });
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(start.file.data);
  assert.ok(script); new vm.Script(script[1]).runInContext(context);
  return { nodes, callbacks, widget, clipboard, timers, get initialized() { return initialized; } };
}

test('group and omitted-private start/finish are rejected before requests or session changes', async () => {
  const h = harness();
  for (const options of [undefined, {}, { privateChat: false }, { privateChat: 'true' }]) {
    assert.equal((await h.manual.start(OWNER, ACCOUNT, options)).code, 'private_only');
    assert.equal((await h.manual.finish(OWNER, 'invalid', ACCOUNT, options)).code, 'private_only');
  }
  assert.equal(h.creates.length, 0); assert.equal(h.submits.length, 0);
  const start = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  assert.equal((await h.manual.finish(OWNER, arg(start), ACCOUNT, { privateChat: false })).code, 'private_only');
  assert.equal((await h.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE)).ok, true);
});
test('owner/account/region validation refuses anonymous, foreign and malformed accounts before creating', async () => {
  const h = harness();
  for (const [owner, account] of [['bad', ACCOUNT], [{ toString: () => OWNER }, ACCOUNT], [OWNER, null], [OWNER, { uid: UID }],
    [OWNER, { ...ACCOUNT, cookie: 'stoken=synthetic-only;' }], [OWNER, { ...ACCOUNT, uid: '600000001', region: 'os', server: 'os_usa' }],
    [OWNER, { ...ACCOUNT, region: 'os' }], [OWNER, { ...ACCOUNT, game_biz: 'hkrpg_cn' }]]) assert.equal((await h.manual.start(owner, account, PRIVATE)).ok, false);
  assert.equal(h.creates.length, 0);
});
test('start returns only an in-memory HTML file, bound nonce/TTL, and no account/device credentials', async () => {
  const h = harness(), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  assert.equal(start.ok, true); assert.equal(start.file.name, 'Miyoushe-Verification.html'); assert.equal(typeof start.file.data, 'string');
  assert.match(start.nonce, /^[a-z\d_-]{32}$/i); assert.equal(start.expiresAt, 1700000300000);
  for (const hidden of [OWNER, UID, COOKIE, 'synthetic-private-token-ABC123', ACCOUNT.label, DEVICE.deviceId, DEVICE.fingerprint]) {
    assert.equal(start.file.data.includes(hidden), false); assert.equal(JSON.stringify(start).includes(hidden), false);
  }
  assert.equal(JSON.stringify(h.manual), '{}'); assert.deepEqual(Object.keys(config(start)).sort(), ['challenge', 'gt', 'new_captcha', 'nonce', 'prefix', 'remainingMs'].sort());
  assert.match(start.text, /系统浏览器/); assert.match(start.file.data, /仅供本人手动操作/); assert.match(start.file.data, /同一 QQ/);
  assert.deepEqual(h.creates[0], { uid: UID, region: 'cn', server: 'cn_gf01', cookie: 'ltuid=11111; ltoken=synthetic-private-token-ABC123;' });
});
test('strict upstream challenge schema rejects gt/script injection, malformed lengths, nonboolean and extra fields', async () => {
  const cases = [
    { ...response().data, gt: '</script><script>alert(1)</script>' }, { ...response().data, gt: 'a'.repeat(31) },
    { ...response().data, challenge: '</script><img src=x onerror=alert(1)>' }, { ...response().data, challenge: 'b'.repeat(31) },
    { ...response().data, challenge: 'b'.repeat(65) }, { ...response().data, challenge: 'b'.repeat(32) + '_' },
    { ...response().data, new_captcha: 1 }, { ...response().data, new_captcha: 'true' },
    { gt: GT, challenge: CHALLENGE }, { ...response().data, cookie: COOKIE }
  ];
  for (const data of cases) {
    const h = harness({ create: () => ({ ok: true, data, device: DEVICE }) });
    const result = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
    assert.equal(result.code, 'invalid_response'); assert.equal(result.file, undefined); assert.equal(h.submits.length, 0);
    assert.equal(JSON.stringify(result).includes(COOKIE), false);
  }
  const good = harness({ create: () => ({ ...response(), data: { gt: GT.toUpperCase(), challenge: BASE, new_captcha: false } }) });
  assert.equal((await good.manual.start(OWNER, ACCOUNT, PRIVATE)).ok, true);
});
test('opaque device is validated, cloned and excluded from HTML; upstream object mutation cannot change submit device', async () => {
  for (const device of [null, [], {}, { ...DEVICE, cookie: COOKIE }, { ...DEVICE, deviceId: 'x\n' }, { ...DEVICE, fingerprint: 'x'.repeat(257) }]) {
    const h = harness({ create: () => ({ ...response(), device }) }); assert.equal((await h.manual.start(OWNER, ACCOUNT, PRIVATE)).code, 'invalid_response');
  }
  const upstream = response(), h = harness({ create: () => upstream });
  const start = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  upstream.device.deviceId = 'changed'; upstream.device.fingerprint = 'changed'; upstream.data.challenge = 'a'.repeat(32);
  assert.equal((await h.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE)).ok, true); assert.deepEqual(h.submits[0].device, DEVICE);
});
test('HTML embeds JSON safely even with a script-terminating configured prefix and only explicitly loads official gt.js', async () => {
  const prefix = '#原神</script><script>attack()</script>&\u2028';
  const h = harness({ prefix }), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  assert.equal(config(start).prefix, prefix); assert.equal(start.file.data.includes(prefix), false);
  assert.equal((start.file.data.match(/<script\b/g) || []).length, 3);
  assert.deepEqual([...start.file.data.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]), ['https://static.geetest.com/static/tools/gt.js']);
  assert.match(start.file.data, /\\u003c\/script\\u003e/); assert.match(start.file.data, /form-action 'none'/);
  const page = browser(start); page.callbacks.success();
  assert.equal(page.nodes.receipt.value.startsWith(prefix + '提交验证 '), true);
});
test('official SDK success produces exactly the human-copy command; no submission happens automatically', async () => {
  const h = harness(), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE), page = browser(start);
  assert.deepEqual({ ...page.initialized }, { gt: GT, challenge: CHALLENGE, new_captcha: true, offline: false, https: true, product: 'embed', width: '100%', lang: 'zh-cn' });
  assert.equal(page.widget.selector, '#captcha'); assert.equal(page.nodes.receipt.value, ''); assert.equal(page.clipboard.length, 0);
  page.callbacks.ready(); page.callbacks.success();
  assert.equal(page.nodes.receipt.value, '#原神提交验证 ' + arg(start)); assert.equal(page.nodes.copy.disabled, false);
  assert.equal(h.submits.length, 0); assert.equal(page.clipboard.length, 0);
  await page.nodes.copy.events.click(); assert.equal(page.clipboard[0], page.nodes.receipt.value);
  assert.equal((await h.manual.finish(OWNER, page.nodes.receipt.value, ACCOUNT, PRIVATE)).ok, true);
  assert.deepEqual(h.submits[0].proof, PROOF); assert.deepEqual(h.submits[0].device, DEVICE);
});
test('page local expiration clears receipt/disables copying and never generates a late proof', async () => {
  const h = harness(), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE), page = browser(start);
  assert.equal(page.timers.length, 1); assert.equal(page.timers[0].delay, 300000);
  page.callbacks.success(); page.timers[0].fn(); page.callbacks.success();
  assert.equal(page.nodes.receipt.value, ''); assert.equal(page.nodes.copy.disabled, true); assert.equal(page.widget.destroyed, true);
  await page.nodes.copy.events.click(); assert.equal(page.clipboard.length, 0); assert.equal(h.submits.length, 0);
});
test('malformed or mismatched page validation never emits a receipt', async () => {
  const h = harness(), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  for (const proof of [false, { ...PROOF, geetest_challenge: 'z'.repeat(32) }, { ...PROOF, geetest_validate: '<script>' }, { ...PROOF, geetest_seccode: VALIDATE + '|other' }]) {
    const page = browser(start, proof); page.callbacks.success(); assert.equal(page.nodes.receipt.value, ''); assert.equal(page.nodes.copy.disabled, true);
  }
});
test('wrong owner and nonce cannot borrow or cancel the original owner session', async () => {
  const h = harness(), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  assert.equal((await h.manual.finish(OTHER, arg(start), ACCOUNT, PRIVATE)).code, 'session_missing');
  assert.equal((await h.manual.finish(OWNER, 'A'.repeat(32) + ' ' + encode(PROOF), ACCOUNT, PRIVATE)).code, 'invalid_nonce');
  h.manual.cancel(OTHER);
  assert.equal(h.submits.length, 0); assert.equal((await h.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE)).ok, true);
});
test('selected UID/Cookie/region changes destroy the old binding and cannot be switched back', async () => {
  const changes = [{ ...ACCOUNT, uid: '223456789' }, { ...ACCOUNT, cookie: COOKIE.replace('ABC123', 'DIFFERENT') },
    { ...ACCOUNT, server: 'cn_qd01' }, { ...ACCOUNT, region: 'os' }, null];
  for (const account of changes) {
    const h = harness(), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
    assert.equal((await h.manual.finish(OWNER, arg(start), account, PRIVATE)).code, 'account_changed');
    assert.equal((await h.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE)).code, 'session_missing'); assert.equal(h.submits.length, 0);
  }
});
test('initial 34-character challenge is bound by its first 32 characters; unrelated proof cannot submit', async () => {
  const h = harness(), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  assert.equal((await h.manual.finish(OWNER, arg(start, { ...PROOF, geetest_challenge: 'z' + PROOF.geetest_challenge.slice(1) }), ACCOUNT, PRIVATE)).code, 'challenge_mismatch');
  assert.equal(h.submits.length, 0);
  assert.equal((await h.manual.finish(OWNER, arg(start, { ...PROOF, geetest_challenge: BASE }), ACCOUNT, PRIVATE)).ok, true);
});
test('strict proof schema rejects length/type/seccode/extras, malformed JSON and noncanonical base64url', async () => {
  const h = harness(), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  const malformed = [null, [], {}, { ...PROOF, geetest_challenge: BASE.slice(1) }, { ...PROOF, geetest_challenge: 'b'.repeat(65) },
    { ...PROOF, geetest_challenge: BASE + '!' }, { ...PROOF, geetest_validate: 'v'.repeat(15) }, { ...PROOF, geetest_validate: 'v'.repeat(257) },
    { ...PROOF, geetest_validate: 1 }, { ...PROOF, geetest_validate: '<script>malicious</script>' }, { ...PROOF, geetest_seccode: VALIDATE },
    { ...PROOF, geetest_seccode: VALIDATE + '|wrong' }, { ...PROOF, cookie: COOKIE }, { ...PROOF, __proto__: { x: 1 } }];
  for (const proof of malformed.slice(0, -1)) assert.equal((await h.manual.finish(OWNER, arg(start, proof), ACCOUNT, PRIVATE)).code, 'invalid_proof');
  for (const encoded of [encode('{broken'), encode('{"__proto__":{}}'), encode(PROOF) + '=', '*', 'A'.repeat(1537), 'AB'])
    assert.equal((await h.manual.finish(OWNER, start.nonce + ' ' + encoded, ACCOUNT, PRIVATE)).code, 'invalid_proof');
  for (const input of [null, 'x'.repeat(2049), arg(start) + '\n', 'badnonce ' + encode(PROOF), arg(start) + ' extra'])
    assert.equal((await h.manual.finish(OWNER, input, ACCOUNT, PRIVATE)).ok, false);
  assert.equal(h.submits.length, 0); assert.equal((await h.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE)).ok, true);
});
test('proof formats matching trusted Mys API include underscores/hyphens and maximum bounded validation length', async () => {
  const h = harness(), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE), value = 'v_-'.repeat(85) + 'v';
  const proof = { geetest_challenge: BASE + '_-', geetest_validate: value, geetest_seccode: value + '|jordan' };
  assert.equal(value.length, 256); assert.equal((await h.manual.finish(OWNER, arg(start, proof), ACCOUNT, PRIVATE)).ok, true);
});
test('five-minute TTL and backwards clock fail closed and destroy the binding', async () => {
  for (const delta of [300000, 300001, -1]) {
    const h = harness(), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE); h.advance(delta);
    assert.equal((await h.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE)).code, 'expired');
    assert.equal((await h.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE)).code, 'session_missing'); assert.equal(h.submits.length, 0);
  }
  const good = harness(), start = await good.manual.start(OWNER, ACCOUNT, PRIVATE); good.advance(299999);
  assert.equal((await good.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE)).ok, true);
});
test('successful/failed/throwing submit consumes the nonce and never replays or exposes upstream text', async () => {
  for (const submit of [() => ({ ok: true, data: { cookie: COOKIE, challenge: 'secret-grant' }, message: COOKIE }),
    () => ({ ok: false, code: 'expired', message: COOKIE }), () => ({ ok: false, code: 'unknown_' + COOKIE, message: COOKIE }),
    () => { throw new Error(COOKIE); }]) {
    const h = harness({ submit }), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE), done = await h.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE);
    assert.equal(JSON.stringify(done).includes(COOKIE), false); assert.equal(JSON.stringify(done).includes('secret-grant'), false);
    assert.equal((await h.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE)).code, 'session_missing'); assert.equal(h.submits.length, 1);
  }
});
test('simultaneous duplicate receipts submit once while a pending official submit cannot reuse nonce', async () => {
  let resolve; const h = harness({ submit: () => new Promise(done => { resolve = done; }) }), start = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  const pending = h.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE);
  assert.equal((await h.manual.finish(OWNER, arg(start), ACCOUNT, PRIVATE)).code, 'session_missing'); assert.equal(h.submits.length, 1);
  resolve({ ok: true }); assert.equal((await pending).ok, true);
});
test('per-owner cooldown is 15 seconds across cancellation and failed creation without blocking other owners', async () => {
  const h = harness(), first = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  assert.equal((await h.manual.start(OWNER, ACCOUNT, PRIVATE)).code, 'cooldown'); h.manual.stop(OWNER);
  h.advance(14999); assert.equal((await h.manual.start(OWNER, ACCOUNT, PRIVATE)).retryAfterMs, 1);
  assert.equal((await h.manual.start(OTHER, ACCOUNT, PRIVATE)).ok, true);
  h.advance(1); const second = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  assert.equal(second.ok, true); assert.notEqual(second.nonce, first.nonce); assert.equal(h.creates.length, 3);
  assert.equal((await h.manual.finish(OWNER, arg(first), ACCOUNT, PRIVATE)).code, 'invalid_nonce');
  const failing = harness({ create: () => { throw new Error(COOKIE); } });
  assert.equal((await failing.manual.start(OWNER, ACCOUNT, PRIVATE)).code, 'verification_failed');
  assert.equal((await failing.manual.start(OWNER, ACCOUNT, PRIVATE)).code, 'cooldown'); assert.equal(failing.creates.length, 1);
});
test('new challenge after cooldown replaces old nonce and keeps concurrent owners separated', async () => {
  const h = harness(), old = await h.manual.start(OWNER, ACCOUNT, PRIVATE), other = await h.manual.start(OTHER, ACCOUNT, PRIVATE);
  h.advance(15000); const current = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
  assert.equal((await h.manual.finish(OWNER, arg(old), ACCOUNT, PRIVATE)).code, 'invalid_nonce');
  assert.equal((await h.manual.finish(OWNER, arg(other), ACCOUNT, PRIVATE)).code, 'invalid_nonce');
  assert.equal((await h.manual.finish(OTHER, arg(other), ACCOUNT, PRIVATE)).ok, true);
  assert.equal((await h.manual.finish(OWNER, arg(current), ACCOUNT, PRIVATE)).ok, true);
});
test('creating reservations count toward max256 and asynchronous cancel prevents returned HTML resurrection', async () => {
  let resolve; const h = harness({ create: () => new Promise(done => { resolve = done; }) });
  const pending = h.manual.start(OWNER, ACCOUNT, PRIVATE);
  assert.equal((await h.manual.start(OWNER, ACCOUNT, PRIVATE)).code, 'busy'); h.manual.cancel(OWNER); resolve(response());
  assert.equal((await pending).code, 'cancelled'); assert.equal((await h.manual.finish(OWNER, 'unknown', ACCOUNT, PRIVATE)).code, 'session_missing');
  const full = harness();
  for (let index = 0; index < 256; index++) assert.equal((await full.manual.start(String(200000000 + index), ACCOUNT, PRIVATE)).ok, true);
  assert.equal((await full.manual.start('300000001', ACCOUNT, PRIVATE)).code, 'busy'); assert.equal(full.creates.length, 256);
  full.advance(300000); assert.equal((await full.manual.start('300000001', ACCOUNT, PRIVATE)).ok, true);
});
test('delayed challenge creation cannot extend TTL or revive a cancelled replacement', async () => {
  let resolve; const h = harness({ create: () => new Promise(done => { resolve = done; }) });
  const pending = h.manual.start(OWNER, ACCOUNT, PRIVATE); h.advance(300000); resolve(response());
  assert.equal((await pending).code, 'expired'); assert.equal(h.submits.length, 0);
  let ready; const short = harness({ create: () => new Promise(done => { ready = done; }) });
  const creating = short.manual.start(OWNER, ACCOUNT, PRIVATE); short.advance(5000); ready(response());
  const start = await creating; assert.equal(config(start).remainingMs, 295000);
});
test('cancel/stop clear only the requesting owner and do not erase cooldown; invalid IDs are safe', async () => {
  const h = harness(), first = await h.manual.start(OWNER, ACCOUNT, PRIVATE), other = await h.manual.start(OTHER, ACCOUNT, PRIVATE);
  assert.equal(h.manual.stop(OWNER).code, 'cancelled'); assert.equal(h.manual.cancel(OWNER).ok, true);
  assert.equal(h.manual.cancel('../bad').code, 'invalid_owner');
  assert.equal((await h.manual.finish(OWNER, arg(first), ACCOUNT, PRIVATE)).code, 'session_missing');
  assert.equal((await h.manual.finish(OTHER, arg(other), ACCOUNT, PRIVATE)).ok, true);
  assert.equal((await h.manual.start(OWNER, ACCOUNT, PRIVATE)).code, 'cooldown');
});
test('upstream errors and arbitrary thrown data are safe; no HTML/proof/credentials are exposed', async () => {
  for (const create of [() => ({ ok: false, code: 'network_error', text: COOKIE, data: { cookie: COOKIE } }),
    () => ({ ok: false, code: COOKIE, message: COOKIE }), () => { throw new Error(COOKIE); }]) {
    const h = harness({ create }), output = await h.manual.start(OWNER, ACCOUNT, PRIVATE);
    assert.equal(output.ok, false); assert.equal(output.file, undefined); assert.equal(JSON.stringify(output).includes(COOKIE), false);
  }
  assert.throws(() => new ManualVerification(), /人工验证/);
  assert.throws(() => new ManualVerification({ mys: {}, prefix: '#原神' }), /人工验证/);
  const h = harness(); h.setTime(NaN); assert.equal((await h.manual.start(OWNER, ACCOUNT, PRIVATE)).code, 'invalid_clock');
});
test('source has no file/network/solver/automatic-action interfaces and pins official SDK documentation', () => {
  const source = fs.readFileSync(new URL('../lib/manual-verification.mjs', import.meta.url), 'utf8');
  assert.equal(manualVerificationSource.persistence, 'none'); assert.equal(manualVerificationSource.automation, 'none');
  assert.equal(manualVerificationSource.ttlMs, 300000); assert.equal(manualVerificationSource.cooldownMs, 15000); assert.equal(manualVerificationSource.maxSessions, 256);
  assert.match(manualVerificationSource.apiDocs, /^https:\/\/docs\.geetest\.com\//);
  for (const pattern of [/from ['"]node:fs/, /writeFile/, /fetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /localStorage/, /sessionStorage/, /\.verify\s*\(/, /\.click\s*\(/, /dispatchEvent/, /2captcha/i, /capmonster/i]) assert.equal(pattern.test(source), false);
});
