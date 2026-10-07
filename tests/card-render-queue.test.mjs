import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createQueuedCardRenderer} from '../lib/card-render-queue.mjs';
import {createCardRenderer} from '../lib/card-renderer.mjs';

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

test('ready images arrive before real drain, while cross-copy FIFO waits and releases each context once',async()=>{
  const duplicate=await import('../lib/card-render-queue.mjs?drain-copy='+randomUUID());
  const botRoot=root(),drains=[deferred(),deferred()],started=[],captured=[];let current=-1;
  const render=async card=>{current=card.order;started.push(card.order);return Buffer.from('image-'+card.order);};
  render.drain=()=>{captured.push(current);return drains[current].promise;};
  const a=createQueuedCardRenderer(render,{botRoot});
  const b=duplicate.createQueuedCardRenderer(render,{botRoot:path.join(botRoot,'child','..')});
  const first=a({html:'synthetic-private-first',private:true,order:0});
  const second=b({html:'synthetic-private-second',private:true,order:1});
  const secondEntry=stateFor(botRoot).queue[0];
  assert.deepEqual(await first,Buffer.from('image-0'));await flush();
  assert.deepEqual(started,[0]);assert.deepEqual(captured,[0]);assert.equal(stateFor(botRoot).active,true);
  assert.equal(stateFor(botRoot).queue.length,1);assert.notEqual(secondEntry.card,null);
  drains[0].resolve(true);
  assert.deepEqual(await second,Buffer.from('image-1'));await flush();
  assert.deepEqual(started,[0,1]);assert.deepEqual(captured,[0,1]);assert.equal(stateFor(botRoot).active,true);
  for(const key of ['card','render','resolve','reject','timer'])assert.equal(secondEntry[key],null);
  drains[1].resolve(true);await flush();await flush();
  assert.deepEqual(started,[0,1]);assert.equal(stateFor(botRoot).active,false);assert.equal(stateFor(botRoot).blocked,false);
});

test('rejected drain preserves delivered image, blocks both copies and clears every waiting private entry',async()=>{
  const duplicate=await import('../lib/card-render-queue.mjs?blocked-copy='+randomUUID());
  const botRoot=root(),drain=deferred(),seen=[];
  const render=async card=>{seen.push(card.html);return Buffer.from('ready');};
  render.drain=()=>drain.promise;
  const queued=createQueuedCardRenderer(render,{botRoot}),peer=duplicate.createQueuedCardRenderer(render,{botRoot});
  const first=queued({html:'active'}),waiting=[queued({html:'synthetic-private-A'}),peer({html:'synthetic-private-B'})];
  const entries=[...stateFor(botRoot).queue];
  const checks=waiting.map(promise=>assert.rejects(promise,error=>error.code==='RENDER_QUEUE_BLOCKED'&&!/synthetic|TOKEN|failure/.test(error.message)));
  assert.deepEqual(await first,Buffer.from('ready'));drain.reject(new Error('TOKEN=synthetic-close-failure'));
  await Promise.all(checks);await flush();
  assert.deepEqual(seen,['active']);assert.equal(stateFor(botRoot).active,true);assert.equal(stateFor(botRoot).blocked,true);
  assert.deepEqual(stateFor(botRoot).queue,[]);
  for(const entry of entries)for(const key of ['card','render','resolve','reject','timer'])assert.equal(entry[key],null);
  await assert.rejects(queued({html:'later'}),error=>error.code==='RENDER_QUEUE_BLOCKED');
  await assert.rejects(peer({html:'later-peer'}),error=>error.code==='RENDER_QUEUE_BLOCKED');
  assert.deepEqual(seen,['active']);
  const independent=createQueuedCardRenderer(async()=>Buffer.from('independent'),{botRoot:root()});
  assert.deepEqual(await independent({html:'public'}),Buffer.from('independent'));
});

test('only true confirms drain; malformed values and synchronous failures remain blocked',async()=>{
  for(const mode of ['false','null','undefined','string','throw','getter']){
    const botRoot=root();let started=0;
    const render=async()=>{started++;return Buffer.from('ready');};
    if(mode==='getter')Object.defineProperty(render,'drain',{get(){throw new Error('synthetic-private-getter');}});
    else render.drain=()=>{if(mode==='throw')throw new Error('synthetic-private-drain');return Promise.resolve({false:false,null:null,undefined:undefined,string:'closed'}[mode]);};
    const queued=createQueuedCardRenderer(render,{botRoot}),first=queued({html:'A'}),second=queued({html:'B'});
    const rejected=assert.rejects(second,error=>error.code==='RENDER_QUEUE_BLOCKED'&&!/synthetic|private/.test(error.message));
    assert.deepEqual(await first,Buffer.from('ready'));await rejected;await flush();
    assert.equal(started,1);assert.equal(stateFor(botRoot).blocked,true);assert.equal(stateFor(botRoot).active,true);
  }
});

test('permanent drain wait keeps its slot while pending deadlines remove private input and callbacks',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const botRoot=root(),drain=deferred(),seen=[];let current;
  const render=async card=>{current=card.html;seen.push(current);return Buffer.from(current);};
  render.drain=()=>current==='active'?drain.promise:Promise.resolve(true);
  const queued=createQueuedCardRenderer(render,{botRoot,queueTimeoutMs:100});
  const first=queued({html:'active'}),expired=queued({html:'synthetic-private-pending',private:true});
  const entry=stateFor(botRoot).queue[0];
  const rejected=assert.rejects(expired,error=>error.code==='RENDER_QUEUE_TIMEOUT');
  assert.deepEqual(await first,Buffer.from('active'));await flush();
  t.mock.timers.tick(99);assert.equal(stateFor(botRoot).queue.length,1);assert.deepEqual(seen,['active']);
  t.mock.timers.tick(1);await rejected;await flush();
  for(const key of ['card','render','resolve','reject','timer'])assert.equal(entry[key],null);
  assert.equal(stateFor(botRoot).active,true);assert.equal(stateFor(botRoot).blocked,false);assert.deepEqual(seen,['active']);
  // Even a long elapsed deadline is not disposal confirmation. Only the real
  // promise may reopen the slot, without resurrecting the expired task.
  t.mock.timers.tick(30000);await flush();assert.deepEqual(seen,['active']);
  drain.resolve(true);await flush();assert.equal(stateFor(botRoot).active,false);
  assert.deepEqual(await queued({html:'next'}),Buffer.from('next'));await flush();assert.deepEqual(seen,['active','next']);
});

test('render errors propagate immediately but an owned drain still gates the next render',async()=>{
  const botRoot=root(),drain=deferred(),error=new Error('synthetic-render-failure'),seen=[];let current;
  const render=async card=>{current=card.order;seen.push(current);if(current===0)throw error;return Buffer.from('next');};
  render.drain=()=>current===0?drain.promise:Promise.resolve(true);
  const queued=createQueuedCardRenderer(render,{botRoot});
  const first=queued({order:0,html:'A'}),second=queued({order:1,html:'B'});
  await assert.rejects(first,value=>value===error);await flush();assert.deepEqual(seen,[0]);assert.equal(stateFor(botRoot).active,true);
  drain.resolve(true);assert.deepEqual(await second,Buffer.from('next'));await flush();assert.deepEqual(seen,[0,1]);assert.equal(stateFor(botRoot).active,false);
});

test('ready delivery cannot bypass the four-waiter limit during a pending real drain',async()=>{
  const botRoot=root(),drain=deferred(),seen=[];let current;
  const render=async card=>{current=card.order;seen.push(current);return Buffer.from(String(current));};
  render.drain=()=>current===0?drain.promise:Promise.resolve(true);
  const queued=createQueuedCardRenderer(render,{botRoot});
  assert.deepEqual(await queued({order:0,html:'active'}),Buffer.from('0'));
  const waiting=Array.from({length:4},(_,i)=>queued({order:i+1,html:'private-'+i}));
  assert.equal(stateFor(botRoot).queue.length,4);
  await assert.rejects(queued({order:5}),error=>error.code==='RENDER_QUEUE_FULL');assert.deepEqual(seen,[0]);
  drain.resolve(true);assert.deepEqual(await Promise.all(waiting),[1,2,3,4].map(value=>Buffer.from(String(value))));
  await flush();assert.deepEqual(seen,[0,1,2,3,4]);assert.equal(stateFor(botRoot).active,false);
});

test('actual memory renderer drain gates context creation after early image delivery and fails closed on close rejection',async()=>{
  for(const rejectClose of [false,true]){
    const botRoot=root(),closes=[deferred(),deferred()],closing=[];let contexts=0;
    const browser={isConnected:()=>true,createBrowserContext:async()=>{
      const order=contexts++;
      const page={
        setJavaScriptEnabled:async()=>{},setCacheEnabled:async()=>{},setRequestInterception:async()=>{},on:()=>{},setViewport:async()=>{},setContent:async()=>{},evaluate:async()=>false,
        $:async()=>({boundingBox:async()=>({x:0,y:0,width:1080,height:1200})}),screenshot:async()=>Buffer.from([255,216,255,217])
      };
      return {newPage:async()=>page,close:async()=>{closing.push(order);await closes[order].promise;}};
    }};
    const render=createCardRenderer({botRoot,getBrowser:()=>browser,deliverBeforeCleanup:true,timeoutMs:1000,cleanupMs:10});
    const queued=createQueuedCardRenderer(render,{botRoot});
    const first=queued({html:'<main id="card">synthetic private first</main>',private:true});
    const second=queued({html:'<main id="card">synthetic private second</main>',private:true});
    const check=rejectClose?assert.rejects(second,error=>error.code==='RENDER_QUEUE_BLOCKED'):null;
    assert.deepEqual(await first,Buffer.from([255,216,255,217]));await flush();
    assert.equal(contexts,1);assert.deepEqual(closing,[0]);assert.equal(stateFor(botRoot).active,true);
    if(rejectClose){
      closes[0].reject(new Error('synthetic private close failure'));await check;await flush();
      assert.equal(contexts,1);assert.equal(stateFor(botRoot).blocked,true);
      await assert.rejects(queued({html:'<main id="card">next</main>'}),error=>error.code==='RENDER_QUEUE_BLOCKED');
    }else{
      closes[0].resolve(true);assert.deepEqual(await second,Buffer.from([255,216,255,217]));await flush();
      assert.equal(contexts,2);assert.deepEqual(closing,[0,1]);assert.equal(stateFor(botRoot).active,true);
      closes[1].resolve(true);await flush();assert.equal(stateFor(botRoot).active,false);assert.equal(stateFor(botRoot).blocked,false);
    }
  }
});
