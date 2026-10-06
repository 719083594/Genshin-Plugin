import {inspect} from 'node:util';
/** In-memory upload; default interpolation must not leak file contents to host logs. */
export function privateFileBuffer(data){
  const value=Buffer.from(data,'utf8'),encode=value.toString.bind(value);
  Object.defineProperty(value,'toString',{value:(encoding,...args)=>encoding===undefined?'[私密文件内容已隐藏]':encode(encoding,...args)});
  Object.defineProperty(value,inspect.custom,{value:()=>'<PrivateFileBuffer '+value.length+' bytes>'});
  return value;
}
