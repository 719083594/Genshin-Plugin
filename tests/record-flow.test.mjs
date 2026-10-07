import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Teyvat} from '../api.mjs';
import {buildRecordCards} from '../lib/record-cards.mjs';
import {sendCardReply} from '../lib/card-reply.mjs';
import {createSharedNativeCardRenderer} from '../lib/shared-renderer.mjs';

async function fixture(run){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-record-flow-'));
  try{
    const bot=new Teyvat(root),seen=[];
    bot.accounts.selected=owner=>({uid:'100000001',label:'示例旅行者',hasCookie:true,owner});
    bot.mys.query=async(kind,account,params)=>{seen.push({kind,owner:account.owner,params});return {ok:true,data:{schedule_id:123,start_time:'1789502400',end_time:'1792094399',total_battle_times:0,total_win_times:0,max_floor:'10-3',reveal_rank:[],floors:[],cookie:'synthetic-private-token'}};};
    await run(bot,seen);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('successful abyss command reaches a private card rather than raw JSON',()=>fixture(async(bot,seen)=>{
  const result=await bot.handle({owner:'100000001',privateChat:true,imageReply:true,text:'#原神深渊 上期'});
  assert.equal(result.card.type,'record');assert.equal(result.card.private,true);
  assert.equal(result.card.model.kind,'spiralAbyss');
  assert.equal(seen[0].params.schedule_type,2);
  assert.doesNotMatch(JSON.stringify(result),/synthetic-private-token|"cookie"|schedule_id/);
  assert.match(result.text,/深境螺旋/);assert.doesNotMatch(result.text,/^\s*\{/);
  const cards=buildRecordCards(result.card);
  assert.ok(cards.length>=1&&cards.length<=8);assert.ok(cards.every(card=>card.svg&&card.private===true));
}));

test('private records in either group event shape are rejected before account lookup or API',()=>fixture(async(bot,seen)=>{
  bot.accounts.selected=()=>{throw new Error('account must not be read');};
  for(const event of [{group_id:'200000001'},{isGroup:true}]){
    const result=await bot.handle({owner:'100000001',privateChat:true,imageReply:true,text:'#原神深渊',...event});
    assert.match(result.text,/本人私聊/);assert.equal(result.card,undefined);
  }
  assert.equal(seen.length,0);
}));

test('text suffix is readable and standalone legacy API remains compatible',()=>fixture(async bot=>{
  const plain=await bot.handle({owner:'100000001',privateChat:true,imageReply:true,text:'#原神深渊 文字'});
  assert.equal(plain.card,undefined);assert.match(plain.text,/深境螺旋/);assert.doesNotMatch(plain.text,/schedule_id/);
  const legacy=await bot.handle({owner:'100000001',privateChat:true,text:'#原神深渊'});
  assert.equal(legacy.card,undefined);assert.equal(JSON.parse(legacy.text).schedule_id,123);
}));

test('upstream denial does not become a fabricated image or blank successful record',()=>fixture(async bot=>{
  bot.mys.query=async()=>({ok:false,message:'请完成本人安全验证。'});
  const result=await bot.handle({owner:'100000001',privateChat:true,imageReply:true,text:'#原神深渊'});
  assert.equal(result.card,undefined);assert.equal(result.text,'请完成本人安全验证。');
}));

test('standalone record command produces a real JPEG when AI service is absent',()=>fixture(async bot=>{
  const result=await bot.handle({owner:'100000001',privateChat:true,imageReply:true,text:'#原神深渊'});
  const delivered=[];
  const render=createSharedNativeCardRenderer({loadService:async()=>{throw new Error('missing optional AI plugin');}});
  await sendCardReply(result,{event:{privateChat:true,reply:async image=>delivered.push(image)},buildCards:buildRecordCards,render,image:bytes=>bytes});
  assert.ok(delivered.length>=1);
  const sharp=(await import('sharp')).default;
  for(const image of delivered){const metadata=await sharp(image).metadata();assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,1080);}
}));

test('a rejected image delivery is not counted as a successfully sent record',async()=>{
  for(const receipt of [false,{retcode:100},{discarded:true},{error:'synthetic failure'}]){
    await assert.rejects(()=>sendCardReply({card:{private:true}},{event:{privateChat:true,reply:async()=>receipt},buildCards:()=>[{svg:'synthetic'}],render:async()=>Buffer.from('synthetic'),image:x=>x}),/CARD_IMAGE_SEND_FAILED/);
  }
});
