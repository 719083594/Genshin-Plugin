import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Teyvat} from '../api.mjs';
const OWNER='100000001',UID='123456789';
const COOKIE='ltuid=123456; ltoken=synthetic-readonly-token;';
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-readonly-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const calls=[];const bot=new Teyvat(root,{fetch:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({retcode:0,data:url.includes('getUserMissionsState')?{total_points:100,already_received_points:20,today_total_points:80,states:[{mission_id:59,process:2,is_get_award:false}]}:{points:200}}),{headers:{'content-type':'application/json'}})}});bot.accounts.bind(OWNER,{uid:UID,cookie:COOKIE,privateChat:true});return {bot,calls};}
test('community reads stay private and owner-isolated without network on rejection',async t=>{const {bot,calls}=setup(t);for(const cmd of ['米游币','米游币任务']){assert.match((await bot.handle({owner:OWNER,group_id:'200000001',text:'#原神'+cmd})).text,/仅允许本人私聊/);assert.match((await bot.handle({owner:'100000002',text:'#原神'+cmd})).text,/先私聊/);}assert.equal(calls.length,0);});
test('coin commands use only authorized fixed GETs and display no Cookie',async t=>{const {bot,calls}=setup(t);const balance=await bot.handle({owner:OWNER,text:'#原神米游币'});const states=await bot.handle({owner:OWNER,text:'#原神米游币任务'});assert.match(balance.text,/余额：200/);assert.match(states.text,/任务 59：进度 2；奖励未领取/);assert.match(states.text,/不执行签到、点赞、分享或兑换/);assert.equal(calls.length,2);for(const call of calls){assert.equal(call.options.method,'GET');assert.equal(call.options.redirect,'error');assert.equal(call.options.headers.Cookie,COOKIE);}assert.doesNotMatch(balance.text+states.text,/synthetic|ltoken/);});
test('removed task commands cannot execute a request or create a subscription',async t=>{const {bot,calls}=setup(t);for(const cmd of ['签到','自动签到 开','点赞','分享','兑换','米游币签到','米游币兑换']){assert.match((await bot.handle({owner:OWNER,text:'#原神'+cmd})).text,/没有识别/);}assert.equal(calls.length,0);assert.deepEqual(bot.subscriptions.list(OWNER),[]);assert.equal(typeof bot.mys.sign,'undefined');});
