import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createBundledHelpReader} from '../lib/bundled-help.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const jpeg=(marker=1)=>Buffer.from([255,216,marker,255,217]);
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bundled-public-help-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('bundled-public-help-'));fs.rmSync(root,{recursive:true,force:true})});
  const ui=path.join(root,'resources/ui'),lib=path.join(root,'lib');fs.mkdirSync(ui,{recursive:true});fs.mkdirSync(lib);
  const imageFile=path.join(ui,'help.jpg'),manifestFile=path.join(ui,'help-manifest.json'),sourceFile=path.join(lib,'card-views.mjs');
  fs.writeFileSync(sourceFile,"throw new Error('Synthetic source must never execute or initialize a browser');\n");
  fs.writeFileSync(imageFile,jpeg());
  const manifest=()=>({version:1,prefix:'#公开',width:1080,imageSha256:hash(fs.readFileSync(imageFile)),sourceSha256:hash(fs.readFileSync(sourceFile))});
  const writeManifest=overrides=>fs.writeFileSync(manifestFile,JSON.stringify({...manifest(),...overrides}));
  writeManifest();
  return {root,ui,lib,imageFile,manifestFile,sourceFile,writeManifest,read:createBundledHelpReader({root,defaultPrefix:'#公开'})};
}
const publicRequest={prefix:'#公开',private:false};

test('valid fixed public JPEG is read without executing source or browser and Buffer copies isolate callers',t=>{
  const f=fixture(t),first=f.read(publicRequest);assert.deepEqual(first,jpeg());
  first[2]=99;assert.equal(f.read(publicRequest)[2],1);
  assert.equal(f.read({private:false})[2],1);
  assert.deepEqual(fs.readdirSync(f.ui).sort(),['help-manifest.json','help.jpg']);
  assert.equal(fs.readFileSync(f.imageFile)[2],1);
});

test('private, absent, ambiguous flags and custom prefixes never obtain a public cached image',t=>{
  const f=fixture(t);assert.ok(f.read(publicRequest));
  for(const request of [null,{}, {prefix:'#公开'}, {...publicRequest,private:true},{...publicRequest,private:0},{...publicRequest,private:'false'},{...publicRequest,prefix:'#别的'},{...publicRequest,prefix:'../../config/local.json'},{...publicRequest,prefix:null}]){
    assert.equal(f.read(request),null);
  }
  assert.ok(f.read(publicRequest));
});

test('constructor and request accessor failures safely return null without leaking filesystem errors',t=>{
  const f=fixture(t);
  for(const config of [null,{}, {root:f.root}, {root:0,defaultPrefix:'#公开'},{root:f.root,defaultPrefix:'bad\nvalue'},{get root(){throw Error('synthetic-private-path')}}]){
    assert.equal(createBundledHelpReader(config)(publicRequest),null);
  }
  assert.equal(f.read({get private(){throw Error('synthetic-secret')}}),null);
});

test('missing image, manifest or source fails closed, including after a previous cache hit',t=>{
  for(const field of ['imageFile','manifestFile','sourceFile']){
    const f=fixture(t);assert.ok(f.read(publicRequest));fs.unlinkSync(f[field]);assert.equal(f.read(publicRequest),null);
  }
});

test('invalid manifest version, prefix, width and hash schemas are rejected',t=>{
  for(const overrides of [{version:2},{prefix:'#别的'},{width:1079},{imageSha256:'bad'},{sourceSha256:'bad'},{imageSha256:1},{sourceSha256:null}]){
    const f=fixture(t);f.writeManifest(overrides);assert.equal(f.read(publicRequest),null);
  }
  for(const content of ['{broken','[]','null']){
    const f=fixture(t);fs.writeFileSync(f.manifestFile,content);assert.equal(f.read(publicRequest),null);
  }
});

test('source edits invalidate a cached help until its matching manifest is rebuilt',t=>{
  const f=fixture(t);assert.ok(f.read(publicRequest));
  fs.appendFileSync(f.sourceFile,'// synthetic newer public command\n');
  assert.equal(f.read(publicRequest),null);
  f.writeManifest();assert.deepEqual(f.read(publicRequest),jpeg());
});

test('raw source bytes are hashed so newline changes cannot silently reuse an outdated manifest',t=>{
  const f=fixture(t);const source=fs.readFileSync(f.sourceFile,'utf8');fs.writeFileSync(f.sourceFile,source.replace(/\n/g,'\r\n'));
  assert.equal(f.read(publicRequest),null);
  f.writeManifest();assert.ok(f.read(publicRequest));
});

test('image tampering cannot return an old cache, even if the original modification time is restored',t=>{
  const f=fixture(t);assert.ok(f.read(publicRequest));const before=fs.statSync(f.imageFile);
  fs.writeFileSync(f.imageFile,jpeg(2));fs.utimesSync(f.imageFile,before.atime,before.mtime);
  assert.equal(f.read(publicRequest),null);
  f.writeManifest();assert.deepEqual(f.read(publicRequest),jpeg(2));
});

test('manifest and image replacement invalidate RAM and correctly validated replacements recover',t=>{
  const f=fixture(t);assert.deepEqual(f.read(publicRequest),jpeg(1));
  const fresh=path.join(f.ui,'replacement.jpg');fs.writeFileSync(fresh,jpeg(3));fs.renameSync(fresh,f.imageFile);
  assert.equal(f.read(publicRequest),null);
  f.writeManifest();assert.deepEqual(f.read(publicRequest),jpeg(3));
});

test('JPEG SOI/EOI and declared image hash are independently required',t=>{
  for(const image of [Buffer.from([137,80,78,71]),Buffer.from([255,216,1,0,0]),Buffer.from([0,0,1,255,217]),Buffer.from([255,216,255])]){
    const f=fixture(t);fs.writeFileSync(f.imageFile,image);f.writeManifest();assert.equal(f.read(publicRequest),null);
  }
  const f=fixture(t);f.writeManifest({imageSha256:'0'.repeat(64)});assert.equal(f.read(publicRequest),null);
});

test('image, manifest and source size limits are applied before reading oversized public files',t=>{
  const image=fixture(t);fs.writeFileSync(image.imageFile,Buffer.alloc(2*1024*1024+1,65));image.writeManifest();assert.equal(image.read(publicRequest),null);
  const manifest=fixture(t);fs.writeFileSync(manifest.manifestFile,' '.repeat(4097));assert.equal(manifest.read(publicRequest),null);
  const source=fixture(t);fs.writeFileSync(source.sourceFile,'x'.repeat(1024*1024+1));source.writeManifest();assert.equal(source.read(publicRequest),null);
});

test('hardlinked image, manifest and source are rejected instead of reading another file alias',t=>{
  for(const field of ['imageFile','manifestFile','sourceFile']){
    const f=fixture(t);assert.ok(f.read(publicRequest));const alias=path.join(f.root,'public-alias');fs.linkSync(f[field],alias);
    assert.equal(f.read(publicRequest),null);fs.unlinkSync(alias);assert.ok(f.read(publicRequest));
  }
});

test('junction or symlink directory replacement is rejected even with previously validated RAM bytes',t=>{
  const f=fixture(t);assert.ok(f.read(publicRequest));
  const original=path.join(f.root,'original-ui');fs.renameSync(f.ui,original);
  fs.symlinkSync(original,f.ui,process.platform==='win32'?'junction':'dir');
  assert.equal(f.read(publicRequest),null);
  assert.deepEqual(fs.readFileSync(path.join(original,'help.jpg')),jpeg());
});

test('symlinked configured root is rejected by the complete ordinary path chain',t=>{
  const f=fixture(t),link=path.join(f.root,'linked-root');fs.symlinkSync(f.root,link,process.platform==='win32'?'junction':'dir');
  const read=createBundledHelpReader({root:link,defaultPrefix:'#公开'});assert.equal(read(publicRequest),null);
});

test('manifest filename hints never redirect reads beyond the fixed public resource path',t=>{
  const f=fixture(t);f.writeManifest({file:'../../config/local.json',imagePath:'../../private.jpg'});
  assert.deepEqual(f.read(publicRequest),jpeg());
});

test('two readers retain separate public RAM bytes and never require a global cache',t=>{
  const a=fixture(t),b=fixture(t);fs.writeFileSync(b.imageFile,jpeg(2));b.writeManifest();
  assert.deepEqual(a.read(publicRequest),jpeg(1));assert.deepEqual(b.read(publicRequest),jpeg(2));
  const bytes=a.read(publicRequest);bytes.fill(0);assert.deepEqual(b.read(publicRequest),jpeg(2));assert.deepEqual(a.read(publicRequest),jpeg(1));
});


test('shipped help JPEG matches the current release view source and default prefix',()=>{
 const root=new URL('../',import.meta.url);
 const read=createBundledHelpReader({root:fileURLToPath(root),defaultPrefix:'#原神'});
 const bytes=read({prefix:'#原神',private:false});
 assert(Buffer.isBuffer(bytes));assert(bytes.length>1000);
});
