import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GachaStore, formatGacha } from '../lib/gacha.mjs';

// Fixtures follow the published UIGF-org specifications, not an invented shared
// root structure: https://uigf.org/zh/standards/uigf.html and legacy v2.2/v2.3/v3.0.
const OWNER = '100000001', UID = '100000001', OTHER = '100000002';
function workspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teyvat-gacha-'));
  try { return fn(root, new GachaStore(root, { now: () => 1791331200000 })); }
  finally {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('teyvat-gacha-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}
function row(id = '1700000000000000001', extra = {}) {
  return { id, item_id: '11301', time: '2026-10-07 12:00:00',
    gacha_type: '301', uigf_gacha_type: '301', count: '1',
    name: '冷刃', item_type: '武器', rank_type: '3', ...extra };
}
function legacy(version, list, uid = UID, info = {}) {
  return { info: { uid, lang: 'zh-cn', export_timestamp: 1791331200, export_app: 'Fixture', export_app_version: '1', uigf_version: version, ...info }, list };
}
function modern(version, list, uid = UID, account = {}) {
  return { info: { export_timestamp: 1791331200, export_app: 'Fixture', export_app_version: '1', version },
    hk4e: [{ uid, timezone: 8, lang: 'zh-cn', list, ...account }] };
}
test('reading an old UID file encrypts and verifies before removing plaintext, including cleanup retry',()=>workspace((root,store)=>{
 const old=store.legacyFile(OWNER,UID);fs.mkdirSync(path.dirname(old),{recursive:true});const rows=[row('1',{uid:UID})];fs.writeFileSync(old,JSON.stringify(rows));
 assert.equal(store.analyze(OWNER,UID).total,1);assert.equal(fs.existsSync(old),false);const raw=fs.readFileSync(store.file(OWNER,UID),'utf8');assert.doesNotMatch(raw,/100000001|冷刃/);assert.doesNotMatch(path.basename(store.file(OWNER,UID)),/100000001/);
 fs.writeFileSync(old,JSON.stringify(rows));assert.equal(store.load(OWNER,UID).length,1);assert.equal(fs.existsSync(old),false);
 const finalCipher=fs.readFileSync(store.file(OWNER,UID),'utf8');assert.throws(()=>new GachaStore(root,{key:'ff'.repeat(32)}),/解密|验证/);assert.equal(fs.readFileSync(store.file(OWNER,UID),'utf8'),finalCipher);
}));
for (const version of ['v2.2', 'v2.3', 'v2.4', 'v3.0', 'v4.0', 'v4.1', 'v4.2']) {
  test(version + ' uses its actual root and round-trips every field', () => workspace((root, store) => {
    const input = version.startsWith('v4.') ? modern(version, [row()]) : legacy(version, [row()]);
    assert.equal(store.import(OWNER, UID, JSON.stringify(input)).total, 1);
    const exported = store.export(OWNER, UID, { version });
    assert.equal(typeof exported.info.export_timestamp, 'number');
    assert.equal(exported.info.export_app, 'Genshin-Plugin');
    let records;
    if (version.startsWith('v4.')) {
      assert.equal(exported.info.version, version);
      assert.equal(exported.info.uigf_version, undefined);
      assert.equal(exported.info.uid, undefined);
      assert.equal(exported.list, undefined);
      assert.equal(exported.hk4e[0].uid, UID);
      assert.equal(exported.hk4e[0].timezone, 8);
      assert.equal(exported.hk4e[0].lang, 'zh-cn');
      records = exported.hk4e[0].list;
    } else {
      assert.equal(exported.info.uigf_version, version);
      assert.equal(exported.info.version, undefined);
      assert.equal(exported.info.uid, UID);
      assert.equal(exported.hk4e, undefined);
      assert.equal(exported.info.region_time_zone, ['v2.4', 'v3.0'].includes(version) ? 8 : undefined);
      records = exported.list;
    }
    assert.deepEqual(records, [row()]);
    assert.equal(records[0].uid, undefined);
    assert.equal(records[0].synthetic_id, undefined);
    const replica = new GachaStore(path.join(root, 'replica'));
    assert.equal(replica.import(OTHER, UID, exported).total, 1);
    assert.deepEqual(replica.load(OTHER, UID), store.load(OWNER, UID));
  }));
}
test('v4 default export is v4.2 and supports integer UID without losing the draw ID', () => workspace((root, store) => {
  store.import(OWNER, UID, modern('v4.2', [row('9999999999999999999')], Number(UID)));
  const value = store.export(OWNER, UID);
  assert.equal(value.info.version, 'v4.2');
  assert.equal(value.hk4e[0].list[0].id, '9999999999999999999');
}));
test('v4 ignores other games and other accounts, selecting only the requested hk4e UID', () => workspace((root, store) => {
  const input = modern('v4.2', [row()]);
  input.hk4e.unshift({ uid: OTHER, timezone: 8, list: [row('9')] });
  input.hkrpg = [{ uid: UID, list: [{ gacha_type: '11' }] }];
  input.nap = [{ uid: UID, list: [{ gacha_type: '1' }] }];
  input.hk4e_ugc = [{ uid: UID, list: [{ gacha_type: '1000' }] }];
  store.import(OWNER, UID, input);
  assert.equal(store.load(OWNER, UID).length, 1);
  assert.equal(store.load(OWNER, UID)[0].id, row().id);
  assert.equal(store.load(OWNER, OTHER).length, 0);
  assert.equal(store.load(OTHER, UID).length, 0);
}));
test('UID-less lists, ambiguous structures, foreign games and unsupported versions fail before writing', () => workspace((root, store) => {
  const foreign = modern('v4.2', [row()]);
  delete foreign.hk4e; foreign.hkrpg = [];
  for (const input of [{ list: [row()] }, [row()], [], { info: {}, list: [row()] },
    { ...legacy('v2.3', [row()]), game: 'hkrpg' }, foreign,
    modern('v4.3', [row()]), legacy('v1.0', [row()]), legacy('v4.0', [row()]),
    { ...legacy('v2.3', [row()]), info: { uid: UID, version: 'v3.0' } }]) {
    assert.throws(() => store.import(OWNER, UID, input), /UID|未知|原神|版本/);
  }
  assert.equal(fs.existsSync(store.file(OWNER, UID)), false);
}));
test('v4 rejects missing metadata, missing timezone and duplicate target accounts', () => workspace((root, store) => {
  const missing = modern('v4.0', [row()]); delete missing.info.export_app;
  assert.throws(() => store.import(OWNER, UID, missing), /必要字段/);
  const noZone = modern('v4.0', [row()]); delete noZone.hk4e[0].timezone;
  assert.throws(() => store.import(OWNER, UID, noZone), /时区/);
  const duplicate = modern('v4.0', [row()]); duplicate.hk4e.push(duplicate.hk4e[0]);
  assert.throws(() => store.import(OWNER, UID, duplicate), /重复/);
  const badVersion = modern('v4.2', [row()]); badVersion.info.uigf_version = 'v4.2';
  assert.throws(() => store.import(OWNER, UID, badVersion), /冲突/);
}));
test('wrong info UID and embedded record UID cannot contaminate or overwrite saved history', () => workspace((root, store) => {
  store.import(OWNER, UID, legacy('v3.0', [row()]));
  const original = fs.readFileSync(store.file(OWNER, UID), 'utf8');
  assert.throws(() => store.import(OWNER, UID, legacy('v3.0', [row()], OTHER)), /UID/);
  assert.throws(() => store.import(OWNER, UID, modern('v4.2', [row('2', { uid: OTHER })])), /UID/);
  assert.throws(() => store.import(OWNER, UID, [row('2', { uid: OTHER })]), /UID/);
  assert.equal(fs.readFileSync(store.file(OWNER, UID), 'utf8'), original);
}));
test('deduplication preserves 301/400 raw banners while their history and pity are shared', () => workspace((root, store) => {
  const list = [row('11'), row('12', { gacha_type: '400', rank_type: '5' }), row('13', { gacha_type: '400', rank_type: '4' })];
  store.import(OWNER, UID, legacy('v3.0', list.slice(0, 2)));
  const second = store.import(OWNER, UID, modern('v4.2', list.slice(1)));
  assert.equal(second.imported, 2); assert.equal(second.added, 1); assert.equal(second.duplicates, 1);
  const analysis = store.analyze(OWNER, UID);
  assert.equal(analysis.total, 3); assert.equal(analysis.pools.length, 1);
  assert.equal(analysis.pools[0].type, '301'); assert.equal(analysis.pools[0].currentPity, 1);
  assert.equal(analysis.pools[0].fiveStarHistory[0].pulls, 2);
  assert.equal(store.export(OWNER, UID).hk4e[0].list[1].gacha_type, '400');
}));
test('conflicting duplicate IDs reject the entire import and optional fields can enrich known records', () => workspace((root, store) => {
  const minimal = { id: '1', item_id: '11301', time: '2026-10-07 12:00:00', gacha_type: '301', uigf_gacha_type: '301' };
  store.import(OWNER, UID, modern('v4.2', [minimal]));
  assert.equal(store.analyze(OWNER, UID).pools[0].unknownRank, 1);
  assert.equal(store.import(OWNER, UID, modern('v4.2', [row('1')])).added, 0);
  assert.equal(store.load(OWNER, UID)[0].rank_type, '3');
  const before = fs.readFileSync(store.file(OWNER, UID), 'utf8');
  for (const change of [{ item_id: '11302' }, { rank_type: '5' }, { time: '2026-10-07 13:00:00' }, { gacha_type: '400' }]) {
    assert.throws(() => store.import(OWNER, UID, modern('v4.2', [row('2'), row('1', change)])), /冲突/);
    assert.equal(fs.readFileSync(store.file(OWNER, UID), 'utf8'), before);
  }
}));
test('v2.3 optional names, rarity and item type are preserved as absent rather than invented', () => workspace((root, store) => {
  const minimal = { id: '1', item_id: '11301', time: '2026-10-07 12:00:00', gacha_type: '301', uigf_gacha_type: '301' };
  store.import(OWNER, UID, legacy('v2.3', [minimal]));
  const exported = store.export(OWNER, UID, 'v2.3');
  assert.deepEqual(exported.list, [minimal]);
  const analysis = store.analyze(OWNER, UID);
  assert.equal(analysis.pools[0].unknownRank, 1);
  assert.equal(analysis.pools[0].five, 0);
  assert.equal(analysis.pools[0].average, null);
  assert.equal(analysis.pools[0].currentPityKnown, false);
  assert.match(formatGacha(analysis), /缺少星级/);
}));
test('v2.2 null and empty legacy IDs are deterministically filled and bounded by the official ceiling', () => workspace((root, store) => {
  const list = [row(null, { time: '2021-01-01 12:00:00' }), row('', { time: '2021-01-01 12:01:00' }),
    row('1612303200000000100', { time: '2021-02-03 12:00:00' })];
  const value = legacy('v2.2', list);
  assert.equal(store.import(OWNER, UID, value).generated, 2);
  const records = store.load(OWNER, UID);
  assert.deepEqual(records.slice(0, 2).map(x => x.id), ['1612303199999999999', '1612303200000000000']);
  assert.equal(records[0].synthetic_id, true);
  assert.equal(store.import(OWNER, UID, value).total, 3);
  assert.equal(store.export(OWNER, UID, 'v2.2').list.every(x => typeof x.id === 'string' && /^\d{1,19}$/.test(x.id)), true);
}));
test('legacy missing IDs are generated by decrementing from the next valid anchor', () => workspace((root, store) => {
  const value = legacy('v2.3', [row('100', { time: '2021-01-01 12:02:00' }),
    row(null, { time: '2021-01-01 12:01:00' }), row('', { time: '2021-01-01 12:00:00' })]);
  store.import(OWNER, UID, value);
  assert.deepEqual(store.load(OWNER, UID).map(x => x.id), ['98', '99', '100']);
}));
test('missing IDs are supported even with no official anchor, but unsafe ID collisions fail clearly', () => workspace((root, store) => {
  store.import(OWNER, UID, legacy('v2.2', [row(null), row('')]));
  assert.equal(store.load(OWNER, UID).length, 2);
  const separate = new GachaStore(path.join(root, 'collision'));
  assert.throws(() => separate.import(OWNER, UID, legacy('v2.3', [
    row('99', { time: '2021-01-01 12:00:00' }), row(null, { time: '2021-01-01 12:01:00' }),
    row('100', { time: '2021-01-01 12:02:00' })])), /冲突/);
}));
test('v4 requires string IDs, actual dates, required item IDs and the official shared-pool mapping', () => workspace((root, store) => {
  for (const change of [{ id: 1700000000000000001 }, { id: null }, { id: '10000000000000000000' },
    { time: '2023-02-29 12:00:00' }, { time: '2026-10-07 25:00:00' }, { item_id: undefined },
    { gacha_type: '400', uigf_gacha_type: '400' }, { gacha_type: '11', uigf_gacha_type: '11' }, { rank_type: 5 }, { rank_type: '6' }]) {
    assert.throws(() => store.import(OWNER, UID, modern('v4.2', [row('1', change)])));
  }
  assert.equal(store.import(OWNER, UID, modern('v4.2', [row('1', { time: '2024-02-29 23:59:59' })])).total, 1);
}));
test('UID and QQ owner isolation include existing-file metadata and invalid Windows path characters', () => workspace((root, store) => {
  store.import(OWNER, UID, legacy('v3.0', [row()]));
  assert.equal(store.load(OTHER, UID).length, 0);
  assert.equal(store.load(OWNER, OTHER).length, 0);
  for (const owner of ['../escape', 'abc', 'owner:stream', '10000/1', 'CON', '']) assert.throws(() => store.load(owner, UID), /用户标识/);
  const input = JSON.parse(fs.readFileSync(store.file(OWNER, UID), 'utf8')); input.tag = 'AAAAAAAAAAAAAAAAAAAAAA==';
  fs.writeFileSync(store.file(OWNER, UID), JSON.stringify(input));
  assert.throws(() => store.import(OWNER, UID, legacy('v3.0', [row('2')])), /损坏|UID/);
}));
test('US and EU legacy accounts infer server timezones; explicit nonstandard timezone wins', () => workspace((root, store) => {
  store.import(OWNER, '600000001', legacy('v2.3', [row()], '600000001'));
  store.import(OWNER, '700000001', legacy('v2.3', [row()], '700000001'));
  assert.equal(store.export(OWNER, '600000001').hk4e[0].timezone, -5);
  assert.equal(store.export(OWNER, '700000001').hk4e[0].timezone, 1);
  store.import(OWNER, UID, legacy('v3.0', [row()], UID, { region_time_zone: -3 }));
  assert.equal(store.export(OWNER, UID).hk4e[0].timezone, -3);
  assert.equal(store.export(OWNER, UID).hk4e[0].list[0].time, row().time);
  assert.throws(() => store.export(OWNER, UID, 'v2.3'), /时区/);
}));
test('merging an explicit new timezone converts local timestamps to the existing timezone', () => workspace((root, store) => {
  const uid = '600000001';
  store.import(OWNER, uid, modern('v4.2', [row('1')], uid, { timezone: -5 }));
  const result = store.import(OWNER, uid, modern('v4.2', [
    row('1', { time: '2026-10-08 01:00:00' }), row('2', { time: '2026-10-08 02:00:00' })], uid, { timezone: 8 }));
  assert.equal(result.total, 2); assert.equal(result.duplicates, 1);
  assert.equal(store.export(OWNER, uid).hk4e[0].timezone, -5);
  assert.deepEqual(store.load(OWNER, uid).map(x => x.time), ['2026-10-07 12:00:00', '2026-10-07 13:00:00']);
}));
test('legacy fractional timezone is retained in v3; lossy modern or old downgrade is refused', () => workspace((root, store) => {
  store.import(OWNER, UID, legacy('v3.0', [row()], UID, { region_time_zone: 5.5 }));
  assert.equal(store.export(OWNER, UID, 'v3.0').info.region_time_zone, 5.5);
  assert.throws(() => store.export(OWNER, UID), /非整数时区/);
  assert.throws(() => store.export(OWNER, UID, 'v2.3'), /时区/);
}));
test('international metadata is preserved and v2.2 or mixed-language history cannot silently mislabel names', () => workspace((root, store) => {
  const english = modern('v4.2', [row('1', { name: 'Cool Steel', item_type: 'Weapon' })], UID, { lang: 'en-us' });
  store.import(OWNER, UID, english);
  assert.equal(store.export(OWNER, UID).hk4e[0].lang, 'en-us');
  assert.throws(() => store.export(OWNER, UID, 'v2.2'), /简体中文/);
  assert.throws(() => store.import(OWNER, UID, legacy('v2.3', [row('2')])), /语言不同/);
  assert.throws(() => store.import(OTHER, UID, legacy('v2.2', [row()], UID, { lang: 'en-us' })), /简体中文/);
}));
test('Chronicled Wish remains its own pool and versions before v3 cannot silently lose it', () => workspace((root, store) => {
  const chronicled = row('2', { gacha_type: '500', uigf_gacha_type: '500', rank_type: '5' });
  store.import(OWNER, UID, legacy('v3.0', [row('1', { rank_type: '5' }), chronicled]));
  assert.equal(store.analyze(OWNER, UID).pools.length, 2);
  assert.equal(store.export(OWNER, UID, 'v3.0').list[1].gacha_type, '500');
  for (const version of ['v2.2', 'v2.3', 'v2.4']) {
    assert.throws(() => store.export(OWNER, UID, version), /集录祈愿/);
    assert.throws(() => store.import(OTHER, UID, legacy(version, [chronicled])), /集录祈愿/);
  }
}));
test('every imported five-star interval is calculated, first observed interval excluded from the average', () => workspace((root, store) => {
  const records = Array.from({ length: 104 }, (_, index) => row(String(index + 1), {
    gacha_type: index % 2 ? '400' : '301',
    rank_type: index >= 4 && (index - 4) % 8 === 0 ? '5' : '3',
    name: '物品' + index }));
  store.import(OWNER, UID, modern('v4.2', records.reverse()));
  const analysis = store.analyze(OWNER, UID), pool = analysis.pools[0];
  assert.equal(pool.total, 104); assert.equal(pool.five, 13);
  assert.equal(pool.fiveStarHistory.length, 13); assert.equal(pool.lastFive.length, 8);
  assert.equal(pool.fiveStarHistory[0].pulls, 5); assert.equal(pool.fiveStarHistory[0].incomplete, true);
  assert.equal(pool.fiveStarHistory[0].maxPulls, null);
  assert.equal(pool.completeIntervals, 12); assert.equal(pool.average, 8);
  assert.notEqual(pool.observedAverage, pool.average);
  assert.equal(pool.currentPity, 3); assert.equal(pool.currentPityKnown, true);
  assert.deepEqual(pool.currentPityRange, { min: 3, max: 3 });
  assert.equal(analysis.historyComplete, false);
  assert.match(formatGacha(analysis), /13 个已知五星/);
}));
test('missing rarity makes intervals and pity uncertain rather than declaring a successful five-star count', () => workspace((root, store) => {
  const ranks = ['5', undefined, '3', '5', '3', undefined, '4'];
  store.import(OWNER, UID, modern('v4.2', ranks.map((rank, index) => row(String(index + 1), { rank_type: rank }))));
  const pool = store.analyze(OWNER, UID).pools[0];
  assert.equal(pool.five, 2); assert.equal(pool.unknownRank, 2); assert.equal(pool.average, null);
  assert.equal(pool.fiveStarHistory[1].intervalKnown, false);
  assert.equal(pool.fiveStarHistory[1].minPulls, 2); assert.equal(pool.fiveStarHistory[1].maxPulls, 3);
  assert.equal(pool.currentPity, 3); assert.equal(pool.currentPityKnown, false);
  assert.deepEqual(pool.currentPityRange, { min: 1, max: 3 });
}));
test('count is item quantity, not a multiplier for wishes, and separate banners do not share pity', () => workspace((root, store) => {
  store.import(OWNER, UID, modern('v4.2', [row('1', { count: '10' }),
    row('2', { gacha_type: '302', uigf_gacha_type: '302', rank_type: '5' }),
    row('3', { gacha_type: '200', uigf_gacha_type: '200', rank_type: '4' })]));
  const analysis = store.analyze(OWNER, UID);
  assert.equal(analysis.total, 3); assert.equal(analysis.pools.length, 3);
  assert.equal(analysis.pools.find(x => x.type === '301').currentPity, 1);
  assert.equal(store.export(OWNER, UID).hk4e[0].list[0].count, '10');
}));
test('initial locally stored array is migrated without losing UID, raw banner or historical records', () => workspace((root, store) => {
  const file = store.file(OWNER, UID); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([row('1', { uid: UID, gacha_type: '400', uigf_gacha_type: '400', lang: 'zh-cn', item_id: undefined })]));
  assert.equal(store.load(OWNER, UID)[0].uigf_gacha_type, '301');
  assert.equal(store.import(OWNER, UID, legacy('v3.0', [row('2')])).total, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).algorithm, 'aes-256-gcm');
  assert.equal(store.export(OWNER, UID).hk4e[0].list[0].gacha_type, '400');
}));
test('bad JSON, oversized object/string, damaged persistence and active import lock fail without overwriting history', () => workspace((root, store) => {
  assert.throws(() => store.import(OWNER, UID, '{'), /JSON/);
  assert.throws(() => store.import(OWNER, UID, ' '.repeat(5 * 1024 * 1024 + 1)), /5MiB/);
  assert.throws(() => store.import(OWNER, UID, { large: 'x'.repeat(5 * 1024 * 1024) }), /5MiB/);
  const circular = {}; circular.self = circular;
  assert.throws(() => store.import(OWNER, UID, circular), /JSON/);
  store.import(OWNER, UID, modern('v4.2', [row()]));
  const file = store.file(OWNER, UID), before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file + '.lock', '');
  assert.throws(() => store.import(OWNER, UID, modern('v4.2', [row('2')])), /正在导入/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.unlinkSync(file + '.lock');
  fs.writeFileSync(file, 'not json');
  assert.throws(() => store.import(OWNER, UID, modern('v4.2', [row('2')])), /损坏/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
}));
test('legacy schema has no 19-digit ID ceiling, so a modern conversion must refuse instead of truncate', () => workspace((root, store) => {
  store.import(OWNER, UID, legacy('v3.0', [row('12345678901234567890')]));
  assert.equal(store.export(OWNER, UID, 'v3.0').list[0].id, '12345678901234567890');
  assert.throws(() => store.export(OWNER, UID), /19位/);
}));
test('unknown legacy language is not inferred from a later partial import', () => workspace((root, store) => {
  store.import(OWNER, UID, legacy('v2.3', [row('1')], UID, { lang: undefined }));
  store.import(OWNER, UID, legacy('v2.3', [row('2')]));
  assert.equal(store.export(OWNER, UID).hk4e[0].lang, undefined);
  assert.throws(() => store.import(OTHER, UID, legacy(null, [row()])), /版本/);
  assert.throws(() => store.import(OTHER, UID, legacy('v3.0', [row()], UID, { export_timestamp: '123' })), /数值/);
}));
test('a synthetic previous five-star leaves the following interval uncertain', () => workspace((root, store) => {
  store.import(OWNER, UID, legacy('v2.2', [row(null, { rank_type: '5', time: '2021-01-01 12:00:00' }),
    row('1612303200000000100', { rank_type: '5', time: '2021-02-03 12:00:00' })]));
  assert.equal(store.analyze(OWNER, UID).pools[0].fiveStarHistory[1].intervalKnown, false);
}));
