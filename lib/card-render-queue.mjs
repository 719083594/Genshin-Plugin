import path from 'node:path';

// Both plugin copies use one FIFO per resolved bot root. Only active/pending
// calls retain card data, in RAM; drained states retain no cards or callbacks.
const REGISTRY=Symbol.for('teyvat-sanguosha.card-render-queue.v1');
const states=globalThis[REGISTRY]||(globalThis[REGISTRY]=new Map());

export class CardRenderQueueError extends Error{
  constructor(code){
    super(code==='RENDER_QUEUE_FULL'?'图片任务较多，请稍后重试。':'图片排队超时，请稍后重试。');
    this.name='CardRenderQueueError';this.code=code;
  }
}

function release(entry){
  if(entry.timer!==null)clearTimeout(entry.timer);
  entry.timer=null;entry.card=null;entry.render=null;entry.resolve=null;entry.reject=null;
}

function pump(state){
  if(state.active||state.queue.length===0)return;
  const entry=state.queue.shift();
  state.active=true;
  if(entry.timer!==null)clearTimeout(entry.timer);
  entry.timer=null;
  void (async()=>{
    try{entry.resolve(await entry.render(entry.card));}
    catch(error){entry.reject(error);}
    finally{release(entry);state.active=false;pump(state);}
  })();
}

/** The underlying renderer owns execution/cleanup deadlines. This queue never
 * retries a render or starts a browser. A later wrapper can tighten admission
 * for a shared root; already admitted calls retain their original deadlines. */
export function createQueuedCardRenderer(render,{botRoot,maxPending=4,queueTimeoutMs=30000}={}){
  if(typeof render!=='function'||typeof botRoot!=='string'||!botRoot||!Number.isSafeInteger(maxPending)||maxPending<0||maxPending>8||!Number.isSafeInteger(queueTimeoutMs)||queueTimeoutMs<1||queueTimeoutMs>30000)throw new TypeError('INVALID_CARD_RENDER_QUEUE');
  const key=path.resolve(botRoot);
  let state=states.get(key);
  if(!state){state={active:false,queue:[],maxPending};states.set(key,state);}
  else state.maxPending=Math.min(state.maxPending,maxPending);
  return function renderQueued(card){
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
