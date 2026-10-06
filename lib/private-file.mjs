import {inspect} from 'node:util';
import {gzipSync} from 'node:zlib';
/** In-memory upload; default interpolation must not leak file contents to host logs. */
export function privateFileBuffer(data){
  const value=Buffer.from(data,'utf8');if(value.length>8*1024*1024)throw new Error('文件超过内存上传上限');const encode=value.toString.bind(value);
  Object.defineProperty(value,'toString',{value:(encoding,...args)=>encoding===undefined?'[私密文件内容已隐藏]':encode(encoding,...args)});
  Object.defineProperty(value,inspect.custom,{value:()=>'<PrivateFileBuffer '+value.length+' bytes>'});
  return value;
}
export function privateFileUpload(data,name){const plain=Buffer.from(data,'utf8');return plain.length>8*1024*1024?{buffer:privateFileBuffer(gzipSync(plain)),name:name+'.gz'}:{buffer:privateFileBuffer(plain),name};}
