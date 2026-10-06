import {AsyncLocalStorage} from 'node:async_hooks';
import {normalizeCookie,validateUid} from './accounts.mjs';

/**
 * Ephemeral adapters for the audited TRSS runtime / Yunzai-genshin APIs.
 * Source: Yunzai-genshin 4a2e1fb8f094b2a8f039ce0768773701718b60b9,
 * model/mys/{NoteUser,MysUser,mysInfo,mysApi}.js; TRSS runtime 79a79c3.
 * No original NoteUser/MysUser constructor, DB method, CK pool, or Redis writer
 * is called. Public/personal renderers may have other caches: this module is
 * not a filesystem sandbox for arbitrary external plugin code.
 */
const storage=new AsyncLocalStorage();
let configured={accounts:null,query:null,allowGroupCookie:false};
const installed=new WeakMap();
const runningEvents=new WeakSet();
const READ_APIS=new Set(['index','dailyNote','spiralAbyss','role_combat','hard_challenge','hard_challenge_popularity','character','characterDetail','detail','avatarSkill','compute','act_calendar','activities','gcg/basicInfo','gcg/matchList','char_master','ledger','ys_ledger','blueprint','blueprintCompute','deckList','gcg/deckList','tcgCards','gcg/cardList','avatar_cardList','action_cardList']);
const CORE_API={hard_challenge_popularity:'hard_challenge/popularity'};
const NO_PERSIST=async()=>false;
const emptyMap=()=>({map:{},list:[]});
const gameKey=value=>{if(value&&typeof value==='object')value=value.game||(value.isSr?'sr':'gs');return value===undefined||value===''||['gs','ys','genshin','hk4e_cn','hk4e_global'].includes(value)?'gs':''};
const ownerKey=value=>{const text=String(value?.user_id??value??'');return /^[1-9]\d{4,14}$/.test(text)?text:''};
const current=()=>{const scope=storage.getStore();return scope?.active?scope:null};
const live=scope=>Boolean(scope?.active&&current()===scope);
const safeFailure=(api,message='该原生接口暂未接入加密账户会话，请使用 #原神 对应命令。')=>({retcode:-1,message,data:{},api});

export function configureNativeAccounts(options={}){
  if(options.accounts&&['list','selected','get'].some(key=>typeof options.accounts[key]!=='function'))throw new TypeError('Invalid encrypted account store');
  if(options.query!==undefined&&options.query!==null&&typeof options.query!=='function')throw new TypeError('Invalid native query adapter');
  configured={accounts:options.accounts||null,query:options.query||null,allowGroupCookie:options.allowGroupCookie===true};
}

function passport(cookie){const fields=new Map(cookie.split(';').map(x=>{const at=x.indexOf('=');return [x.slice(0,at).trim(),x.slice(at+1).trim()]}));return fields.get('ltuid')||fields.get('ltuid_v2')||fields.get('account_id')||fields.get('account_id_v2')||''}
function cookieAllowed(scope){return live(scope)&&(scope.allowGroupCookie||(!scope.event.isGroup&&!scope.event.group_id&&scope.event.privateChat!==false))}
function accountFor(scope,uid){if(!live(scope))return null;return scope.accounts.get(String(uid))||null}
function credentialFor(scope,uid){const account=accountFor(scope,uid);return cookieAllowed(scope)&&account?.cookie?account:null}
function targetUid(scope,event=scope?.event,match=true){
  if(!live(scope)||!gameKey(event)||event?.isSr||ownerKey(event)!==scope.owner)return '';
  if(event?.at&&!event.atBot&&String(event.at)!==scope.owner)return '';
  if(match&&event?.uid){try{return validateUid(event.uid).uid}catch{return ''}}
  return scope.selected?.uid||'';
}

function cookieInfo(scope,account){
  const value={uid:account.uid,qq:scope.owner,ltuid:account.ltuid,type:account.region==='cn'?'mys':'hoyolab'};
  Object.defineProperty(value,'ck',{enumerable:false,get:()=>credentialFor(scope,account.uid)?.cookie||'',set:()=>{}});
  value.toJSON=()=>({uid:value.uid,qq:value.qq,type:value.type});
  return value;
}

function memoryMysUser(scope,id){
  const rows=()=>live(scope)?[...scope.accounts.values()].filter(x=>x.ltuid===id&&credentialFor(scope,x.uid)):[];
  const first=()=>rows().find(x=>x.uid===targetUid(scope))||rows()[0];
  const mys={
    ltuid:id,
    get type(){return first()?.region==='os'?'hoyolab':'mys'},
    get uid(){return first()?.uid||''},
    get uids(){return {gs:rows().map(x=>x.uid),sr:[],zzz:[]}},
    get device(){return ''},
    getUids(game='gs'){return gameKey(game)?rows().map(x=>x.uid):[]},
    getUid(game='gs'){return gameKey(game)?first()?.uid||'':''},
    hasGame(game='gs'){return this.getUids(game).length>0},
    hasUid(uid,game='gs'){return gameKey(game)&&rows().some(x=>x.uid===String(uid))},
    ownUid(uid,game='gs'){return this.hasUid(uid,game)},
    getUidData(uid,game='gs'){return this.hasUid(uid,game)?{uid:String(uid),type:'ck',ltuid:id,game:'gs'}:false},
    getCkInfo(game='gs'){const account=gameKey(game)&&first();return account?cookieInfo(scope,account):{uid:'',qq:scope.owner,type:'',ck:''}},
    getUidInfo(){return rows().length?'【原神】:'+rows().map(x=>x.uid).join(', '):''},
    // Read-only session: none of these compatibility methods save or mutate CKs.
    save:NO_PERSIST,initCache:NO_PERSIST,addQueryUid:NO_PERSIST,addUid:()=>false,setCkData:()=>false,
    disable:NO_PERSIST,del:NO_PERSIST,delWithUser:NO_PERSIST,_delCache:()=>false,
    getQueryUids:async()=>[],getQueryLtuid:async()=>'',
    reqMysUid:async()=>({status:2,msg:'原生跨游戏角色刷新已停用；请通过加密核心重新验证本人原神授权。'})
  };
  Object.defineProperty(mys,'ck',{enumerable:false,get:()=>first()?.cookie||'',set:()=>{}});
  Object.defineProperty(mys,'cookie',{enumerable:false,get:()=>first()?.cookie||'',set:()=>{}});
  mys.toJSON=()=>({type:mys.type,uids:mys.uids});
  return Object.freeze(mys);
}

function memoryUser(scope,owner){
  const own=()=>live(scope)&&owner===scope.owner;
  const accounts=()=>own()?[...scope.accounts.values()]:[];
  const data=uid=>{const account=accounts().find(x=>x.uid===String(uid));if(!account)return false;const cookie=credentialFor(scope,account.uid);return {uid:account.uid,type:cookie?'ck':'reg',...(cookie?{ltuid:account.ltuid}:{}),game:'gs'}};
  const user={
    qq:owner,
    get uid(){return own()?scope.selected?.uid||'':''},
    get _regUid(){return this.uid},
    get hasCk(){return accounts().some(x=>credentialFor(scope,x.uid))},
    get mysUsers(){if(!own())return {};return Object.fromEntries([...scope.mysUsers].filter(([,mys])=>mys.hasGame('gs')))},
    get ckUids(){return this.getCkUidList('gs').map(x=>x.uid)},
    get uidList(){return this.getUidList('gs')},
    get uidData(){return this.getUidData()},
    get mysUser(){return this.getMysUser()},
    get ckUidList(){return this.getCkUidList()},
    get cks(){return {}},
    getUid(game='gs'){return gameKey(game)?this.uid:''},
    getUidList(game='gs'){return gameKey(game)?accounts().map(x=>data(x.uid)):[]},
    getCkUidList(game='gs'){return this.getUidList(game).filter(x=>x.type==='ck')},
    getCkUid(game='gs'){const ownList=this.getCkUidList(game);return ownList.find(x=>x.uid===this.uid)?.uid||ownList[0]?.uid||''},
    getUidData(uid='',game='gs'){return gameKey(game)?data(uid||this.uid):false},
    hasUid(uid='',game='gs'){return gameKey(game)&&(uid?Boolean(data(uid)):accounts().length>0)},
    getUidMapList(game='gs',type='all'){const list=type==='ck'?this.getCkUidList(game):this.getUidList(game);return {list,map:Object.fromEntries(list.map(x=>[x.uid,x]))}},
    getGameDs(game='gs'){const map=this.getUidMapList(game).map;return {uid:this.getUid(game),data:map}},
    getMysUser(game='gs'){if(!gameKey(game))return false;const account=credentialFor(scope,this.uid);return account?scope.mysUsers.get(account.ltuid)||false:false},
    autoRegUid(uid='',game='gs'){return gameKey(game)&&own()?String(uid||this.uid):''},
    // Account management belongs exclusively to the encrypted core.
    save:NO_PERSIST,initCache:NO_PERSIST,initDB:NO_PERSIST,initMysUser:NO_PERSIST,
    addRegUid:()=>false,delRegUid:()=>false,setMainUid:()=>false,addMysUser:NO_PERSIST,delMysUser:NO_PERSIST,delCk:NO_PERSIST,
    eachMysUser:async fn=>{if(own())for(const mys of Object.values(user.mysUsers))await fn(mys,mys.ltuid)},
    eachAllMysUser:NO_PERSIST,checkCk:async()=>[],
    toJSON:()=>({temporary:true,hasCk:user.hasCk})
  };
  return Object.freeze(user);
}

function emptyUser(owner=''){return memoryUser(null,owner)}
function findMysUser(scope,input){
  if(!live(scope)||!cookieAllowed(scope))return false;
  if(input&&typeof input==='object')input=input.ltuid||'';
  if(typeof input==='string'&&input.includes('=')){
    let normalized;try{normalized=normalizeCookie(input)}catch{return false}
    const account=[...scope.accounts.values()].find(x=>x.cookie===normalized);return account?scope.mysUsers.get(account.ltuid)||false:false;
  }
  return scope.mysUsers.get(String(input||''))||false;
}

async function scopedQuery(scope,uid,api,data={}){
  if(!live(scope)||!gameKey(scope.event)||scope.event.isSr||!READ_APIS.has(api)||typeof scope.query!=='function')return safeFailure(api);
  const account=credentialFor(scope,uid);if(!account)return safeFailure(api,'当前QQ未授权此原神UID；不会借用其他用户或公共Cookie。');
  const params=data&&typeof data==='object'&&!Array.isArray(data)?{...data}:{};
  // Native callers add their own device headers; the reviewed core owns headers.
  delete params.headers;delete params.Getfp;
  if(api==='blueprint'&&Array.isArray(params.share_code))params.share_code=params.share_code[0];
  if(api==='blueprintCompute'&&params.body&&typeof params.body==='object'&&!Array.isArray(params.body)){params.list=params.body.list;delete params.body;}
  try{
    const result=await scope.query(CORE_API[api]||api,{...account},params);
    if(!live(scope))return safeFailure(api,'此原生授权会话已结束。');
    if(!result?.ok)return safeFailure(api,'官方查询未完成；请在官方App验证授权后重试。');
    const payload=structuredClone(result.data||{});
    if(api==='character'&&payload.list&&!payload.avatars)payload.avatars=payload.list;
    return {retcode:0,message:'OK',data:payload,api};
  }catch{return safeFailure(api,'原神查询暂不可用；凭据不会写入原生账号库。')}
}

function apiAdapter(scope,uid){return {uid,game:'gs',getData:(api,data)=>scopedQuery(scope,uid,api,data),get cookie(){return ''},cache:NO_PERSIST}}
export const queryNativeScoped=(uid,api,data={})=>scopedQuery(current(),String(uid),api,data);
function mysInfo(scope,event=scope?.event,api='all'){
  const uid=targetUid(scope,event);if(!uid)return false;
  const account=credentialFor(scope,uid);
  if(api==='cookie'&&!account)return false;
  const ckInfo=account?cookieInfo(scope,account):{uid,qq:scope.owner,type:'',ck:''};
  return {
    e:event,uid,ckInfo,ckUser:account?scope.mysUsers.get(account.ltuid):null,
    isSelf:Boolean(account),gtest:false,
    checkAuth:name=>name==='cookie'||READ_APIS.has(name),
    checkCode:async response=>response||safeFailure(api),checkReply:NO_PERSIST,
    getCookie:async(game='gs')=>gameKey(game)?credentialFor(scope,uid)?.cookie||'':'',
    delCk:NO_PERSIST,disableToday:NO_PERSIST,
    toJSON:()=>({uid,temporary:true,authorized:Boolean(credentialFor(scope,uid))})
  };
}

function runtimeAdapter(scope,runtime){
  const result=Object.create(runtime||null);
  Object.defineProperties(result,{
    _xhhLiteMysApi:{value:true,configurable:true},
    e:{value:scope.event,configurable:true},_mysInfo:{value:{},configurable:true},
    getUid:{value:async()=>targetUid(scope),configurable:true},
    getMysInfo:{value:async(type='all')=>mysInfo(scope,scope.event,type),configurable:true},
    getMysApi:{value:async(type='all',option={},isSr=false)=>{const info=mysInfo(scope,scope.event,type);return !isSr&&gameKey(option)&&info&&credentialFor(scope,info.uid)?apiAdapter(scope,info.uid):false},configurable:true},
    createMysApi:{value:(uid,ck,option={},isSr=false)=>!isSr&&gameKey(option)&&credentialFor(scope,uid)?apiAdapter(scope,String(uid)):false,configurable:true}
  });
  return result;
}

/**
 * `accounts` must be the owner's encrypted AccountsStore. `query` has the same
 * (api, account, params) signature and sanitized result as HoyolabClient.query.
 * Group Cookie use is explicit; the default bridge exposes UID-only in groups.
 */
export async function runNativeScope(event,handler,options={}){
  if(typeof handler!=='function')throw new TypeError('Native handler must be a function');
  if(!event||typeof event!=='object')throw new TypeError('Native event must be an object');
  if(current()?.event===event)return handler();
  if(runningEvents.has(event))throw new Error('同一原生消息正在处理，请稍后重试。');
  runningEvents.add(event);
  const setup={...configured,...options};
  const owner=ownerKey(event),scope={owner,event,active:true,accounts:new Map(),mysUsers:new Map(),selected:null,query:setup.query,allowGroupCookie:setup.allowGroupCookie===true};
  try{if(owner&&setup.accounts&&gameKey(event)&&!event.isSr){
    const rows=setup.accounts.list(owner)||[];
    for(const row of rows){
      const loaded=setup.accounts.get(owner,row.uid);if(!loaded)continue;
      const valid=validateUid(loaded.uid,loaded.server||loaded.region);
      const cookie=loaded.cookie?normalizeCookie(loaded.cookie):'';
      scope.accounts.set(valid.uid,{...valid,cookie,ltuid:cookie?passport(cookie):'',label:String(loaded.label||'')});
    }
    const selected=setup.accounts.selected(owner);scope.selected=selected?scope.accounts.get(String(selected.uid))||null:null;
    for(const account of scope.accounts.values())if(account.ltuid&&!scope.mysUsers.has(account.ltuid))scope.mysUsers.set(account.ltuid,memoryMysUser(scope,account.ltuid));
  }}catch(error){runningEvents.delete(event);throw error}
  const keys=['user','uid','runtime','_mys','targetUser','selfUser','isSelfCookie','_original_reply','_reqCount','_retcode','reply'];
  const previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(event,key)]));
  try{return await storage.run(scope,async()=>{
    event.user=memoryUser(scope,owner);event.uid=scope.selected?.uid||'';event.runtime=runtimeAdapter(scope,previous.get('runtime')?.value||event.runtime);
    return await handler();
  })}finally{
    runningEvents.delete(event);
    scope.active=false;for(const account of scope.accounts.values())account.cookie='';scope.accounts.clear();scope.mysUsers.clear();scope.selected=null;
    for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(event,key,descriptor);else delete event[key]}
  }
}

/** Patch only verified source APIs. There is intentionally no original fallback. */
export function installNativeAccountGuard({NoteUser,MysUser,MysInfo,MysApi}={}){
  const restores=[];
  const replace=(target,key,value)=>{
    if(!target)return;
    const previous=Object.getOwnPropertyDescriptor(target,key);
    const installedKeys=installed.get(target)||new Set();if(installedKeys.has(key))return;
    Object.defineProperty(target,key,{value,writable:true,configurable:true});installedKeys.add(key);installed.set(target,installedKeys);
    restores.push(()=>{if(previous)Object.defineProperty(target,key,previous);else delete target[key];installedKeys.delete(key)});
  };
  replace(NoteUser,'create',async value=>{const scope=current(),owner=ownerKey(value),allowedGame=typeof value==='object'?gameKey(value):true;const user=scope&&owner===scope.owner&&allowedGame?memoryUser(scope,owner):emptyUser(owner);if(value&&typeof value==='object'&&value.user_id)value.user=user;return user});
  replace(NoteUser,'forEach',async fn=>{const scope=current();if(scope?.selected)await fn(memoryUser(scope,scope.owner))});
  replace(MysUser,'create',async value=>findMysUser(current(),value));
  replace(MysUser,'getByQueryUid',async(uid,game='gs')=>{const scope=current(),account=gameKey(game)&&credentialFor(scope,uid);return account?scope.mysUsers.get(account.ltuid)||false:false});
  replace(MysUser,'forEach',async fn=>{const scope=current();if(scope)for(const mys of scope.mysUsers.values())if(mys.hasGame())await fn(mys)});
  for(const key of ['initCache','initUserCk','initPubCk','delDisable','initDB','clearCache','eachServ'])replace(key==='initDB'?NoteUser:key==='eachServ'||key==='clearCache'?MysUser:MysInfo,key,NO_PERSIST);
  replace(MysUser,'delDisable',async()=>0);replace(MysUser,'checkCkStatus',async()=>({status:2,msg:'请通过加密核心更新授权。',uids:[]}));
  replace(MysInfo,'getUid',async(event,match=true)=>targetUid(current(),event,match));
  replace(MysInfo,'getSelfUid',async event=>{const scope=current(),uid=targetUid(scope,event);return credentialFor(scope,uid)?uid:false});
  replace(MysInfo,'init',async(event,api)=>mysInfo(current(),event,api));
  replace(MysInfo,'get',async(event,api,data={})=>{
    const scope=current(),uid=targetUid(scope,event);if(!uid)return false;
    if(api&&typeof api==='object'&&!Array.isArray(api)){const result=[];for(const [name,params] of Object.entries(api))result.push(await scopedQuery(scope,uid,name,params));return result}
    return scopedQuery(scope,uid,api,data);
  });
  replace(MysInfo,'checkUidBing',async(uid,game='gs')=>{const scope=current(),account=gameKey(game)&&credentialFor(scope,uid);return account?scope.mysUsers.get(account.ltuid)||false:false});
  replace(MysInfo,'getBingCkUid',async()=>({}));
  // Direct native calculator/ledger construction must also bypass its Redis
  // response cache and original fetch. Credentials are discarded at assignment.
  if(MysApi?.prototype){
    replace(MysApi.prototype,'getData',function(api,data){const scope=current();return scope&&gameKey(this.game)?scopedQuery(scope,String(this.uid),api,data):Promise.resolve(false)});
    replace(MysApi.prototype,'cache',NO_PERSIST);
    const target=MysApi.prototype,key='cookie',previous=Object.getOwnPropertyDescriptor(target,key),keys=installed.get(target)||new Set();
    if(!keys.has(key)){Object.defineProperty(target,key,{configurable:true,get:()=>'',set:()=>{}});keys.add(key);installed.set(target,keys);restores.push(()=>{if(previous)Object.defineProperty(target,key,previous);else delete target[key];keys.delete(key)})}
  }
  return {installed:restores.length,restore(){for(const restore of restores.reverse())restore()}};
}

/** Credential-writing classes are excluded by the provider loader, not just guards. */
export const forbiddenNativeAccountApps=Object.freeze({genshin:['user','setPubCk','userAdmin','payLog','gcLog'],xhh:['autoBbsCoin']});
export const nativeAccountSource=Object.freeze({genshinCommit:'4a2e1fb8f094b2a8f039ce0768773701718b60b9',runtimeCommit:'79a79c3defd9111429cd1da2acd120f22e68aa29',readApis:[...READ_APIS],limitations:['原生账户管理/公共CK/跨QQ绑定停用','无stoken持久化或社区米游币自动任务','UserGame/getFp/充值authkey未接入','外部渲染器的面板/群榜缓存需另行审计，账户桥不是文件沙箱']});
