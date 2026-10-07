import test from 'node:test';import assert from 'node:assert/strict';
import {createInstructionReply} from '../lib/fixed-instructions.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const topics=[['登录说明','genshin-login'],['功能','genshin-features']];

async function withImages(run){const previous=globalThis.segment;globalThis.segment={image:bytes=>({type:'image',bytes})};try{await run();}finally{globalThis.segment=previous;}}
test('固定登录说明与功能图不拦截动态授权或文字帮助',async()=>{
 const topics=[],send=createInstructionReply({sendHelp:async(e,topic)=>{topics.push(topic);return true;}});
 for(const msg of ['#原神扫码登录','#原神安全验证','#原神账户','#原神功能 文字'])assert.equal(await send({msg}),false);
 assert.equal(await send({msg:'#原神登录说明'}),true);assert.equal(await send({msg:'#原神功能'}),true);
 assert.deepEqual(topics,['genshin-login','genshin-features']);
});

test('without AI every fixed instruction sends its real bundled verified JPEG',()=>withImages(async()=>{
 let imports=0;const send=createInstructionReply({root,loadService:async()=>{imports++;throw Error('optional service missing');}});
 for(const [command,topic]of topics){const replies=[];assert.equal(await send({msg:'#原神'+command,reply:async payload=>{replies.push(payload);}}),true);assert.equal(replies.length,1);assert.equal(replies[0].type,'image');assert(Buffer.isBuffer(replies[0].bytes));assert.deepEqual(replies[0].bytes,fs.readFileSync(path.join(root,'resources/help/'+topic+'-1.jpg')));}
 assert.equal(imports,topics.length);
}));

test('a failed optional import can recover while successful shared delivery is reused',()=>withImages(async()=>{
 let imports=0,factories=0,assisted=0;const replies=[];
 const send=createInstructionReply({root,loadService:async()=>{if(++imports===1)throw Error('optional missing');return {createFixedHelpDelivery:()=>{factories++;return async e=>{assisted++;await e.reply({type:'shared'});return true;};}};}});
 const event={msg:'#原神功能',reply:async payload=>{replies.push(payload);}};
 assert.equal(await send(event),true);assert.equal(replies[0].type,'image');assert.equal(await send(event),true);assert.equal(await send(event),true);
 assert.equal(imports,2);assert.equal(factories,1);assert.equal(assisted,2);assert.deepEqual(replies.map(item=>item.type),['image','shared','shared']);
}));

test('unusable shared factory and no-send delivery use local images; partial sends never retry',()=>withImages(async()=>{
 for(const service of [{},{createFixedHelpDelivery:()=>null},{createFixedHelpDelivery:()=>async()=>false}]){const replies=[],send=createInstructionReply({root,loadService:async()=>service});assert.equal(await send({msg:'#原神功能',reply:async payload=>{replies.push(payload);}}),true);assert.equal(replies.length,1);assert.equal(replies[0].type,'image');}
 const replies=[],send=createInstructionReply({root,loadService:async()=>({createFixedHelpDelivery:()=>async e=>{await e.reply({type:'shared-first-page'});throw Error('STATIC_HELP_SEND_INCOMPLETE');}})});
 await assert.rejects(send({msg:'#原神功能',reply:async payload=>{replies.push(payload);}}),/STATIC_HELP_SEND_INCOMPLETE/);assert.equal(replies.length,1);
 const custom=createInstructionReply({root,prefix:()=>'/旅行',loadService:async()=>{throw Error('optional missing');}});assert.equal(await custom({msg:'/旅行功能',reply:()=>assert.fail('default-prefix images cannot be reused')}),false);
}));
