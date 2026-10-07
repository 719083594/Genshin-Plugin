import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Identical copies in both plugins share this process-wide registry. It holds
// locks and the host initialization promise, never HTML, account data or images.
const REGISTRY=Symbol.for('teyvat-sanguosha.memory-card-renderer.v1');
const states=globalThis[REGISTRY]||(globalThis[REGISTRY]=new Map());
const ASSET_EXTENSIONS=new Set(['.css','.png','.jpg','.jpeg','.webp','.gif','.avif','.svg','.woff','.woff2','.ttf','.otf']);
const MAX_DATA_IMAGE_BYTES=256*1024,MAX_DATA_TOTAL_BYTES=2*1024*1024,MAX_DATA_IMAGES=64;
const PNG_MAGIC=Buffer.from([137,80,78,71,13,10,26,10]);
const CRC_TABLE=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0});
const inside=(root,file)=>{const rel=path.relative(root,file);return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)};
export class CardRenderError extends Error{
  constructor(code,message='图片暂未生成，请稍后重试或查看文字内容。'){super(message);this.name='CardRenderError';this.code=code;}
}
const fail=(code,message)=>{throw new CardRenderError(code,message)};
function crc32(bytes){let crc=0xffffffff;for(const value of bytes)crc=CRC_TABLE[(crc^value)&255]^(crc>>>8);return (crc^0xffffffff)>>>0}
function embeddedDimensions(bytes,type){
  let width=0,height=0;
  if(type==='png'){
    if(bytes.length<45||!bytes.subarray(0,8).equals(PNG_MAGIC))fail('INVALID_DATA_IMAGE');
    let offset=8,header=false,data=false,ended=false;
    while(offset+12<=bytes.length){
      const length=bytes.readUInt32BE(offset),end=offset+12+length;
      if(end>bytes.length)fail('INVALID_DATA_IMAGE');
      const chunk=bytes.toString('ascii',offset+4,offset+8);
      if(!/^[A-Za-z]{4}$/.test(chunk)||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4)||['acTL','fcTL','fdAT'].includes(chunk))fail('INVALID_DATA_IMAGE');
      if(!header){if(chunk!=='IHDR'||length!==13)fail('INVALID_DATA_IMAGE');width=bytes.readUInt32BE(offset+8);height=bytes.readUInt32BE(offset+12);header=true}
      else if(chunk==='IHDR')fail('INVALID_DATA_IMAGE');
      if(chunk==='IDAT')data=true;
      if(chunk==='IEND'){if(length!==0||end!==bytes.length||!data)fail('INVALID_DATA_IMAGE');ended=true;break}
      offset=end;
    }
    if(!ended)fail('INVALID_DATA_IMAGE');
  }else{
    if(bytes.length<12||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)fail('INVALID_DATA_IMAGE');
    let offset=2;
    while(offset<bytes.length-2){
      if(bytes[offset++]!==255)fail('INVALID_DATA_IMAGE');while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];if(marker===0xda)break;
      if(marker===0||marker===0xd8||marker===0xd9||marker>=0xd0&&marker<=0xd7)fail('INVALID_DATA_IMAGE');
      if(offset+2>bytes.length)fail('INVALID_DATA_IMAGE');
      const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)fail('INVALID_DATA_IMAGE');
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
        if(width||length<8||bytes[offset+2]!==8)fail('INVALID_DATA_IMAGE');
        height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);
        const components=bytes[offset+7];if(![1,3,4].includes(components)||length!==8+components*3)fail('INVALID_DATA_IMAGE');
      }
      offset+=length;
    }
  }
  if(!width||!height||width>4096||height>4096||width*height>4194304)fail('INVALID_DATA_IMAGE');
}
function validateEmbeddedImages(html){
  const allowed=new Set();let total=0,count=0;
  const scanned=html.replace(/<meta\b[^>]*>/gi,tag=>/\bhttp-equiv\s*=\s*(?:"Content-Security-Policy"|'Content-Security-Policy'|Content-Security-Policy(?=\s|\/?>))/i.test(tag)?tag.replace(/\bdata:(?=[\s;'"\/?>])/gi,'VALIDATED_CSP_IMAGE_SCHEME'):tag);
  const remainder=scanned.replace(/data:[^"'\s<>)]*/gi,uri=>{
    const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
    if(!match||match[2].length%4||match[2].length>Math.ceil(MAX_DATA_IMAGE_BYTES/3)*4)fail('INVALID_DATA_IMAGE','内嵌图片不符合PNG/JPEG安全要求。');
    const bytes=Buffer.from(match[2],'base64');
    if(bytes.length>MAX_DATA_IMAGE_BYTES||bytes.toString('base64')!==match[2]||(total+=bytes.length)>MAX_DATA_TOTAL_BYTES||++count>MAX_DATA_IMAGES)fail('DATA_IMAGE_LIMIT','内嵌图片过多或过大，请减少查询数量。');
    embeddedDimensions(bytes,match[1]);allowed.add(uri);return 'VALIDATED_INLINE_IMAGE';
  });
  // Views produce canonical ASCII URLs. Refuse entity/CSS-escaped spellings
  // rather than letting a second parser introduce an unchecked data scheme.
  const decoded=remainder.replace(/&#(?:x([a-f\d]+)|(\d+));?/gi,(_,hex,decimal)=>{const value=Number.parseInt(hex||decimal,hex?16:10);return value>0&&value<=0x10ffff?String.fromCodePoint(value):''})
    .replace(/&(colon|tab|newline);/gi,(_,name)=>name.toLowerCase()==='colon'?':':' ')
    .replace(/\\(?:\r\n|[\r\n\f])/g,'').replace(/\\([a-f\d]{1,6})(?:\r\n|[\t\n\f\r ])?|\\([^\r\n])/gi,(_,hex,char)=>hex?String.fromCodePoint(Math.min(Number.parseInt(hex,16)||0xfffd,0x10ffff)):char).replace(/[\u0000-\u0020\u007f]/g,'');
  if(/data:/i.test(decoded))fail('INVALID_DATA_IMAGE','内嵌图片必须使用标准PNG/JPEG格式。');
  return allowed;
}
function ordinaryFile(root,file,maxSize){
  if(!inside(root,file))fail('UNSAFE_ASSET');
  for(let cursor=root;cursor!==path.dirname(cursor);cursor=path.dirname(cursor))if(fs.lstatSync(cursor).isSymbolicLink())fail('UNSAFE_ASSET');
  let cursor=root;
  for(const part of ['',...path.relative(root,file).split(path.sep).filter(Boolean)]){
    if(part)cursor=path.join(cursor,part);
    const stat=fs.lstatSync(cursor);
    if(stat.isSymbolicLink()||cursor!==file&&!stat.isDirectory()||cursor===file&&(!stat.isFile()||stat.nlink!==1||stat.size>maxSize))fail('UNSAFE_ASSET');
    if(cursor===file)return stat.size;
  }
  fail('UNSAFE_ASSET');
}
function assetInfo(roots,url,maxSize){
  const parsed=new URL(url);
  if(parsed.protocol!=='file:'||parsed.hostname||parsed.username||parsed.password)fail('UNSAFE_ASSET');
  const file=fileURLToPath(parsed);
  if(!ASSET_EXTENSIONS.has(path.extname(file).toLowerCase()))fail('UNSAFE_ASSET');
  const root=roots.find(value=>inside(value,file));
  if(!root)fail('UNSAFE_ASSET');
  return {file,size:ordinaryFile(root,file,maxSize)};
}
const browserReady=browser=>Boolean(browser&&typeof browser.createBrowserContext==='function'&&(typeof browser.isConnected!=='function'||browser.isConnected()));
const policy="default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; base-uri 'none'; form-action 'none'; img-src file: data:; font-src file:; style-src 'unsafe-inline' file:";

/** HTML/CSS must come from trusted views. No host screenshot/template cache or
 * launcher is used. ensureBrowser may call the existing host browserInit only;
 * its verified contract returns the same Browser as getBrowser(), or false.
 * With file assets, bootstrapFile must be an unchanged public HTML file within
 * assetRoots, establishing a file origin before private setContent in memory. */
export function createCardRenderer({botRoot,getBrowser,assetRoots=[],bootstrapFile=null,ensureBrowser=null,onMetrics=null,timeoutMs=20000,cleanupMs=5000,maxHeight=12000,maxPixels=12000000,maxBytes=8*1024*1024,maxHtmlBytes=4*1024*1024,maxAssetBytes=8*1024*1024,maxTotalAssetBytes=32*1024*1024,maxAssetRequests=100}={}){
  if(typeof botRoot!=='string'||!botRoot||typeof getBrowser!=='function'||ensureBrowser!==null&&typeof ensureBrowser!=='function'||onMetrics!==null&&typeof onMetrics!=='function'||!Array.isArray(assetRoots)||!assetRoots.every(value=>typeof value==='string'&&value))throw new TypeError('Invalid card renderer configuration');
  for(const [value,min,max]of [[timeoutMs,100,30000],[cleanupMs,10,10000],[maxHeight,100,16000],[maxPixels,10000,16000000],[maxBytes,4,16*1024*1024],[maxHtmlBytes,1024,4*1024*1024],[maxAssetBytes,1,16*1024*1024],[maxTotalAssetBytes,1,64*1024*1024],[maxAssetRequests,1,200]])if(!Number.isInteger(value)||value<min||value>max)throw new TypeError('Invalid card renderer limits');
  const root=path.resolve(botRoot),roots=[...new Set(assetRoots.map(value=>path.resolve(value)))];
  if(roots.some(value=>!inside(root,value)||value===root))throw new TypeError('Asset roots must be specific public directories within botRoot');
  let bootstrap=null;
  if(bootstrapFile!==null){
    if(typeof bootstrapFile!=='string'||!['.html','.htm'].includes(path.extname(bootstrapFile).toLowerCase()))throw new TypeError('Invalid public bootstrap file');
    bootstrap=path.resolve(bootstrapFile);
    const owner=roots.find(value=>inside(value,bootstrap));
    if(!owner)throw new TypeError('Public bootstrap must be inside assetRoots');
    try{ordinaryFile(owner,bootstrap,maxAssetBytes)}catch{throw new TypeError('Public bootstrap must be an ordinary public HTML file')}
  }
  if(roots.length&&!bootstrap)throw new TypeError('File assets require an explicit public bootstrapFile');
  const stateKey=process.platform==='win32'?root.toLowerCase():root;
  if(!states.has(stateKey))states.set(stateKey,{active:false,blockers:new Set(),initializing:null});
  const state=states.get(stateKey);
  // An old unknown blocker during mixed-version module loading cannot safely
  // be cleared. New contexts each own one independent confirmation token.
  if(!state.blockers)state.blockers=new Set();
  async function existingBrowser(){
    let browser;try{browser=getBrowser()}catch{fail('BROWSER_UNAVAILABLE')}
    if(browserReady(browser))return browser;
    if(!ensureBrowser)fail('BROWSER_NOT_READY','图片浏览器尚未就绪，请稍后重试或查看文字内容。');
    if(!state.initializing){
      const pending=Promise.resolve().then(()=>ensureBrowser());
      state.initializing=pending;
      // Keep the exact promise until it settles, including after a render
      // deadline. Another plugin must never launch a replacement in parallel.
      pending.then(()=>{if(state.initializing===pending)state.initializing=null},()=>{if(state.initializing===pending)state.initializing=null});
    }
    let initialized;try{initialized=await state.initializing;browser=getBrowser()}catch{fail('BROWSER_UNAVAILABLE')}
    if(!browserReady(browser)||initialized!==browser)fail('BROWSER_UNAVAILABLE','图片浏览器启动未成功，请稍后重试或查看文字内容。');
    return browser;
  }
  return async function renderCard({html,width=1080,private:privatePage=true}={}){
    if(typeof html!=='string'||!html||Buffer.byteLength(html)>maxHtmlBytes||!Number.isInteger(width)||width<320||width>1600||typeof privatePage!=='boolean')fail('INVALID_CARD','图片内容或尺寸不符合要求。');
    const embeddedImages=validateEmbeddedImages(html);
    if(state.blocked===true||state.blockers.size)fail('CLEANUP_PENDING','上次图片页面尚未确认关闭，请暂时查看文字内容。');
    if(state.active)fail('RENDER_BUSY','另一张图片正在生成，请稍后重试。');
    state.active=true;
    // Only admitted renders report; queue wait, view creation and transport are
    // outside this lifecycle. Keep the interrupted phase, not "cleanup", so a
    // timeout can be diagnosed without logging inputs, account data or errors.
    const started=performance.now(),metrics={browser:0,context:0,setup:0,content:0,screenshot:0,cleanup:0,total:0,lastPhase:'browser'};
    let phase='browser',phaseStarted=started,measuring=true;
    const markPhase=next=>{
      if(!measuring)return;
      const time=performance.now();metrics[phase]+=time-phaseStarted;phaseStarted=time;
      if(next){phase=next;metrics.lastPhase=next}else measuring=false;
    };
    const reportMetrics=()=>{
      if(!onMetrics)return;
      const snapshot=Object.freeze(Object.fromEntries(Object.entries(metrics).map(([name,value])=>[name,typeof value==='number'?Math.round(Math.max(0,value)*10)/10:value])));
      // A logger callback cannot replace the render outcome or cleanup breaker.
      // Async callbacks are not awaited; their rejection is consumed as well.
      try{Promise.resolve(onMetrics(snapshot)).catch(()=>{})}catch{}
    };
    let context,page,timer,aborted=false,contextPending=false,realClose;
    const closeToken=Symbol('owned-card-context');
    const check=()=>{if(aborted)fail('RENDER_TIMEOUT')};
    const beginClose=()=>{
      if(!context)return null;
      if(!realClose){
        // Add before awaiting to avoid a timeout/late-success lost-wakeup race.
        // Only this context's genuine successful close may remove its token.
        state.blockers.add(closeToken);
        realClose=Promise.resolve().then(()=>context.close()).then(()=>{state.blockers.delete(closeToken);return true},()=>false);
      }
      return realClose;
    };
    const waitForClose=async()=>{
      const pending=beginClose();if(!pending)return true;
      let deadline;
      try{return await Promise.race([pending,new Promise(resolve=>{deadline=setTimeout(()=>resolve(false),cleanupMs)})])}finally{clearTimeout(deadline)}
    };
    let assetsBytes=0,assetRequests=0,blockedAsset=false,bootstrapping=false,bootstrapUsed=false;
    const requestHandler=request=>{
      Promise.resolve().then(()=>{
        if(aborted)return request.abort();
        if(bootstrapping&&!bootstrapUsed&&bootstrap&&request.url()===pathToFileURL(bootstrap).href&&request.isNavigationRequest()&&request.frame()===page.mainFrame()){
          const owner=roots.find(value=>inside(value,bootstrap));ordinaryFile(owner,bootstrap,maxAssetBytes);bootstrapUsed=true;return request.continue();
        }
        try{
          if(request.isNavigationRequest())fail('UNSAFE_ASSET');
          if(embeddedImages.has(request.url())&&request.resourceType()==='image'){
            if(++assetRequests>maxAssetRequests)fail('ASSET_LIMIT');
            return request.continue();
          }
          const asset=assetInfo(roots,request.url(),maxAssetBytes);
          if(++assetRequests>maxAssetRequests||(assetsBytes+=asset.size)>maxTotalAssetBytes)fail('ASSET_LIMIT');
          return request.continue();
        }catch{
          // A public bootstrap may contain unexpanded template asset URLs. They
          // are blocked too, but only the trusted final card determines success.
          if(!bootstrapping)blockedAsset=true;
          return request.abort();
        }
      }).catch(()=>{if(!bootstrapping)blockedAsset=true;Promise.resolve().then(()=>request.abort()).catch(()=>{})});
    };
    try{
      return await Promise.race([(async()=>{
        const browser=await existingBrowser();check();
        markPhase('context');
        contextPending=true;context=await browser.createBrowserContext();contextPending=false;
        if(aborted){beginClose();check()}
        page=await context.newPage();check();
        markPhase('setup');
        await page.setJavaScriptEnabled(false);check();
        await page.setCacheEnabled(false);check();
        await page.setRequestInterception(true);check();
        page.on('request',requestHandler);
        await page.setViewport({width,height:800,deviceScaleFactor:1});check();
        markPhase('content');
        if(bootstrap){bootstrapping=true;await page.goto(pathToFileURL(bootstrap).href,{waitUntil:'domcontentloaded',timeout:timeoutMs});bootstrapping=false;check()}
        const secured='<!doctype html><meta http-equiv="Content-Security-Policy" content="'+policy+'">'+html;
        await page.setContent(secured,{waitUntil:'load',timeout:timeoutMs});check();
        const brokenImages=await page.evaluate(async()=>{await document.fonts.ready;return Array.from(document.images).some(image=>!image.complete||!image.naturalWidth)});check();
        if(brokenImages===true)fail('INVALID_DATA_IMAGE','图片资源未能完整解码，已停止生成。');
        if(blockedAsset)fail('UNSAFE_ASSET','图片包含未获允许的资源，已停止生成。');
        const card=await page.$('#card')||await page.$('#container')||await page.$('body');check();
        if(!card)fail('EMPTY_CARD');
        const box=await card.boundingBox();check();
        if(!box||![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.x<0||box.y<0||box.width<100||box.x+box.width>width||box.height<100||box.y+box.height>maxHeight||Math.ceil(box.width)*Math.ceil(box.height)>maxPixels)fail('IMAGE_TOO_LARGE','图片尺寸过大，请查看文字内容或减少查询数量。');
        markPhase('screenshot');
        // ElementHandle.screenshot adds an unbounded IntersectionObserver wait,
        // scrolling and a second geometry lookup. The trusted static card is
        // already measured: capture that exact bounded region without scrolling
        // or resizing, while retaining Puppeteer's browser screenshot guard.
        const image=Buffer.from(await page.screenshot({type:'jpeg',quality:88,clip:{x:box.x,y:box.y,width:box.width,height:box.height},captureBeyondViewport:true}));check();
        if(blockedAsset)fail('UNSAFE_ASSET','图片包含未获允许的资源，已停止生成。');
        if(image.length<4||image.length>maxBytes||image[0]!==0xff||image[1]!==0xd8)fail('INVALID_IMAGE');
        return image;
      })(),new Promise((_,reject)=>{timer=setTimeout(()=>{aborted=true;reject(new CardRenderError('RENDER_TIMEOUT','图片生成超时，请稍后重试或查看文字内容。'))},timeoutMs)})]);
    }catch(error){if(error instanceof CardRenderError)throw error;fail('RENDER_FAILED')}
    finally{
      aborted=true;clearTimeout(timer);html='';
      markPhase();const cleanupStarted=performance.now();
      // A late createBrowserContext must keep this token until its eventual
      // returned context is really closed; a timeout is not that confirmation.
      if(contextPending)state.blockers.add(closeToken);
      const cleanupPending=contextPending||!(await waitForClose());
      state.active=false;
      metrics.cleanup=performance.now()-cleanupStarted;metrics.total=performance.now()-started;reportMetrics();
      if(cleanupPending&&context)fail('CLEANUP_PENDING','图片页面未确认关闭，本次图片不发送；请暂时查看文字内容。');
    }
  };
}
