import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createQueuedCardRenderer} from '../lib/card-render-queue.mjs';

const root=()=>path.join(os.tmpdir(),'synthetic-card-queue-'+randomUUID());
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const stateFor=botRoot=>globalThis[Symbol.for('teyvat-sanguosha.card-render-queue.v1')].get(path.resolve(botRoot));

test('independently evaluated plugin copies share the same resolved-root FIFO and run at most one render',async()=>{
  const duplicate=await import('../lib/card-render-queue.mjs?copy='+randomUUID());
  const botRoot=root(),gates=[deferred(),deferred(),deferred()],started=[];let active=0,maximum=0;
  const render=async card=>{started.push(card.html);maximum=Math.max(maximum,++active);try{return await gates[card.order].promise;}finally{active--;}};
  const a=createQueuedCardRenderer(render,{botRoot});
  const b=duplicate.createQueuedCardRenderer(render,{botRoot:path.join(botRoot,'child','..')});
  const calls=[a({html:'A',order:0}),b({html:'B',order:1}),a({html:'C',order:2})];
  assert.deepEqual(started,['A']);gates[0].resolve('first');assert.equal(await calls[0],'first');
  await flush();assert.deepEqual(started,['A','B']);gates[1].resolve('second');assert.equal(await calls[1],'second');
  await flush();assert.deepEqual(started,['A','B','C']);gates[2].resolve('third');assert.equal(await calls[2],'third');
  await flush();assert.equal(maximum,1);assert.deepEqual(stateFor(botRoot).queue,[]);assert.equal(stateFor(botRoot).active,false);
});

test('default capacity permits exactly one running plus four waiting and refuses excess without invoking render',async()=>{
  const botRoot=root(),gate=deferred(),started=[];
  const queued=createQueuedCardRenderer(async card=>{started.push(card.order);if(card.order===0)await gate.promise;return card.order;},{botRoot});
  const calls=Array.from({length:5},(_,order)=>queued({order}));
  assert.equal(stateFor(botRoot).queue.length,4);
  await assert.rejects(queued({order:5,html:'synthetic-private-card'}),error=>error.code==='RENDER_QUEUE_FULL'&&!error.message.includes('synthetic'));
  assert.deepEqual(started,[0]);gate.resolve();assert.deepEqual(await Promise.all(calls),[0,1,2,3,4]);assert.deepEqual(started,[0,1,2,3,4]);
});

test('waiting timeout removes the task, clears private card/callback references, and never executes it',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const botRoot=root(),gate=deferred(),started=[];
  const queued=createQueuedCardRenderer(async card=>{started.push(card.html);if(card.html==='active')await gate.promise;return card.html;},{botRoot,queueTimeoutMs:100});
  const active=queued({html:'active'}),expired=queued({html:'synthetic-private-timeout',private:true});
  const entry=stateFor(botRoot).queue[0];
  const rejected=assert.rejects(expired,error=>error.code==='RENDER_QUEUE_TIMEOUT'&&!error.message.includes('synthetic'));
  t.mock.timers.tick(99);assert.equal(stateFor(botRoot).queue.length,1);
  t.mock.timers.tick(1);await rejected;assert.equal(stateFor(botRoot).queue.length,0);
  for(const key of ['card','render','resolve','reject','timer'])assert.equal(entry[key],null);
  const next=queued({html:'next'});gate.resolve();assert.equal(await active,'active');assert.equal(await next,'next');
  assert.deepEqual(started,['active','next']);
});

test('a started render has no queue timer and is governed solely by the underlying renderer',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const botRoot=root(),firstGate=deferred(),secondGate=deferred();let started=0;
  const queued=createQueuedCardRenderer(async()=>{started++;return started===1?firstGate.promise:secondGate.promise;},{botRoot,queueTimeoutMs:10});
  const first=queued({html:'A'}),second=queued({html:'B'}),entry=stateFor(botRoot).queue[0];
  firstGate.resolve('A');assert.equal(await first,'A');await flush();assert.equal(started,2);assert.equal(entry.timer,null);
  let settled=false;second.finally(()=>{settled=true;});t.mock.timers.tick(1000);await flush();assert.equal(settled,false);
  secondGate.resolve('B');assert.equal(await second,'B');await flush();assert.equal(entry.card,null);
});

test('rejections and synchronous throws propagate unchanged and do not block following calls',async()=>{
  const botRoot=root(),gate=deferred(),error=new Error('synthetic-underlying-error'),sync=new Error('synthetic-sync-error'),seen=[];
  const queued=createQueuedCardRenderer(card=>{seen.push(card.order);if(card.order===0)return gate.promise;if(card.order===1)throw sync;return Buffer.from('ok');},{botRoot});
  const first=queued({order:0}),second=queued({order:1}),third=queued({order:2});
  const checks=[assert.rejects(first,value=>value===error),assert.rejects(second,value=>value===sync)];
  const queuedEntries=[...stateFor(botRoot).queue];gate.reject(error);await Promise.all(checks);assert.deepEqual(await third,Buffer.from('ok'));await flush();
  assert.deepEqual(seen,[0,1,2]);for(const entry of queuedEntries)for(const key of ['card','render','resolve','reject','timer'])assert.equal(entry[key],null);
  assert.equal(stateFor(botRoot).active,false);
});

test('different bot roots remain independent and queued input flags are snapshotted',async()=>{
  const botRoot=root(),gate=deferred(),seen=[];
  const queued=createQueuedCardRenderer(async card=>{seen.push(card);if(card.html==='active')await gate.promise;return card.html;},{botRoot});
  const other=createQueuedCardRenderer(async card=>card.html,{botRoot:root()});
  const first=queued({html:'active'}),input={html:'original',width:720,private:true},second=queued(input);
  input.html='changed';input.private=false;input.width=1080;
  assert.equal(await other({html:'independent'}),'independent');gate.resolve();await first;assert.equal(await second,'original');
  assert.deepEqual(seen[1],{html:'original',width:720,private:true});assert.notEqual(seen[1],input);
});

test('bounds validate before admission, zero pending disables waits, and shared roots keep the stricter admission limit',async()=>{
  const draw=async()=>null;
  for(const options of [{},{botRoot:''},{botRoot:2},{botRoot:root(),maxPending:-1},{botRoot:root(),maxPending:9},{botRoot:root(),maxPending:1.5},{botRoot:root(),queueTimeoutMs:0},{botRoot:root(),queueTimeoutMs:30001},{botRoot:root(),queueTimeoutMs:Infinity}])assert.throws(()=>createQueuedCardRenderer(draw,options),TypeError);
  assert.throws(()=>createQueuedCardRenderer(null,{botRoot:root()}),TypeError);
  const botRoot=root(),gate=deferred(),first=createQueuedCardRenderer(()=>gate.promise,{botRoot,maxPending:8});
  const strict=createQueuedCardRenderer(draw,{botRoot,maxPending:0}),running=first({html:'A'});
  await assert.rejects(strict({html:'B'}),error=>error.code==='RENDER_QUEUE_FULL');
  await assert.rejects(first({html:'C'}),error=>error.code==='RENDER_QUEUE_FULL');gate.resolve('A');assert.equal(await running,'A');
  assert.equal(await strict({html:'D'}),null);
});
