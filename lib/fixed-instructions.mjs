let factory;
export function createInstructionReply({root,prefix=()=>'#原神',sendHelp}={}){
 let delivery;
 return async e=>{
  const p=typeof prefix==='function'?prefix():prefix,text=String(e.msg||'').trim();
  if(!text.startsWith(p))return false;
  const topic={'登录说明':'genshin-login','功能':'genshin-features'}[text.slice(p.length).trim()];
  if(!topic)return false;
  if(!sendHelp){try{factory??=import('../../AI-Plugin/src/rendering/static-help-reply.mjs');delivery??=(await factory).createFixedHelpDelivery({root,defaultPrefix:'#原神'});}catch{factory=undefined;return false;}}
  return (sendHelp||delivery)(e,topic,{prefix:p});
 };
}
