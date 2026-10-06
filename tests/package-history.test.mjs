import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PackageHistory,HISTORY_SOURCE,readHistoryDatabase,validateHistory,mergeHistory,formatHistory} from '../lib/package-history.mjs';
import {Teyvat} from '../lib/core.mjs';

function fixture(t, options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-history-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'resources'));
  const seed={schema:1,source:HISTORY_SOURCE,sourceSha256:'a'.repeat(64),observedAt:'2026-10-07T00:00:00.000Z',
    main:[{version:'1.0.0',size:'11.97 GB',time:null}],pre:[]};
  fs.writeFileSync(path.join(root,'resources/package-history.json'),JSON.stringify(seed));
  return {root,seed,history:new PackageHistory(root,options)};
}
function databaseFile(root, {view=false}={}) {
  const file=path.join(root,'source.db');
  const db=new DatabaseSync(file);
  db.exec('CREATE TABLE "main"(game TEXT,version TEXT,size TEXT,time TEXT)');
  if(view)db.exec('CREATE VIEW pre AS SELECT game,version AS ver,version AS oldver,size,time FROM "main"');
  else db.exec('CREATE TABLE pre(game TEXT,ver TEXT,oldver TEXT,size TEXT,time TEXT)');
  db.prepare('INSERT INTO "main" VALUES(?,?,?,?)').run('ys','2.0.0','20 GB',null);
  db.prepare('INSERT INTO "main" VALUES(?,?,?,?)').run('sr','9.0.0','999 GB',null);
  if(!view)db.prepare('INSERT INTO pre VALUES(?,?,?,?,?)').run('ys','2.0.0','1.6.0','9 GB',null);
  db.close(); return file;
}

test('bundled snapshot is attributed and supports exact version lookup without network',t=>{
  const {history}=fixture(t,{fetch:()=>assert.fail('unexpected network')});
  assert.equal(history.list('1.0.0').main.length,1);
  assert.equal(history.list('9.9.9').main.length,0);
  assert.match(formatHistory(history.list()),/GamePush 作者资料/);
  assert.match(formatHistory(history.list()),/统计口径/);
  assert.throws(()=>history.list('../../config/local.json'));
});
test('SQLite reader only imports Genshin and keeps base version and source hash',async t=>{
  const {root}=fixture(t); const file=databaseFile(root);
  const data=await readHistoryDatabase(file);
  assert.deepEqual(data.main.map(row=>row.version),['2.0.0']);
  assert.equal(data.pre[0].oldVersion,'1.6.0');
  assert.match(data.sourceSha256,/^[a-f\d]{64}$/);
  assert.equal(data.main[0].time,null);
});
test('SQLite reader rejects views instead of executing downloaded schema expressions',async t=>{
  const {root}=fixture(t); const file=databaseFile(root,{view:true});
  await assert.rejects(readHistoryDatabase(file),/数据无效/);
});
test('SQLite reader rejects generated fields before selecting downloaded expressions',async t=>{
  const {root}=fixture(t);const file=path.join(root,'generated.db');const db=new DatabaseSync(file);
  db.exec(`CREATE TABLE "main"(game TEXT,version TEXT,size TEXT GENERATED ALWAYS AS (printf('%1000000s','x')) VIRTUAL,time TEXT);CREATE TABLE pre(game TEXT,ver TEXT,oldver TEXT,size TEXT,time TEXT)`);
  db.prepare('INSERT INTO "main"(game,version,time) VALUES(?,?,?)').run('ys','2.0.0',null);db.close();
  await assert.rejects(readHistoryDatabase(file),/数据无效/);
});
test('schema rejects wrong source, duplicate version keys and control characters',t=>{
  const {seed}=fixture(t);
  for(const value of [{...seed,source:'https://evil.invalid/a'}, {...seed,main:[...seed.main,...seed.main]},
    {...seed,main:[{version:'1.0.0',size:'20 GB\nforged',time:null}]}])assert.throws(()=>validateHistory(value));
});
test('merge keeps existing observations on conflicts and adds new records',t=>{
  const {seed}=fixture(t); const next=structuredClone(seed);
  next.main[0].size='99 GB'; next.main.push({version:'2.0.0',size:'20 GB',time:null});
  const merged=mergeHistory(seed,next);
  assert.equal(merged.added,1);assert.equal(merged.conflicts,1);
  assert.equal(merged.history.main[0].size,'11.97 GB');
});
test('bounded fixed-source update imports public records and removes temporary database',async t=>{
  const {root,history}=fixture(t);
  const body=fs.readFileSync(databaseFile(root));let requested;
  history.fetch=async(url,options)=>{requested={url,options};return new Response(body)};
  const result=await history.update();
  assert.equal(requested.url,HISTORY_SOURCE);assert.equal(requested.options.redirect,'error');
  assert.equal(result.added,2);assert.equal(history.read().main.length,2);
  assert.equal(history.read().pre[0].oldVersion,'1.6.0');
  assert.deepEqual(fs.readdirSync(path.join(root,'data')),['package-history.json']);
});
test('oversized and redirected responses preserve existing history',async t=>{
  const {root,history,seed}=fixture(t);
  for(const fetch of [async()=>new Response('x'.repeat(1024*1024+1)),async()=>{
    const response=new Response('x');Object.defineProperty(response,'url',{value:'https://evil.invalid/'});return response;
  }]){
    history.fetch=fetch;await assert.rejects(history.update());
    assert.deepEqual(history.read(),seed);
    assert.equal(fs.existsSync(path.join(root,'data/package-history.json')),false);
  }
});
test('same-process parallel update for the same path fails rather than racing',async t=>{
  const {root,history}=fixture(t);let release;
  const ready=new Promise(resolve=>release=resolve);
  const body=fs.readFileSync(databaseFile(root));
  history.fetch=async()=>{await ready;return new Response(body)};
  const first=history.update();
  await assert.rejects(new PackageHistory(root).update(),/正在更新/);
  release();await first;
});
test('directory junction/symlink refuses reads and updates without touching its target',async t=>{
  const {root,history}=fixture(t);const elsewhere=path.join(root,'external');fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere,path.join(root,'data'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>history.read());await assert.rejects(history.update());
  assert.deepEqual(fs.readdirSync(elsewhere),[]);
});
test('hardlinked history file is rejected without mutating its original',async t=>{
  const {root,history,seed}=fixture(t);fs.mkdirSync(path.join(root,'data'));
  const original=path.join(root,'original.json');fs.writeFileSync(original,JSON.stringify(seed));
  fs.linkSync(original,path.join(root,'data/package-history.json'));
  assert.throws(()=>history.read());await assert.rejects(history.update());
  assert.deepEqual(JSON.parse(fs.readFileSync(original,'utf8')),seed);
});
test('directory replaced during network wait receives no temporary writes or cleanup',async t=>{
  const {root,history}=fixture(t);const body=fs.readFileSync(databaseFile(root));
  const external=path.join(root,'external');fs.mkdirSync(external);
  history.fetch=async()=>{fs.renameSync(path.join(root,'data'),path.join(root,'original-data'));fs.symlinkSync(external,path.join(root,'data'),process.platform==='win32'?'junction':'dir');return new Response(body)};
  const originalWrite=fs.writeFileSync,originalDelete=fs.unlinkSync;let writes=0,deletes=0;
  fs.writeFileSync=function(...args){writes++;return originalWrite.apply(this,args)};
  fs.unlinkSync=function(...args){deletes++;return originalDelete.apply(this,args)};
  try{await assert.rejects(history.update(),/路径不安全/)}finally{fs.writeFileSync=originalWrite;fs.unlinkSync=originalDelete}
  assert.equal(writes,0);assert.equal(deletes,0);
  assert.deepEqual(fs.readdirSync(external),[]);
  assert.deepEqual(fs.readdirSync(path.join(root,'original-data')),[]);
});
test('core history update requires the master flag and version query stays public',async t=>{
  const {root}=fixture(t);const engine=new Teyvat(root,{fetch:()=>assert.fail('unexpected network')});
  t.after(()=>engine.login.stop());
  const denied=await engine.handle({user_id:123456,privateChat:true,text:'#原神更新版本数据'});
  assert.match(denied.text,/仅允许机器人主人/);
  const publicResult=await engine.handle({user_id:123456,privateChat:false,group_id:67890,text:'#原神版本数据 1.0.0'});
  assert.match(publicResult.text,/11.97 GB/);assert.match(publicResult.text,/GamePush 作者/);
});
