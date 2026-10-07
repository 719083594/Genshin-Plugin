/** Public artwork only. Authentication and personal records never reach this fetcher. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const HOSTS=['mihoyo.com','miyoushe.com','hoyolab.com','hoyoverse.com'];
const MAX_BYTES=524288,MAX_CACHE_BYTES=8*1024*1024;

export function safeRecordArtworkUrl(value){
  if(typeof value!=='string'||value.length>2048)return null;
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.port||!HOSTS.some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))return null;
    if(!/\.(?:png|jpe?g|webp)$/i.test(url.pathname))return null;
    url.search='';url.hash='';return url.href;
  }catch{return null;}
}

function artworkRequests(model){
  const found=new Map();let visited=0;
  function walk(value,depth=0){
    if(!value||typeof value!=='object'||depth>12||++visited>4000)return;
    if(Array.isArray(value)){for(const item of value.slice(0,200))walk(item,depth+1);return;}
    const id=value.id??value.avatar_id??value.character_id;
    const url=safeRecordArtworkUrl(value.icon??value.image??value.avatar_icon);
    if(id!==undefined&&/^[\w-]{1,40}$/.test(String(id))&&(url||/^1\d{7}$/.test(String(id)))&&found.size<96&&(!found.has(String(id))||url))found.set(String(id),url);
    for(const child of Object.values(value))walk(child,depth+1);
  }
  walk(model);return [...found];
}

function localPublicAvatars(){
  const root=fileURLToPath(new URL('../../miao-plugin/resources/meta-gs/character/',import.meta.url));
  let catalog;
  return async id=>{
    if(!/^1\d{7}$/.test(id))return null;
    if(!catalog)catalog=Promise.all([fs.realpath(root),fs.readFile(path.join(root,'data.json'),'utf8')]).then(([realRoot,json])=>({realRoot,rows:JSON.parse(json)})).catch(()=>null);
    const loaded=await catalog;if(!loaded)return null;
    const row=loaded.rows[id],name=row?.name;
    if(String(row?.id)!==id||typeof name!=='string'||!name||name==='.'||name==='..'||name.includes('/')||name.includes('\\')||name.includes('\0'))return null;
    const file=await fs.realpath(path.join(root,name,'imgs','face.webp'));
    if(!file.startsWith(loaded.realRoot+path.sep))return null;
    const info=await fs.stat(file);if(!info.isFile()||info.size>MAX_BYTES)return null;
    return fs.readFile(file);
  };
}

function raster(bytes){
  return bytes.length>12&&(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
    bytes[0]===255&&bytes[1]===216&&bytes[2]===255||
    bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP');
}

export function createRecordAssetResolver({fetch:fetcher=globalThis.fetch,loadSharp=()=>import('sharp'),loadLocalArtwork=localPublicAvatars(),timeoutMs=2000,deadlineMs=6000}={}){
  if(typeof fetcher!=='function'||typeof loadSharp!=='function'||typeof loadLocalArtwork!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000||!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>10000)throw new TypeError('INVALID_RECORD_ASSET_OPTIONS');
  const cache=new Map();let cacheBytes=0,backend;
  const sharp=async()=>{if(!backend)backend=Promise.resolve().then(loadSharp).then(module=>module.default??module).catch(error=>{backend=null;throw error});return backend;};
  async function canonicalArtwork(bytes){
    if(bytes.length>MAX_BYTES||!raster(bytes))throw new Error('INVALID_ARTWORK');
    const converter=await sharp();
    const image=await converter(bytes,{limitInputPixels:4194304,failOn:'warning',unlimited:false}).rotate().resize(160,160,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png({palette:true}).toBuffer();
    if(image.length>262144)throw new Error('ARTWORK_TOO_LARGE');
    return 'data:image/png;base64,'+image.toString('base64');
  }
  async function download(url,signal){
    const response=await fetcher(url,{method:'GET',redirect:'error',credentials:'omit',referrerPolicy:'no-referrer',signal,headers:{Accept:'image/png,image/jpeg,image/webp'}});
    if(!response.ok||response.url&&safeRecordArtworkUrl(response.url)!==url)throw new Error('ARTWORK_UNAVAILABLE');
    const type=response.headers?.get?.('content-type')||'';
    if(!/^image\/(?:png|jpeg|webp)(?:;|$)/i.test(type)||Number(response.headers?.get?.('content-length')||0)>MAX_BYTES)throw new Error('INVALID_ARTWORK');
    const chunks=[];let size=0;
    for await(const part of response.body){const bytes=Buffer.from(part);size+=bytes.length;if(size>MAX_BYTES)throw new Error('ARTWORK_TOO_LARGE');chunks.push(bytes);}
    const bytes=Buffer.concat(chunks);
    return canonicalArtwork(bytes);
  }
  return async model=>{
    const avatars=Object.create(null),requests=artworkRequests(model);let position=0;
    const deadline=AbortSignal.timeout(deadlineMs);
    async function worker(){
      while(position<requests.length&&!deadline.aborted){
        const [id,url]=requests[position++],key=url||'local-avatar:'+id,saved=cache.get(key);
        if(saved&&saved.expires>Date.now()){avatars[id]=saved.data;continue;}
        if(saved){cache.delete(key);cacheBytes-=saved.bytes;}
        try{
          let local=null;try{local=await loadLocalArtwork(id);}catch{}
          if(!local&&!url)continue;
          const data=local?await canonicalArtwork(Buffer.from(local)):await download(url,AbortSignal.any([deadline,AbortSignal.timeout(timeoutMs)]));
          avatars[id]=data;
          while(cache.size>=128||cacheBytes+data.length>MAX_CACHE_BYTES){const key=cache.keys().next().value;if(key===undefined)break;cacheBytes-=cache.get(key).bytes;cache.delete(key);}
          cache.set(key,{data,bytes:data.length,expires:Date.now()+3600000});cacheBytes+=data.length;
        }catch{/* Artwork failure retains the designed, labelled avatar placeholder. */}
      }
    }
    await Promise.all(Array.from({length:Math.min(4,requests.length)},worker));
    return {avatars};
  };
}
