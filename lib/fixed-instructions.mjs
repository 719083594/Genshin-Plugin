import {createFixedHelpDelivery} from './static-help-reply.mjs';
export function createInstructionReply({root,prefix=()=>'#原神',sendHelp,loadService=()=>import('../../AI-Plugin/src/rendering/static-help-reply.mjs')}={}){
 if(sendHelp!==undefined&&typeof sendHelp!=='function'||typeof loadService!=='function')throw new TypeError('INVALID_FIXED_INSTRUCTION_OPTIONS');
 let factory,delivery,localDelivery;
 async function sharedDelivery(){
  try{
   if(delivery)return delivery;
   factory??=Promise.resolve().then(loadService);
   const service=await factory;
   if(delivery)return delivery;
   if(typeof service?.createFixedHelpDelivery!=='function')throw new Error('STATIC_HELP_SERVICE_UNAVAILABLE');
   delivery=service.createFixedHelpDelivery({root,defaultPrefix:'#原神'});
   if(typeof delivery!=='function')throw new Error('STATIC_HELP_SERVICE_UNAVAILABLE');
   return delivery;
  }catch{factory=undefined;delivery=undefined;return null;}
 }
 return async e=>{
  const p=typeof prefix==='function'?prefix():prefix,text=String(e.msg||'').trim();
  if(!text.startsWith(p))return false;
  const topic={'登录说明':'genshin-login','功能':'genshin-features'}[text.slice(p.length).trim()];
  if(!topic)return false;
  if(sendHelp)return sendHelp(e,topic,{prefix:p});
  const shared=await sharedDelivery();
  // The fixed-help delivery contract returns false only before any page is
  // sent. A partial-send exception propagates and must never duplicate pages.
  if(shared&&await shared(e,topic,{prefix:p}))return true;
  localDelivery??=createFixedHelpDelivery({root,defaultPrefix:'#原神'});
  return localDelivery(e,topic,{prefix:p});
 };
}
