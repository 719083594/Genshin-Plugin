import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AccountsStore} from '../lib/accounts.mjs';
import {configureNativeAccounts,installNativeAccountGuard,runNativeScope} from '../lib/native-accounts.mjs';

const owner='100000001',other='123456789';
const cookie='ltuid=444444; cookie_token=private-native-token;';
function setup(t){
  const calls=[];
  class NoteUser{static async create(){calls.push('original-note-create');throw new Error('DB forbidden')}static async forEach(){calls.push('original-note-forEach')}}
  class MysUser{static async create(){calls.push('original-mys-create')}static async getByQueryUid(){calls.push('original-ck-pool')}static async forEach(){calls.push('original-mys-forEach')}}
  class MysInfo{static async initCache(){calls.push('original-cache')}static async init(){calls.push('original-info')}static async getUid(){calls.push('original-uid')}static async get(){calls.push('original-fetch')}}
  class MysApi{constructor(uid,ck,option={}){this.uid=uid;this.cookie=ck;this.game=option.game||'gs'}async getData(){calls.push('original-api-fetch')}async cache(){calls.push('original-api-redis')}}
  const guard=installNativeAccountGuard({NoteUser,MysUser,MysInfo,MysApi});t.after(()=>{guard.restore();configureNativeAccounts()});
  const account={uid:'123456789',region:'cn',server:'cn_gf01',hasCookie:true,selected:true,cookie};
  const second={uid:'523456789',region:'cn',server:'cn_qd01',hasCookie:true,cookie:'ltuid=555555; cookie_token=another-native-token;'};
  const records=new Map([[owner,[account,second]],[other,[{uid:'223456789',region:'cn',server:'cn_gf01',cookie:'ltuid=666666; cookie_token=other-user-token;',selected:true}]]]);
  const accounts={list:id=>(records.get(id)||[]).map(({cookie,...a})=>({...a,hasCookie:Boolean(cookie)})),get:(id,uid)=>records.get(id)?.find(a=>a.uid===uid),selected:id=>records.get(id)?.find(a=>a.selected)||null};
  const requests=[];const query=async(api,a,params)=>{requests.push({api,uid:a.uid,cookie:a.cookie,params});return {ok:true,data:api==='character'?{list:[{id:10000002}]}:{value:42}}};
  configureNativeAccounts({accounts,query});
  const event={user_id:owner,msg:'#面板',game:'gs',isGroup:false,user:{old:true},runtime:{render(){return 'render'},getUid(){throw new Error('original runtime forbidden')}},reply:async()=>{}};
  return {calls,requests,account,second,records,accounts,query,event,NoteUser,MysUser,MysInfo,MysApi};
}

test('runtime initialization before a scope receives an empty temporary user without DB/Redis fallback',async t=>{
  const {calls,event,NoteUser,MysInfo,MysUser}=setup(t);await MysInfo.initCache();const user=await NoteUser.create(event);
  assert.equal(user.uid,'');assert.equal(user.hasCk,false);assert.deepEqual(user.mysUsers,{});assert.equal(await user.save(),false);
  assert.equal(await MysUser.create('444444'),false);await NoteUser.forEach(()=>assert.fail('background enumeration'));await MysUser.forEach(()=>assert.fail('background CK pool'));assert.deepEqual(calls,[]);
});

test('owner UID/account lists and existing native getters come only from the encrypted core within a scope',async t=>{
  const {event,NoteUser,MysUser,calls}=setup(t);const previousUser=event.user,previousRuntime=event.runtime;
  await runNativeScope(event,async()=>{
    assert.equal(event.user.getUid('gs'),'123456789');assert.deepEqual(event.user.getUidList('gs').map(x=>x.uid),['123456789','523456789']);
    assert.equal((await NoteUser.create(owner)).getUid('gs'),'123456789');assert.equal((await MysUser.create('444444')).ck,cookie);
    assert.equal((await MysUser.getByQueryUid('523456789','gs')).ltuid,'555555');assert.equal(event.runtime.render(),'render');
    assert.equal(await event.user.addRegUid('323456789'),false);assert.equal(await event.user.delRegUid('123456789'),false);assert.equal(await event.user.setMainUid('523456789'),false);assert.equal(await event.user.save(),false);
    assert.equal(event.user.getUid(),'123456789');
  });assert.equal(event.user,previousUser);assert.equal(event.runtime,previousRuntime);assert.equal(event.uid,undefined);assert.deepEqual(calls,[]);
});

test('foreign games and @other owners cannot receive UID authorization or borrow cookies',async t=>{
  const {event,MysInfo,MysUser,NoteUser,requests}=setup(t);
  await runNativeScope(event,async()=>{
    assert.equal(event.user.getUid('sr'),'');assert.deepEqual(event.user.getUidList('zzz'),[]);assert.equal(await MysUser.getByQueryUid('123456789','sr'),false);
    assert.equal((await NoteUser.create(other)).hasCk,false);assert.equal(await MysUser.create('666666'),false);assert.equal(await MysUser.getByQueryUid('223456789'),false);
    event.at=other;assert.equal(await MysInfo.getSelfUid(event),false);assert.equal(await event.runtime.getMysInfo('cookie'),false);assert.equal(await MysInfo.get(event,'dailyNote'),false);
    delete event.at;event.game='sr';assert.equal(await MysInfo.getUid(event),'');assert.equal(await MysInfo.get(event,'dailyNote'),false);
  });assert.deepEqual(requests,[]);
});

test('group default is UID-only and opt-in group Cookie exposure remains scoped to the requesting owner',async t=>{
  const {event,requests}=setup(t);event.isGroup=true;event.group_id=12345;
  await runNativeScope(event,async()=>{assert.equal(event.user.uid,'123456789');assert.equal(event.user.hasCk,false);assert.deepEqual(event.user.mysUsers,{});assert.equal(await event.runtime.getMysInfo('cookie'),false)});
  await runNativeScope(event,async()=>{assert.equal(event.user.hasCk,true);const api=await event.runtime.getMysApi('cookie');assert.equal((await api.getData('dailyNote')).retcode,0)},{allowGroupCookie:true});assert.equal(requests.length,1);assert.equal(requests[0].uid,'123456789');
});

test('read-only native query adapters use the reviewed core protocol, strip native headers, and cannot sign or refresh another game',async t=>{
  const {event,requests,MysInfo,MysApi,calls}=setup(t);
  await runNativeScope(event,async()=>{
    const result=await MysInfo.get(event,'character',{headers:{Cookie:'bad-native-cookie'}});assert.deepEqual(result.data.avatars,[{id:10000002}]);assert.deepEqual(requests[0].params,{});
    const direct=new MysApi('123456789',cookie);assert.equal(direct.cookie,'');assert.equal((await direct.getData('hard_challenge_popularity')).retcode,0);assert.equal(requests.at(-1).api,'hard_challenge/popularity');
    assert.equal((await direct.getData('bbs_sign')).retcode,-1);assert.equal((await direct.getData('UserGame')).retcode,-1);assert.equal((await new MysApi('223456789',cookie).getData('dailyNote')).retcode,-1);
    assert.equal(await event.runtime.getMysApi('cookie',{},true),false);assert.equal(await direct.cache(),false);
  });assert.deepEqual(calls,[]);assert.equal(requests.length,2);
});

test('retained facade references lose Cookie access after completion, and JSON never contains Cookie/token values',async t=>{
  const {event}=setup(t);let mys,info,api,user;
  await runNativeScope(event,async()=>{user=event.user;mys=user.getMysUser();info=await event.runtime.getMysInfo('cookie');api=await event.runtime.getMysApi('cookie');assert.equal(mys.ck,cookie);assert.equal(info.ckInfo.ck,cookie);assert.doesNotMatch(JSON.stringify({user,mys,info,api}),/private-native-token|cookie_token/)});
  assert.equal(mys.ck,'');assert.equal(info.ckInfo.ck,'');assert.equal(user.hasCk,false);assert.equal((await api.getData('dailyNote')).retcode,-1);
});
test('original furniture callers normalize regex-match share codes and wrapped calculation bodies through reviewed core',async t=>{
 const {event,requests}=setup(t);await runNativeScope(event,async()=>{const api=await event.runtime.getMysApi('cookie');await api.getData('blueprint',{share_code:['1234567890123'],headers:'ignored'});await api.getData('blueprintCompute',{body:{list:[{id:123,cnt:2}]}})});assert.deepEqual(requests.map(x=>x.params),[{share_code:'1234567890123'},{list:[{id:123,cnt:2}]}]);
});

test('two overlapping QQ event scopes select their own Cookie without global cross-account contamination',async t=>{
  const {event,requests}=setup(t);let resume;const wait=new Promise(resolve=>{resume=resolve});const seen=[];
  const first=runNativeScope(event,async()=>{await wait;seen.push(event.user.getMysUser().ltuid);await (await event.runtime.getMysApi('cookie')).getData('dailyNote')});
  const second={...event,user_id:other,runtime:{render(){return 'ok'}}};await runNativeScope(second,async()=>{seen.push(second.user.getMysUser().ltuid);await (await second.runtime.getMysApi('cookie')).getData('dailyNote')});resume();await first;
  assert.deepEqual(seen,['666666','444444']);assert.deepEqual(requests.map(x=>x.uid),['223456789','123456789']);assert.equal(requests[1].cookie,cookie);
});

test('a parallel handler cannot replace the same event authorization, while nested helpers retain their existing scope',async t=>{
  const {event}=setup(t);let resume;const pending=new Promise(resolve=>{resume=resolve});
  const first=runNativeScope(event,async()=>{await runNativeScope(event,async()=>assert.equal(event.user.uid,'123456789'));await pending;assert.equal(event.user.getMysUser().ltuid,'444444')});
  await assert.rejects(runNativeScope(event,async()=>assert.fail('overlapping event handler')),/同一原生消息/);resume();await first;
});

test('handler errors restore event properties; upstream errors never expose native Cookie text',async t=>{
  const {event}=setup(t);const previousRuntime=event.runtime,previousUser=event.user;
  await assert.rejects(runNativeScope(event,async()=>{event._mys={ck:cookie};throw new Error('handler-failed')}),/handler-failed/);assert.equal(event.runtime,previousRuntime);assert.equal(event.user,previousUser);assert.equal(event._mys,undefined);
  await runNativeScope(event,async()=>{const response=await (await event.runtime.getMysApi('cookie')).getData('dailyNote');assert.equal(response.retcode,-1);assert.doesNotMatch(response.message,/private-native-token|cookie_token/)},{query:async()=>{throw new Error(cookie)}});
});

test('native static dispatch supports only current-owner enumeration and never populates a global CK pool',async t=>{
  const {event,NoteUser,MysUser,MysInfo}=setup(t);await runNativeScope(event,async()=>{
    const users=[],mys=[];await NoteUser.forEach(user=>users.push(user.qq));await MysUser.forEach(user=>mys.push(user.ltuid));assert.deepEqual(users,[owner]);assert.deepEqual(mys,['444444','555555']);assert.deepEqual(await MysInfo.getBingCkUid(),{});
    const own=await MysUser.create(cookie);assert.equal(own.ltuid,'444444');assert.equal(await MysUser.create('ltuid=444444; cookie_token=wrong-token;'),false);assert.equal(await own.reqMysUid().then(x=>x.status),2);assert.equal(await own.initCache(),false);assert.equal(await own.addQueryUid('123456789'),false);
  });
});

test('with a real encrypted AccountStore, querying a native account does not change plaintext or ciphertext files',async t=>{
  const {event,query}=setup(t);const root=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-native-account-'));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const accounts=new AccountsStore(root,{key:'12'.repeat(32)});accounts.bind(owner,{uid:'123456789',cookie,privateChat:true});const before=fs.readFileSync(accounts.file,'utf8');
  await runNativeScope(event,async()=>{assert.equal(event.user.getUid(),'123456789');const info=await event.runtime.getMysInfo('cookie');assert.equal(info.ckInfo.ck,cookie);await event.user.save();await info.ckUser.save();await info.ckUser.initCache();await info.ckUser.addQueryUid('123456789');await (await event.runtime.getMysApi('cookie')).getData('index')},{accounts,query});
  assert.equal(fs.readFileSync(accounts.file,'utf8'),before);assert.deepEqual(fs.readdirSync(path.join(root,'data')),['accounts.enc.json']);assert.doesNotMatch(before,/123456789|444444|native-token/);
});
