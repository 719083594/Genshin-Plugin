import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Teyvat} from '../api.mjs';
import {sendCardReply,CardReplyError} from '../lib/card-reply.mjs';

async function workspace(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-card-flow-'));try{await fn(root)}finally{fs.rmSync(root,{recursive:true,force:true})}}

test('帮助图片是适配器显式选项，文字回退和独立 API 不启动图片或上游请求',()=>workspace(async root=>{
 let requests=0;
 const bot=new Teyvat(root,{fetch:async()=>{requests++;throw new Error('unexpected request')}});
 const event={owner:'100000001',privateChat:true};
 assert.equal((await bot.handle({...event,text:'#原神帮助'})).card,undefined);
 assert.deepEqual((await bot.handle({...event,text:'#原神帮助',imageReply:true})).card,{type:'help',private:false});
 const plain=await bot.handle({...event,text:'#原神帮助 文字',imageReply:true});
 assert.equal(plain.card,undefined);assert.match(plain.text,/提瓦特助手/);assert.equal(requests,0);
}));

test('私密卡片群聊拒绝发生在视图构建和图片发送之前',async()=>{
 let touched=false;
 await assert.rejects(sendCardReply({card:{private:true}},{event:{group_id:'200000001',privateChat:true},buildCards:()=>{touched=true},render:()=>{touched=true}}),/PRIVATE_CARD_ONLY/);
 assert.equal(touched,false);
});

test('卡片按页以内存 Buffer 发送，private 标记由核心结果决定',async()=>{
 const delivered=[],seen=[];
 const result={card:{type:'personal',private:true}};
 assert.equal(await sendCardReply(result,{event:{reply:async payload=>delivered.push(payload)},buildCards:()=>[{html:'one',private:false},{html:'two'}],render:async card=>{seen.push(card);return Buffer.from(card.html)},image:bytes=>({type:'image',bytes})}),true);
 assert.deepEqual(seen.map(x=>x.private),[true,true]);assert.deepEqual(delivered.map(x=>x.bytes.toString()),['one','two']);
 let rendered=false;
 await assert.rejects(sendCardReply(result,{event:{},buildCards:()=>Array(9).fill({}),render:()=>{rendered=true}}),/INVALID_CARD_COUNT/);
 assert.equal(rendered,false);
});


test('后页失败明确保留已发送页数，第一页失败则保留原错误',async()=>{
 const failure=new Error('synthetic-render-error'),output=[];
 const options={event:{reply:async item=>output.push(item)},buildCards:()=>[{html:'one'},{html:'two'}],render:async card=>{if(card.html==='two')throw failure;return Buffer.from('synthetic-image')},image:bytes=>bytes};
 await assert.rejects(sendCardReply({card:{private:true}},options),error=>error instanceof CardReplyError&&error.sent===1&&error.total===2&&error.cause===failure&&!error.message.includes('synthetic'));
 assert.equal(output.length,1);
 await assert.rejects(sendCardReply({card:{private:true}},{...options,render:async()=>{throw failure}}),error=>error===failure);
 assert.equal(output.length,1);
});
