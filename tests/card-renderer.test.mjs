import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {deflateSync} from 'node:zlib';
import {createCardRenderer,CardRenderError} from '../lib/card-renderer.mjs';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'teyvat-memory-card-')),assets=path.join(root,'resources');
  fs.mkdirSync(assets);fs.writeFileSync(path.join(assets,'bootstrap.html'),'<!doctype html><body>PUBLIC BOOTSTRAP</body>');fs.writeFileSync(path.join(assets,'theme.css'),'body{color:#123}');fs.writeFileSync(path.join(assets,'font.woff2'),'synthetic-public-font');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,assets,bootstrap:path.join(assets,'bootstrap.html')};
}
function fakeBrowser({box={width:1080,height:1200},requests=[],setContentError=null,contextDelay=null,screenshotDelay=null,closeFailure=false,closeDelay=null,brokenImages=false,bytes=Buffer.from([255,216,255,217])}={}){
  const calls=[],handlers={},frame={};let closed=0;
  const dispatch=(url,navigation=false)=>handlers.request({url:()=>url,isNavigationRequest:()=>navigation,resourceType:()=> 'image',frame:()=>frame,continue:async()=>calls.push(['allow',url]),abort:async()=>calls.push(['block',url])});
  const page={
    setJavaScriptEnabled:async value=>calls.push(['javascript',value]),setCacheEnabled:async value=>calls.push(['cache',value]),setRequestInterception:async value=>calls.push(['interception',value]),on:(event,fn)=>{handlers[event]=fn},mainFrame:()=>frame,
    setViewport:async value=>calls.push(['viewport',value]),
    goto:async(url,options)=>{calls.push(['goto',url,options]);dispatch(url,true);await flush()},
    setContent:async(html,options)=>{calls.push(['content',html,options]);for(const request of requests)typeof request==='string'?dispatch(request):dispatch(request.url,request.navigation);await flush();if(setContentError)throw setContentError},
    evaluate:async()=>{calls.push(['ready']);return brokenImages},
    $:async selector=>selector==='#card'?{boundingBox:async()=>({x:0,y:0,...box}),screenshot:async options=>{calls.push(['screenshot',options]);if(screenshotDelay)await screenshotDelay;return bytes}}:null
  };
  const context={newPage:async()=>{calls.push(['newPage']);return page},close:async()=>{closed++;calls.push(['close']);if(closeDelay)await closeDelay;if(closeFailure)throw Error('COOKIE=synthetic-secret context-close failure')}};
  const browser={createBrowserContext:async()=>{calls.push(['context']);if(contextDelay)await contextDelay;return context},isConnected:()=>true,close:()=>assert.fail('host browser must never close'),newPage:()=>assert.fail('host default context must never be used'),launch:()=>assert.fail('renderer must never launch a browser')};
  return {browser,calls,dispatch,get closed(){return closed}};
}
const card='<html><head><style>body{margin:0}#card{width:1080px;height:1200px;background:#fff}</style></head><body><main id="card">SYNTHETIC PRIVATE CARD</main></body></html>';
function renderer(f,b,extra={}){return createCardRenderer({botRoot:f.root,getBrowser:()=>b.browser,timeoutMs:1000,cleanupMs:20,...extra})}
function pngChunk(type,data){
  const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;
  for(const value of body){crc^=value;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1}
  const length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,sum]);
}
function png(width=1,height=1,padding=0){
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(Buffer.from([0,220,170,70,255]))),...(padding?[pngChunk('tEXt',Buffer.concat([Buffer.from('QA\0'),Buffer.alloc(padding,65)]))]:[]),pngChunk('IEND',Buffer.alloc(0))]);
}
const dataUrl=(bytes,type='png')=>'data:image/'+type+';base64,'+bytes.toString('base64');
const inlineCard=urls=>'<html><head><meta http-equiv="Content-Security-Policy" content="img-src file: data:;"></head><body><main id="card">'+urls.map(url=>'<img src="'+url+'">').join('')+'</main></body></html>';

test('canonical PNG/JPEG inline images are validated in memory before the browser and only same-card image URLs are allowed',async t=>{
  const f=fixture(t),pngUrl=dataUrl(png()),jpeg=Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,0,255,217]),jpegUrl=dataUrl(jpeg,'jpeg'),b=fakeBrowser({requests:[pngUrl,jpegUrl]});
  await renderer(f,b)({html:inlineCard([pngUrl,jpegUrl])});assert.deepEqual(b.calls.filter(call=>call[0]==='allow').map(call=>call[1]),[pngUrl,jpegUrl]);assert.ok(b.calls.find(call=>call[0]==='content')[1].includes('img-src file: data:;'));assert.equal(b.closed,1);
  const foreign=dataUrl(png(2,1)),other=fakeBrowser({requests:[foreign]});await assert.rejects(renderer(f,other)({html:inlineCard([pngUrl])}),error=>error.code==='UNSAFE_ASSET');
  const remote=fakeBrowser({requests:['https://sjpubicres.sanguosha.cn/release/character_heads/example.png']});await assert.rejects(renderer(f,remote)({html:inlineCard([pngUrl])}),error=>error.code==='UNSAFE_ASSET');
});

test('SVG/HTML, mismatched magic, malformed/animated PNG and escaped data schemes are rejected before initialization',async t=>{
  const f=fixture(t);let initialized=0;const render=createCardRenderer({botRoot:f.root,getBrowser:()=>false,ensureBrowser:async()=>{initialized++;return false}}),valid=png(),crcBad=Buffer.from(valid);crcBad[29]^=1;
  const animation=Buffer.concat([valid.subarray(0,-12),pngChunk('acTL',Buffer.alloc(8)),valid.subarray(-12)]);
  const invalid=[dataUrl(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),'svg+xml'),dataUrl(Buffer.from('<html>private</html>'),'png'),dataUrl(valid,'jpeg'),dataUrl(crcBad),dataUrl(animation),dataUrl(png(4097,1)),dataUrl(png(3000,2000)),dataUrl(png(0,1)),dataUrl(Buffer.from([255,216,255,217]),'jpeg'),'d&#97;ta:image/svg+xml;base64,PHN2Zy8+','d\\61 ta:image/svg+xml;base64,PHN2Zy8+','data&colon;image/svg+xml;base64,PHN2Zy8+'];
  for(const uri of invalid)await assert.rejects(render({html:inlineCard([uri])}),error=>error.code==='INVALID_DATA_IMAGE');assert.equal(initialized,0);
});

test('inline images enforce per-image bytes, total bytes, strict base64 and occurrence limits before creating pages',async t=>{
  const f=fixture(t),b=fakeBrowser(),render=renderer(f,b),large=dataUrl(png(1,1,256*1024));
  await assert.rejects(render({html:inlineCard([large])}),error=>['INVALID_DATA_IMAGE','DATA_IMAGE_LIMIT'].includes(error.code));
  const medium=dataUrl(png(1,1,240000));await assert.rejects(render({html:inlineCard(Array(9).fill(medium))}),error=>error.code==='DATA_IMAGE_LIMIT');
  const small=dataUrl(png());await assert.rejects(render({html:inlineCard(Array(65).fill(small))}),error=>error.code==='DATA_IMAGE_LIMIT');
  for(const bad of [small+'=',small.replace(/.$/,'%3D'),small.replace('base64,','base64,\n')])await assert.rejects(render({html:inlineCard([bad])}),error=>error.code==='INVALID_DATA_IMAGE');assert.equal(b.calls.length,0);
});

test('a browser decoder failure suppresses a partial image and closes the isolated context',async t=>{
  const f=fixture(t),b=fakeBrowser({brokenImages:true});await assert.rejects(renderer(f,b)({html:inlineCard([dataUrl(png())])}),error=>error.code==='INVALID_DATA_IMAGE');assert.equal(b.closed,1);assert.equal(b.calls.some(call=>call[0]==='screenshot'),false);
});

test('private and public cards both use isolated memory-only contexts with JS/cache disabled and no screenshot path',async t=>{
  const f=fixture(t),b=fakeBrowser(),before=fs.readdirSync(f.root,{recursive:true}).sort(),source=fs.readFileSync(f.bootstrap,'utf8');
  const render=renderer(f,b);
  for(const privatePage of [true,false])assert.ok(Buffer.isBuffer(await render({html:card,private:privatePage})));
  assert.equal(b.closed,2);assert.equal(b.calls.filter(call=>call[0]==='context').length,2);
  assert.ok(b.calls.filter(call=>call[0]==='javascript').every(call=>call[1]===false));assert.ok(b.calls.filter(call=>call[0]==='cache').every(call=>call[1]===false));
  assert.ok(b.calls.filter(call=>call[0]==='content').every(call=>call[1].includes("script-src 'none'")&&call[1].includes("connect-src 'none'")&&call[1].includes('SYNTHETIC PRIVATE CARD')));
  assert.ok(b.calls.filter(call=>call[0]==='screenshot').every(call=>call[1].path===undefined&&call[1].type==='jpeg'));
  assert.equal(b.calls.some(call=>call[0]==='goto'),false);assert.deepEqual(fs.readdirSync(f.root,{recursive:true}).sort(),before);assert.equal(fs.readFileSync(f.bootstrap,'utf8'),source);
});

test('local ordinary CSS/fonts are allowed only under explicit roots and public HTML bootstraps file origin without edits',async t=>{
  const f=fixture(t),css=pathToFileURL(path.join(f.assets,'theme.css')).href+'?v=1',font=pathToFileURL(path.join(f.assets,'font.woff2')).href,b=fakeBrowser({requests:[css,font]});
  const render=renderer(f,b,{assetRoots:[f.assets],bootstrapFile:f.bootstrap});
  await render({html:card});assert.equal(b.closed,1);
  assert.deepEqual(b.calls.filter(call=>call[0]==='allow').map(call=>call[1]),[pathToFileURL(f.bootstrap).href,css,font]);assert.equal(b.calls.some(call=>call[0]==='block'),false);
  assert.equal(fs.readFileSync(f.bootstrap,'utf8'),'<!doctype html><body>PUBLIC BOOTSTRAP</body>');
});

test('remote/data resources, private files, extra HTML and hardlinks cannot be read or captured',async t=>{
  const f=fixture(t),privateFile=path.join(f.root,'private.css');fs.writeFileSync(privateFile,'synthetic-only-private');const hard=path.join(f.assets,'linked.css');fs.linkSync(privateFile,hard);
  const urls=['https://example.invalid/avatar.png','data:image/png;base64,c3ludGhldGlj',pathToFileURL(privateFile).href,pathToFileURL(f.bootstrap).href,pathToFileURL(hard).href];
  for(const url of urls){const b=fakeBrowser({requests:[url]}),render=renderer(f,b,{assetRoots:[f.assets],bootstrapFile:f.bootstrap});await assert.rejects(render({html:card}),error=>error.code==='UNSAFE_ASSET');assert.ok(b.calls.some(call=>call[0]==='block'&&call[1]===url));assert.equal(b.calls.some(call=>call[0]==='screenshot'),false);assert.equal(b.closed,1)}
  const navigation=fakeBrowser({requests:[{url:pathToFileURL(path.join(f.assets,'theme.css')).href,navigation:true}]});await assert.rejects(renderer(f,navigation,{assetRoots:[f.assets],bootstrapFile:f.bootstrap})({html:card}),error=>error.code==='UNSAFE_ASSET');
});

test('symlinked assets and symlinked bootstrap paths are refused',async t=>{
  const f=fixture(t),outside=path.join(f.root,'separate');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'theme.css'),'synthetic-other-css');fs.writeFileSync(path.join(outside,'bootstrap.html'),'PUBLIC');
  const linked=path.join(f.assets,'linked');fs.symlinkSync(outside,linked,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>renderer(f,fakeBrowser(),{assetRoots:[f.assets],bootstrapFile:path.join(linked,'bootstrap.html')}),/ordinary public HTML/);
  const url=pathToFileURL(path.join(linked,'theme.css')).href,b=fakeBrowser({requests:[url]});
  await assert.rejects(renderer(f,b,{assetRoots:[f.assets],bootstrapFile:f.bootstrap})({html:card}),error=>error.code==='UNSAFE_ASSET');assert.equal(b.closed,1);
});

test('limits reject invalid HTML/width before initialization and excessive dimensions or bytes before returning an image',async t=>{
  const f=fixture(t);let initialized=0;
  const invalid=createCardRenderer({botRoot:f.root,getBrowser:()=>false,ensureBrowser:async()=>{initialized++;return false},maxHtmlBytes:1024});
  for(const args of [{html:card,width:200},{html:'x'.repeat(1025)},{html:card,private:'yes'}])await assert.rejects(invalid(args),error=>error.code==='INVALID_CARD');assert.equal(initialized,0);
  for(const box of [{width:1081,height:1200},{width:1080,height:12001},{width:1600,height:10000},{x:999999999,width:1080,height:1200},{y:999999999,width:1080,height:1200}]){const b=fakeBrowser({box});await assert.rejects(renderer(f,b)({html:card,width:box.width===1600?1600:1080}),error=>error.code==='IMAGE_TOO_LARGE');assert.equal(b.calls.some(call=>call[0]==='screenshot'),false);assert.equal(b.closed,1)}
  const b=fakeBrowser({bytes:Buffer.from([255,216,1,2,3,4])});await assert.rejects(renderer(f,b,{maxBytes:4})({html:card}),error=>error.code==='INVALID_IMAGE');assert.equal(b.closed,1);
  assert.throws(()=>renderer(f,b,{assetRoots:[f.root]}),/specific public directories/);assert.throws(()=>renderer(f,b,{assetRoots:[f.assets]}),/bootstrapFile/);
});

test('request count and asset byte budgets abort excessive local loads',async t=>{
  const f=fixture(t),url=pathToFileURL(path.join(f.assets,'theme.css')).href;
  for(const options of [{maxAssetRequests:1},{maxTotalAssetBytes:1},{maxAssetBytes:1}]){
    // A one-byte per-file budget cannot admit the public bootstrap either.
    if(options.maxAssetBytes){assert.throws(()=>renderer(f,fakeBrowser(),{assetRoots:[f.assets],bootstrapFile:f.bootstrap,...options}),/ordinary public HTML/);continue}
    const b=fakeBrowser({requests:[url,url]});await assert.rejects(renderer(f,b,{assetRoots:[f.assets],bootstrapFile:f.bootstrap,...options})({html:card}),error=>error.code==='UNSAFE_ASSET');assert.equal(b.closed,1);assert.equal(b.calls.some(call=>call[0]==='screenshot'),false);
  }
});

test('another identical module copy shares the rendering lock for both public and private commands',async t=>{
  const peer=await import('../lib/card-renderer.mjs?second-plugin-copy'),f=fixture(t);let release;const pending=new Promise(resolve=>{release=resolve}),b=fakeBrowser({screenshotDelay:pending});
  const first=renderer(f,b)({html:card,private:false});await flush();
  const second=peer.createCardRenderer({botRoot:f.root,getBrowser:()=>b.browser});await assert.rejects(second({html:card,private:true}),error=>error.code==='RENDER_BUSY');release();await first;
  assert.equal(b.calls.filter(call=>call[0]==='context').length,1);assert.equal(b.closed,1);
});

test('host initialization runs once, and a timeout keeps its pending promise shared rather than launching again',async t=>{
  const peer=await import('../lib/card-renderer.mjs?second-plugin-copy'),f=fixture(t),b=fakeBrowser();let current=false,release,count=0;const initialized=new Promise(resolve=>{release=()=>{current=b.browser;resolve(b.browser)}});
  const options={botRoot:f.root,getBrowser:()=>current,ensureBrowser:()=>{count++;return initialized},timeoutMs:100,cleanupMs:20};
  await assert.rejects(createCardRenderer(options)({html:card}),error=>error.code==='RENDER_TIMEOUT');assert.equal(count,1);assert.equal(b.closed,0);
  const second=peer.createCardRenderer({...options,timeoutMs:1000})({html:card,private:false});await flush();assert.equal(count,1);release();assert.ok(Buffer.isBuffer(await second));assert.equal(count,1);assert.equal(b.calls.filter(call=>call[0]==='context').length,1);
});

test('missing, failed or foreign host initialization is sanitized and never creates a page',async t=>{
  const f=fixture(t),b=fakeBrowser();
  await assert.rejects(createCardRenderer({botRoot:f.root,getBrowser:()=>false})({html:card}),error=>error.code==='BROWSER_NOT_READY');
  for(const ensureBrowser of [async()=>false,async()=>{throw Error('COOKIE=synthetic-secret')},async()=>b.browser])await assert.rejects(createCardRenderer({botRoot:f.root,getBrowser:()=>false,ensureBrowser})({html:card}),error=>error instanceof CardRenderError&&!error.message.includes('synthetic-secret')&&error.code==='BROWSER_UNAVAILABLE');
  assert.equal(b.calls.length,0);
});

test('late contexts after a deadline are closed before the shared safety breaker reopens',async t=>{
  const f=fixture(t);let release;const contextDelay=new Promise(resolve=>{release=resolve}),b=fakeBrowser({contextDelay});
  const render=renderer(f,b,{timeoutMs:100});await assert.rejects(render({html:card}),error=>error.code==='RENDER_TIMEOUT');await assert.rejects(render({html:card}),error=>error.code==='CLEANUP_PENDING');
  release();await flush();assert.equal(b.closed,1);assert.equal(b.calls.some(call=>call[0]==='newPage'),false);
  assert.ok(Buffer.isBuffer(await render({html:card})));assert.equal(b.closed,2);
});

test('failed or hanging context close suppresses output and permanently blocks more contexts',async t=>{
  for(const options of [{closeFailure:true},{closeDelay:new Promise(()=>{})}]){
    const f=fixture(t),b=fakeBrowser(options),render=renderer(f,b);
    await assert.rejects(render({html:card}),error=>error.code==='CLEANUP_PENDING'&&!error.message.includes('synthetic-secret'));await assert.rejects(render({html:card}),error=>error.code==='CLEANUP_PENDING');
    assert.equal(b.closed,1);assert.equal(b.calls.filter(call=>call[0]==='context').length,1);
  }
});

test('upstream render errors never echo private HTML, paths or credentials',async t=>{
  const f=fixture(t),b=fakeBrowser({setContentError:Error('COOKIE=synthetic-secret /private/account.json')});
  await assert.rejects(renderer(f,b)({html:card}),error=>error.code==='RENDER_FAILED'&&!/synthetic|private|COOKIE/.test(error.message));assert.equal(b.closed,1);
});
