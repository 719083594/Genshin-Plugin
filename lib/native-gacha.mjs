import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {nativeGachaIdentity,readNativeGachaScoped} from './native-accounts.mjs';

// miao b01d774: GachaData.readJSON only reads Data.readJSON. The original
// Runtime/Puppeteer template chain writes HTML (and dev JSON), so it is never
// called for these private images, even when its retType is "base64".
const installed=new WeakMap(),running=new WeakSet();
const TEMPLATES=new Set(['gacha/gacha-detail','gacha/gacha-stat']);
let privateRendering={renderPrivate:null,image:null};
export class NativeGachaError extends Error{
  constructor(code,message='私人祈愿图未生成；请使用 #原神祈愿分析 查看已导入记录。'){super(message);this.name='NativeGachaError';this.code=code;}
}
const fail=(code,message)=>{throw new NativeGachaError(code,message)};
const inside=(root,file)=>{const rel=path.relative(root,file);return rel===''||!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)};
function protectedPath(file,root){
  if(typeof file!=='string')return null;
  const raw=file.replace(/\\/g,'/').replace(/^\/+/,''),parts=raw.split('/');
  if(!parts.some(part=>/^(?:gachaJson|srJson)$/i.test(part)))return null;
  if(!['','root','yunzai'].includes(root)||parts.some(part=>!part||part==='.'||part==='..')||file.includes('\\')||file.includes('\0'))fail('UNSAFE_PATH');
  const match=/^data\/gachaJson\/([1-9]\d{4,14})\/(\d{9,10})\/(100|200|301|302|400|500)\.json$/.exec(raw);
  if(!match)fail('UNSAFE_PATH');
  return {owner:match[1],uid:match[2],pool:match[3]==='400'?'301':match[3]};
}
function cnTime(time,timezone){
  if(typeof time!=='string'||!/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(time)||typeof timezone!=='number'||!Number.isFinite(timezone)||Math.abs(timezone)>24)fail('INVALID_RECORDS');
  const value=new Date(Date.parse(time.replace(' ','T')+'Z')+(8-timezone)*3600000);
  if(!Number.isFinite(value.getTime()))fail('INVALID_RECORDS');
  return value.toISOString().slice(0,19).replace('T',' ');
}
function recordsForMiao(snapshot,pool,{resolveItem,validateVersion}){
  if(!snapshot||!Array.isArray(snapshot.records)||snapshot.records.length>100000)fail('INVALID_RECORDS');
  const rows=snapshot.records.filter(row=>String(row.uigf_gacha_type||row.gacha_type)==pool);
  if(rows.length&&!resolveItem)fail('METADATA_UNAVAILABLE','原生物品元数据尚未就绪；请使用 #原神祈愿分析。');
  return rows.map(row=>{
    if(row.order_uncertain||row.synthetic_id)fail('UNCERTAIN_ORDER','旧文件部分记录顺序无法确认，暂不生成可能误导的原生图；请使用 #原神祈愿分析。');
    if(typeof row.id!=='string'||!/^\d{1,64}$/.test(row.id)||String(row.uid)!==String(snapshot.uid))fail('INVALID_RECORDS');
    let item;try{item=resolveItem({...row,game:'gs'})}catch{fail('METADATA_UNAVAILABLE')}
    if(!item||!['char','weapon'].includes(item.type)||!['3','4','5'].includes(String(item.star))||typeof item.name!=='string'||!item.name||item.name.length>200||!/^\d{1,30}$/.test(String(item.id)))fail('METADATA_UNAVAILABLE','部分记录缺少可核对的原神物品信息，原生图已停止；完整记录仍保留在加密库。');
    if(row.item_id&&String(row.item_id)!==String(item.id)||row.rank_type&&String(row.rank_type)!==String(item.star))fail('METADATA_CONFLICT');
    const time=cnTime(row.time,snapshot.timezone);
    if(String(item.star)==='5'&&['301','302','500'].includes(pool)&&(!validateVersion||validateVersion({time,pool,name:item.name,type:item.type})!==true))fail('UNKNOWN_POOL','部分五星缺少对应历史卡池资料，无法可靠判断UP；请使用 #原神祈愿分析。');
    return {uid:String(snapshot.uid),id:row.id,gacha_type:pool,uigf_gacha_type:pool,item_id:String(item.id),name:item.name,item_type:item.type==='char'?'角色':'武器',rank_type:String(item.star),count:row.count||'1',time};
  // miao sorts by time, retaining input order for equal timestamps. Supply
  // descending BigInt IDs so same-second ten-pulls remain newest first.
  }).sort((a,b)=>b.time.localeCompare(a.time)||(BigInt(a.id)>BigInt(b.id)?-1:BigInt(a.id)<BigInt(b.id)?1:0));
}

// Fixed model contracts: Character.get(value,game) may fall back to SR through
// Meta.matchGame, so explicitly reject its returned game. Weapon.get is exact.
// GachaData.getVersion(time,hasVersion,isMix,game) returns empty UP arrays when
// the installed historical metadata cannot resolve the record's pool.
export function createMiaoGachaMetadata({Character,Weapon,GachaData}={}){
  if(typeof Character?.get!=='function'||typeof Weapon?.get!=='function'||typeof GachaData?.getVersion!=='function')fail('METADATA_UNAVAILABLE');
  return {
    resolveItem(row){
      const key=row.item_id||row.name;if(!key)return null;
      const char=Character.get(key,'gs'),weapon=Weapon.get(key,'gs');
      const candidates=[];
      if(char?.game==='gs'&&char.isOfficial===true)candidates.push({id:char.id,name:char.name,star:char.star,type:'char'});
      if(weapon?.game==='gs')candidates.push({id:weapon.id,name:weapon.name,star:weapon.star,type:'weapon'});
      return candidates.length===1?candidates[0]:null;
    },
    validateVersion({time,pool,type}){
      if(!['301','302','500'].includes(pool)||!['char','weapon'].includes(type))return false;
      const version=GachaData.getVersion(new Date(time),true,pool==='500','gs');
      const names=version?.[type==='char'?'char5':'weapon5'];
      return typeof version?.version==='string'&&version.version!=='未知'&&Array.isArray(names)&&names.length>0;
    }
  };
}

export function configureNativeGacha({renderPrivate=null,image=null}={}){
  if(renderPrivate!==null&&typeof renderPrivate!=='function'||image!==null&&typeof image!=='function')throw new TypeError('Invalid private gacha renderer');
  privateRendering={renderPrivate,image};
}
export function installNativeGacha({Data,resolveItem,validateVersion}={}){
  if(!Data||!['readJSON','writeJSON','delFile'].every(name=>typeof Data[name]==='function'))fail('INCOMPATIBLE_DATA');
  if(installed.has(Data))return installed.get(Data);
  const originals=Object.fromEntries(['readJSON','writeJSON','delFile'].map(name=>[name,Data[name]]));
  const wrappers={
    readJSON(file='',root=''){
      const entry=protectedPath(file,root);if(!entry)return originals.readJSON.apply(this,arguments);
      return recordsForMiao(readNativeGachaScoped(entry.owner,entry.uid),entry.pool,{resolveItem,validateVersion});
    },
    writeJSON(cfg,data,root=''){
      const objectForm=arguments.length===1&&cfg&&typeof cfg==='object'&&!Array.isArray(cfg);
      const file=objectForm?(cfg.path?cfg.path+'/'+cfg.name:cfg.name):cfg;
      if(protectedPath(file,objectForm?cfg.root||'':root))fail('READ_ONLY','原生祈愿写入已停用；请通过 #原神祈愿导入 写入本人加密库。');
      return originals.writeJSON.apply(this,arguments);
    },
    delFile(file,root=''){
      if(protectedPath(file,root))fail('READ_ONLY','原生祈愿删除已停用；不会改动加密库或旧文件。');
      return originals.delFile.apply(this,arguments);
    }
  };
  for(const [name,fn]of Object.entries(wrappers))Data[name]=fn;
  const guard={installed:true,restore(){for(const [name,fn]of Object.entries(wrappers))if(Data[name]===fn)Data[name]=originals[name];installed.delete(Data)}};
  installed.set(Data,guard);return guard;
}

/** Called inside runNativeScope, only for miao gacha detail/stat handlers. */
export async function runNativeGacha(event,handler){
  let previous,entered=false;
  try{
    const identity=nativeGachaIdentity();
    if(running.has(event))fail('BUSY','此条祈愿消息正在处理，请稍后重试。');
    running.add(event);entered=true;
    previous=Object.getOwnPropertyDescriptor(event,'runtime');
    const runtime=Object.create(event.runtime||null),settings=privateRendering;
    Object.defineProperty(runtime,'render',{value:async(plugin,template,data={},options={})=>{
      const current=nativeGachaIdentity();
      if(current.owner!==identity.owner||current.uid!==identity.uid||plugin!=='miao-plugin'||!TEMPLATES.has(template)||data.game!=='gs'||String(data.uid)!==identity.uid)fail('RENDER_SCOPE');
      if(!settings.renderPrivate||!settings.image)fail('RENDERER_UNAVAILABLE','私人内存渲染尚未就绪；请使用 #原神祈愿分析。');
      const buffer=await settings.renderPrivate({plugin,template,data,options});
      const after=nativeGachaIdentity();
      if(after.owner!==identity.owner||after.uid!==identity.uid||!Buffer.isBuffer(buffer))fail('RENDER_SCOPE');
      return settings.image(buffer);
    },configurable:true});
    event.runtime=runtime;
    const result=await handler();
    await event.reply?.('统计仅覆盖本人已导入记录；首段可能不完整，UP判断依据本地历史卡池资料。时间按UTC+8显示。'+(/全部/.test(event.msg||'')?'原生全部统计含角色、武器、常驻、集录池；新手池请查看文字祈愿分析。':''));
    return result;
  }catch(error){
    await event.reply?.(error instanceof NativeGachaError?error.message:'私人祈愿图未生成；仅允许本人私聊查询当前所选原神UID，请检查加密记录。');
    return true;
  }finally{
    if(entered){running.delete(event);if(previous)Object.defineProperty(event,'runtime',previous);else delete event.runtime;}
  }
}

function publicFile(root,file){
  if(!inside(root,file))fail('UNSAFE_RESOURCE');
  for(let ancestor=root;ancestor!==path.dirname(ancestor);ancestor=path.dirname(ancestor))if(fs.lstatSync(ancestor).isSymbolicLink())fail('UNSAFE_RESOURCE');
  let cursor=root;
  for(const part of ['',...path.relative(root,file).split(path.sep).filter(Boolean)]){
    if(part)cursor=path.join(cursor,part);
    const stat=fs.lstatSync(cursor);
    if(stat.isSymbolicLink()||cursor!==file&&!stat.isDirectory()||cursor===file&&(!stat.isFile()||stat.nlink!==1))fail('UNSAFE_RESOURCE');
  }
  return file;
}

/** Reuse an existing browser only. No host Runtime, launcher, Redis, file cache,
 * screenshot path, external URL or persistent/private browser context is used. */
export function createNativeGachaRenderer({botRoot,getBrowser,templateEngine,timeoutMs=20000,maxHeight=12000,maxBytes=8*1024*1024}={}){
  if(typeof getBrowser!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)throw new TypeError('Invalid memory renderer configuration');
  const root=path.resolve(botRoot),resources=path.join(root,'plugins/miao-plugin/resources');
  let active=false,blocked=false,engine=templateEngine;
  return async function render({plugin,template,data,options={}}){
    if(blocked)fail('CLEANUP_PENDING','上次私密页面尚未确认关闭；请暂用文字祈愿分析。');
    if(active)fail('RENDER_BUSY','私人图片正在生成，请稍后重试。');
    if(plugin!=='miao-plugin'||!TEMPLATES.has(template)||data?.game!=='gs')fail('RENDER_SCOPE');
    if((data.gacha?.fiveLog?.length||0)>160||(data.gacha?.versionData?.length||0)>80)fail('IMAGE_TOO_LARGE','记录过多，暂不生成超长图片；完整统计请使用 #原神祈愿分析 或导出。');
    const browser=getBrowser();
    if(!browser||typeof browser.createBrowserContext!=='function'||browser.isConnected?.()===false)fail('BROWSER_NOT_READY','图片浏览器尚未启动；本命令不会新开浏览器，请先使用普通公共图片命令，或查看文字祈愿分析。');
    const tpl=publicFile(resources,path.join(resources,template+'.html'));
    const layout=publicFile(resources,path.join(resources,'common/layout/elem.html'));
    if(!engine)try{engine=createRequire(path.join(root,'package.json'))('art-template')}catch{fail('TEMPLATE_UNAVAILABLE')}
    if(typeof engine.render!=='function')fail('TEMPLATE_UNAVAILABLE');
    const res=pathToFileURL(resources+path.sep).href;
    const base={sys:{scale:1},copyright:'Teyvat-Plugin · Miao-Plugin',...data,pluResPath:res};
    let payload=typeof options.beforeRender==='function'?options.beforeRender({data:base})||base:base;
    payload={...payload,_res_path:res,_miao_path:res,_tpl_path:path.join(resources,'common/tpl')+path.sep,defaultLayout:path.join(resources,'common/layout/default.html'),elemLayout:layout};
    let html;try{html=engine.render(fs.readFileSync(tpl,'utf8'),payload,{filename:tpl,cache:false})}catch{fail('TEMPLATE_FAILED')}
    if(typeof html!=='string'||Buffer.byteLength(html)>4*1024*1024)fail('IMAGE_TOO_LARGE');
    // Adapt only the fixed upstream instruction markup in memory; never edit
    // the original templates or advertise the disabled authkey/write routes.
    html=html.replace(/<strong>#?抽卡帮助<\/strong>获取抽卡链接/g,'<strong>#原神帮助</strong>查看使用说明')
      .replace(/<strong>#?更新抽卡记录<\/strong>更新抽卡信息/g,'<strong>#原神祈愿导入</strong>导入本人UIGF记录')
      .replace(/<strong>#?抽卡帮助<\/strong>/g,'<strong>#原神帮助</strong>')
      .replace(/<strong>#?更新抽卡记录<\/strong>/g,'<strong>#原神祈愿导入</strong>');
    active=true;let context,page,aborted=false,timer,contextPending=false,closeAttempt;
    const check=()=>{if(aborted)fail('RENDER_TIMEOUT')};
    const close=()=>!context?Promise.resolve(true):closeAttempt||(closeAttempt=Promise.race([Promise.resolve().then(()=>context.close()).then(()=>true,()=>false),new Promise(resolve=>{const t=setTimeout(()=>resolve(false),1000);t.unref?.()})]));
    const allowed=request=>{
      try{
        const url=new URL(request.url());
        if(url.protocol!=='file:'||url.hostname)return false;
        return Boolean(publicFile(resources,fileURLToPath(url)));
      }catch{return false}
    };
    try{
      return await Promise.race([(async()=>{
        contextPending=true;context=await browser.createBrowserContext();contextPending=false;if(aborted){blocked=!(await close());check()}
        page=await context.newPage();check();
        await page.setJavaScriptEnabled(false);check();
        await page.setCacheEnabled(false);check();
        await page.setRequestInterception(true);check();
        page.on('request',request=>{Promise.resolve().then(()=>allowed(request)?request.continue():request.abort()).catch(()=>{})});
        await page.setViewport({width:900,height:800,deviceScaleFactor:1});check();
        // Bootstrap from an unchanged public file. Only the following setContent
        // receives private HTML; no private file URL or disk write is involved.
        await page.goto(pathToFileURL(layout).href,{waitUntil:'domcontentloaded',timeout:timeoutMs});check();
        await page.setContent(html,{waitUntil:'load',timeout:timeoutMs});check();
        await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(Array.from(document.images,image=>image.complete?undefined:new Promise(resolve=>{image.onload=resolve;image.onerror=resolve}))) });check();
        const body=await page.$('#container');check();if(!body)fail('EMPTY_IMAGE');
        const box=await body.boundingBox();check();
        if(!box||!Number.isFinite(box.width)||!Number.isFinite(box.height)||box.width<100||box.width>1600||box.height<100||box.height>maxHeight)fail('IMAGE_TOO_LARGE','图片尺寸超出安全范围；请查看文字祈愿分析或导出完整记录。');
        const bytes=await body.screenshot({type:'jpeg',quality:85});check();
        const buffer=Buffer.from(bytes);
        if(buffer.length<4||buffer.length>maxBytes||buffer[0]!==0xff||buffer[1]!==0xd8)fail('INVALID_IMAGE');
        return buffer;
      })(),new Promise((_,reject)=>{timer=setTimeout(()=>{aborted=true;reject(new NativeGachaError('RENDER_TIMEOUT','私人图片生成超时；未写入明文缓存。'))},timeoutMs)})]);
    }catch(error){if(error instanceof NativeGachaError)throw error;fail('RENDER_FAILED')}
    finally{aborted=true;clearTimeout(timer);html='';const cleanupPending=contextPending||!(await close());if(cleanupPending)blocked=true;active=false;if(cleanupPending&&context)fail('CLEANUP_PENDING','私密页面未确认关闭，本次图片不发送；请暂用文字祈愿分析。');}
  };
}

export const nativeGachaSource=Object.freeze({miaoCommit:'b01d77483268eb2236876ad0995fab27052c09ad',readPath:'data/gachaJson/<QQ>/<UID>/<pool>.json',templates:[...TEMPLATES],limitations:['仅本人私聊当前所选UID','无authkey获取、原生记录写入或旧明文回退','未知物品、顺序或历史卡池不生成可能误导的图','只复用已经启动的浏览器，不launch/reconnect；每次仅一个临时context/page']});
