import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicHelpCache} from '../lib/public-help-cache.mjs';

const card=(html='synthetic-public-help',width=1080)=>({html,width,private:false});
const jpeg=(marker=1)=>Buffer.from([255,216,marker,255,217]);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const flush=()=>Promise.resolve();

test('only explicitly public cards may fill or read a matching cache',async()=>{
  let calls=0;const render=createPublicHelpCache(async()=>{calls++;return jpeg()});
  await render(card());
  for(const input of [null,undefined,{},card('',1080),{...card(),private:true},{html:card().html,width:1080},{...card(),private:0}]){
    await assert.rejects(render(input),TypeError);
  }
  assert.equal(calls,1);
  assert.deepEqual(await render(card()),jpeg());assert.equal(calls,1);
});

test('same-key pending calls coalesce and each consumer receives independent Buffer bytes',async()=>{
  const gate=deferred();let calls=0;const source=jpeg(2);
  const render=createPublicHelpCache(async()=>{calls++;return gate.promise});
  const first=render(card()),second=render({...card(),owner:'synthetic-identity'});
  await flush();assert.equal(calls,1);gate.resolve(source);
  const [a,b]=await Promise.all([first,second]);assert.notEqual(a,b);assert.notEqual(a,source);
  a[2]=99;source[2]=88;assert.equal(b[2],2);
  const hit=await render(card());assert.equal(hit[2],2);hit[2]=77;
  assert.equal((await render(card()))[2],2);assert.equal(calls,1);
});

test('different HTML and widths replace the only cached image',async()=>{
  let calls=0;const render=createPublicHelpCache(async()=>jpeg(++calls));
  assert.equal((await render(card('A')))[2],1);
  assert.equal((await render(card('B')))[2],2);
  assert.equal((await render(card('A')))[2],3);
  assert.equal((await render(card('A',720)))[2],4);
  assert.equal((await render(card('A',1080)))[2],5);
  assert.equal(calls,5);
});

test('a late old-key result cannot overwrite a newer completed image',async()=>{
  const gates={A:deferred(),B:deferred()};const calls=[];
  const render=createPublicHelpCache(async value=>{calls.push(value.html);return gates[value.html].promise});
  const a=render(card('A')),b=render(card('B'));await flush();
  gates.B.resolve(jpeg(2));assert.equal((await b)[2],2);
  gates.A.resolve(jpeg(1));assert.equal((await a)[2],1);
  assert.equal((await render(card('B')))[2],2);assert.deepEqual(calls,['A','B']);
  assert.equal((await render(card('A')))[2],1);assert.deepEqual(calls,['A','B','A']);
});

test('same-key pending work remains merged across an intervening different-key call',async()=>{
  const gates={A:deferred(),B:deferred()};const calls=[];
  const render=createPublicHelpCache(async value=>{calls.push(value.html);return gates[value.html].promise});
  const a1=render(card('A')),b=render(card('B')),a2=render(card('A'));await flush();
  assert.deepEqual(calls,['A','B']);gates.A.resolve(jpeg(1));
  assert.deepEqual(await a1,await a2);gates.B.resolve(jpeg(2));await b;
  assert.equal((await render(card('A')))[2],1);assert.deepEqual(calls,['A','B']);
});

test('renderer input is snapshotted before asynchronous work and identity metadata is omitted',async()=>{
  let received;const render=createPublicHelpCache(async value=>{received=value;return jpeg()});
  const input={...card('original'),owner:'synthetic-identity',session:{synthetic:true}};
  const result=render(input);input.html='changed';input.width=720;input.private=true;
  await result;assert.deepEqual(received,{html:'original',width:1080,private:false});
  const hit=await render(card('original'));assert.deepEqual(hit,jpeg());
});

test('render errors propagate by identity, failed pending work clears and the next call retries',async()=>{
  const gate=deferred(),error=new Error('synthetic-render-error');let calls=0;
  const render=createPublicHelpCache(async()=>{calls++;return calls===1?gate.promise:jpeg(2)});
  const a=render(card()),b=render(card());
  const checks=[assert.rejects(a,value=>value===error),assert.rejects(b,value=>value===error)];
  await flush();gate.reject(error);await Promise.all(checks);assert.equal(calls,1);
  assert.equal((await render(card()))[2],2);assert.equal(calls,2);
  await render(card());assert.equal(calls,2);
});

test('oversized, non-JPEG and non-Buffer render results are returned without caching',async()=>{
  for(const value of [jpeg(),Buffer.from([137,80,78,71]),'not-a-buffer',false]){
    let calls=0;const render=createPublicHelpCache(async()=>{calls++;return value},{maxBytes:value===false?100:4});
    assert.deepEqual(await render(card()),value);assert.deepEqual(await render(card()),value);assert.equal(calls,2);
  }
});

test('TTL starts at successful completion and expires exactly at the configured boundary',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});
  const gate=deferred();let calls=0;
  const render=createPublicHelpCache(async()=>{calls++;return calls===1?gate.promise:jpeg(2)},{maxAgeMs:500});
  const first=render(card());await flush();t.mock.timers.tick(2000);gate.resolve(jpeg(1));await first;
  t.mock.timers.tick(499);assert.equal((await render(card()))[2],1);assert.equal(calls,1);
  t.mock.timers.tick(1);assert.equal((await render(card()))[2],2);assert.equal(calls,2);
  await render(card());assert.equal(calls,2);
});

test('failed different-key work does not resurrect the evicted old cached key',async()=>{
  const error=new Error('synthetic-failure');let calls=0;
  const render=createPublicHelpCache(async value=>{calls++;if(value.html==='B')throw error;return jpeg()});
  await render(card('A'));await assert.rejects(render(card('B')),value=>value===error);
  await render(card('A'));assert.equal(calls,3);
});

test('factory instances have separate RAM state and default width matches explicit 1080',async()=>{
  let calls=0;const draw=async()=>{calls++;return jpeg()};
  const first=createPublicHelpCache(draw),second=createPublicHelpCache(draw);
  await first({html:'public',private:false});await first(card('public'));assert.equal(calls,1);
  await second(card('public'));assert.equal(calls,2);
});

test('invalid factory settings fail before rendering and zero TTL disables reuse',async()=>{
  for(const options of [{maxAgeMs:-1},{maxAgeMs:Infinity},{maxAgeMs:1.5},{maxBytes:-1},{maxBytes:Infinity},{maxBytes:1.5}]){
    assert.throws(()=>createPublicHelpCache(()=>jpeg(),options),TypeError);
  }
  assert.throws(()=>createPublicHelpCache(null),TypeError);
  let calls=0;const render=createPublicHelpCache(async()=>{calls++;return jpeg()},{maxAgeMs:0});
  await render(card());await render(card());assert.equal(calls,2);
  for(const width of [null,319,1601,'1080',1080.5])await assert.rejects(render(card('invalid',width)),TypeError);
});
