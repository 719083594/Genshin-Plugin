export class JsonHttp{
  constructor({fetch=globalThis.fetch,timeoutMs=12000}={}){this.fetch=fetch;this.timeoutMs=timeoutMs}
  async get(url){const u=new URL(url);if(u.protocol!=='https:'||!['enka.network','hyp-api.mihoyo.com','raw.githubusercontent.com'].includes(u.hostname))throw new Error('未授权的数据接口');let response;try{response=await this.fetch(u,{redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),headers:{'User-Agent':'Teyvat-Plugin/0.1.0 (https://github.com/719083594/Teyvat-Plugin)'}})}catch{throw new Error('数据接口连接失败或超时，请稍后重试')}if(!response.ok)throw new Error('数据接口 HTTP '+response.status);const size=Number(response.headers?.get?.('content-length')||0);if(size>8*1024*1024)throw new Error('数据响应过大');let raw;try{raw=await response.text()}catch{throw new Error('读取响应失败')}if(Buffer.byteLength(raw)>8*1024*1024)throw new Error('数据响应过大');try{return JSON.parse(raw)}catch{throw new Error('接口未返回JSON')}
  }
}
