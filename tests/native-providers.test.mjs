import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isGenshinEvent,wrapProviderClass,loadNativeProviders} from '../lib/native-providers.mjs';
import {planProviderSettings,applyProviderSettings} from '../scripts/provider-settings.mjs';

test('native providers reject all non-Genshin game markers and raw prefixes',()=>{
  for(const msg of ['*面板','%面板','#*面板','#%面板','#星铁面板','#绝区零体力','#鸣潮体力','#开启星铁体力推送','#zzz体力','/sr 面板'])assert.equal(isGenshinEvent({msg}),false,msg);
  for(const game of ['sr','zzz','ww'])assert.equal(isGenshinEvent({game,msg:'#钟离面板'}),false,game);
  assert.equal(isGenshinEvent({msg:'#钟离面板',original_msg:'*钟离面板'}),false);
  assert.equal(isGenshinEvent({msg:'#钟离面板',raw_message:'%钟离面板'}),false);
  assert.equal(isGenshinEvent({msg:'#钟离面板',game:'gs'}),true);
  assert.equal(isGenshinEvent({msg:'#原神体力'}),true);
  for(const msg of ['https://public-operation-hkrpg.mihoyo.com/common/gacha_record/api/getGachaLog?authkey=synthetic','https://api.mihoyo.com/hkrpg/?x=1','#绑定 game_biz=hkrpg_cn','#绑定 game_biz=nap_cn'])assert.equal(isGenshinEvent({msg}),false,msg);
  assert.equal(isGenshinEvent({msg:'#绑定 game_biz=hk4e_cn'}),true);
});

class ExampleApp {
  constructor(){this.rule=[{reg:'.*',fnc:'first'},{reg:'.*',fnc:'second'}];this.priority=100;this.task={cron:'0 1 * * *',fnc:()=>this.queryItem(null,'sr')};}
  first(event){return event.game;}
  second(){return 'second';}
  accept(){return 'accept';}
  saveSrUid(){throw new Error('Foreign context callback must never run');}
  saveUid(){return 'uid';}
  queryItem(tl,game){return game;}
  pushOne(tl,qq,game){return game;}
  reminderTargets(game){return [game];}
}

test('every rule, accept, and context callback guards the live event',async()=>{
  const Wrapped=wrapProviderClass(ExampleApp,{provider:'miao',key:'profile'});
  const app=new Wrapped();
  for(const rule of app.rule)assert.equal(await app[rule.fnc]({msg:'*面板'}),false);
  app.e={game:'sr',msg:'#面板'};
  assert.equal(await app.first({game:'gs',msg:'#面板'}),false);
  assert.equal(await app.accept(),false);
  app.e={msg:'#绑定uid'};
  assert.equal(await app.saveSrUid(),false);
  assert.equal(await app.saveUid(),'uid');
  assert.equal(await app.first(),'gs');
});

test('xhh background reminder query boundaries exclude foreign games',async()=>{
  const Wrapped=wrapProviderClass(ExampleApp,{provider:'xhh',key:'resinPush'});
  const app=new Wrapped();
  assert.equal(await app.queryItem(null,'sr'),null);
  assert.equal(await app.queryItem(null,'gs'),'gs');
  assert.equal(await app.pushOne(null,'123','zzz'),false);
  assert.deepEqual(app.reminderTargets('sr'),[]);
  assert.deepEqual(app.reminderTargets('gs'),['gs']);
  assert.deepEqual(app.task,[]);
});

test('bare stamina command becomes Genshin only and restores the message',async()=>{
  class Stamina {constructor(){this.rule=[{fnc:'note_',reg:'.*'}];}note_(e){return e.msg;}note(e,game){return game;}}
  const Wrapped=wrapProviderClass(Stamina,{provider:'xhh',key:'TL'});
  const app=new Wrapped(),event={msg:'#体力'};
  assert.equal(await app.note_(event),'#原神体力');
  assert.equal(event.msg,'#体力');
  assert.equal(await app.note(event,'sr'),'没有');
});

test('FanSky configuration update is owner only and unfinished functions disappear',async()=>{
  class Fan {
    constructor(){this.rule=[{fnc:'HistoryTeam',reg:'.*'},{fnc:'TeamCache',reg:'.*'},{fnc:'UpdataJSON',reg:'.*'},{fnc:'TeyvatEnTry',reg:'.*'}];}
    UpdataJSON(){return 'updated';}TeyvatEnTry(e){return e.msg;}
  }
  const Wrapped=wrapProviderClass(Fan,{provider:'fanSky',key:'BotEntry',masters:['12345']});
  const app=new Wrapped();assert.equal(app.rule.length,2);
  let warning;assert.equal(await app.UpdataJSON({msg:'#更新小助手配置',user_id:1,reply:text=>{warning=text}}),true);
  assert.match(warning,/主人/);
  assert.equal(await app.UpdataJSON({msg:'#更新小助手配置',user_id:'12345'}),'updated');
  assert.equal(await app.TeyvatStatus(),1);
  const event={msg:'#小助手队伍伤害钟离,胡桃'};
  assert.equal(await app.TeyvatEnTry(event),'#队伍伤害钟离,胡桃');assert.equal(event.msg,'#小助手队伍伤害钟离,胡桃');
});

test('isolated core reports missing providers without importing external code',async()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-provider-'));
  try {
    const result=await loadNativeProviders({root:temporary,botRoot:temporary,config:{providers:{miao:true,genshin:true,xhh:true,fanSky:true}}});
    assert.deepEqual(result.apps,{});
    assert.deepEqual(Object.values(result.status).map(item=>item.state),['missing','missing','missing','missing']);
    assert.equal(planProviderSettings(temporary).state,'missing');
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});

test('configuration staging backs up original loaders and shuts down external defaults',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-settings-'));
  try {
    const write=(file,content)=>{const target=path.join(temporary,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);};
    write('lib/plugins/plugin.js','// host marker only, never imported');
    for(const directory of ['miao-plugin','genshin','xhh-TL','FanSky_Qs'])write('plugins/'+directory+'/index.js','throw new Error("Original entrypoint must never execute")');
    write('plugins/xhh-TL/config/default_config.yaml',JSON.stringify({solver_deploy_enable:true,auto_sign_verify_addr:'https://third-party.invalid/',unknownDefault:17}));
    write('plugins/genshin/defSet/mys/pushNews.yaml',JSON.stringify({gsannounceGroup:{},srannounceGroup:{123:[456]}}));
    const plan=planProviderSettings(temporary,{yaml:{parse:JSON.parse,stringify:value=>JSON.stringify(value)}});
    assert.equal(plan.state,'ready');
    // Planning never writes or executes source.
    assert.match(fs.readFileSync(path.join(temporary,'plugins/xhh-TL/index.js'),'utf8'),/throw/);
    const config=JSON.parse(plan.writes.find(item=>item.file.endsWith(path.join('xhh-TL','config','config.yaml'))).text);
    assert.equal(config.auto_sign_verify_addr,'');assert.equal(config.solver_deploy_enable,false);assert.equal(config.bbs_coin_games,'gs');assert.equal(config.unknownDefault,17);
    const push=JSON.parse(plan.writes.find(item=>item.file.endsWith('mys.pushNews.yaml')).text);assert.deepEqual(push.srannounceGroup,{});
    assert.equal(applyProviderSettings(plan).written,plan.writes.length);
    assert.match(fs.readFileSync(path.join(temporary,'plugins/xhh-TL/index.js'),'utf8'),/export const apps = \{\}/);
    assert.match(fs.readFileSync(path.join(temporary,'plugins/xhh-TL/index.teyvat-original.js.txt'),'utf8'),/throw/);
    assert.equal(fs.existsSync(path.join(temporary,'plugins/xhh-TL/data/auto_sign.json')),false);
  }finally{assert.equal(path.dirname(temporary),path.resolve(os.tmpdir()));fs.rmSync(temporary,{recursive:true,force:true});}
});
