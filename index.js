import {privateFileUpload} from './lib/private-file.mjs';
import {fileURLToPath} from 'node:url';import fs from 'node:fs';import path from 'node:path';
import {Teyvat} from './api.mjs';import {loadNativeProviders} from './lib/native-providers.mjs';
import {installLogRedaction} from './lib/log-redaction.mjs';
import {configureNativeAccounts,installNativeAccountGuard} from './lib/native-accounts.mjs';
import {installNativeStorage} from './lib/native-storage.mjs';
import {installNativeFileCache} from './lib/native-file-cache.mjs';
import {installNativeRedis} from './lib/native-redis.mjs';
import {installNativeXhhGuard} from './lib/native-xhh.mjs';
import {installNativeGacha,configureNativeGacha,createNativeGachaRenderer,createMiaoGachaMetadata} from './lib/native-gacha.mjs';
import {createCardRenderer,CardRenderError} from './lib/card-renderer.mjs';
import {createQueuedCardRenderer,CardRenderQueueError} from './lib/card-render-queue.mjs';
import {createPublicHelpCache} from './lib/public-help-cache.mjs';
import {resolveHostPuppeteer} from './lib/host-bridge.mjs';
import {buildHelpCard} from './lib/card-views.mjs';
import {buildRecordCards} from './lib/record-cards.mjs';
import {createRecordAssetResolver} from './lib/record-assets.mjs';
import {createSharedNativeCardRenderer} from './lib/shared-renderer.mjs';
import {NativeCardRenderError} from './lib/native-card-renderer.mjs';
import {sendCardReply,CardReplyError} from './lib/card-reply.mjs';
import {createBundledHelpReader} from './lib/bundled-help.mjs';
import {createInstructionReply} from './lib/fixed-instructions.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));let apps={};export let nativeStatus={};
let enabled=false;try{enabled=JSON.parse(fs.readFileSync(path.join(root,'config/local.json'),'utf8')).adapter==='yunzai'}catch{}
if(enabled){
  installLogRedaction(globalThis.logger,{prefix:JSON.parse(fs.readFileSync(path.join(root,'config/local.json'),'utf8')).prefix});
  fs.mkdirSync(path.resolve(root,'../../temp/html'),{recursive:true});
  if(globalThis.segment&&typeof globalThis.segment.button!=='function')globalThis.segment.button=()=>'';
  const Base=globalThis.plugin||(await import('../../lib/plugins/plugin.js')).default;
  const send=async(target,text)=>{const bots=globalThis.Bot?.bots||{};const bot=bots[target.botId]||globalThis.Bot?.[target.botId];if(!bot?.sendApi)throw new Error('订阅机器人未在线');const r=await bot.sendApi(target.groupId?'send_group_msg':'send_private_msg',{[target.groupId?'group_id':'user_id']:Number(target.groupId||target.owner),message:[{type:'text',data:{text}}]});if(r?.retcode!==0&&r?.status!=='ok')throw new Error('订阅发送失败')};
  const engine=new Teyvat(root,{send});
  const replyInstructions=createInstructionReply({root,prefix:()=>engine.config.read().prefix});
  const storageOptions={root,botRoot:path.resolve(root,'../..'),key:engine.config.read().credentialsKey};
  installNativeFileCache(storageOptions);
  installNativeRedis({redis:globalThis.redis,...storageOptions});
  const {Data}=await import('../miao-plugin/components/index.js');installNativeStorage({Data,...storageOptions});
  const {Character,Weapon}=await import('../miao-plugin/models/index.js');
  const GachaData=(await import('../miao-plugin/apps/gacha/GachaData.js')).default;
  installNativeGacha({Data,...createMiaoGachaMetadata({Character,Weapon,GachaData})});
  const hostRenderer=resolveHostPuppeteer((await import('../../lib/renderer/loader.js')).default);
  const renderCard=createQueuedCardRenderer(createCardRenderer({botRoot:storageOptions.botRoot,getBrowser:()=>hostRenderer.browser,ensureBrowser:()=>hostRenderer.browserInit(),assetRoots:[path.join(root,'resources/ui')],bootstrapFile:path.join(root,'resources/ui/shell.html'),deliverBeforeCleanup:true,onMetrics:metrics=>globalThis.logger?.info?.('[Genshin] 图片耗时：'+JSON.stringify(metrics))}),{botRoot:storageOptions.botRoot});
  const renderRecord=createSharedNativeCardRenderer({onMetrics:metrics=>globalThis.logger?.info?.('[Genshin] 记录图片耗时：'+JSON.stringify(metrics))});
  const resolveRecordAssets=createRecordAssetResolver();
  const readHelp=createBundledHelpReader({root,defaultPrefix:'#原神'});
  const renderCachedHelp=createPublicHelpCache(renderCard);
  const renderHelp=card=>{const prefix=engine.config.read().prefix;if(prefix==='#原神'){const bytes=readHelp({prefix,private:card.private});if(!bytes)throw new CardRenderError('HELP_IMAGE_UNAVAILABLE');return bytes}return renderCachedHelp(card)};
  configureNativeGacha({renderPrivate:createNativeGachaRenderer({botRoot:storageOptions.botRoot,getBrowser:()=>hostRenderer.browser}),image:buffer=>globalThis.segment.image(buffer)});
  const LiteMysApi=(await import('../xhh-TL/utils/mysClient.js')).default;installNativeXhhGuard({LiteMysApi});
  configureNativeAccounts({accounts:engine.accounts,gacha:engine.gacha,query:(api,account,params)=>engine.mys.query(api,account,params),allowGroupCookie:false});
  const Runtime=(await import('../../lib/plugins/runtime.js')).default;
  const MysApi=(await import('../genshin/model/mys/mysApi.js')).default;
  installNativeAccountGuard({NoteUser:Runtime.prototype.NoteUser,MysInfo:Runtime.prototype.MysInfo,MysUser:Runtime.prototype.MysUser,MysApi});
  class TeyvatCommands extends Base{
    constructor(){const p=engine.config.read().prefix.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');super({name:'原神助手',dsc:'原神独立核心',event:'message',priority:-8000,rule:[{reg:new RegExp('^'+p),fnc:'run',title:'原神专用助手',description:'#原神帮助：账户、便笺、挑战、展柜、资料、祈愿、版本与订阅'}]})}
    init(){engine.subscriptions.start()}
    async run(e){const result=await engine.handle({...e,text:e.msg,owner:String(e.user_id),privateChat:!e.group_id,imageReply:true});if(result.handled&&await replyInstructions(e))return true;if(result.card){try{await sendCardReply(result,{event:e,render:result.card.type==='help'?renderHelp:renderRecord,image:bytes=>globalThis.segment.image(bytes),buildCards:async card=>card.type==='help'?[buildHelpCard({prefix:engine.config.read().prefix})]:buildRecordCards(card,{assets:await resolveRecordAssets(card.model)})});return true}catch(error){const failure=error instanceof CardReplyError?error.cause:error;globalThis.logger?.warn?.('[Genshin] 图片处理失败：'+(failure instanceof CardRenderError||failure instanceof CardRenderQueueError||failure instanceof NativeCardRenderError?failure.code:'SEND_OR_VIEW_FAILED'));if(error instanceof CardReplyError){await e.reply('已发送 '+error.sent+'/'+error.total+' 页，其余图片未能生成；原命令末尾加「文字」可查看全文。');return true}await e.reply('图片暂未生成，先显示文字；可在原命令末尾加「文字」查看完整记录。')}}if(result.image){await e.reply([result.text,globalThis.segment?.image?.(result.image)||result.image]);if(result.qrSession)void engine.login.wait(String(e.user_id),result.qrSession,{privateChat:true}).then(async r=>{if(r.status==='Confirmed')await e.reply('米游社扫码及本人国服角色验证成功，账号凭据已AES加密保存：'+r.accounts.map(a=>a.uid).join('、')+'。');else if(!r.ok)await e.reply(r.message)}).catch(()=>{})}else if(result.file){if(!e.friend?.sendFile)await e.reply('协议端不支持私聊文件发送；请使用本地CLI export。');else {if(result.text)await e.reply(result.text);const upload=privateFileUpload(result.file.data,result.file.name);await e.friend.sendFile(upload.buffer,upload.name)}}else if(result.handled)await e.reply(result.text);return result.handled}
  }
  const native=await loadNativeProviders({root,config:engine.config.read()});nativeStatus=native.status;engine.nativeStatus=native.status;apps={TeyvatCommands,...native.apps};globalThis.logger?.info?.('[Genshin] 原神模块 '+Object.keys(native.apps).length+' 个');
}
export {apps};
