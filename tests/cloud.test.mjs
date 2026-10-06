import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { CloudClient, CloudError, isPublicCloudAddress, validateCloudBaseUrl } from '../lib/cloud.mjs';

const UID = '100000001', OTHER = '100000002';
const KEY = 'synthetic-cloud-test-key', AUTH = 'synthetic/auth+test=';
const LINK = 'https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-v3/index.html?game_biz=hk4e_cn&region=cn_gf01&authkey=' + encodeURIComponent(AUTH);
const RECORD = { id: '100000000000000001', uid: UID, gacha_type: '400', uigf_gacha_type: '301', time: '2026-10-07 00:00:00',
  item_id: '10000003', rank_type: '5', count: '1', name: '测试物品', item_type: '角色' };
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

function mockClient(responses = [], options = {}) {
  const requests = [], queue = [...responses];
  const fetch = async (url, init) => {
    requests.push({ url: new URL(url), init, body: init.body && JSON.parse(init.body) });
    if (!queue.length) throw new Error('Mock response missing (no network is used)');
    const value = queue.shift();
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value(url, init);
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { client: new CloudClient({ baseUrl: 'https://cloud.example.com/api', key: KEY, fetch, resolveHost: publicDns, ...options }), requests };
}
const success = data => ({ code: 0, data });
const isError = code => error => error instanceof CloudError && error.code === code;

test('HTTPS service configuration rejects local/private/reserved/authenticated URLs without fallback', () => {
  for (const baseUrl of [undefined, '', 'http://111.170.175.22:5213/api', 'https://localhost/api', 'https://host.local/',
    'https://127.0.0.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://10.0.0.1/', 'https://172.20.0.1/',
    'https://192.168.1.1/', 'https://169.254.169.254/', 'https://100.64.0.1/', 'https://[::1]/', 'https://[fd00::1]/',
    'https://[::ffff:127.0.0.1]/', 'https://[2001:0db8::1]/', 'https://user:password@cloud.example.com/api',
    'https://cloud.example.com/api?api_key=secret', 'https://cloud.example.com/api#fragment']) {
    assert.throws(() => new CloudClient({ baseUrl }), CloudError);
  }
  assert.equal(validateCloudBaseUrl('https://cloud.example.com/api/'), 'https://cloud.example.com/api/');
  assert.equal(isPublicCloudAddress('8.8.8.8'), true);
  assert.equal(isPublicCloudAddress('2606:4700::1111'), true);
  assert.equal(isPublicCloudAddress('2001:0db8::1'), false);
});

test('DNS resolving any private address prevents a request, including mixed DNS answers', async () => {
  for (const resolveHost of [async () => [{ address: '127.0.0.1', family: 4 }],
    async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }],
    async () => [{ address: '::ffff:192.168.1.1', family: 6 }]]) {
    const { client, requests } = mockClient([], { resolveHost });
    await assert.rejects(client.query(UID), isError('UNSAFE_SERVICE'));
    assert.equal(requests.length, 0);
  }
});

test('default HTTPS transport retains the original TLS hostname and pins the checked DNS address', async t => {
  let connection;
  const transport = t.mock.method(https, 'request', (url, options, callback) => {
    connection = { url: new URL(url), options };
    const req = new EventEmitter();
    req.end = () => {
      const incoming = Readable.from([Buffer.from(JSON.stringify(success({ uid: UID, total: 1 })))]);
      incoming.statusCode = 200; incoming.rawHeaders = ['Content-Type', 'application/json'];
      callback(incoming);
    };
    return req;
  });
  syncBuiltinESMExports();
  t.after(() => { transport.mock.restore(); syncBuiltinESMExports(); });
  const client = new CloudClient({ baseUrl: 'https://cloud.example.com/api', resolveHost: publicDns });
  const result = await client.query(UID);
  assert.equal(result.uid, UID);
  assert.equal(connection.url.hostname, 'cloud.example.com');
  assert.equal(connection.options.agent, false);
  assert.equal(connection.options.rejectUnauthorized, true);
  connection.options.lookup('cloud.example.com', { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
  });
});

test('analysis and query send only Genshin parameters with no API Key', async () => {
  const { client, requests } = mockClient([success({ uid: UID, game: 'gs', total: 2 }), success({ hk4e: [{ uid: UID, list: [RECORD] }], hkrpg: [], nap: [] })]);
  const analysis = await client.analysis(UID), query = await client.query(UID);
  assert.equal(analysis.game_biz, 'hk4e_cn');
  assert.equal(query.data.hk4e[0].uid, UID);
  assert.equal(query.data.hkrpg, undefined);
  assert.deepEqual(requests.map(r => r.url.pathname), ['/api/analysis', '/api/query']);
  for (const r of requests) {
    assert.equal(r.url.searchParams.get('uid'), UID);
    assert.equal(r.url.searchParams.get('game'), 'gs');
    assert.equal(r.init.headers['X-API-Key'], undefined);
    assert.equal(r.init.redirect, 'error');
  }
  assert.equal(JSON.stringify(client), '{}');
  assert.equal(client.key, undefined);
});

test('export and upload use the verified JSON protocol, Key headers, and sanitized record fields', async () => {
  const { client, requests } = mockClient([success({ info: { version: 'v4.2' }, hk4e: [{ uid: UID, timezone: 8, list: [RECORD] }] }),
    success({ uid: UID, game_biz: 'hk4e_cn', total_genshin: 1, total_starrail: 0, api_key: KEY })]);
  const exported = await client.export(UID), uploaded = await client.upload(UID, [{ ...RECORD, authkey: 'must-not-upload', _isoTime: 'private metadata' }]);
  assert.equal(exported.format, 'v42');
  assert.equal(exported.data.info.version, 'v4.2');
  assert.deepEqual(requests[0].body, { uid: UID, game_biz: 'hk4e_cn', format: 'v42' });
  assert.equal(requests[1].url.pathname, '/api/gacha/import-json');
  assert.equal(requests[1].body.records[0].uigf_gacha_type, '301');
  assert.equal(requests[1].body.records[0]._isoTime, undefined);
  assert.equal(requests[1].body.records[0].authkey, undefined);
  assert.equal(uploaded.imported, 1);
  assert.equal(uploaded.data.api_key, undefined);
  for (const r of requests) { assert.equal(r.init.method, 'POST'); assert.equal(r.init.headers['X-API-Key'], KEY); }
});

test('v22 export is explicit and unsupported formats never make a request', async () => {
  const { client, requests } = mockClient([success({ info: { uid: UID, uigf_version: 'v2.2' }, list: [] })]);
  await client.export(UID, { format: 'v22' });
  assert.equal(requests[0].body.format, 'v22');
  await assert.rejects(client.export(UID, { format: 'v30' }), isError('INVALID_FORMAT'));
  assert.equal(requests.length, 1);
});

test('Key-dependent methods fail closed without credentials', async () => {
  const { client, requests } = mockClient([], { key: '' });
  await assert.rejects(client.export(UID), isError('KEY_REQUIRED'));
  await assert.rejects(client.upload(UID, [RECORD]), isError('KEY_REQUIRED'));
  await assert.rejects(client.verifyLink(LINK, UID), isError('KEY_REQUIRED'));
  await assert.rejects(client.importLink(LINK, UID), isError('KEY_REQUIRED'));
  assert.equal(requests.length, 0);
});

test('link whitelist rejects HTTP, deceptive domains, unsupported paths/games, duplicates and global servers', async () => {
  const { client, requests } = mockClient([]);
  const badLinks = [LINK.replace('https:', 'http:'), LINK.replace('webstatic.mihoyo.com', 'webstatic.mihoyo.com.evil.example'),
    LINK.replace('webstatic.mihoyo.com', 'evil.example.com'), LINK.replace('webstatic.mihoyo.com', 'webstatic.mihoyo.com@evil.example.com'),
    LINK.replace('/hk4e/event/e20190909gacha-v3/index.html', '/common/other-game/index.html'),
    LINK.replace('hk4e_cn', 'hkrpg_cn'), LINK.replace('hk4e_cn', 'hk4e_global'), LINK.replace('cn_gf01', 'os_asia'),
    LINK + '&authkey=another', LINK + '&game_biz=hk4e_cn', LINK + '&redirect_url=https://evil.example.com/', LINK.replace('authkey=', 'unknown=')];
  for (const link of badLinks) await assert.rejects(client.verifyLink(link, UID), CloudError);
  await assert.rejects(client.verifyLink(LINK), isError('INVALID_UID'));
  await assert.rejects(client.importLink(LINK), isError('INVALID_UID'));
  assert.equal(requests.length, 0);
});

test('verifyLink returns only proven UID/game and importLink verifies expected UID before importing', async () => {
  const { client, requests } = mockClient([
    success({ uid: UID, game_biz: 'hk4e_cn', authkey: AUTH }),
    success({ uid: UID, game_biz: 'hk4e_cn', api_key: KEY }),
    success({ uid: UID, game_biz: 'hk4e_cn', total_genshin: 3, authkey: AUTH })
  ]);
  const verified = await client.verifyLink(LINK, UID), imported = await client.importLink(LINK, UID);
  assert.equal(verified.verified, true);
  assert.deepEqual(verified.data, { uid: UID, game_biz: 'hk4e_cn' });
  assert.equal(imported.imported, 3);
  assert.deepEqual(requests.map(r => r.url.pathname), ['/api/gacha/verify-link', '/api/gacha/verify-link', '/api/gacha/import-link']);
  for (const r of requests) assert.deepEqual(r.body, { link: LINK });
  for (const r of [verified, imported]) {
    assert.ok(!JSON.stringify(r).includes(AUTH));
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.ok(!JSON.stringify(r).includes('authkey='));
  }
});

test('failed or ambiguous verification never reaches import-link, even for another valid Genshin UID', async () => {
  for (const data of [{ uid: OTHER, game_biz: 'hk4e_cn' }, { uid: UID, game_biz: 'hkrpg_cn' }, { uid: UID }, { game_biz: 'hk4e_cn' },
    { uid: '800000001', game_biz: 'hk4e_cn' }]) {
    const { client, requests } = mockClient([success(data)]);
    await assert.rejects(client.importLink(LINK, UID), CloudError);
    assert.deepEqual(requests.map(r => r.url.pathname), ['/api/gacha/verify-link']);
  }
  const { client, requests } = mockClient([success({ uid: UID, game_biz: 'hk4e_cn' })]);
  await assert.rejects(client.importLink(LINK + '&uid=' + OTHER, UID), isError('UID_MISMATCH'));
  assert.equal(requests.length, 1);
});

test('wrong import result never reports success after a validated request', async () => {
  const { client } = mockClient([success({ uid: UID, game_biz: 'hk4e_cn' }), success({ uid: OTHER, game_biz: 'hk4e_cn', total_genshin: 3 })]);
  await assert.rejects(client.importLink(LINK, UID), isError('IMPORT_MISMATCH'));
});

test('foreign UID, cross-game records and invalid uploads are isolated before returning/sending data', async () => {
  for (const data of [{ hk4e: [{ uid: OTHER, list: [] }] }, { game_biz: 'nap_cn' }, { hkrpg: [{ uid: UID, list: [] }] }]) {
    const { client } = mockClient([success(data)]);
    await assert.rejects(client.query(UID), CloudError);
  }
  const { client, requests } = mockClient([]);
  for (const records of [[{ ...RECORD, uid: OTHER }], [{ ...RECORD, game_biz: 'hkrpg_cn' }], [{ ...RECORD, gacha_type: '11' }],
    [{ ...RECORD, id: Number(RECORD.id) }], [{ ...RECORD, time: '2026-02-30 00:00:00' }], [RECORD, RECORD], []])
    await assert.rejects(client.upload(UID, records), CloudError);
  await assert.rejects(client.query('800000001'), isError('INVALID_UID'));
  assert.equal(requests.length, 0);
});

test('upstream messages, thrown transport errors and secret-bearing successful strings are never echoed', async () => {
  const leak = `provider says ${KEY} ${LINK}`;
  const { client } = mockClient([{ code: 401, message: leak }, new Error(leak), success({ uid: UID, api_key: KEY, message: leak,
    nested: { token: 'private-token', authkey: AUTH }, image: 'https://cloud.example.com/public.png?api_key=' + KEY })]);
  for (let i = 0; i < 2; i++) await assert.rejects(client.query(UID), error => {
    assert.ok(error instanceof CloudError);
    assert.ok(!String(error).includes(KEY)); assert.ok(!String(error).includes(AUTH)); assert.ok(!String(error).includes('https://'));
    return true;
  });
  const result = await client.query(UID), serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(KEY)); assert.ok(!serialized.includes(AUTH)); assert.ok(!serialized.includes('private-token'));
  assert.equal(result.data.image, '[敏感内容已隐藏]');
});

test('redirects, invalid responses and oversized bodies are rejected with fixed errors', async () => {
  const { client } = mockClient([
    () => ({ ok: true, status: 200, redirected: true }),
    () => new Response('not json ' + KEY),
    () => new Response('private response', { status: 200, headers: { 'content-length': String(9 * 1024 * 1024) } })
  ]);
  await assert.rejects(client.query(UID), isError('UNSAFE_REDIRECT'));
  await assert.rejects(client.query(UID), isError('INVALID_RESPONSE'));
  await assert.rejects(client.query(UID), isError('RESPONSE_TOO_LARGE'));
});

test('DNS timeout is bounded without sending a request', async () => {
  const { client, requests } = mockClient([], { timeoutMs: 1000, resolveHost: () => new Promise(() => {}) });
  await assert.rejects(client.query(UID), isError('TIMEOUT'));
  assert.equal(requests.length, 0);
});
