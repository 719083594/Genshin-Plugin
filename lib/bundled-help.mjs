import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const MAX_IMAGE=2*1024*1024,MAX_MANIFEST=4096,MAX_SOURCE=1024*1024;
const HASH=/^[a-f0-9]{64}$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fingerprint=stat=>[stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');

function ordinaryFile(file,maxBytes){
  let result;
  for(let current=file;;){
    const stat=fs.lstatSync(current,{bigint:true});
    if(stat.isSymbolicLink()||(current===file?(!stat.isFile()||stat.nlink!==1n||stat.size<1n||stat.size>BigInt(maxBytes)):!stat.isDirectory()))throw new Error('INVALID_PUBLIC_HELP_FILE');
    if(current===file)result=stat;
    const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
  return result;
}

function readPublicFile(file,maxBytes){
  const before=ordinaryFile(file,maxBytes);
  let fd;
  try{
    fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    const opened=fs.fstatSync(fd,{bigint:true});
    if(!opened.isFile()||opened.nlink!==1n||fingerprint(opened)!==fingerprint(before))throw new Error('PUBLIC_HELP_FILE_CHANGED');
    const bytes=Buffer.alloc(Number(opened.size));
    let offset=0;
    while(offset<bytes.length){
      const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);
      if(count===0)throw new Error('PUBLIC_HELP_FILE_CHANGED');
      offset+=count;
    }
    if(fingerprint(fs.fstatSync(fd,{bigint:true}))!==fingerprint(opened)||fingerprint(ordinaryFile(file,maxBytes))!==fingerprint(opened))throw new Error('PUBLIC_HELP_FILE_CHANGED');
    return {bytes,fingerprint:fingerprint(opened)};
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}

/** Reads only the fixed, pre-rendered public help and its source/manifest.
 * No browser, account store, network or disk writes. Small files are checked
 * on every request; cached JPEG bytes are reused only while the ordinary image
 * file's identity/timestamps still match. Every caller gets a Buffer copy. */
export function createBundledHelpReader(options={}){
  let root,defaultPrefix;
  try{
    root=typeof options?.root==='string'&&options.root?path.resolve(options.root):null;
    defaultPrefix=options?.defaultPrefix;
  }catch{root=null;}
  const configured=Boolean(root&&typeof defaultPrefix==='string'&&defaultPrefix.length>0&&defaultPrefix.length<=64&&!/[\u0000-\u001f\u007f]/.test(defaultPrefix));
  const imageFile=root&&path.join(root,'resources/ui/help.jpg'),manifestFile=root&&path.join(root,'resources/ui/help-manifest.json'),sourceFile=root&&path.join(root,'lib/card-views.mjs');
  let cached=null;
  return function readBundledHelp(request={}){
    try{
      if(!configured||!request||request.private!==false)return null;
      const prefix=request.prefix===undefined?defaultPrefix:request.prefix;
      if(prefix!==defaultPrefix)return null;
      const manifestBytes=readPublicFile(manifestFile,MAX_MANIFEST).bytes;
      const manifest=JSON.parse(manifestBytes.toString('utf8'));
      if(!manifest||Array.isArray(manifest)||manifest.version!==1||manifest.prefix!==defaultPrefix||manifest.width!==1080||typeof manifest.imageSha256!=='string'||!HASH.test(manifest.imageSha256)||typeof manifest.sourceSha256!=='string'||!HASH.test(manifest.sourceSha256))throw new Error('INVALID_PUBLIC_HELP_MANIFEST');
      const sourceBytes=readPublicFile(sourceFile,MAX_SOURCE).bytes;
      if(digest(sourceBytes)!==manifest.sourceSha256)throw new Error('PUBLIC_HELP_SOURCE_CHANGED');
      const imageStat=ordinaryFile(imageFile,MAX_IMAGE);
      const token=digest(manifestBytes)+':'+manifest.sourceSha256+':'+fingerprint(imageStat);
      if(cached?.token===token)return Buffer.from(cached.bytes);
      cached=null;
      const image=readPublicFile(imageFile,MAX_IMAGE);
      if(image.bytes.length<4||image.bytes[0]!==255||image.bytes[1]!==216||image.bytes.at(-2)!==255||image.bytes.at(-1)!==217||digest(image.bytes)!==manifest.imageSha256)throw new Error('INVALID_PUBLIC_HELP_IMAGE');
      // Recheck metadata after the image read, including replacement races.
      if(image.fingerprint!==fingerprint(imageStat)||digest(readPublicFile(manifestFile,MAX_MANIFEST).bytes)!==digest(manifestBytes)||digest(readPublicFile(sourceFile,MAX_SOURCE).bytes)!==manifest.sourceSha256)throw new Error('PUBLIC_HELP_FILE_CHANGED');
      cached={token,bytes:Buffer.from(image.bytes)};
      return Buffer.from(cached.bytes);
    }catch{cached=null;return null;}
  };
}
