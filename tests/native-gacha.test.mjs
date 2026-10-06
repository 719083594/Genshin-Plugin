import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {AccountsStore} from '../lib/accounts.mjs';
import {GachaStore} from '../lib/gacha.mjs';
import {configureNativeAccounts,runNativeScope,readNativeGachaScoped} from '../lib/native-accounts.mjs';
import {configureNativeGacha,installNativeGacha,runNativeGacha,createNativeGachaRenderer,createMiaoGachaMetadata} from '../lib/native-gacha.mjs';
import {wrapProviderClass} from '../lib/native-providers.mjs';
import {installNativeStorage} from '../lib/native-storage.mjs';

const OWNER='100000001',OTHER='100000002',UID='123456789',SECOND='523456789',KEY='ab'.repeat(32);
const ITEM={id:'10000030',name:'钟离',star:5,type:'char'};
const row=(id='1000000000000000001',change={})=>({uid:UID,id,gacha_type:'301',uigf_gacha_type:'301',item_id:ITEM.id,name:ITEM.name,item_type:'角色',rank_type:'5',time:'2026-10-07 12:00:00',...change});
function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-native-gacha-'));
  const accounts=new AccountsStore(root,{key:KEY}),gacha=new GachaStore(root,{key:KEY});
  accounts.bind(OWNER,{uid:UID});accounts.bind(OWNER,{uid:SECOND});accounts.select(OWNER,UID);accounts.bind(OTHER,{uid:UID});
  const original=[];
  const Data={readJSON(){original.push('read');return {public:true}},writeJSON(){original.push('write')},delFile(){original.push('delete')}};
  const guard=installNativeGacha({Data,resolveItem:r=>r.item_id==='11301'?{id:'11301',name:'黑缨枪',star:3,type:'weapon'}:ITEM,validateVersion:()=>true});
  configureNativeAccounts({accounts,gacha});
  t.after(()=>{guard.restore();configureNativeAccounts();configureNativeGacha();assert.ok(root.startsWith(os.tmpdir())&&path.basename(root).startsWith('teyvat-native-gacha-'));fs.rmSync(root,{recursive:true,force:true})});
  const event=owner=>({user_id:owner,msg:'#角色记录',game:'gs',isGroup:false,privateChat:true,runtime:{render(){assert.fail('persistent Runtime renderer used')}},reply:async()=>{}});
  const file=(owner=OWNER,uid=UID,pool='301')=>`/data/gachaJson/${owner}/${uid}/${pool}.json`;
  return {root,accounts,gacha,Data,original,event,file};
}

test('AES-only native reads merge 301/400, retain exact large IDs and descending same-second order without a plaintext cache',async t=>{
  const {root,gacha,Data,event,file,original}=setup(t);
  gacha.import(OWNER,UID,[row(),row('1000000000000000002',{gacha_type:'400',uigf_gacha_type:'301'}),row('1000000000000000003',{gacha_type:'302',uigf_gacha_type:'302',item_id:'11301',rank_type:'3'})]);
  const cipher=fs.readFileSync(gacha.file(OWNER,UID),'utf8');
  assert.doesNotMatch(cipher,/钟离|123456789|100000001/);
  await runNativeScope(event(OWNER),async()=>{
    const list=Data.readJSON(file(),'root');assert.deepEqual(list.map(r=>r.id),['1000000000000000002','1000000000000000001']);
    assert.deepEqual(list.map(r=>r.gacha_type),['301','301']);assert.equal(Data.readJSON(file(OWNER,UID,'302'),'root')[0].name,'黑缨枪');
    list[0].name='mutated';assert.equal(Data.readJSON(file(),'root')[0].name,'钟离');
  });
  assert.equal(fs.readFileSync(gacha.file(OWNER,UID),'utf8'),cipher);assert.equal(fs.existsSync(path.join(root,'data/gachaJson')),false);assert.deepEqual(original,[]);
});

test('no scope, another owner, another UID, group or another game cannot read the original or encrypted records',async t=>{
  const {gacha,Data,event,file,original}=setup(t);gacha.import(OWNER,UID,[row()]);
  assert.throws(()=>Data.readJSON(file(),'root'));
  await runNativeScope(event(OWNER),async()=>{
    assert.throws(()=>Data.readJSON(file(OTHER),'root'));assert.throws(()=>Data.readJSON(file(OWNER,SECOND),'root'));
    assert.throws(()=>Data.readJSON(`/data/srJson/${OWNER}/${UID}/11.json`,'root'));
  });
  for(const change of [{group_id:'23456789',isGroup:true},{privateChat:false},{privateChat:undefined},{message_type:'group'},{isPrivate:false},{game:'sr',isSr:true},{at:OTHER}])await runNativeScope({...event(OWNER),...change},async()=>assert.throws(()=>Data.readJSON(file(),'root')));
  assert.throws(()=>readNativeGachaScoped(OWNER,UID));assert.deepEqual(original,[]);
});

test('overlapping QQ scopes and a retained read callback remain isolated',async t=>{
  const {gacha,Data,event,file}=setup(t);gacha.import(OWNER,UID,[row()]);gacha.import(OTHER,UID,[row('1000000000000000020')]);
  let resume,later;const pending=new Promise(resolve=>{resume=resolve});const seen=[];
  const a=runNativeScope(event(OWNER),async()=>{later=()=>Data.readJSON(file(),'root');await pending;seen.push(later()[0].id)});
  await runNativeScope(event(OTHER),async()=>seen.push(Data.readJSON(file(OTHER),'root')[0].id));resume();await a;
  assert.deepEqual(seen,['1000000000000000020','1000000000000000001']);assert.throws(later);
});

test('native write/delete and malformed paths never fall back; unrelated public JSON remains readable',t=>{
  const {Data,file,original}=setup(t);
  for(const p of [file(),file().replace('/data/','/data/../data/'),file().replace('/gachaJson/','/gachaJson//'),file().replace('/gachaJson/','/GACHAJSON/'),file().replaceAll('/','\\'),`/data/srJson/${OWNER}/${UID}/11.json`]){
    assert.throws(()=>Data.writeJSON(p,[],'root'));assert.throws(()=>Data.writeJSON({path:path.posix.dirname(p),name:path.posix.basename(p),data:[],root:'root'}));assert.throws(()=>Data.delFile(p,'root'));
  }
  assert.deepEqual(Data.readJSON('resources/meta-gs/character/data.json','miao'),{public:true});assert.deepEqual(original,['read']);
});

test('readEncrypted refuses core legacy plaintext and tampered plaintext in the ciphertext path',t=>{
  const {gacha}=setup(t);const old=gacha.legacyFile(OWNER,UID);fs.mkdirSync(path.dirname(old),{recursive:true});const plain=JSON.stringify([row()]);fs.writeFileSync(old,plain);
  assert.throws(()=>gacha.readEncrypted(OWNER,UID),/加密迁移/);assert.equal(fs.readFileSync(old,'utf8'),plain);
  const current=gacha.file(OWNER,UID);fs.writeFileSync(current,JSON.stringify({storage_version:1,uid:UID,timezone:8,records:[row()]}));
  assert.throws(()=>gacha.readEncrypted(OWNER,UID),/损坏|不安全/);assert.equal(fs.readFileSync(old,'utf8'),plain);
});

test('gacha guard composes after native AES file storage without creating native gacha files or weakening PlayerData encryption',async t=>{
  const {root,gacha,event,file}=setup(t);gacha.import(OWNER,UID,[row()]);
  const Data={readJSON(){assert.fail('original private read')},writeJSON(){assert.fail('original private write')},delFile(){assert.fail('original private deletion')}};
  const storage=installNativeStorage({Data,root,botRoot:root,key:KEY,migrate:false});const bridge=installNativeGacha({Data,resolveItem:()=>ITEM,validateVersion:()=>true});
  t.after(()=>{bridge.restore();storage.restore()});
  Data.writeJSON(`/data/PlayerData/gs/${UID}.json`,{name:'synthetic-private-profile'},'root');
  assert.equal(Data.readJSON(`/data/PlayerData/gs/${UID}.json`,'root').name,'synthetic-private-profile');
  await runNativeScope(event(OWNER),async()=>assert.equal(Data.readJSON(file(),'root')[0].name,'钟离'));
  assert.equal(fs.existsSync(path.join(root,'data/PlayerData/gs',UID+'.json')),false);assert.equal(fs.existsSync(path.join(root,'data/gachaJson')),false);
  for(const filename of fs.readdirSync(path.join(root,'data/native-cache/miao')))assert.doesNotMatch(fs.readFileSync(path.join(root,'data/native-cache/miao',filename),'utf8'),/synthetic-private-profile|123456789/);
});

test('metadata resolves UIGF optional fields, converts source timezone to CN and refuses rank conflicts or uncertain order',async t=>{
  const {gacha,Data,event,file}=setup(t);
  gacha.import(OWNER,UID,{info:{version:'v4.2',export_timestamp:1791331200,export_app:'Fixture',export_app_version:'1'},hk4e:[{uid:UID,timezone:-5,list:[row(undefined,{time:'2026-10-07 01:00:00',name:undefined,item_type:undefined,rank_type:undefined})]}]});
  await runNativeScope(event(OWNER),async()=>{const r=Data.readJSON(file(),'root')[0];assert.equal(r.time,'2026-10-07 14:00:00');assert.equal(r.name,'钟离');assert.equal(r.item_type,'角色');assert.equal(r.rank_type,'5')});
  const wrong={readEncrypted:()=>({uid:UID,timezone:8,records:[row(undefined,{rank_type:'4'})]})};
  await runNativeScope(event(OWNER),async()=>assert.throws(()=>Data.readJSON(file(),'root'),e=>e.code==='METADATA_CONFLICT'),{gacha:wrong});
  const uncertain={readEncrypted:()=>({uid:UID,timezone:8,records:[row(undefined,{order_uncertain:true})]})};
  await runNativeScope(event(OWNER),async()=>assert.throws(()=>Data.readJSON(file(),'root'),e=>e.code==='UNCERTAIN_ORDER'),{gacha:uncertain});
  const synthetic={readEncrypted:()=>({uid:UID,timezone:8,records:[row(undefined,{synthetic_id:true})]})};
  await runNativeScope(event(OWNER),async()=>assert.throws(()=>Data.readJSON(file(),'root'),e=>e.code==='UNCERTAIN_ORDER'),{gacha:synthetic});
});

test('private native runtime uses only the memory renderer, preserves event runtime and never uses default HTML/debug caches',async t=>{
  const {event,gacha}=setup(t);gacha.import(OWNER,UID,[row()]);const e=event(OWNER),runtime=e.runtime,replies=[],calls=[];e.reply=async v=>replies.push(v);
  configureNativeGacha({renderPrivate:async args=>{calls.push(args.template);return Buffer.from([255,216,255,217])},image:buffer=>({type:'image',data:{file:buffer}})});
  await runNativeScope(e,()=>runNativeGacha(e,async()=>{const message=await e.runtime.render('miao-plugin','gacha/gacha-detail',{uid:UID,game:'gs',gacha:{}});await e.reply(message);return true}));
  assert.equal(e.runtime,runtime);assert.deepEqual(calls,['gacha/gacha-detail']);assert.equal(replies[0].type,'image');assert.match(replies[1],/首段可能不完整/);
  await runNativeScope(e,()=>runNativeGacha(e,async()=>e.runtime.render('miao-plugin','gacha/gacha-info',{uid:UID,game:'gs'})));
  assert.equal(calls.length,1);
});

test('the fixed miao model adapter rejects Character cross-game fallback and verifies actual pool metadata arguments',()=>{
  const calls=[];
  const Character={get:(key,game)=>{calls.push(['char',key,game]);return key==='1001'?{game:'sr',id:1001,name:'外部角色',star:5,isOfficial:true}:key===ITEM.id?{...ITEM,game:'gs',isOfficial:true}:false}};
  const Weapon={get:(key,game)=>{calls.push(['weapon',key,game]);return key==='11301'?{game,id:11301,name:'黑缨枪',star:3}:false}};
  const GachaData={getVersion:(date,hasVersion,isMix,game)=>{calls.push(['version',date,hasVersion,isMix,game]);return isMix?{version:'未知',char5:[],weapon5:[]}:{version:'6.0',char5:['钟离'],weapon5:['护摩之杖']}}};
  const metadata=createMiaoGachaMetadata({Character,Weapon,GachaData});
  assert.equal(metadata.resolveItem({item_id:'1001'}),null);assert.equal(metadata.resolveItem({item_id:ITEM.id}).name,'钟离');assert.equal(metadata.resolveItem({item_id:'11301'}).type,'weapon');
  assert.equal(metadata.validateVersion({time:'2026-10-07 12:00:00',pool:'301',type:'char'}),true);assert.equal(metadata.validateVersion({time:'2026-10-07 12:00:00',pool:'500',type:'weapon'}),false);
  assert.ok(calls.filter(x=>['char','weapon'].includes(x[0])).every(x=>x[2]==='gs'));assert.deepEqual(calls.filter(x=>x[0]==='version').map(x=>x.slice(2)),[[true,false,'gs'],[true,true,'gs']]);
});

test('native detail/stat plus Yz aliases use private rendering, while public card-pool info retains the host renderer',async t=>{
  const {event,gacha,Data,file}=setup(t);gacha.import(OWNER,UID,[row()]);const calls=[],replies=[];
  configureNativeGacha({renderPrivate:async args=>{calls.push(['private',args.template]);return Buffer.from([255,216,255,217])},image:b=>({type:'image',data:{file:b}})});
  class App{
    constructor(){this.rule=['detail','stat','Yzdetail','Yzstat','info'].map(fnc=>({fnc,reg:'.*'}))}
    async detail(e){calls.push(['detailMsg',e.msg]);const records=Data.readJSON(file(),'root');assert.equal(records.length,1);return e.runtime.render('miao-plugin','gacha/gacha-detail',{uid:e.uid,game:'gs',gacha:{}})}
    stat(e){return e.runtime.render('miao-plugin','gacha/gacha-stat',{uid:e.uid,game:'gs',gacha:{}})}
    info(e){return e.runtime.render('miao-plugin','gacha/gacha-info',{game:'gs'})}
  }
  App.prototype.Yzdetail=App.prototype.detail;App.prototype.Yzstat=App.prototype.stat;
  const Wrapped=wrapProviderClass(App,{provider:'miao',key:'gacha'}),app=new Wrapped();
  for(const name of ['detail','stat','Yzdetail','Yzstat']){
    const e=event(OWNER);e.msg='#喵喵角色记录';e.reply=async text=>replies.push(text);await app[name](e);assert.equal(e.msg,'#喵喵角色记录');
  }
  assert.equal(calls.filter(x=>x[0]==='private').length,4);assert.ok(calls.filter(x=>x[0]==='detailMsg').every(x=>x[1]==='#角色记录'));
  const publicEvent=event(OWNER);publicEvent.runtime={render:()=>{calls.push(['public']);return 'public-card'}};assert.equal(await app.info(publicEvent),'public-card');
  const before=calls.length,group={...event(OWNER),isGroup:true,group_id:23456789,reply:async text=>replies.push(text)};await app.Yzstat(group);assert.equal(calls.length,before);assert.match(replies.at(-1),/本人私聊/);
});

function fakeRenderer(t,{box={width:900,height:1200},screenshot,contextDelay,closeFailure=false,deadline=1000}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-memory-gacha-')),resources=path.join(root,'plugins/miao-plugin/resources');
  for(const [file,text]of [['gacha/gacha-detail.html','PUBLIC TEMPLATE'],['gacha/gacha-stat.html','PUBLIC STATS'],['common/layout/elem.html','<!doctype html><div id="container"></div>'],['common/common.css','body{}']]){const name=path.join(resources,file);fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,text)}
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[],handlers={};let closed=0;
  const page={setJavaScriptEnabled:async v=>calls.push(['javascript',v]),setCacheEnabled:async v=>calls.push(['cache',v]),setRequestInterception:async v=>calls.push(['interception',v]),on:(key,fn)=>{handlers[key]=fn},setViewport:async v=>calls.push(['viewport',v]),goto:async(url,options)=>calls.push(['goto',url,options]),setContent:async(html,options)=>calls.push(['setContent',html,options]),evaluate:async()=>{},$:async()=>({boundingBox:async()=>box,screenshot:async opts=>{calls.push(['screenshot',opts]);return screenshot?screenshot():Buffer.from([255,216,255,217])}})};
  const context={newPage:async()=>{calls.push(['newPage']);return page},close:async()=>{closed++;calls.push(['contextClose']);if(closeFailure)throw Error('synthetic close failure')}};
  const browser={createBrowserContext:async()=>{calls.push(['newContext']);if(contextDelay)await contextDelay;return context},isConnected:()=>true,close:()=>assert.fail('production browser closed'),newPage:()=>assert.fail('default production context used')};
  const engine={render:(source,data,options)=>{calls.push(['template',source,data,options]);return '<div id="container">PRIVATE '+data.uid+'<strong>#抽卡帮助</strong>获取抽卡链接，<strong>#更新抽卡记录</strong>更新抽卡信息，<strong>抽卡帮助</strong> 获取帮助，<strong>更新抽卡记录</strong></div>'}};
  const render=createNativeGachaRenderer({botRoot:root,getBrowser:()=>browser,templateEngine:engine,timeoutMs:deadline});
  const args={plugin:'miao-plugin',template:'gacha/gacha-detail',data:{uid:UID,game:'gs',gacha:{fiveLog:[]}}};
  return {root,resources,render,args,calls,handlers,get closed(){return closed}};
}

test('memory renderer uses an isolated context, disables JS/cache, allows only local assets, and returns JPEG Buffer without writes',async t=>{
  const x=fakeRenderer(t),before=fs.readdirSync(x.resources,{recursive:true}).sort();
  const image=await x.render(x.args);assert.ok(Buffer.isBuffer(image));assert.equal(x.closed,1);
  assert.deepEqual(x.calls.find(c=>c[0]==='javascript'),['javascript',false]);assert.deepEqual(x.calls.find(c=>c[0]==='cache'),['cache',false]);
  assert.ok(x.calls.find(c=>c[0]==='goto')[1].endsWith('/common/layout/elem.html'));assert.ok(x.calls.find(c=>c[0]==='setContent')[1].includes(UID));
  assert.deepEqual([x.calls.find(c=>c[0]==='setContent')[1],fs.readFileSync(path.join(x.resources,'gacha/gacha-detail.html'),'utf8')],['<div id="container">PRIVATE '+UID+'<strong>#原神帮助</strong>查看使用说明，<strong>#原神祈愿导入</strong>导入本人UIGF记录，<strong>#原神帮助</strong> 获取帮助，<strong>#原神祈愿导入</strong></div>','PUBLIC TEMPLATE']);
  assert.equal(x.calls.find(c=>c[0]==='screenshot')[1].path,undefined);assert.equal(x.calls.find(c=>c[0]==='template')[2]._res_path,pathToFileURL(x.resources+path.sep).href);
  const outside=path.join(x.root,'synthetic-private.txt'),linked=path.join(x.resources,'common/linked.css');fs.writeFileSync(outside,'synthetic-only-private');fs.linkSync(outside,linked);
  const choices=[];for(const url of [pathToFileURL(path.join(x.resources,'common/common.css')).href,'https://example.com/private','file:///etc/passwd','data:text/html,private',pathToFileURL(linked).href])x.handlers.request({url:()=>url,continue:()=>choices.push('allow'),abort:()=>choices.push('block')});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(choices,['allow','block','block','block','block']);fs.unlinkSync(linked);assert.deepEqual(fs.readdirSync(x.resources,{recursive:true}).sort(),before);
});

test('renderer does not start a browser and refuses unknown templates or large images before screenshot',async t=>{
  const x=fakeRenderer(t,{box:{width:900,height:50000}});await assert.rejects(x.render(x.args),e=>e.code==='IMAGE_TOO_LARGE');assert.equal(x.closed,1);assert.equal(x.calls.some(c=>c[0]==='screenshot'),false);
  await assert.rejects(x.render({...x.args,template:'../../config/local'}),e=>e.code==='RENDER_SCOPE');
  const missing=createNativeGachaRenderer({botRoot:x.root,getBrowser:()=>false,templateEngine:{render(){assert.fail('template compiled without browser')}}});
  await assert.rejects(missing(x.args),e=>e.code==='BROWSER_NOT_READY');
});

test('deadline closes a late-created owned context and concurrent render never creates another page',async t=>{
  let resume;const pending=new Promise(resolve=>{resume=resolve});const x=fakeRenderer(t,{contextDelay:pending,deadline:100});
  const first=x.render(x.args);await assert.rejects(x.render(x.args),e=>e.code==='RENDER_BUSY');await assert.rejects(first,e=>e.code==='RENDER_TIMEOUT');await assert.rejects(x.render(x.args),e=>e.code==='CLEANUP_PENDING');resume();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(x.closed,1);assert.equal(x.calls.some(c=>c[0]==='newPage'),false);
});

test('a failed private-context close prevents repeated rendering rather than leaking additional browser contexts',async t=>{
  const x=fakeRenderer(t,{closeFailure:true});await assert.rejects(x.render(x.args),e=>e.code==='CLEANUP_PENDING');await assert.rejects(x.render(x.args),e=>e.code==='CLEANUP_PENDING');assert.equal(x.calls.filter(c=>c[0]==='newContext').length,1);assert.equal(x.closed,1);
});
