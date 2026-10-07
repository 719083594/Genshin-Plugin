import {createHash} from 'node:crypto';

/** One public help JPEG in this factory's RAM only. The adapter must call this
 * only for help metadata; private cards are refused even on a matching key.
 * Pending work contains promises only and is removed on success or failure. */
export function createPublicHelpCache(render,{maxAgeMs=600000,maxBytes=2*1024*1024}={}){
  if(typeof render!=='function'||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<0||!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new TypeError('INVALID_PUBLIC_HELP_CACHE');
  let cached=null,activeKey=null;
  const pending=new Map();
  return async function renderCached(card){
    if(!card||card.private!==false)throw new TypeError('PUBLIC_HELP_ONLY');
    const html=card.html,width=card.width===undefined?1080:card.width;
    if(typeof html!=='string'||!html||!Number.isSafeInteger(width)||width<320||width>1600)throw new TypeError('INVALID_PUBLIC_HELP_CARD');
    // Snapshot only renderer inputs, not caller identity or arbitrary metadata.
    const snapshot={html,width,private:false};
    const key=createHash('sha256').update(String(width)).update('\0').update(html).digest('hex');
    if(key!==activeKey){activeKey=key;cached=null;}
    if(cached){
      const age=Date.now()-cached.createdAt;
      if(cached.key===key&&age>=0&&age<maxAgeMs)return Buffer.from(cached.bytes);
      cached=null;
    }
    let job=pending.get(key);
    if(!job){
      job=Promise.resolve().then(()=>render(snapshot)).then(bytes=>{
        // A late result for an older key cannot evict the current help image.
        if(activeKey===key&&maxAgeMs>0&&Buffer.isBuffer(bytes)&&bytes.length>=4&&bytes.length<=maxBytes&&bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217){
          cached={key,createdAt:Date.now(),bytes:Buffer.from(bytes)};
        }
        return bytes;
      });
      pending.set(key,job);
    }
    try{
      const bytes=await job;
      // Segment builders and concurrent consumers never share cached bytes.
      return Buffer.isBuffer(bytes)?Buffer.from(bytes):bytes;
    }finally{
      if(pending.get(key)===job)pending.delete(key);
    }
  };
}
