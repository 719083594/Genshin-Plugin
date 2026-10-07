import test from 'node:test';
import assert from 'node:assert/strict';
import {safeRecordArtworkUrl,createRecordAssetResolver} from '../lib/record-assets.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7XcAAAAASUVORK5CYII=','base64');
const loadSharp=async()=>()=>({rotate(){return this;},resize(){return this;},png(){return this;},async toBuffer(){return png;}});
const model={characters:[{id:10000002,icon:'https://upload-bbs.miyoushe.com/character/face.png'}]};

test('artwork URLs admit only official HTTPS raster assets and strip query data',()=>{
  assert.equal(safeRecordArtworkUrl('https://upload-bbs.miyoushe.com/character/face.png?ignored=value#fragment'),model.characters[0].icon);
  for(const value of ['http://upload-bbs.miyoushe.com/face.png','https://miyoushe.com.evil.example/face.png','https://user:password@mihoyo.com/face.png','https://127.0.0.1/face.png','file:///face.png','https://mihoyo.com/face.svg','https://mihoyo.com:8443/face.png'])assert.equal(safeRecordArtworkUrl(value),null);
});

test('public artwork uses credential-free requests and RAM-only cache across accounts',async()=>{
  const calls=[];
  const resolve=createRecordAssetResolver({loadSharp,loadLocalArtwork:async()=>null,fetch:async(url,options)=>{calls.push({url,options});return new Response(png,{headers:{'content-type':'image/png'}});}});
  const first=await resolve({...model,uid:'100000001',cookie:'synthetic-never-fetch'});
  const second=await resolve({...model,uid:'100000002'});
  assert.equal(calls.length,1);assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.credentials,'omit');
  assert.equal(calls[0].options.headers.Cookie,undefined);
  assert.deepEqual(Object.keys(first),['avatars']);assert.equal(first.avatars['10000002'],second.avatars['10000002']);
  assert.doesNotMatch(JSON.stringify(calls),/synthetic-never-fetch|100000001|100000002/);
});

test('local public portraits work without an API image URL or any network request',async()=>{
  const ids=[];
  const resolve=createRecordAssetResolver({loadSharp,loadLocalArtwork:async id=>{ids.push(id);return png;},fetch:async()=>{throw new Error('local artwork must not fetch');}});
  const result=await resolve({characters:[{id:10000002,name:'神里绫华'}]});
  assert.deepEqual(ids,['10000002']);assert.match(result.avatars['10000002'],/^data:image\/png;base64,/);
});

test('failed, oversized, disguised SVG and non-official artwork keeps labelled placeholders',async()=>{
  for(const response of [new Response('<svg/>',{headers:{'content-type':'image/png'}}),new Response(png,{headers:{'content-type':'image/svg+xml'}}),new Response(png,{headers:{'content-type':'image/png','content-length':'524289'}}),new Response('',{status:403})]){
    const resolve=createRecordAssetResolver({loadLocalArtwork:async()=>null,loadSharp:async()=>{throw new Error('unsafe input reached rasterizer');},fetch:async()=>response});
    assert.deepEqual(Object.keys((await resolve(model)).avatars),[]);
  }
  let called=false;
  const resolve=createRecordAssetResolver({fetch:async()=>{called=true;throw new Error('must not fetch');}});
  await resolve({characters:[{id:'x',icon:'https://localhost/face.png'}]});assert.equal(called,false);
});
