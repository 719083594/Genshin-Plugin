import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const defaultAssets=fileURLToPath(new URL('../resources/ui/',import.meta.url));
const groups=[
 ['01','旅行手记','日常状态 · 战绩挑战 · 社区查询',[
  [15,'便笺 / 树脂','树脂、委托、宝钱与派遣状态','私聊'],[16,'个人资料 / 角色列表','查看自己的旅行与角色资料','私聊'],[20,'深渊 [上期]','本期或上期螺旋深渊战绩','私聊'],
  [14,'剧诗 / 幻想真境','幻想真境剧诗战斗记录','私聊'],[6,'危战 / 幽境','幽境危战挑战资料','私聊'],[5,'原石札记 [月份]','原石、摩拉收入与来源统计','私聊'],
  [32,'活动日历','原神近期活动与开放时间','私聊'],[51,'七圣召唤 / 七圣牌组','卡牌、牌组与本人召唤资料','私聊'],[24,'米游币 / 米游币任务','只读查看余额和任务进度','私聊']
 ]],
 ['02','角色研究所','角色面板 · 装备养成 · 队伍搭配',[
  [57,'展柜 [UID]','公开角色展柜与属性总览',''],[10,'#更新面板 / #雷神面板','喵喵角色图片、装备与伤害','原生'],[17,'#队伍伤害','小火花队伍计算与手法对照','原生'],
  [59,'#小助手队伍伤害','FanSky 的队伍计算入口','原生'],[31,'#深渊配队 / #持有率','参考挑战样本与角色统计','原生'],[22,'#钟离天赋','角色天赋、命座与养成资料图','原生'],
  [21,'角色 / 武器 / 圣遗物 / 材料','命令后接名称，查询固定资料',''],[16,'养成 角色ID / 养成计算','官方养成资料与材料计算','私聊'],[60,'#单人评级','角色单人评价，结果以接口为准','原生']
 ]],
 ['03','祈愿与版本','加密祈愿库 · 游戏资源 · 历史资料',[
  [35,'祈愿导入 JSON','导入本人的 UIGF 记录','私聊'],[23,'祈愿分析 / 祈愿导出','记录去重、保底与完整导出','私聊'],[5,'#抽卡统计 / #角色记录','加密记录原生图；也支持武器池','私聊'],
  [10,'版本 / 预下载 / 安装包','查看当前 PC 版本及资源链接',''],[22,'版本数据 [版本号]','作者历史资料库与包体记录',''],[17,'更新版本数据','同步历史资料；版本历史另存观察','主人']
 ]],
 ['04','旅行通行证','米游社扫码 · 账号管理 · 本人验证',[
  [49,'扫码登录 [UID]','米游社 APP 扫码，核验本人角色','私聊'],[10,'扫码状态 / 取消扫码','查看授权进度或结束本次扫码','私聊'],[78,'账户 / 切换 UID / 解绑 UID','管理本人多个加密账号','私聊'],
  [24,'绑定 UID / 登录说明','绑定查询目标；本人授权看登录说明',''],[16,'安全验证 / 提交验证 / 取消验证','依照本人官方页面完成验证','私聊'],[15,'树脂提醒 / 版本推送 开或关','自主订阅；订阅列表查看当前设置','']
 ]],
 ['05','探索与工具','尘歌壶 · 卡牌资料 · 可选扩展',[
  [74,'尘歌壶方案 模数 / 家具计算','分享方案与家具材料需求','私聊'],[51,'七圣卡牌','查看角色牌、行动牌等资料','私聊'],[44,'功能 / 状态','查看当前能力和组合模块状态',''],
  [22,'墨安绑定 / 墨安分析 / 墨安记录','可选云端记录；需可用 HTTPS 服务','需配置'],[35,'云端拉取 / 云端导出 / 云端上传','本人主动操作；上传须开启配置','需配置'],[49,'云链接验证 / 云链接导入','验证本人的原神国服祈愿链接','需配置']
 ]]
];
/** Public help only. No account, session, nickname or balance is read here. */
export function buildHelpCard({prefix='#原神',assetRoot=defaultAssets}={}){
 const res=pathToFileURL(path.resolve(assetRoot)+path.sep).href;
 const icon=number=>`<i class="icon" style="background-position:-${((number-1)%10)*64}px -${Math.floor((number-1)/10)*64}px"></i>`;
 const sections=groups.map(([n,title,sub,items])=>`<section><div class="section-title"><b>${n}</b><h2>${title}</h2><span>${sub}</span></div><div class="grid">${items.map(([i,cmd,desc,badge])=>`<article>${icon(i)}<div><h3>${esc(cmd.startsWith('#')?cmd:prefix+cmd)}</h3><p>${esc(desc)}</p>${badge?`<em>${esc(badge)}</em>`:''}</div></article>`).join('')}</div></section>`).join('');
 const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src file:; font-src file:"><style>
 *{box-sizing:border-box}html,body{margin:0;width:1080px}body{font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif;color:#f2f2fc;background:#101c33}#container{width:1080px;position:relative;overflow:hidden;background:radial-gradient(ellipse at 5% 22%,#695e8066,transparent 40%),linear-gradient(160deg,#243153,#101d35 60%,#173b48)}.hero{position:relative;height:350px;padding:50px 54px;background:linear-gradient(90deg,#101b38 0%,#172542d9 36%,#394a7b25 75%),url('${res}ayaka.png') right center/cover no-repeat;border-bottom:1px solid #d9c79e6b}.eyebrow{font-size:17px;letter-spacing:5px;color:#e9dcba}.hero h1{font-size:66px;letter-spacing:5px;margin:22px 0 12px;color:#fff8e6;text-shadow:0 3px 12px #12203d}.hero p{font-size:25px;letter-spacing:4px;margin:0;color:#e2ddf8}.chips{display:flex;gap:12px;margin-top:27px}.chips span{border:1px solid #d6c29980;border-radius:20px;padding:6px 16px;font-size:16px;color:#f8ebc9;background:#14213ec9}.hero:after{content:'✦';position:absolute;right:42px;top:27px;color:#fff2c2;font-size:42px}.intro{display:flex;justify-content:space-between;gap:20px;padding:24px 43px;color:#dce4f2;font-size:21px}.intro b{color:#e8d4a6}main{padding:0 30px 26px}section{border:1px solid #cfb78342;border-radius:20px;overflow:hidden;margin-bottom:22px;background:#172641dd;box-shadow:0 12px 30px #06101e35}.section-title{display:flex;align-items:center;gap:16px;height:68px;padding:0 23px;border-bottom:1px solid #abacc637;background:linear-gradient(90deg,#43516c66,transparent)}.section-title>b{font-family:Georgia,serif;font-size:27px;font-style:italic;color:#a1c6dd}.section-title h2{font-size:26px;color:#f4dcaa;margin:0;font-weight:650;letter-spacing:2px}.section-title span{margin-left:auto;color:#bdc5d8;font-size:17px}.grid{display:grid;grid-template-columns:repeat(3,1fr)}article{display:flex;gap:12px;padding:20px 16px;min-height:125px;position:relative;border-bottom:1px solid #bec9de24;border-right:1px solid #bec9de24}article:nth-child(3n){border-right:0}.icon{flex:0 0 64px;height:52px;background-image:url('${res}icons.png');background-size:640px 640px;filter:drop-shadow(0 3px 4px #040d2180);margin-top:4px}article>div{min-width:0}h3{font-size:22px;line-height:1.45;letter-spacing:.1px;color:#ffe5aa;margin:0 0 7px;overflow-wrap:anywhere;font-weight:650}article p{font-size:19px;line-height:1.5;color:#d5deed;margin:0}em{font-style:normal;font-size:13px;line-height:1;border:1px solid #abc3d04f;color:#b3d1e0;padding:3px 6px;border-radius:4px;display:inline-block;margin-top:8px}.notice{margin:0 6px;padding:17px 21px;border:1px solid #b7a17850;border-radius:12px;font-size:18px;line-height:1.65;color:#cbd6e8;background:#08182c55}.notice b{color:#eed9aa}footer{padding:23px 38px 30px;display:flex;justify-content:space-between;color:#aebdd1;font-size:15px;border-top:1px solid #b6bdcd28}footer strong{color:#dfcaa4;font-weight:500}
 </style></head><body><div id="container"><header class="hero"><div class="eyebrow">GENSHIN · FIELD GUIDE</div><h1>原神助手</h1><p>每一段旅途，都值得被记录。</p><div class="chips"><span>原神专用</span><span>国服优先</span><span>账号加密保存</span></div></header><div class="intro"><span><b>✦</b> 从这里开始你的查询</span><span>标记「私聊」的功能仅供本人使用</span></div><main>${sections}<div class="notice"><b>使用提示</b>　[方括号] 内为可选参数；名称、UID、模数和 JSON 请换成自己的内容。原生命令直接以 # 开头。<br>账号授权与安全回执只在本人私聊操作；米游币仅查询。短信登录与墨安服务仍需另行接入。<br>需要文字菜单：${esc(prefix)}帮助 文字</div></main><footer><strong>原神助手 0.1.0 · 旅途常新</strong><span>参考与素材：Miao-Plugin / xhh-TL / FanSky · 详见项目致谢</span></footer></div></body></html>`;
 return {html,width:1080,private:false,title:'原神助手 · 功能指南'};
}
