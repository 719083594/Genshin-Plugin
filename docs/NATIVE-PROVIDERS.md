# 原神组合功能、安装与实际验收

账户统一使用原神助手的 AES-256-GCM 库，包括 QQ、账号 UID、备注、Cookie 与滚动备份。私聊 `#原神扫码登录 [UID]` 或 `#原神绑定Cookie UID Cookie` 核验本人角色后保存；多号由 `#原神账户/切换/解绑` 管理。真实官方扫码创建/pending/本人确认及角色核验已成功，AES 保存了一个国服账户。不复制到原生明文 DB/YAML/Redis CK 池，也不使用原 genshin 的裸 `#绑定Cookie`、公共 CK、跨 QQ 账号绑定与 authkey 缓存入口。组合面板可使用公开缓存；个人只读查询通过当前 QQ 的临时会话对象从 AES 库读取。不保存 stoken；米游币余额/任务状态通过独立固定 GET 复用 AES Cookie，本人已授权只读实测成功。签到、点赞、分享、兑换及领奖执行不提供。

## 外部源码快照

| 模块目录（必须保留原名） | 官方来源 | 固定版本 | 许可证 |
| --- | --- | --- | --- |
| `plugins/miao-plugin` | https://github.com/yoimiya-kokomi/miao-plugin | `b01d77483268eb2236876ad0995fab27052c09ad` | MIT，Yoimiya |
| `plugins/genshin` | https://github.com/TimeRainStarSky/Yunzai-genshin | `4a2e1fb8f094b2a8f039ce0768773701718b60b9` | 独立仓库未放 LICENSE；原核心 GPL-3.0 来源证据见下文 |
| `plugins/xhh-TL` | https://gitee.com/longhengmu/xhh-TL | `1b5e5644c9351fcfd950acabf2c791060a7c44b6` | MIT，cchanlan |
| `plugins/FanSky_Qs` | https://github.com/AFanSKyQs/FanSky_Qs | `86d002866114fa1dd1c765325fde621925938adc` | Apache-2.0，AFanSKyQs |

以上源码由用户直接安装在 bot，保留原仓库、版权通知与全部资源，不打包进原神助手 GitHub。新插件包含原创选择器、账户会话隔离、边界守卫、配置和文档。MATOOL 没有可核验许可证，不复制其代码或模板；GamePush 的原神版本/包体协议由独立核心访问 HoYoPlay/Sophon，本次不安装其其他游戏模块。本机包体观察历史已实现，远端完整历史数据库仍待实现，不能声称与上游全部功能等价。

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
3. 从宿主根执行 `node plugins/Genshin-Plugin/scripts/provider-settings.mjs --bot-root BOT_ROOT` 查看计划（把 BOT_ROOT 替换为本机宿主根目录），再加 `--apply` 写入设置。该脚本不启动源码、不发网络请求、不输出凭证。
4. 每个外部根 `index.js` 替换为原创 `export const apps = {};`，原内容备份为 `index.teyvat-original.js.txt`。这样外部顶层不会重复注册命令。当前选择器从固定快照导入 miao 9 类、genshin 13 类、小火花 9 类和 FanSky BotEntry 1 类，共 32 类，并排除下述原生凭据入口。
5. 只有各源实际导入成功后才在 `config/local.json` 启用 `providers.miao/genshin/xhh/fanSky`。`loadNativeProviders` 返回 `loaded/partial/error/missing/disabled` 与逐 app 的错误码；`partial` 不应当成完整成功。
6. 完整重启 bot，读取启动日志、导入结果、规则表、任务表后再做真实 QQ 交互验收。

配置脚本强制的具体边界：

- 小火花禁用 `all_abyss/sr_gacha_enable/waves_tl_enable/tmp_clean_enable/del_ck_hook_enable/solver_deploy_enable/captcha_notice_enable`。清空 `auto_verify_addr/auto_sign_verify_addr`，不向默认第三方过码站点提交验证码参数。`bbs_coin_games=gs`；stoken 搜索仅限 `plugins/xhh-TL/data/Stoken`；gsuid 外部数据库路径指向本插件内不存在的位置，停止自动探测其他项目库。
- 原配置脚本保留的小火花提醒/签到/社区模块开关和 cron 不代表任务运行。选择器不导入 `resinPush/autoSign/autoBbsCoin` 三类，连同其手动订阅入口和后台账户扫描一起排除；提醒通过独立加密核心订阅，不将账号信息写入原生订阅 JSON；签到能力及其旧配置/订阅已删除。米游币只读查询无需引入原社区任务类。
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

前三个类可由 TRSS Runtime 的 getter 取得；MysApi 必须显式读取 `plugins/genshin/model/mys/mysApi.js` 的 default，Runtime 没有 MysApi getter。guard 替换固定源码中会初始化原生账户的静态 API，直接构造 MysApi 的查询也转入核对过的只读核心协议；原 Cookie 字段赋值被丢弃，无 scope 不读取账户、不初始化公共 CK。Runtime 早于处理函数创建用户时只得到空临时对象，后台 forEach 不遍历账户。role_combat/hard_challenge/ledger/deckList 已验证本人真实 API；index/dailyNote/spiralAbyss 此前 5003→1034，官方设备指纹部署后，本人已私聊完成官方极验并提交，日志标记确认官方接受，用户确认便笺/深渊/个人资料三项 QQ 命令正常。未逐字段核对，也不扩展为其他接口或账号均已通过。

默认群内只提供 UID，个人查询限私聊；如明确允许本人在群内查询，需显式启用 allowGroupCookie，仍仅使用发起者自己的 AES 账户。`@其他用户`、其他游戏与外部 UID 不会借用 Cookie。整份独立祈愿和订阅路由/去重状态也采用 AES-256-GCM；祈愿文件名由密钥与账户对应 AAD 计算 HMAC-SHA256，路径不含 QQ/UID。旧祈愿/订阅已加入启动和读取迁移，回验后清理确认未变的旧源，错钥拒绝另建空库。私聊上传使用内存 Buffer，CLI 二维码在终端显示、普通 command JSON 写 stdout；只有用户显式 export 才创建指定明文 UIGF 文件。

## 原生缓存加密范围

当前 index 已安装以下原创缓存适配器，复用实例 credentialsKey，禁止将 Cookie/_ck/token/authkey 写入原生缓存。包含这些适配器的新版已经线上部署，32 个原生类与独立核心共 33 类加载成功，无构造失败；真实 Redis Lua 合成旧数据迁移、凭据剥离、排名顺序与原始键删除全部通过，测试键已清理。完整图片/个人接口仍需分别验收。

| 适配器 | 受控原路径/命名空间 | 保存方式与边界 |
| --- | --- | --- |
| native-storage | miao Data 的 `data/PlayerData/gs/*.json`、`data/UserData/*.json`，宿主默认/root/yunzai 根 | 正文全 AES、HMAC 文件名；读/写/删除保持同步 API；旧 UserData 仅加密，不运行原格式转换或明文备份；resources、SR 与其他插件根仍委托原逻辑 |
| native-file-cache | `data/NoteData/<UID>.json`、`plugins/FanSky_Qs/resources/cache/<UID>.json`、`data/FanSky_Qs/Top/{ChestTop,AchieveTop}.json`、`plugins/xhh-TL/data/resin_timer.json` | 仅这些直接 fs JSON 缓存重定向至 AES/HMAC 文件；保留原 fs 返回类型，旧源回验且未变化才删除 |
| native-redis | `miao:rank:`、`miao:role-card:`、`miao:user-cfg:`、`miao:profile-cd:`、`FanSky:Teyvet:`、`FanSky:SmallFunctions:ChestTop:`、`FanSky:SmallFunctions:AchieveTop:`、`xhh:show_`、`xhh:hide_`、`xhh:transformer_` | 键、完整值、hash 字段、榜单成员与分数存单 AES 文件，榜单在内存排序；受控 namespace 不再向原 Redis 写账号缓存；transformer_ck 凭据缓存写入被拒绝 |

面板/文件旧源先加密并回读，再核对同一源未变化才清理；损坏、变更冲突或清理失败保留并报错。Redis 旧 string/hash/zset 先写 AES 回验，再用原 Redis Lua 比对类型、全部值与绝对到期时间后 CAS 删除；带 TTL 迁移需 Redis 7 的 PEXPIRETIME，无 eval 或缺能力时保留原值并明确报错。真实 Redis Lua 合成旧数据迁移、凭据剥离、排名顺序与原始键删除已线上验收，测试键已清理；这是合成样本验证，不能推断任意旧第三方数据均已迁移。

非受控文件/Redis namespace 继续原逻辑，未知 Redis 方法、multi/sendCommand 也不在这个兼容钩子的范围内。账户桥与缓存适配器不是任意第三方代码的文件沙箱；新增未经审计的路径或调用方式不能自动获得同样保证。

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

当前桥接支持源码核对过的原神只读 index、dailyNote、spiralAbyss、role_combat、hard_challenge/popularity、character/detail、养成、活动和 gcg 基础接口；新增 ledger/ys_ledger、blueprint/blueprintCompute、deckList 与角色/行动卡牌列表也已加入允许范围。独立命令为 `#原神札记 [月份]`、`#原神尘歌壶方案 模数`、`#原神家具计算 JSON`、`#原神七圣牌组/七圣卡牌`。家具模数 match 数组与 wrapped body 已有兼容测试；未核验的本人响应和旧图片仍需验收。UserGame、充值 authkey、stoken 与 bbs_sign 不由桥接执行。独立核心设备指纹与人工验证已由本人使用，官方接受回执后，用户确认此前 1034 的便笺/深渊/个人资料三项命令正常。

安全验证由独立核心原创 `#原神安全验证` / `#原神提交验证 nonce 回执` / `#原神取消验证` 管理。官方 create 已实测签发 v3 挑战；HTML 用官方 gt.js 让本人手动完成，QQ 浏览器不支持时下载 HTML 用系统浏览器打开，生成整条命令后复制回同一 QQ 私聊。五分钟会话只存在内存，绑定 QQ、所选 UID、Cookie 的 SHA-256 与挑战前 32 字符；切号/解绑取消，重复回执不能再次提交。HTML 无 Cookie/UID/设备标识，设备上下文和官方提交后短期放行信息也只在内存，不交给原生 CK 池。本轮本人已完成人工操作，官方接受回执的日志标记与三项 QQ 查询正常反馈已取得；不保证所有账号或未来查询免验证，不用自动 solver、公共 CK 或明文账户填补缺口。

月谕圣牌与七圣卡牌不同：miao 的 `apps/stat/RoleCard.js` 从 role_combat 的 tarot_card_state 读取收藏，个人读协议已在范围内；其 QQ/UID、称呼与收藏状态缓存已纳入 native-redis 的 role-card 前缀加密，适配器已上线且真实 Redis 合成迁移/排序验收通过。当前默认群内不提供 Cookie，收藏图片与完整群交换仍待验收，不能因七圣牌组 API 成功便宣称群圣牌交换已通过。

## 已选择功能与尚未验收项

喵喵角色卡、公开角色面板、伤害计算、圣遗物统计与替换、角色资料、日历、胡桃/小助手统计等由原模块执行，原神守卫覆盖全部规则函数、accept 和上下文回调。`#喵喵帮助` 保留，通用 `#帮助` 不由组合喵喵抢占。小火花提供体力卡、剧诗、全深渊、配队/持有率、队伍伤害和公开版本配置；个人记录仅在当前会话已核验协议范围内可用，提醒改用独立加密核心，签到执行已删除。FanSky 提供成就/宝箱统计、`#单人评级` 与显式 `#小助手队伍伤害`；后者与小火花 `#队伍伤害` 分开。选择器把裸 `#体力` 改为只查原神，不请求另外三个游戏。

上游自身未完成的 `#历史队伍伤害`、注释掉的队伍缓存菜单、旧文档猜角色功能不注册。FanSky 单人评级当前源码仍走队伍接口，不声称已验证专属单人算法。原 genshin 活动到期推送实现无条件访问星铁活动源，本版移除其自动与手动任务；普通原神公告/资讯查询保留，原神专用活动推送仍待独立实现。miao `#上传深渊` 的旧别名当前只查统计，不实际调用 uploadData，不宣称数据已上传。

功能/API/授权完整逐项映射由 `FEATURE-AUDIT.md` 记录；无 Cookie 的公开接口探测成功只证明当次数据源可读，不证明账户/QQ图片/群排行功能已验收。

最新源码已线上部署，32 个原生类与独立核心共 33 类加载成功，无构造失败；六个容器 healthy，账户成功解密保留，两个插件帮助回复获用户确认。Runtime.MysInfo/NoteUser/e.user 与 FanSky 资源已核验。本人国服扫码并 AES 保存一个账户、role_combat/hard_challenge/ledger/deckList 的真实 API 已成功；官方设备指纹签发及真实 Redis Lua 合成迁移、凭据剥离、排序、原键删除均已验证。index/dailyNote/spiralAbyss 历史 1034 经本人人工验证、官方接受回执后，用户确认三项 QQ 命令均正常；用户也确认生产私聊 `#钟离天赋` 正常收到图片，此条端到端通过。未逐字段核对，不据此宣布全部账号、个人接口、图片或推送通过。

剩余验收至少包括：除已通过的 `#钟离天赋` 外，其他原生公共图、个人面板、深渊/剧诗公开配置图片、小火花深渊配队、FanSky 完整参数成就榜响应；拒绝 `*面板/%面板/#星铁面板/#绝区零体力/#鸣潮体力`；非主人不能更新小助手配置；无用户订阅时任务不发消息。便笺/深渊/个人资料三项已有本人人工验证后的正常反馈，仍须逐项核对家具/卡牌、祈愿、队伍计算与独立订阅；继续检查真实用户图形调用中原生 DB/YAML/Redis CK 池无新增凭据、列明缓存不再新增明文账号标识。真实 Redis 的合成迁移与排序已通过，完整实际群榜图片仍待验收。stoken 等缺口应直接报告未覆盖，不能以“模块已载入”或单条图片通过代替。

## API与素材致谢

实际数据提供者包含米哈游/米游社/HoYoLAB/HoYoPlay、Enka.Network（国服可能重定向 MiniGG）、提瓦特小助手 yshelper/lelaer、Alioth.wiki、非小酋 feixiaoqiu、monsterxcn/nonebot-plugin-gspanel。喵喵原模块还保留其 Hutao/miao.games、Nanoka/Hakush.in/HomDGCat/Bilibili Wiki 等可选来源；启用原命令时须分别核验实际调用与可用性。角色/武器/圣遗物及游戏图片属于各原权利人，仓库代码许可证不能替代素材授权。

参考原项目：[miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin)、[xhh-TL](https://gitee.com/longhengmu/xhh-TL)、[FanSky_Qs](https://github.com/AFanSKyQs/FanSky_Qs)、[Yunzai-genshin](https://github.com/TimeRainStarSky/Yunzai-genshin)、[TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)。仅功能/API设计参考的 [MATOOL-Plugin](https://github.com/Muoan/MATOOL-Plugin)、[GamePush-Plugin](https://github.com/rainbowwarmth/GamePush-Plugin) 不应写成已完整安装。

### 原生祈愿图片的私密读取与渲染

`native-gacha.mjs` 拦截 miao 的 `data/gachaJson/<QQ>/<UID>/<pool>.json` 读取：只在当前 QQ 的有效私聊范围内从独立 AES 库解密，不读取原明文路径，不创建兼容 JSON；写入/删除也拒绝。301/400 合并，302/200/500 分池，新手池保留独立文字分析。严格核对已知原神物品、五星 UP 元数据与排序；缺资料时提示而不猜统计。

只保护 detail/stat/Yzdetail/Yzstat 的个人绘图，公开卡池图保留宿主公共渲染。个人图绕开会写 HTML/调试 JSON 的 Runtime 链，在已有宿主 Puppeteer 浏览器中新建独立上下文，禁止 JS、缓存、外部网络，只读 miao 普通公共资源文件；截图直接返回 Buffer，无文件路径。限制并发、时间、尺寸及字节；关闭失败锁住后续个人渲染，不关闭宿主浏览器或创建新浏览器。没有现成浏览器时提示先用公共图片命令。离线测试不等于真实本人记录图片已通过。
