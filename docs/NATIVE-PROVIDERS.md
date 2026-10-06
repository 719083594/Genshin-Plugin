# 原神组合功能、安装与实际验收

账户统一使用提瓦特助手的 AES-256-GCM 库，包括 QQ、账号 UID、备注、Cookie 与滚动备份。私聊 `#原神扫码登录 [UID]` 或 `#原神绑定Cookie UID Cookie` 核验本人角色后保存；多号由 `#原神账户/切换/解绑` 管理。真实官方扫码端点已验证创建与 pending，本人确认后的完整授权链路仍待验收。不复制到原生明文 DB/YAML/Redis CK 池，也不使用原 genshin 的裸 `#绑定Cookie`、公共 CK、跨 QQ 账号绑定与 authkey 缓存入口。组合面板可使用公开缓存；个人只读查询通过当前 QQ 的临时会话对象从 AES 库读取。stoken 持久化/兑换和米游币尚未完成加密适配，当前保持待实现。

## 外部源码快照

| 模块目录（必须保留原名） | 官方来源 | 固定版本 | 许可证 |
| --- | --- | --- | --- |
| `plugins/miao-plugin` | https://github.com/yoimiya-kokomi/miao-plugin | `b01d77483268eb2236876ad0995fab27052c09ad` | MIT，Yoimiya |
| `plugins/genshin` | https://github.com/TimeRainStarSky/Yunzai-genshin | `4a2e1fb8f094b2a8f039ce0768773701718b60b9` | 独立仓库未放 LICENSE；原核心 GPL-3.0 来源证据见下文 |
| `plugins/xhh-TL` | https://gitee.com/longhengmu/xhh-TL | `1b5e5644c9351fcfd950acabf2c791060a7c44b6` | MIT，cchanlan |
| `plugins/FanSky_Qs` | https://github.com/AFanSKyQs/FanSky_Qs | `86d002866114fa1dd1c765325fde621925938adc` | Apache-2.0，AFanSKyQs |

以上源码由用户直接安装在 bot，保留原仓库、版权通知与全部资源，不打包进提瓦特助手 GitHub。新插件包含原创选择器、账户会话隔离、边界守卫、配置和文档。MATOOL 没有可核验许可证，不复制其代码或模板；GamePush 的原神版本/包体协议由独立核心访问 HoYoPlay/Sophon，本次不安装其其他游戏模块。本机包体观察历史已实现，远端完整历史数据库仍待实现，不能声称与上游全部功能等价。

genshin 来源核验：官方 Miao-Yunzai `40cc2103efba1fbb279b768e3f5345d45372d357` 根 LICENSE 为 GPL-3.0，其受版本管理的 `plugins/genshin` 419 个文件与上述独立仓库 420 个文件中有 416 个 Git blob 完全相同。可复核 `model/gsCfg.js`=`f5dc01aa70491a153decc8f935be926244e74444`、`model/base.js`=`51621158e752f55fd5e2a7077138a9d2bb8b1f6c`、`model/mys/NoteUser.js`=`104b191d4acb69a6de83839b8be0f20298ab5de8`。这提供原核心的 GPL 出处证据，不能推断独立仓库所有新增文件自动获得宿主许可。更严格的可再分发方案是从 Miao-Yunzai GPL 快照取其原 genshin 目录，并使用原创加载器；本项目不再分发这些文件。TRSS 官方 README 推荐 `#安装genshin` 与 `#安装miao-plugin`，但安装说明不是新增文件的许可证。

## 宿主与依赖

已按 TRSS 3.1.3、生产宿主 commit `79a79c3defd9111429cd1da2acd120f22e68aa29` 的 loader/runtime 读取源码设计，Node 24.21 满足要求。宿主必须提供 `lib/plugins/plugin.js`、`runtime.js`、puppeteer、Redis、`#miao` 和 `#miao.models` imports。安装 genshin 后必须完整重启进程：runtime 在模块首次导入时捕获 genshin 类，单纯热加载不能刷新原先缺失的宿主绑定。

需要保留宿主 lodash、md5、node-fetch、moment、yaml、chokidar、sequelize 及其原有 SQLite dialect 配置。定向新增依赖：

- miao 的 `cheerio` 和 **image-size 1.x**；后者 `CharImg.js` 使用 default import，宿主 image-size 2.x 不能直接替代。
- FanSky 所选模块需要 axios。只安装现代兼容 axios，避免整仓库旧版依赖把宿主 oicq、markdown-it、form-data 覆盖为旧版。
- xhh 多数图像工具的 sharp 是可选降级，但已选择的 `apps/nanokaAbyss.js` 静态导入 sharp；这次选择的 9 类中包含该模块，需要安装兼容 Node 24 的 sharp，否则版本挑战图片模块会导入失败、整体状态为 partial。
- 本项目国服扫码 PNG 需要 qrcode；原 genshin 快照本身没有扫码获取/轮询实现。

不用执行外部仓库的安装脚本、整仓库 pnpm install、自动更新命令、验证码服务部署脚本。

## 加载及配置顺序

1. 在 bot 暂停或隔离目录内取得上表固定源码快照，检查 commit 与原 LICENSE；资源保持原目录名。
2. 定向解决上述实际缺失依赖，保持宿主数据库与原有机器人插件配置。
3. 从宿主根执行 `node plugins/Teyvat-Plugin/scripts/provider-settings.mjs --bot-root BOT_ROOT` 查看计划（把 BOT_ROOT 替换为本机宿主根目录），再加 `--apply` 写入设置。该脚本不启动源码、不发网络请求、不输出凭证。
4. 每个外部根 `index.js` 替换为原创 `export const apps = {};`，原内容备份为 `index.teyvat-original.js.txt`。这样外部顶层不会重复注册命令。当前选择器从固定快照导入 miao 9 类、genshin 13 类、小火花 9 类和 FanSky BotEntry 1 类，共 32 类，并排除下述原生凭据入口。
5. 只有各源实际导入成功后才在 `config/local.json` 启用 `providers.miao/genshin/xhh/fanSky`。`loadNativeProviders` 返回 `loaded/partial/error/missing/disabled` 与逐 app 的错误码；`partial` 不应当成完整成功。
6. 完整重启 bot，读取启动日志、导入结果、规则表、任务表后再做真实 QQ 交互验收。

配置脚本强制的具体边界：

- 小火花禁用 `all_abyss/sr_gacha_enable/waves_tl_enable/tmp_clean_enable/del_ck_hook_enable/solver_deploy_enable/captcha_notice_enable`。清空 `auto_verify_addr/auto_sign_verify_addr`，不向默认第三方过码站点提交验证码参数。`bbs_coin_games=gs`；stoken 搜索仅限 `plugins/xhh-TL/data/Stoken`；gsuid 外部数据库路径指向本插件内不存在的位置，停止自动探测其他项目库。
- 原配置脚本保留的小火花提醒/签到/社区模块开关和 cron 不代表任务运行。选择器不导入 `resinPush/autoSign/autoBbsCoin` 三类，连同其手动订阅入口和后台账户扫描一起排除；账号签到/提醒通过独立加密核心订阅，不将账号信息写入原生订阅 JSON。原米游币需 stoken，当前不启用账号功能。
- miao `profileServer=222`、profile enka `https://enka.network/`、无代理、无私有 miao Token、请求间隔 5 分钟；`charPicSe/proShareProfileImg/notReleasedData/teamCalc=false`，群排名启用。TRSS 上原 Cfg 会强制部分 miao:true 功能为真，不能只靠 false 设置隔离，因此规则层还作过滤。
- genshin `allowUseCookie=0`，公共查询不借其他用户 Cookie；`abbrSetAuth=2`，全局别名设置只给主人。清空非原神推送群设置。
- FanSky 不调用 StarRunCheckConfig，因此不初始化 AI/群管/娱乐、不写代理、不在启动 10 秒后下载数据，也不会给主人发送失败私聊；仅本选择器的 BotEntry 状态设为开启。更新小助手配置附加主人权限。

外部仓库更新会恢复原 index 并改变快照，必须重新审计、重新应用配置/选择器并完整重启。聊天内原 miao/xhh 更新代码命令已移除，防止未经审计的更新重新开启外部顶层加载。

## 加密账户会话

`lib/native-accounts.mjs` 使用 AsyncLocalStorage 隔离每次消息。入口先从当前 QQ 的 AccountsStore 解密本人账户，临时 NoteUser/MysUser 提供固定源码使用的 `getUid/getUidList/getCkUidList/getUidData/getMysUser/mysUsers/ckInfo`，结束后凭据读取失效，事件对象恢复。`save/initCache/addQueryUid` 为无持久化兼容方法；未执行原 NoteUser/MysUser 构造、SQLite 保存、Redis CK 池或跨游戏角色刷新。

安装 guard 必须在第一次消息 Runtime.init 前完成：

```js
configureNativeAccounts({
  accounts: engine.accounts,
  query: (api, account, params) => engine.mys.query(api, account, params),
  allowGroupCookie: false
});
installNativeAccountGuard({ NoteUser, MysUser, MysInfo, MysApi });
// 每个已过滤的原生处理函数：
await runNativeScope(event, () => originalHandler());
```

前三个类可由 TRSS Runtime 的 getter 取得；MysApi 必须显式读取 `plugins/genshin/model/mys/mysApi.js` 的 default，Runtime 没有 MysApi getter。guard 替换固定源码中会初始化原生账户的静态 API，直接构造 MysApi 的查询也转入已核验的只读核心协议；原 Cookie 字段赋值被丢弃，无 scope 不读取账户、不初始化公共 CK。Runtime 早于处理函数创建用户时只得到空临时对象，后台 forEach 不遍历账户。真实个人游戏接口仍需本人授权验收。

默认群内只提供 UID，个人查询限私聊；如明确允许本人在群内查询，需显式启用 allowGroupCookie，仍仅使用发起者自己的 AES 账户。`@其他用户`、其他游戏与外部 UID 不会借用 Cookie。整份独立祈愿和订阅路由/去重状态也采用 AES-256-GCM；祈愿文件名由密钥与账户对应 AAD 计算 HMAC-SHA256，路径不含 QQ/UID，用户主动导出的 UIGF 为可交换明文文件。旧祈愿路径仅兼容读取，成功重新导入并核验后清理未变更的旧文件。桥接不是任意外部代码的文件沙箱：面板、群榜、收藏和原生游戏记录另有缓存，必须另外审计其数据与权限；旧实例其他明文数据也须迁移，不能把新文件加密宣传为全部外部文件已加密。

原生凭据入口及理由：

| 类/入口 | 当前处理 | 固定源码风险 |
| --- | --- | --- |
| genshin user（含 accept/init） | 不注册 | 自动检测 Cookie、User.bing 写库、myCk 回显、主子账号绑定；init 自动迁移/删除旧明文账号文件 |
| genshin setPubCk | 不注册 | 公共 Cookie 写 YAML，用户 CK 进入公共查询池 |
| genshin userAdmin | 不注册 | 刷新/清空 CK 池、枚举或删除原生账户 |
| genshin payLog/gcLog | 不注册 | 消费/祈愿 authkey 写 Redis，QQ-UID 关系与记录写明文缓存；本地祈愿走本项目 UIGF |
| miao admin.miaoApiInfo | 移除规则 | QQ/私有 Token 拼入明文 HTTP 查询参数 |
| xhh resinPush/autoSign/autoBbsCoin | 三类不注册 | 手动订阅写原生明文 JSON，后台全局账号遍历；社区 stoken 尚无加密适配 |
| genshin ledger.ledgerTask | 移除规则且 task 清空 | 原石札记定时账户状态写入原生缓存；手动札记只读协议已加入核心，会话/图片待验收 |

当前桥接支持源码核对过的原神只读 index、dailyNote、spiralAbyss、role_combat、hard_challenge/popularity、character/detail、养成、活动和 gcg 基础接口；新增 ledger/ys_ledger、blueprint/blueprintCompute、deckList 与角色/行动卡牌列表也已加入允许范围。独立命令为 `#原神札记 [月份]`、`#原神尘歌壶方案 模数`、`#原神家具计算 JSON`、`#原神七圣牌组/七圣卡牌`。本人响应与旧图片调用的参数兼容仍需验收；UserGame、getFp、充值 authkey、stoken 与 bbs_sign 不由桥接执行，不能用公共 CK 或原生明文保存来填补缺口。

月谕圣牌与七圣卡牌不同：miao 的 `apps/stat/RoleCard.js` 从 role_combat 的 tarot_card_state 读取收藏，个人读协议已在范围内；群交换会把 QQ/UID、称呼和收藏状态写入原 Redis 缓存。当前默认群内不提供 Cookie，尚未完成该群缓存加密适配和图片验收，不能因七圣列表请求已写便宣称群圣牌交换已覆盖。

## 已选择功能与尚未验收项

喵喵角色卡、公开角色面板、伤害计算、圣遗物统计与替换、角色资料、日历、胡桃/小助手统计等由原模块执行，原神守卫覆盖全部规则函数、accept 和上下文回调。`#喵喵帮助` 保留，通用 `#帮助` 不由组合喵喵抢占。小火花提供体力卡、剧诗、全深渊、配队/持有率、队伍伤害和公开版本配置；个人记录仅在当前会话已核验协议范围内可用，签到与提醒改用独立加密核心。FanSky 提供成就/宝箱统计、`#单人评级` 与显式 `#小助手队伍伤害`；后者与小火花 `#队伍伤害` 分开。选择器把裸 `#体力` 改为只查原神，不请求另外三个游戏。

上游自身未完成的 `#历史队伍伤害`、注释掉的队伍缓存菜单、旧文档猜角色功能不注册。FanSky 单人评级当前源码仍走队伍接口，不声称已验证专属单人算法。原 genshin 活动到期推送实现无条件访问星铁活动源，本版移除其自动与手动任务；普通原神公告/资讯查询保留，原神专用活动推送仍待独立实现。miao `#上传深渊` 的旧别名当前只查统计，不实际调用 uploadData，不宣称数据已上传。

功能/API/授权完整逐项映射由 `FEATURE-AUDIT.md` 记录；无 Cookie 的公开接口探测成功只证明当次数据源可读，不证明账户/QQ图片/群排行功能已验收。

此前宿主已确认 40 类可加载、Runtime.MysInfo/NoteUser/e.user 存在，FanSky 规则资源已取得。这是加密约束收紧前的装载证据。当前源码收紧为 32 类，本轮完整部署与消息验收仍待完成；旧证据不代表新选择器、真实用户扫码、个人记录或 QQ 图片通过。

部署验收至少包括：原神公开面板、深渊/剧诗公开配置图片、小火花深渊配队、FanSky 完整参数成就榜响应；拒绝 `*面板/%面板/#星铁面板/#绝区零体力/#鸣潮体力`；非主人不能更新小助手配置；无用户订阅时任务不发消息。本人私聊扫码/授权后，再验证个人便笺、深渊、剧诗、札记、家具、七圣牌组/卡牌、祈愿、队伍计算与独立订阅，核对原生 DB/YAML/Redis CK 池没有新增账号。stoken、群收藏缓存等缺口应直接报告未覆盖，不能以“模块已载入”代替。

## API与素材致谢

实际数据提供者包含米哈游/米游社/HoYoLAB/HoYoPlay、Enka.Network（国服可能重定向 MiniGG）、提瓦特小助手 yshelper/lelaer、Alioth.wiki、非小酋 feixiaoqiu、monsterxcn/nonebot-plugin-gspanel。喵喵原模块还保留其 Hutao/miao.games、Nanoka/Hakush.in/HomDGCat/Bilibili Wiki 等可选来源；启用原命令时须分别核验实际调用与可用性。角色/武器/圣遗物及游戏图片属于各原权利人，仓库代码许可证不能替代素材授权。

参考原项目：[miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin)、[xhh-TL](https://gitee.com/longhengmu/xhh-TL)、[FanSky_Qs](https://github.com/AFanSKyQs/FanSky_Qs)、[Yunzai-genshin](https://github.com/TimeRainStarSky/Yunzai-genshin)、[TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)。仅功能/API设计参考的 [MATOOL-Plugin](https://github.com/Muoan/MATOOL-Plugin)、[GamePush-Plugin](https://github.com/rainbowwarmth/GamePush-Plugin) 不应写成已完整安装。
