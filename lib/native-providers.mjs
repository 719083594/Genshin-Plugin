import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runNativeScope,queryNativeScoped} from './native-accounts.mjs';
import {runNativeGacha} from './native-gacha.mjs';

// The original projects remain external, separately licensed dependencies.
// Never import their top-level entrypoints: those may install unrelated apps,
// refresh credentials, download resources, or start administrative hooks.
export const providerSnapshots = Object.freeze({
  miao: {directory:'miao-plugin',commit:'b01d77483268eb2236876ad0995fab27052c09ad',license:'MIT'},
  genshin: {directory:'genshin',commit:'4a2e1fb8f094b2a8f039ce0768773701718b60b9',license:'GPL-3.0 provenance; see docs/NATIVE-PROVIDERS.md'},
  xhh: {directory:'xhh-TL',commit:'1b5e5644c9351fcfd950acabf2c791060a7c44b6',license:'MIT'},
  fanSky: {directory:'FanSky_Qs',commit:'86d002866114fa1dd1c765325fde621925938adc',license:'Apache-2.0'}
});

const foreignGame = /(?:星铁|崩铁|星穹|铁道|星轨|穹轨|绝区零|鸣潮|崩坏(?:三|3|二|2)|崩三|崩二|崩坏学园|未定事件簿|未定|三游戏|四游戏)/i;
const foreignAlias = /^(?:[#/]*\s*)(?:sr|hsr|xt|zzz|ww|mc|zmd)(?=[\s\u4e00-\u9fff]|$)/i;
const foreignMethod = /(?:Sr(?:All|Uid)?$|Zzz(?:All|Uid)?$|Ww(?:All)?$|Waves|hsrMaze|saveSrUid|saveZzzUid)/;
const removedMethods = new Set(['HistoryTeam','updatePlugin','update','updateRes','TeamCache']);

export function isGenshinEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.game && !['gs','ys','genshin','hk4e_cn','hk4e_global'].includes(String(event.game).toLowerCase())) return false;
  if (event.isSr === true) return false;
  for (const text of [event.msg,event.original_msg,event.raw_message]) {
    if (typeof text !== 'string') continue;
    const trimmed=text.trim();
    if (/^[#/]*\s*[*%]/.test(trimmed) || foreignGame.test(trimmed) || foreignAlias.test(trimmed)) return false;
    if (/\/(?:hkrpg|nap|common)\//i.test(trimmed) || /(?:game_biz|game_biz%3d)\s*(?:=|%3d)\s*(?!hk4e(?:_|%5f))\w+/i.test(trimmed)) return false;
  }
  return true;
}

function ownerAllowed(event,masters) {
  return event?.isMaster === true || masters.map(String).includes(String(event?.user_id));
}

// Exported to allow meaningful isolation tests without running downloaded code.
export function wrapProviderClass(Base,{provider,key,masters=[],disableTasks=false}={}) {
  if (typeof Base !== 'function') throw new TypeError('Provider app is not a class');
  return class GenshinProvider extends Base {
    constructor(...args) {
      super(...args);
      this.namespace='Teyvat:'+provider+':'+key;
      this.name='提瓦特 / '+(this.name || key || provider);
      const originalRules=Array.isArray(this.rule)?this.rule:[];
      this.rule=originalRules.filter(rule=>!removedMethods.has(rule.fnc)&&!foreignMethod.test(String(rule.fnc)));
      // TRSS considers many miao:false settings forced true; restrict help here.
      if (provider==='miao'&&key==='help') {
        this.rule=this.rule.map(rule=>rule.fnc==='help'?{...rule,reg:'^[#/]?喵喵(?:命令|帮助|菜单|help|说明|功能|指令|使用说明)$'}:rule);
      }
      if (provider==='genshin'&&key==='mysNews') {
        // The original ActivityPush always fetches SR as well as GI. Keep the
        // GI article queries; activity reminders require a dedicated GI task.
        this.rule=this.rule.filter(rule=>!['setActivityPush','mysNewsTask'].includes(rule.fnc));
        disableTasks=true;
      }
      if (provider==='xhh'&&key==='TL') {
        this.rule=this.rule.filter(rule=>!['toggleSrDisplay','toggleZzzDisplay','toggleWavesDisplay'].includes(rule.fnc));
      }
      if (disableTasks) this.task=[];
      // Account reminders run through the encrypted core. External background
      // scanners may read/write their own unencrypted cookie/UID stores.
      if(provider==='xhh'&&['resinPush','autoSign','autoBbsCoin'].includes(key))this.task=[];
      if(provider==='miao'&&key==='admin')this.rule=this.rule.filter(rule=>rule.fnc!=='miaoApiInfo'&&rule.key!=='miaoApiInfo');
      if(provider==='genshin'&&key==='ledger'){this.task=[];this.rule=this.rule.filter(rule=>rule.fnc!=='ledgerTask')}
      if(provider==='xhh'&&key==='TL'){
        this.noteViaCookie=async(event,game,cookie,uid)=>game==='gs'?queryNativeScoped(uid,'dailyNote'):false;
        this.getGameDate=async(event,headers,uid)=>{const result=await queryNativeScoped(uid,'index');const role=result.retcode===0?result.data?.role:null;return role?{level:role.level,name:role.nickname}:{};};
        const finish=this.finishNote;if(typeof finish==='function')this.finishNote=(event,game,response,uid,headers,options)=>game==='gs'?finish.call(this,event,game,response,uid,{...headers,Cookie:''},options):Promise.resolve(false);
      }
      // Resolve collisions deterministically: xhh is the team calculation
      // provider; FanSky remains available through its explicit namespace.
      if (provider==='fanSky') {
        this.rule=this.rule.map(rule=>rule.fnc==='TeyvatEnTry'?{...rule,reg:'^#(?:小助手队伍伤害(?:详情|过程|全图)?|单人评级)(\\d+)?(.*)$'}:rule);
      }
      const methods=new Set(this.rule.map(rule=>rule.fnc).filter(name=>typeof name==='string'));
      methods.add('accept');
      // Context callbacks are dispatched separately from rule handlers by TRSS.
      for (const name of ['saveUid','saveSrUid','saveZzzUid','saveCk','saveCookie','uploadImg','uploadCharacterImg','setAbbr','logJsonFile','pubCk']) methods.add(name);
      for (const name of methods) {
        const original=this[name];
        if (typeof original!=='function') continue;
        this[name]=async (...callArgs)=>{
          const event=this.e || callArgs[0];
          if (!isGenshinEvent(event)||foreignMethod.test(name)) return false;
          if (provider==='fanSky'&&name==='UpdataJSON'&&!ownerAllowed(event,masters)) {
            await event.reply?.('只有机器人主人可以更新小助手配置。');
            return true;
          }
          event.game='gs';
          if (!callArgs.length) callArgs=[event];
          if(provider==='miao'&&key==='gacha'&&['detail','stat','Yzdetail','Yzstat'].includes(name)){
            const previous=event.msg;
            // The fixed original detail parser does not strip its 喵喵 prefix.
            if(['detail','Yzdetail'].includes(name))event.msg=String(event.msg||'').replace(/^#*喵喵/,'#');
            try{return await runNativeScope(event,()=>runNativeGacha(event,()=>original.apply(this,callArgs)))}finally{event.msg=previous}
          }
          if (provider==='xhh'&&key==='TL'&&name==='note_') {
            // Bare #体力 otherwise queries all three HoYoverse games.
            const previous=event.msg;
            if (/^\s*#?(?:全体力|米游社体力|体力总览|体力|tl)\s*$/i.test(previous||'')) event.msg='#原神体力';
            try{return await runNativeScope(event,()=>original.apply(this,callArgs));}finally{event.msg=previous;}
          }
          if (provider==='fanSky'&&name==='TeyvatEnTry'&&/^#小助手队伍伤害/.test(event.msg||'')) {
            const previous=event.msg;event.msg=event.msg.replace(/^#小助手队伍伤害/,'#队伍伤害');
            try{return await runNativeScope(event,()=>original.apply(this,callArgs));}finally{event.msg=previous;}
          }
          return runNativeScope(event,()=>original.apply(this,callArgs));
        };
      }
      if (provider==='fanSky') this.TeyvatStatus=async()=>1;
      // Background jobs are not message handlers. Block foreign-game reads at
      // their actual query boundary as well, including migrated subscriptions.
      if (provider==='xhh'&&key==='resinPush') {
        for (const [name,index,fallback] of [['queryItem',1,null],['pushOne',2,false],['reminderTargets',0,[]]]) {
          const original=this[name];
          if(typeof original==='function')this[name]=(...callArgs)=>callArgs[index]==='gs'?original.apply(this,callArgs):fallback;
        }
      }
      if (provider==='xhh'&&key==='TL') {
        const original=this.note;
        if(typeof original==='function')this.note=(event,game='gs',...rest)=>game==='gs'?original.call(this,event,game,...rest):Promise.resolve('没有');
      }
    }
  };
}

function readConfig(root) {
  try {return JSON.parse(fs.readFileSync(path.join(root,'config/local.json'),'utf8'));} catch {return {};}
}

export async function loadNativeProviders({root=fileURLToPath(new URL('..',import.meta.url)),config,botRoot}={}) {
  config=config||readConfig(root);
  botRoot=botRoot||path.resolve(root,'../..');
  const apps={},status={};
  const host=fs.existsSync(path.join(botRoot,'lib/plugins/plugin.js'));
  const enabled=config.providers||{};
  const add=(provider,key,Base,options={})=>{
    if(typeof Base!=='function')throw new TypeError('Missing exported class: '+key);
    apps['TeyvatNative_'+provider+'_'+key]=wrapProviderClass(Base,{provider,key,masters:config.masters||[],...options});
  };
  const importFile=file=>import(pathToFileURL(file).href);
  for(const [provider,meta] of Object.entries(providerSnapshots)) {
    const flag=provider==='fanSky'?(enabled.fanSky??enabled.fansky):enabled[provider];
    if(flag!==true){status[provider]={state:'disabled',commit:meta.commit};continue;}
    const directory=path.join(botRoot,'plugins',meta.directory);
    if(!host||!fs.existsSync(directory)){status[provider]={state:'missing',commit:meta.commit};continue;}
    const before=Object.keys(apps).length,failures=[];
    const load=async(key,file,exportName=key,options={})=>{
      try{const module=await importFile(path.join(directory,file));add(provider,key,module[exportName]||module.default,options);}
      catch(error){failures.push({app:key,code:error?.code||error?.name||'IMPORT_FAILED'});}
    };
    if(provider==='miao') {
      try {
        const module=await importFile(path.join(directory,'apps/index.js'));
        for(const [key,Base] of Object.entries(module.apps||{}))add(provider,key,Base);
      } catch(error){failures.push({app:'apps/index',code:error?.code||error?.name||'IMPORT_FAILED'});}
    } else if(provider==='genshin') {
      const folder=path.join(directory,'apps');
      if(fs.existsSync(folder))for(const file of fs.readdirSync(folder).filter(name=>name.endsWith('.js')&&!['noteZzz.js','user.js','userAdmin.js','setPubCk.js','payLog.js','gcLog.js'].includes(name)).sort()) {
        const key=file.slice(0,-3);
        try{const module=await importFile(path.join(folder,file));const Base=Object.values(module).find(value=>typeof value==='function');add(provider,key,Base);}
        catch(error){failures.push({app:key,code:error?.code||error?.name||'IMPORT_FAILED'});}
      }else failures.push({app:'apps',code:'MISSING_APPS'});
    } else if(provider==='xhh') {
      for(const key of ['TL','teamDamage','role_combat','miniRoleCombat','gsAllAbyss','abyssTeam','hardTeam','holdRate','nanokaAbyss'])await load(key,'apps/'+key+'.js');
    } else if(provider==='fanSky') {
      await load('BotEntry','apps/Teyvat/BotEntry.js');
    }
    const loaded=Object.keys(apps).length-before;
    status[provider]={state:failures.length?(loaded?'partial':'error'):'loaded',apps:loaded,commit:meta.commit,...(failures.length?{failures}:{})};
  }
  return {apps,status};
}
