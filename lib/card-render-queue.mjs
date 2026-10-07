import path from 'node:path';

// Both plugin copies use one FIFO per resolved bot root. Only active/pending
// calls retain card data, in RAM. Delivered calls retain only their real drain
// promise; a failed drain keeps this root closed to further rendering.
const REGISTRY=Symbol.for('teyvat-sanguosha.card-render-queue.v1');
const states=globalThis[REGISTRY]||(globalThis[REGISTRY]=new Map());

export class CardRenderQueueError extends Error{
  constructor(code){
    super(code==='RENDER_QUEUE_FULL'?'图片任务较多，请稍后重试。':code==='RENDER_QUEUE_BLOCKED'?'图片页面尚未确认关闭，请暂时查看文字内容。':'图片排队超时，请稍后重试。');
    this.name='CardRenderQueueError';this.code=code;
  }
}

function release(entry){
  if(entry.timer!==null)clearTimeout(entry.timer);
  entry.timer=null;entry.card=null;entry.render=null;entry.resolve=null;entry.reject=null;
}

function captureDrain(render){
  try{const drain=render.drain;return typeof drain==='function'?Promise.resolve(drain.call(render)):null;}
  catch{return Promise.reject(new CardRenderQueueError('RENDER_QUEUE_BLOCKED'));}
}

function block(state){
  state.blocked=true;
  // Keep active: a rejected drain is not proof the owned context was closed.
  for(const entry of state.queue.splice(0)){
    const rejectQueued=entry.reject;
    release(entry);
    rejectQueued(new CardRenderQueueError('RENDER_QUEUE_BLOCKED'));
  }
}

function pump(state){
  if(state.blocked||state.active||state.queue.length===0)return;
  const entry=state.queue.shift();
  state.active=true;
  if(entry.timer!==null)clearTimeout(entry.timer);
  entry.timer=null;
  void (async()=>{
    let drain;
    try{
      const value=await entry.render(entry.card);
      // Capture before resolving: callers must not be able to replace the
      // renderer's current drain before this invocation owns its promise.
      drain=captureDrain(entry.render);
      entry.resolve(value);
    }catch(error){
      drain=captureDrain(entry.render);
      entry.reject(error);
    }
    // Delivery is settled, but the resource slot remains occupied. Do not keep
    // HTML, callbacks or the renderer reachable through this queue entry while
    // its context closes, including a close that never settles.
    release(entry);
    if(drain){
      try{if(await drain!==true){block(state);return;}}
      catch{block(state);return;}
    }
    state.active=false;pump(state);
  })();
}

/** The underlying renderer owns execution/cleanup deadlines. This queue never
 * retries a render or starts a browser. Optional render.drain() must represent
 * actual context disposal, not a cleanup deadline. Only true confirms disposal;
 * other results block this root without leaking the underlying exception.
 * A wrapper can tighten admission
 * for a shared root; already admitted calls retain their original deadlines. */
export function createQueuedCardRenderer(render,{botRoot,maxPending=4,queueTimeoutMs=30000}={}){
  if(typeof render!=='function'||typeof botRoot!=='string'||!botRoot||!Number.isSafeInteger(maxPending)||maxPending<0||maxPending>8||!Number.isSafeInteger(queueTimeoutMs)||queueTimeoutMs<1||queueTimeoutMs>30000)throw new TypeError('INVALID_CARD_RENDER_QUEUE');
  const key=path.resolve(botRoot);
  let state=states.get(key);
  if(!state){state={active:false,blocked:false,queue:[],maxPending};states.set(key,state);}
  else state.maxPending=Math.min(state.maxPending,maxPending);
  return function renderQueued(card){
    if(state.blocked)return Promise.reject(new CardRenderQueueError('RENDER_QUEUE_BLOCKED'));
    if(state.active&&state.queue.length>=state.maxPending)return Promise.reject(new CardRenderQueueError('RENDER_QUEUE_FULL'));
    // Views pass plain objects. Copy their renderer options now so a caller
    // cannot change HTML or private/width flags while its task is waiting.
    const snapshot=card&&typeof card==='object'?{...card}:card;
    return new Promise((resolve,reject)=>{
      const entry={card:snapshot,render,resolve,reject,timer:null};
      if(state.active){
        entry.timer=setTimeout(()=>{
          const index=state.queue.indexOf(entry);
          if(index<0)return;
          state.queue.splice(index,1);
          const rejectQueued=entry.reject;
          release(entry);
          rejectQueued(new CardRenderQueueError('RENDER_QUEUE_TIMEOUT'));
        },queueTimeoutMs);
      }
      state.queue.push(entry);pump(state);
    });
  };
}
