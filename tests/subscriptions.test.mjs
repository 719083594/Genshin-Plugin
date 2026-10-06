import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Subscriptions, SubscriptionError } from '../lib/subscriptions.mjs';

const OWNER = '12345678';
const OTHER = '87654321';
const BOT = '23456789';
const GROUP = '34567890';
const UID = '100000001';
const SECOND_UID = '100000002';
const COOKIE = 'ltuid=123456; ltoken=synthetic-subscription-token;';
const healthy = { current_resin: 190, max_resin: 200, resin_recovery_time: '4800', current_home_coin: 2400, max_home_coin: 2400, transformer: { obtained: true, recovery_time: { reached: true } }, secret: COOKIE, expeditions: [{ avatar_side_icon: 'never-send-private-data' }] };

function setup(t, overrides = {}) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'teyvat-subscriptions-test-'));
  t.after(() => {
    const target = path.resolve(root);
    assert.ok(target.startsWith(base + path.sep) && path.basename(target).startsWith('teyvat-subscriptions-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  let now = Date.parse('2026-10-07T00:15:00Z'); // Shanghai 08:15
  const config = { enabled: true, notifications: { enabled: true, intervalMinutes: 15, resinThreshold: 180 }, autoSign: { enabled: true, time: '08:10', retryMinutes: 60 } };
  const ownerAccounts = new Map([[OWNER, new Map([[UID, { uid: UID, region: 'cn', server: 'cn_gf01', hasCookie: true, cookie: COOKIE }]])], [OTHER, new Map([[SECOND_UID, { uid: SECOND_UID, region: 'cn', server: 'cn_gf01', hasCookie: true, cookie: COOKIE }]])]]);
  const selected = new Map([[OWNER, UID], [OTHER, SECOND_UID]]);
  const accounts = {
    selected(owner) { return this.get(owner, selected.get(owner)); },
    get(owner, uid) { return ownerAccounts.get(owner)?.get(uid); }
  };
  const sent = [];
  const queries = [];
  const signs = [];
  const versions = [];
  let note = healthy;
  let signResult = { ok: true, status: 'signed', message: 'ignored' };
  let version = { current: '6.0.0', preDownload: '' };
  const options = {
    accounts,
    mys: {
      async query(kind, account) { queries.push({ kind, uid: account.uid }); return { ok: true, data: structuredClone(note) }; },
      async sign(account) { signs.push(account.uid); return signResult; }
    },
    publicData: { async version() { versions.push(now); return version; } },
    send: async (target, text) => { sent.push({ target, text }); return true; },
    config: () => config,
    now: () => now,
    ...overrides
  };
  const subscriptions = new Subscriptions(root, options);
  return { root, subscriptions, options, config, sent, queries, signs, versions, accounts, ownerAccounts, selected,
    advance(ms) { now += ms; }, time(value) { now = Date.parse(value); }, note(value) { note = value; }, signResult(value) { signResult = value; }, version(value) { version = value; } };
}

test('no subscription or disabled global switches means no requests or messages', async t => {
  const env = setup(t);
  assert.equal((await env.subscriptions.tick()).calls, 0);
  env.subscriptions.set(OWNER, { kind: 'resin', enabled: true });
  env.subscriptions.set(OWNER, { kind: 'sign', enabled: true });
  env.subscriptions.set(OWNER, { kind: 'version', enabled: true });
  env.config.notifications.enabled = false;
  env.config.autoSign.enabled = false;
  assert.equal((await env.subscriptions.tick()).calls, 0);
  assert.equal(env.queries.length + env.signs.length + env.versions.length + env.sent.length, 0);
  env.config.enabled = false;
  env.config.notifications.enabled = env.config.autoSign.enabled = true;
  assert.equal((await env.subscriptions.tick()).calls, 0);
});

test('subscriptions capture only an owned authorized UID and list is owner-isolated', t => {
  const env = setup(t);
  assert.throws(() => env.subscriptions.set(OWNER, { kind: 'resin', enabled: true, uid: SECOND_UID }), { code: 'not_authorized' });
  const row = env.subscriptions.set(OWNER, { kind: 'resin', enabled: true, botId: BOT, groupId: GROUP });
  assert.equal(row.uid, UID);
  assert.deepEqual(env.subscriptions.list(OTHER), []);
  env.ownerAccounts.get(OWNER).get(UID).hasCookie = false;
  assert.throws(() => env.subscriptions.set(OWNER, { kind: 'sign', enabled: true }), { code: 'not_authorized' });
});

test('subscription input rejects credentials, bad thresholds, types and routing IDs', t => {
  const env = setup(t);
  for (const input of [{ kind: 'resin', enabled: true, cookie: COOKIE }, { kind: 'resin', enabled: true, threshold: 0 }, { kind: 'resin', enabled: true, threshold: '180' }, { kind: 'resin', enabled: true, botId: '../escape' }, { kind: 'unknown', enabled: true }, { kind: 'sign', enabled: true, report: 'group' }]) {
    assert.throws(() => env.subscriptions.set(OWNER, input), SubscriptionError);
  }
});

test('group reminders include only threshold/recovery and ready states, with persistent edge dedup', async t => {
  const env = setup(t);
  env.subscriptions.set(OWNER, { kind: 'resin', enabled: true, botId: BOT, groupId: GROUP });
  const first = await env.subscriptions.tick();
  assert.equal(first.calls, 1);
  assert.equal(first.sent, 1);
  assert.deepEqual(env.sent[0].target, { owner: OWNER, botId: BOT, groupId: GROUP });
  assert.match(env.sent[0].text, /190\/200/);
  assert.match(env.sent[0].text, /质变仪/);
  assert.match(env.sent[0].text, /洞天宝钱/);
  for (const text of [UID, COOKIE, 'never-send-private-data']) assert.ok(!env.sent[0].text.includes(text));
  assert.equal((await env.subscriptions.tick()).calls, 0);
  env.advance(15 * 60000);
  const restored = new Subscriptions(env.root, env.options);
  assert.equal((await restored.tick()).sent, 0);
  assert.equal(env.sent.length, 1);
  const persisted = fs.readFileSync(env.subscriptions.file, 'utf8');
  assert.ok(!persisted.includes(COOKIE));
  assert.ok(!persisted.includes('synthetic'));
  assert.ok(!persisted.includes('"cookie"'));
});

test('spending resin, using the transformer and collecting coins re-arm independent rising edges', async t => {
  const env = setup(t);
  env.subscriptions.set(OWNER, { kind: 'resin', enabled: true });
  await env.subscriptions.tick();
  env.advance(15 * 60000);
  env.note({ ...healthy, current_resin: 100, current_home_coin: 10, transformer: { obtained: true, recovery_time: { reached: false } } });
  assert.equal((await env.subscriptions.tick()).sent, 0);
  env.advance(15 * 60000);
  env.note({ ...healthy, current_resin: 190, current_home_coin: 10, transformer: { obtained: true, recovery_time: { reached: false } } });
  await env.subscriptions.tick();
  assert.match(env.sent[1].text, /树脂/);
  assert.ok(!env.sent[1].text.includes('质变仪') && !env.sent[1].text.includes('洞天'));
  env.advance(15 * 60000);
  env.note(healthy);
  await env.subscriptions.tick();
  assert.ok(!env.sent[2].text.includes('树脂'));
  assert.match(env.sent[2].text, /质变仪/);
});

test('send failures keep rising edges retryable after restart', async t => {
  const env = setup(t);
  let attempts = 0;
  env.options.send = async (target, text) => { attempts++; if (attempts === 1) throw new Error(COOKIE); env.sent.push({ target, text }); };
  const scheduler = new Subscriptions(env.root, env.options);
  scheduler.set(OWNER, { kind: 'resin', enabled: true });
  assert.equal((await scheduler.tick()).sent, 0);
  env.advance(15 * 60000);
  assert.equal((await new Subscriptions(env.root, env.options).tick()).sent, 1);
  assert.equal(attempts, 2);
});

test('upstream failures and incomplete notes never send false reminders or reset ready edges', async t => {
  const env = setup(t);
  let response = { ok: false, message: COOKIE };
  env.options.mys.query = async () => response;
  const scheduler = new Subscriptions(env.root, env.options);
  scheduler.set(OWNER, { kind: 'resin', enabled: true });
  assert.equal((await scheduler.tick()).sent, 0);
  env.advance(15 * 60000); response = { ok: true, data: {} };
  assert.equal((await scheduler.tick()).sent, 0);
  env.advance(15 * 60000); response = { ok: true, data: healthy };
  assert.equal((await scheduler.tick()).sent, 1);
  env.advance(15 * 60000); response = { ok: true, data: {} };
  assert.equal((await scheduler.tick()).sent, 0);
  env.advance(15 * 60000); response = { ok: true, data: healthy };
  assert.equal((await scheduler.tick()).sent, 0);
});

test('unbound or revoked accounts stop queries even if an old subscription remains enabled', async t => {
  const env = setup(t);
  env.subscriptions.set(OWNER, { kind: 'resin', enabled: true });
  env.subscriptions.set(OWNER, { kind: 'sign', enabled: true });
  env.ownerAccounts.get(OWNER).delete(UID);
  assert.equal((await env.subscriptions.tick()).calls, 0);
  assert.equal(env.sent.length, 0);
  assert.equal(env.subscriptions.set(OWNER, { kind: 'resin', enabled: false }).count, 1);
  assert.equal(env.subscriptions.list(OWNER)[0].enabled, false);
});

test('auto-sign uses Shanghai time, once per owned account/day, and always sends private summaries', async t => {
  const env = setup(t);
  env.time('2026-10-06T23:59:00Z'); // Shanghai 07:59, previous UTC date
  env.subscriptions.set(OWNER, { kind: 'sign', enabled: true, groupId: GROUP, botId: BOT });
  assert.equal((await env.subscriptions.tick()).calls, 0);
  env.time('2026-10-07T00:15:00Z');
  assert.equal((await env.subscriptions.tick()).calls, 2);
  assert.equal(env.sent[0].target.groupId, null);
  assert.match(env.sent[0].text, /2026-10-07/);
  assert.match(env.sent[0].text, /签到成功/);
  assert.equal((await env.subscriptions.tick()).calls, 0);
  const restored = new Subscriptions(env.root, env.options);
  assert.equal((await restored.tick()).calls, 0);
  assert.equal(env.sent.length, 1);
  env.time('2026-10-08T00:15:00Z');
  assert.equal((await restored.tick()).calls, 2);
  assert.equal(env.signs.length, 2);
});

test('multiple explicit account opt-ins produce one private sign summary for their owner', async t => {
  const env = setup(t);
  env.ownerAccounts.get(OWNER).set(SECOND_UID, { uid: SECOND_UID, hasCookie: true, cookie: COOKIE });
  env.subscriptions.set(OWNER, { kind: 'sign', enabled: true, botId: BOT });
  env.selected.set(OWNER, SECOND_UID);
  env.subscriptions.set(OWNER, { kind: 'sign', enabled: true, botId: BOT });
  const result = await env.subscriptions.tick();
  assert.equal(result.calls, 4);
  assert.deepEqual(env.signs.sort(), [UID, SECOND_UID]);
  assert.equal(env.sent.length, 1);
  assert.match(env.sent[0].text, /100000001/);
  assert.match(env.sent[0].text, /100000002/);
  assert.equal(env.subscriptions.list(OTHER).length, 0);
});

test('failed sign is never called success, is retried at most three times/day and repeated failure reports are deduplicated', async t => {
  const env = setup(t);
  env.signResult({ ok: false, code: 'verification_required', message: COOKIE });
  env.subscriptions.set(OWNER, { kind: 'sign', enabled: true });
  assert.equal((await env.subscriptions.tick()).failed, 1);
  assert.match(env.sent[0].text, /未完成/);
  assert.ok(!env.sent[0].text.includes('签到成功') && !env.sent[0].text.includes('synthetic'));
  env.advance(15 * 60000);
  assert.equal((await env.subscriptions.tick()).calls, 0);
  env.advance(45 * 60000);
  assert.equal((await env.subscriptions.tick()).calls, 2);
  assert.equal(env.sent.length, 1);
  env.advance(60 * 60000); await env.subscriptions.tick();
  env.advance(60 * 60000);
  assert.equal((await env.subscriptions.tick()).calls, 0);
  assert.equal(env.signs.length, 3);
});

test('successful sign with a failed send is re-reported after restart without re-signing', async t => {
  const env = setup(t);
  env.options.send = async () => false;
  const scheduler = new Subscriptions(env.root, env.options);
  scheduler.set(OWNER, { kind: 'sign', enabled: true });
  assert.equal((await scheduler.tick()).sent, 0);
  env.options.send = async (target, text) => { env.sent.push({ target, text }); };
  const restored = new Subscriptions(env.root, env.options);
  assert.equal((await restored.tick()).calls, 0);
  assert.equal(env.signs.length, 1);
  assert.equal(env.sent.length, 1);
});

test('silent auto-sign reports nothing but persists its successful daily dedup', async t => {
  const env = setup(t);
  env.subscriptions.set(OWNER, { kind: 'sign', enabled: true, report: 'none' });
  assert.equal((await env.subscriptions.tick()).calls, 2);
  assert.equal(env.sent.length, 0);
  assert.equal((await env.subscriptions.tick()).calls, 0);
});

test('versions establish a silent baseline and broadcast changes with one shared request', async t => {
  const env = setup(t);
  env.subscriptions.set(OWNER, { kind: 'version', enabled: true, botId: BOT, groupId: GROUP });
  env.subscriptions.set(OTHER, { kind: 'version', enabled: true });
  assert.equal((await env.subscriptions.tick()).calls, 1);
  assert.equal(env.sent.length, 0);
  env.advance(15 * 60000);
  env.version({ current: '6.0.0', preDownload: '6.1.0' });
  const result = await env.subscriptions.tick();
  assert.equal(result.calls, 1);
  assert.equal(result.sent, 2);
  assert.equal(env.versions.length, 2);
  assert.match(env.sent[0].text, /预下载 6.1.0/);
  const restored = new Subscriptions(env.root, env.options);
  assert.equal((await restored.tick()).sent, 0);
});

test('version failures do not announce changes; next successful request compares against last good baseline', async t => {
  const env = setup(t);
  env.subscriptions.set(OWNER, { kind: 'version', enabled: true });
  await env.subscriptions.tick();
  env.advance(15 * 60000);
  env.version({ current: '<bad-response>' });
  assert.equal((await env.subscriptions.tick()).sent, 0);
  env.version({ current: '6.1.0' });
  assert.equal((await env.subscriptions.tick()).sent, 1);
});

test('concurrent ticks and separate instances cannot duplicate upstream calls', async t => {
  const env = setup(t);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let calls = 0;
  env.options.mys.query = async () => { calls++; await waiting; return { ok: true, data: healthy }; };
  const first = new Subscriptions(env.root, env.options);
  const second = new Subscriptions(env.root, env.options);
  first.set(OWNER, { kind: 'resin', enabled: true });
  const running = first.tick();
  assert.equal((await first.tick()).busy, true);
  assert.equal((await second.tick()).busy, true);
  release();
  assert.equal((await running).sent, 1);
  assert.equal(calls, 1);
});

test('unsubscribe or global disable during an in-flight query prevents delivery', async t => {
  const env = setup(t);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  env.options.mys.query = async () => { await waiting; return { ok: true, data: healthy }; };
  const scheduler = new Subscriptions(env.root, env.options);
  scheduler.set(OWNER, { kind: 'resin', enabled: true });
  const running = scheduler.tick();
  scheduler.set(OWNER, { kind: 'resin', enabled: false });
  release();
  assert.equal((await running).sent, 0);
  assert.equal(scheduler.list(OWNER)[0].enabled, false);
  scheduler.set(OWNER, { kind: 'resin', enabled: true });
  const next = scheduler.tick();
  env.config.notifications.enabled = false;
  assert.equal((await next).sent, 0);
});

test('50-request budget rotates to accounts deferred by the first tick', async t => {
  const env = setup(t);
  for (let index = 0; index < 55; index++) {
    const uid = String(100000001 + index);
    env.ownerAccounts.get(OWNER).set(uid, { uid, hasCookie: true, cookie: COOKIE });
    env.subscriptions.set(OWNER, { kind: 'resin', enabled: true, uid });
  }
  assert.equal((await env.subscriptions.tick()).calls, 50);
  assert.equal(env.queries.length, 50);
  assert.equal((await env.subscriptions.tick()).calls, 5);
  assert.equal(new Set(env.queries.map(query => query.uid)).size, 55);
});

test('sign reserves two HTTP requests per account and stops at the 50-request budget', async t => {
  const env = setup(t);
  for (let index = 0; index < 30; index++) {
    const uid = String(100000001 + index);
    env.ownerAccounts.get(OWNER).set(uid, { uid, hasCookie: true, cookie: COOKIE });
    env.subscriptions.set(OWNER, { kind: 'sign', enabled: true, uid });
  }
  assert.equal((await env.subscriptions.tick()).calls, 50);
  assert.equal(env.signs.length, 25);
  assert.equal((await env.subscriptions.tick()).calls, 10);
  assert.equal(new Set(env.signs).size, 30);
});

test('start and stop use an injected clock, default to 15 minutes and avoid duplicate timers', t => {
  let callback, interval, cleared;
  const env = setup(t, { config: {}, clock: { setInterval(fn, ms) { callback = fn; interval = ms; return 123; }, clearInterval(id) { cleared = id; } } });
  assert.equal(env.subscriptions.start(), true);
  assert.equal(interval, 15 * 60000);
  assert.equal(typeof callback, 'function');
  assert.equal(env.subscriptions.start(), false);
  assert.equal(env.subscriptions.stop(), true);
  assert.equal(cleared, 123);
  assert.equal(env.subscriptions.stop(), false);
});

test('malformed persistent state is preserved and cannot cause messages', async t => {
  const env = setup(t);
  fs.mkdirSync(path.dirname(env.subscriptions.file), { recursive: true });
  fs.writeFileSync(env.subscriptions.file, 'not-json');
  assert.throws(() => env.subscriptions.list(OWNER), { code: 'invalid_storage' });
  assert.equal((await env.subscriptions.tick()).sent, 0);
  assert.equal(fs.readFileSync(env.subscriptions.file, 'utf8'), 'not-json');
});

test('locks from a confirmed exited process are recovered, while live or unknown locks remain protected', async t => {
  const env = setup(t);
  env.subscriptions.set(OWNER, { kind: 'resin', enabled: true });
  // Above any normal Linux/Windows PID range; kill(pid, 0) confirms ESRCH.
  const exited = { lockVersion: 1, pid: 2147483647, token: 'synthetic-lock' };
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  fs.writeFileSync(env.subscriptions.tickLockFile, JSON.stringify(exited));
  assert.equal((await env.subscriptions.tick()).sent, 1);
  fs.writeFileSync(env.subscriptions.lockFile, JSON.stringify(exited));
  assert.equal(env.subscriptions.set(OWNER, { kind: 'resin', enabled: false }).count, 1);
  fs.writeFileSync(env.subscriptions.tickLockFile, JSON.stringify({ lockVersion: 1, pid: process.pid, token: 'live-owner' }));
  assert.equal((await env.subscriptions.tick()).busy, true);
  fs.unlinkSync(env.subscriptions.tickLockFile);
  fs.writeFileSync(env.subscriptions.tickLockFile, 'unknown-owner');
  assert.equal((await env.subscriptions.tick()).busy, true);
});

test('inactive legacy subscriptions are encrypted at startup even with global switches disabled',t=>{const x=setup(t);const file=path.join(x.root,'data/subscriptions.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({version:1,subscriptions:{},cursor:0,versionSnapshot:null,versionNextAt:0}));new Subscriptions(x.root,{config:{enabled:false}});assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).algorithm,'aes-256-gcm');});
