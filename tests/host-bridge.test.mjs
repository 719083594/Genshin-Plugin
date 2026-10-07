import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveHostPuppeteer,HostRendererBridgeError} from '../lib/host-bridge.mjs';

test('TRSS default dispatcher is bypassed in favor of the exact registered named instance',()=>{
  let initialized=0;const calls=[];
  class Puppeteer{constructor(){this.browser=false}async browserInit(){initialized++;return this.browser}}
  const named=new Puppeteer(),loader={getRenderer(name){calls.push(name);return name==='puppeteer'?named:this},render(){assert.fail('public dispatcher render must not execute')}};
  assert.equal(loader.getRenderer(),loader);calls.length=0;
  assert.equal(resolveHostPuppeteer(loader),named);assert.deepEqual(calls,['puppeteer']);assert.equal(initialized,0);assert.equal(named.browser,false);
});

test('cold false/null/undefined Browser values are allowed without accessing or starting a browser',()=>{
  for(const browser of [false,null,undefined]){
    const named={browser,browserInit(){assert.fail('resolution cannot start a browser')}};
    assert.equal(resolveHostPuppeteer({getRenderer:()=>named}),named);assert.equal(named.browser,browser);
  }
  const named={get browser(){assert.fail('browser getter cannot run during resolution')},browserInit(){}};
  assert.equal(resolveHostPuppeteer({getRenderer:()=>named}),named);
});

test('an existing Browser and the mutable host instance are returned without replacement or freezing',()=>{
  const browser={},named={browser,browserInit(){return this.browser}};
  assert.equal(resolveHostPuppeteer({getRenderer:()=>named}).browser,browser);assert.equal(Object.isFrozen(named),false);named.browser=false;assert.equal(named.browser,false);
});

test('missing named registration, dispatcher fallback, absent browser slot or absent initialization method fail closed',()=>{
  for(const loader of [null,{}, {getRenderer:()=>null},{getRenderer:()=>({browser:false})},{getRenderer:()=>({browserInit(){}})},{getRenderer:()=>function Renderer(){}}])assert.throws(()=>resolveHostPuppeteer(loader),error=>error instanceof HostRendererBridgeError&&error.code==='HOST_PUPPETEER_UNAVAILABLE');
  const dispatcher={browser:false,browserInit(){assert.fail('dispatcher initialization must not execute')},getRenderer(){return this}};
  assert.throws(()=>resolveHostPuppeteer(dispatcher),HostRendererBridgeError);
});

test('host lookup failures and throwing accessors cannot expose upstream paths or credentials',()=>{
  const upstream=()=>{throw Error('Cookie=synthetic-private /private/config.json')};
  for(const loader of [{getRenderer:upstream},{get getRenderer(){return upstream()}},{getRenderer:()=>({browser:false,get browserInit(){return upstream()}})}])assert.throws(()=>resolveHostPuppeteer(loader),error=>error.code==='HOST_PUPPETEER_UNAVAILABLE'&&!/synthetic|Cookie|config|private/.test(error.message));
});

test('resolution uses the loader method receiver and never retries another name or the default route',()=>{
  const named={browser:false,browserInit(){}},loader={selected:named,getRenderer(name){assert.equal(this,loader);assert.equal(name,'puppeteer');return this.selected}};
  assert.equal(resolveHostPuppeteer(loader),named);
});
