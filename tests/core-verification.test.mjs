import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Teyvat} from '../api.mjs';

test('manual verification commands are private, use current owner and preserve HTML as an in-memory file',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-verification-core-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const engine=new Teyvat(root);const owner='100000001';engine.accounts.bind(owner,{uid:'123456789',cookie:'ltuid=10001; ltoken=synthetic-test-cookie;',privateChat:true});
 let calls=0,cancelled=0;engine.verification={start:async(id,account,options)=>{calls++;assert.equal(id,owner);assert.equal(account.uid,'123456789');assert.equal(options.privateChat,true);return {ok:true,text:'本人验证说明',file:{name:'Miyoushe-Verification.html',data:'<html>synthetic challenge</html>'}}},finish:async(id,arg,account)=>{calls++;assert.equal(arg,'synthetic-receipt');assert.equal(account.uid,'123456789');return {ok:true,text:'官方已接受本人回执'}},cancel:()=>{cancelled++;return {ok:true,text:'已清理'}}};
 for(const cmd of ['安全验证','提交验证 synthetic-receipt','取消验证'])assert.match((await engine.handle({owner,group_id:'200000001',privateChat:true,text:'#原神'+cmd})).text,/私聊/);
 assert.equal(calls,0);assert.equal(cancelled,0);
 const result=await engine.handle({owner,privateChat:true,text:'#原神安全验证'});assert.equal(result.file.name,'Miyoushe-Verification.html');assert.equal(result.text,'本人验证说明');assert.equal(fs.existsSync(path.join(root,'data/exports/Miyoushe-Verification.html')),false);
 assert.match((await engine.handle({owner,privateChat:true,text:'#原神提交验证 synthetic-receipt'})).text,/已接受/);
 assert.match((await engine.handle({owner,privateChat:true,text:'#原神取消验证'})).text,/清理/);
 await engine.handle({owner,privateChat:true,text:'#原神切换 123456789'});await engine.handle({owner,privateChat:true,text:'#原神解绑 123456789'});assert.equal(cancelled,3);
});
