import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PublicData,formatPackages} from '../lib/public.mjs';

const game={id:'1Z8W5NHUQb',biz:'hk4e_cn'};
const cdn='https://autopatchcn.yuanshen.com/client_app';
const branch=(tag='7.1.0')=>({tag,package_id:'public-package',password:'public-launcher-password',diff_tags:['7.0.0','6.7.0']});
const manifest=(category,compressed,uncompressed)=>({matching_field:category,manifest:{id:'manifest_'+category.replace('-','_'),checksum:'public-checksum'},manifest_download:{url_prefix:cdn+'/sophon/manifests/build',url_suffix:''},chunk_download:{url_prefix:cdn+'/sophon/chunks/build'},stats:{compressed_size:String(compressed+100),uncompressed_size:String(uncompressed+100)},deduplicated_stats:{compressed_size:String(compressed),uncompressed_size:String(uncompressed)}});
function fixture(){return {
  branches:{retcode:0,data:{game_branches:[{game,main:branch(),pre_download:null}]}},
  full:{retcode:0,data:{tag:'7.1.0',manifests:[manifest('game',1000,2000),manifest('zh-cn',200,400),manifest('en-us',900,1800),manifest('ja-jp',800,1600),manifest('ko-kr',700,1400)]}},
  patch:{retcode:0,data:{tag:'7.1.0',manifests:['game','zh-cn','en-us'].map((category,i)=>({...manifest(category,0,0),deduplicated_stats:undefined,stats:{'7.0.0':{compressed_size:String(10+i),uncompressed_size:String(20+i)},'6.7.0':{compressed_size:String(30+i),uncompressed_size:String(40+i)}}}))}},
  archives:{retcode:0,data:{game_packages:[{game,main:{major:{version:'5.5.0',game_pkgs:[{url:cdn+'/YuanShen_5.5.0.zip.001',size:'500',decompressed_size:'1000',md5:'archive-digest'}],audio_pkgs:[{language:'zh-cn',url:cdn+'/Audio_Chinese_5.5.0.zip',size:'100',decompressed_size:'200'}]},patches:[]},pre_download:{major:null,patches:[]}}]}}
}}
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-packages-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const bodies=fixture(),calls=[];const data=new PublicData(root,{fetch:async(url,options={})=>{calls.push({url:String(url),options});const pathname=new URL(url).pathname;const kind=pathname.endsWith('getGameBranches')?'branches':pathname.endsWith('getGamePackages')?'archives':pathname.endsWith('getPatchBuild')?'patch':'full';const body=bodies[kind];if(body instanceof Error)throw body;return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}})}});return {data,bodies,calls,root}}

test('CN PC Sophon totals use deduplicated game + Chinese, and patch totals retain each base version',async t=>{
  const {data,calls}=setup(t);const result=await data.packages();
  assert.equal(result.version,'7.1.0');assert.equal(result.full.downloadBytes,1200);assert.equal(result.full.resourceBytes,2400);
  assert.deepEqual(result.updates.map(x=>[x.fromVersion,x.downloadBytes,x.resourceBytes]),[['7.0.0',21,41],['6.7.0',61,81]]);
  assert.equal(result.full.resources.length,5);
  const fullCall=calls.find(x=>x.url.includes('getBuild?')),patchCall=calls.find(x=>x.url.includes('getPatchBuild?'));
  assert.equal(fullCall.options.method,'GET');assert.equal(patchCall.options.method,'POST');assert.equal(patchCall.options.redirect,'error');
  assert.equal(new URL(fullCall.url).searchParams.get('plat_app'),'ddxf5qt290cg');
  assert.ok(calls.every(x=>!Object.keys(x.options.headers||{}).some(k=>/cookie|authorization/i.test(k))));
});

test('stale ZIP metadata remains explicitly labeled, and current manifests are not called installer archives',async t=>{
  const {data}=setup(t);const result=await data.packages();assert.equal(result.archives.version,'5.5.0');assert.equal(result.archives.current,false);
  assert.match(result.full.resources[0].manifest.url,/\/manifest_game$/);
  const text=formatPackages(result);assert.match(text,/旧版本，非当前版本/);assert.match(text,/不是可直接安装的 ZIP/);assert.match(text,/5\.5\.0\.zip/);
});

test('absent pre-download has no fabricated zero-byte package or extra requests',async t=>{
  const {data,calls}=setup(t);const result=await data.packages('pre');assert.equal(result.available,false);assert.equal(result.full,null);assert.equal(result.archives,null);
  assert.equal(calls.length,1);assert.match(formatPackages(result),/没有可用资源分支/);assert.equal(data.packageHistory('pre').length,1);
});

test('pre-download uses predownload branch and its own current archive version',async t=>{
  const {data,bodies,calls}=setup(t);bodies.branches.data.game_branches[0].pre_download=branch('7.2.0');bodies.full.data.tag='7.2.0';bodies.patch.data.tag='7.2.0';
  bodies.archives.data.game_packages[0].pre_download=bodies.archives.data.game_packages[0].main; bodies.archives.data.game_packages[0].pre_download.major.version='7.2.0';
  const result=await data.packages('pre');assert.equal(result.version,'7.2.0');assert.equal(result.archives.current,true);
  assert.equal(new URL(calls.find(x=>x.url.includes('getBuild?')).url).searchParams.get('branch'),'predownload');
});

test('rejects wrong game, wrong region, and branch/build mismatch without recording a successful observation',async t=>{
  const {data,bodies}=setup(t);bodies.branches.data.game_branches[0].game={id:'64kMb5iAWu',biz:'hkrpg_cn'};
  await assert.rejects(data.packages(),/国服原神/);assert.deepEqual(data.packageHistory(),[]);
  bodies.branches.data.game_branches[0].game={...game,biz:'hk4e_global'};await assert.rejects(data.packages(),/国服原神/);
  bodies.branches.data.game_branches[0].game=game;bodies.full.data.tag='7.0.0';await assert.rejects(data.packages(),/版本不一致/);assert.deepEqual(data.packageHistory(),[]);
});

test('missing size data stays unknown rather than silently zero, unsafe download links are removed',async t=>{
  const {data,bodies}=setup(t);delete bodies.full.data.manifests[0].deduplicated_stats.compressed_size;
  bodies.full.data.manifests[0].manifest_download.url_prefix='https://evil.example/manifest';bodies.archives.data.game_packages[0].main.major.game_pkgs[0].url='http://autopatchcn.yuanshen.com/insecure.zip';
  const result=await data.packages();assert.equal(result.full.downloadBytes,null);assert.equal(result.full.resources[0].manifest.url,'');assert.equal(result.archives.game.length,0);
  assert.match(formatPackages(result),/下载估算 未知/);
});

test('optional patch/archive failures preserve current full resource metadata',async t=>{
  const {data,bodies}=setup(t);bodies.patch=new Error('offline');bodies.archives={retcode:-1};
  const result=await data.packages();assert.equal(result.full.downloadBytes,1200);assert.deepEqual(result.updates,[]);assert.equal(result.archives,null);assert.equal(result.warnings.length,2);
});

test('malformed negative or unsafe byte values fail the full query',async t=>{
  const {data,bodies}=setup(t);bodies.full.data.manifests[0].deduplicated_stats.compressed_size='-1';await assert.rejects(data.packages(),/字节数不合法/);
  bodies.full.data.manifests[0].deduplicated_stats.compressed_size='9007199254740992';await assert.rejects(data.packages(),/字节数不合法/);assert.deepEqual(data.packageHistory(),[]);
});

test('history tracks content/size changes at the same version, deduplicates observations, and stores no package URLs/passwords',async t=>{
  const {data,bodies,root}=setup(t);await data.packages();data.cache.clear();await data.packages();assert.equal(data.packageHistory().length,1);
  bodies.full.data.manifests[0].deduplicated_stats.compressed_size='1100';data.cache.clear();await data.packages();assert.equal(data.packageHistory().length,2);assert.equal(data.packageHistory().at(-1).version,'7.1.0');
  const raw=fs.readFileSync(path.join(root,'data/packages.json'),'utf8');assert.doesNotMatch(raw,/https:|password|public-launcher/);
  assert.equal(data.packageHistory('pre').length,0);assert.deepEqual(data.versionHistory(),[]);
});

test('metadata cache shares one fetch sequence while subsequent callers get unmodified results',async t=>{
  const {data,calls}=setup(t);await Promise.all([data.packages(),data.packages()]);assert.equal(calls.length,4);
  const changed=await data.packages();changed.full.downloadBytes=-9;assert.equal((await data.packages()).full.downloadBytes,1200);
});

test('existing version response and independent version history remain unchanged',async t=>{
  const {data}=setup(t);const row=await data.version();assert.deepEqual(Object.keys(row),['time','current','preDownload']);assert.equal(row.current,'7.1.0');assert.equal(row.preDownload,'');assert.equal(data.versionHistory().length,1);assert.deepEqual(data.packageHistory(),[]);
  await data.packages();assert.equal(data.versionHistory().length,1);
});

test('history limit is bounded and input cannot select an arbitrary remote package',t=>{
  const {data}=setup(t);for(let i=0;i<202;i++)data.observePackages({time:String(i),type:'main',available:false,version:String(i),languages:['zh-cn'],full:null,updates:[],archives:null});assert.equal(data.packageHistory().length,200);assert.equal(data.packageHistory()[0].version,'2');
  assert.throws(()=>data.packages('https://evil.example'),/类型必须/);assert.throws(()=>data.packageHistory('../escape'),/类型必须/);
});
