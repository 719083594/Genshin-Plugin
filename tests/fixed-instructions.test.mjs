import test from 'node:test';import assert from 'node:assert/strict';
import {createInstructionReply} from '../lib/fixed-instructions.mjs';
test('固定登录说明与功能图不拦截动态授权或文字帮助',async()=>{
 const topics=[],send=createInstructionReply({sendHelp:async(e,topic)=>{topics.push(topic);return true;}});
 for(const msg of ['#原神扫码登录','#原神安全验证','#原神账户','#原神功能 文字'])assert.equal(await send({msg}),false);
 assert.equal(await send({msg:'#原神登录说明'}),true);assert.equal(await send({msg:'#原神功能'}),true);
 assert.deepEqual(topics,['genshin-login','genshin-features']);
});
