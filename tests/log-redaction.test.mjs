import test from 'node:test';import assert from 'node:assert/strict';import {redactGameCredentials,installLogRedaction} from '../lib/log-redaction.mjs';
test('私聊授权日志隐藏Cookie及Key且保留普通日志',()=>{assert.equal(redactGameCredentials('event #原神绑定Cookie 123456789 cookie_token=synthetic;'), 'event #原神绑定Cookie [凭据已隐藏]');assert.equal(redactGameCredentials('#原神墨安绑定 synthetic-key'),'#原神墨安绑定 [凭据已隐藏]');assert.equal(redactGameCredentials('#原神版本'),'#原神版本');const rows=[];const logger={info(...args){rows.push(args)}};installLogRedaction(logger);installLogRedaction(logger);logger.info(['#原神墨安绑定 synthetic-key']);assert.equal(rows.flat(2).join().includes('synthetic-key'),false)});

test('前缀与命令之间允许空格，配置前缀按字面值转义',()=>{
  for(const text of ['#原神 绑定Cookie 123456789 ltoken=synthetic-token;', '#原神\t墨安绑定 synthetic-key', '#原神绑定Cookie 123456789 synthetic-token'])assert.doesNotMatch(redactGameCredentials(text),/synthetic/);
  assert.equal(redactGameCredentials('[私聊] #[原神]+ 绑定Cookie 123456789 synthetic-token',{prefix:'#[原神]+'}), '[私聊] #[原神]+ 绑定Cookie [凭据已隐藏]');
  assert.equal(redactGameCredentials('普通 Cookie 配置说明，不含凭据'), '普通 Cookie 配置说明，不含凭据');
});

test('嵌套事件与凭据字段递归脱敏，原对象及普通日志字段不变',()=>{
  const value={event:{raw_message:'#原神 绑定Cookie 123456789 synthetic-token',message:[{type:'text',data:{text:'#原神墨安绑定 synthetic-key'}}]},headers:{Cookie:'ltuid=123; cookie_token=synthetic-token;',Authorization:'Bearer synthetic-token'},tokens:{stoken_v2:'synthetic-token',account_mid_v2:'synthetic-mid'},apiKey:'synthetic-key',status:'ok',count:3};
  const output=redactGameCredentials(value);
  assert.doesNotMatch(JSON.stringify(output),/synthetic/);
  assert.equal(output.headers.Cookie,'[凭据已隐藏]');assert.equal(output.apiKey,'[凭据已隐藏]');assert.equal(output.status,'ok');assert.equal(output.count,3);
  assert.match(value.headers.Cookie,/synthetic-token/);assert.notEqual(output.event,value.event);
});

test('序列化JSON、上游Cookie字段、URL authkey及错误对象不泄露凭据',()=>{
  const values=['{"Cookie":"ltuid=123; ltoken=synthetic-token;"}', 'ltoken=synthetic-token; stoken_v2=synthetic-other;', '{"token":"synthetic-token", "access_token":"synthetic-token"}', 'https://official.example/api?uid=123&authkey=synthetic-token&lang=zh-cn', 'Authorization: "Bearer synthetic-token"', 'Authorization: Bearer synthetic-token', 'proxy-authorization=Basic synthetic-token', new Error('network cookie_token=synthetic-token;')];
  for(const value of values)assert.doesNotMatch(JSON.stringify(redactGameCredentials(value)),/synthetic/);
});

test('循环、深层和过大对象有界处理，访问器与自定义inspect不执行',()=>{
  const circular={status:'ok'};circular.self=circular;
  assert.doesNotThrow(()=>JSON.stringify(redactGameCredentials(circular)));
  let deep={cookie:'synthetic-token'};for(let i=0;i<10000;i++)deep={next:deep};
  assert.doesNotMatch(JSON.stringify(redactGameCredentials(deep)),/synthetic/);
  const large=Array.from({length:10000},()=>({token:'synthetic-token'}));assert.ok(redactGameCredentials(large).length<=201);
  let called=0;const accessor={};Object.defineProperty(accessor,'message',{enumerable:true,get(){called++;throw new Error('must not execute')}});accessor[Symbol.for('nodejs.util.inspect.custom')]=()=>{called++;return 'synthetic-token'};
  assert.doesNotMatch(JSON.stringify(redactGameCredentials(accessor)),/synthetic/);assert.equal(called,0);
  assert.equal(redactGameCredentials(Buffer.from('synthetic-token')),'[二进制日志已省略]');
});

test('日志安装保持this与返回值且更新前缀不会重复包装',()=>{
  const rows=[];const logger={marker:42,info(value){assert.equal(this.marker,42);rows.push(value);return 'done'}};
  installLogRedaction(logger,{prefix:'#原神'});const wrapped=logger.info;installLogRedaction(logger,{prefix:'#提瓦特'});assert.equal(logger.info,wrapped);
  assert.equal(logger.info({msg:'#提瓦特 绑定Cookie 123456789 synthetic-token'}),'done');assert.doesNotMatch(JSON.stringify(rows),/synthetic/);assert.equal(rows.length,1);
});

test('人工验证回执命令和结构字段不进入日志',()=>{
  const command='#原神提交验证 '+ 'a'.repeat(32)+' '+Buffer.from(JSON.stringify({geetest_validate:'synthetic-proof'})).toString('base64url');
  assert.doesNotMatch(redactGameCredentials(command),/synthetic|aaaa/);
  assert.equal(redactGameCredentials({geetest_validate:'synthetic-proof',challenge:'synthetic-challenge'}).geetest_validate,'[凭据已隐藏]');
});

test('OneBot二维码及私聊导出base64文件不写进日志，普通文件路径保留',()=>{
  const encoded=Buffer.from('{"uid":"123456789","private":"synthetic-account-data"}').toString('base64');
  const value={params:{message:[{type:'image',data:{file:'base64://'+encoded}}]},export:{file:'base64://'+encoded,name:'Genshin-profile.json'},public:{file:'https://official.example/image.png'}};
  const output=redactGameCredentials(value);
  assert.equal(output.params.message[0].data.file,'[凭据已隐藏]');assert.equal(output.public.file,value.public.file);assert.doesNotMatch(JSON.stringify(output),/synthetic-account-data/);assert.ok(!JSON.stringify(output).includes(encoded));
  for(const text of ['sendApi '+JSON.stringify(value), '[CQ:image,file=base64://'+encoded+']', 'File: base64://'+encoded])assert.ok(!redactGameCredentials(text).includes(encoded));
  assert.equal(value.export.file,'base64://'+encoded);
});
