# 致谢、API 与许可

区分实际源码调用、可选原模块的数据源与仅作设计参考的项目。源码实现或接口存在不能代替服务可用性、本人的账户和真实 QQ 功能验收。

## 五个指定参考项目

| 项目与原作者 | 固定 commit | 本项目使用方式 | 原许可 |
| --- | --- | --- | --- |
| [xhh-TL / longhengmu，cchanlan](https://gitee.com/longhengmu/xhh-TL) | `1b5e5644c9351fcfd950acabf2c791060a7c44b6` | 便笺协议核对；签到为历史审计参考，执行能力已移除；可选原神体力、挑战与配队模块，原签到/提醒/社区类不注册 | MIT ©2026 cchanlan |
| [miao-plugin / Yoimiya-Kokomi](https://github.com/yoimiya-kokomi/miao-plugin) | `b01d77483268eb2236876ad0995fab27052c09ad` | 固定原神文本资料摘录；可选图片面板、伤害、图鉴、抽卡与榜单 | MIT ©2023 Yoimiya |
| [MATOOL-Plugin / Muoan](https://github.com/Muoan/MATOOL-Plugin) | `fc3275598f382f93703de42600b904f8ad605066` | 祈愿分析、导入导出、云记录设计参考；未复制代码/模板 | 快照无 LICENSE/package license |
| [GamePush-Plugin / rainbowwarmth](https://github.com/rainbowwarmth/GamePush-Plugin) | `43a9c547ef6cfb687ef6bf9eb8a188beb28473f8` | HoYoPlay 请求协议、版本与包体监控设计参考；未安装原模块 | MIT ©2025 RainBow |
| [FanSky_Qs / AFanSKyQs](https://github.com/AFanSKyQs/FanSky_Qs) | `86d002866114fa1dd1c765325fde621925938adc` | 可选 BotEntry 原神队伍、成就/宝箱统计与本地群榜 | Apache-2.0 |

组合还依赖 [Yunzai-genshin / TimeRainStarSky](https://github.com/TimeRainStarSky/Yunzai-genshin) `4a2e1fb8f094b2a8f039ce0768773701718b60b9`、[TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) 与 [Miao-Yunzai](https://github.com/yoimiya-kokomi/Miao-Yunzai) 的账户、渲染和运行时。Yunzai-genshin 独立快照没有 LICENSE；与 GPL-3.0 Miao-Yunzai 原核心匹配的出处证据及新增文件边界见 [组合说明](NATIVE-PROVIDERS.md)。不能由宿主 GPL 自动推断任意外部新增文件的许可。

## 独立核心实际 API

| 提供者 | 当前源码使用的端点与用途 |
| --- | --- |
| 米哈游 / 米游社 | `api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie`，`game_biz=hk4e_cn`；绑定前验证角色归属 |
| 米游社通行证 | `passport-api.miyoushe.com/account/ma-cn-passport/web/{createQRLogin,queryQRLoginStatus}`；原创国服扫码创建/轮询，票据只保留内存；真实创建/pending/本人确认及角色归属验证已成功，AES 保存一个国服账户，不代表所有账号或渠道通过 |
| 米哈游 / 米游社 | `api-takumi-record.mihoyo.com/game_record/app/genshin/api/` 下的 index、dailyNote、spiralAbyss、role_combat、hard_challenge、character/list、character/detail、act_calendar、gcg/basicInfo、gcg/deckList、gcg/cardList 等；本人 role_combat/hard_challenge/deckList 已验证成功。index/dailyNote/spiralAbyss 此前 5003→1034，本人手动极验与回执被官方接受后，用户确认个人资料/便笺/深渊三项 QQ 命令正常；未逐字段核对，其他分支/账号需逐项验收 |
| 米哈游官方设备指纹服务与账号 SDK | 运行时调用 [设备指纹 getFp](https://public-data-api.mihoyo.com/device-fp/api/getFp)，字段/bootstrap 参考 [官方账号 Web SDK](https://webstatic.mihoyo.com/dora/biz/mihoyo-account-sdk/main.js) 和实取的 [Web 字段列表 getExtList](https://public-data-api.mihoyo.com/device-fp/api/getExtList?platform=4&app_name=bbs_cn)。getFp 不带账户凭据，只有服务真实签发的有效值用于 x-rpc-device_fp。官方真实签发与部署已验证，不代表可绕过 1034 安全验证 |
| 米游社本人人工验证 | `https://bbs-api.miyoushe.com/misc/wapi/createVerification` 与 `verifyVerfication`（官方路径拼写）；协议核对 xhh-TL utils/mysVerify.js，未引入其 solver。官方 create 实测返回 v3 gt32hex/challenge32hex；new_captcha 数字 1 在客户端转成布尔。本人已手动完成并提交回执，日志固定标记确认官方接受，用户随后确认便笺/深渊/个人资料正常；不保证所有账号或未来查询免验证 |
| 极验 / GeeTest 官方 SDK | HTML 仅显式加载 [HTTPS gt.js](https://static.geetest.com/static/tools/gt.js)，初始化/onSuccess/getValidate 三字段流程依据 [官方 HTTPS 客户端文档](https://docs.geetest.com/2.0/sections/idx-client-sdk.html)、[v3 Web API](https://docs.geetest.com/captcha/apirefer/api/web) 与 [资源域名说明](https://docs.geetest.com/captcha/deploy/client/web/)。由本人手动操作后复制回执，不使用第三方 solver 或自动解题；HTML 不含账户凭据 |
| 米哈游 | `api-takumi.mihoyo.com/event/e20200928calculate/` 下的 v1/sync/avatar/detail、v1/avatarSkill/list、v2/compute、v1/furniture/blueprint、v1/furniture/compute；养成、尘歌壶模数与家具材料计算，不是队伍伤害模拟 |
| 米哈游原石札记 | 国服 `hk4e-api.mihoyo.com/event/ys_ledger/monthInfo`，国际服 `sg-hk4e-api.hoyolab.com/event/ysledgeros/month_info`；固定本人 UID/服务器和月份，国服本人 API 已成功，国际服仍待账户响应验收 |
| 米哈游 / 米游社 | `bbs-api.mihoyo.com/apihub/wapi/getUserMissionsState?point_sn=myb`、`common/homutreasure/v1/web/user/point?app_id=1&point_sn=myb`；本人 Cookie 仅发送两个固定 GET，2026-10-07 明确授权后返回成功；不执行签到、点赞、分享、兑换或领奖 |
| HoYoLAB | `api-os-takumi.mihoyo.com`、`sg-public-api.hoyolab.com/event/game_record/genshin/api/`、其 event/e20200928calculate/、`sg-hk4e-api.hoyolab.com/event/sol/`；国际服按 UID 分流，含家具和七圣路由，凭证不跨区域域名，实际国际服账户响应未验收 |
| 米哈游 HoYoPlay | `hyp-api.mihoyo.com/hyp/hyp-connect/api/getGameBranches`，launcher_id=`jGHBHlcOq1`、game_id=`1Z8W5NHUQb`；国服原神 PC 正式/预下载标签，无凭证当次探测取得 retcode=0 |
| 米哈游 HoYoPlay / Sophon | `hyp-api.mihoyo.com/hyp/hyp-connect/api/getGamePackages`、`api-takumi.mihoyo.com/downloader/sophon_chunk/api/getBuild`（GET）与 `getPatchBuild`（POST），plat_app=`ddxf5qt290cg`；国服 PC 全量/增量资源大小、清单与传统 ZIP 元数据，无 Cookie 请求。传统 ZIP 版本可能落后于正式分支，必须核对版本后使用 |
| [Enka.Network / algoinde](https://enka.network/) | `https://enka.network/api/uid/<UID>/`；[API 文档](https://github.com/EnkaNetwork/API-docs)，只显示公开展柜。独立核心拒绝自动重定向，部分国服服务跳转可能需后续适配 |
| [UIGF / 统一可交换祈愿记录标准](https://uigf.org/) | 本地祈愿参考其 v2.2/v2.3/v2.4/v3.0/v4.0/v4.1/v4.2 原神记录结构，默认 v4.2 导出；不表示标准认证、支持所有未来版本或完成各云服务互通 |
| [GamePush 公开历史资料 / rainbowwarmth](https://cnb.cool/rainbowwarmth/resources) | 固定 HTTPS [历史数据库](https://cnb.cool/rainbowwarmth/resources/-/git/raw/main/GamePush-Plugin/GamePush-Plugin.db)，首次只读核验 40 KiB，提取 `game=ys` 的 57 条正式和 53 条预下载记录为 JSON 快照；数据库 SHA-256 `6ff7d6a08e762a9d550168f1db4ef55985204a13c1d00be9cdfb3bb92dc2e103`。运行时仅主人明确同步时下载，不执行远端代码，不导入其他游戏；作者历史大小口径不等于启动器当前资源大小，也不保证所有过去版本齐全 |

协议还参考 [genshin.py / seriaati](https://github.com/seriaati/genshin.py) 的路由、签名、签到与养成接口，未复制其代码。这些是官方应用域名上的社区观察协议，并非官方发布的第三方开发 SDK。个人接口需要本人授权、官方数据权限和逐项响应验收。

独立资料由固定 miao 快照提取：127 角色、257 武器、63 圣遗物套装、263 材料，保留 [MIT 通知](../resources/MIAO-LICENSE.txt)。数量描述文件快照，不保证游戏后续更新自动同步。

帮助菜单还使用同一固定 [miao-plugin](https://github.com/yoimiya-kokomi/miao-plugin/tree/b01d77483268eb2236876ad0995fab27052c09ad/resources) 的 `resources/help/icon.png`（本地 `resources/ui/icons.png`）与 `resources/common/theme/main-01.png`（本地 `resources/ui/ayaka.png`）公开素材；保留上述 MIT 通知。菜单分组、排版及内存渲染代码原创，素材和原神角色形象权利由原作者及对应游戏权利人保留，不由本项目 GPL 重新授权。

## 可选原模块 API 与素材源

只有启用模块并实际执行相关命令时才会连接下列来源，未启用不能写为已接通。

| 提供者与归属 | 原模块所用来源与用途 |
| --- | --- |
| 米哈游 / 米游社 | 上游 widget/v2、getUserGameRolesByStoken、event/luna/info/sign、bbs-api.mihoyo.com、设备指纹/账号接口；本组合仅已接入的只读 Cookie 协议按会话使用，stoken 不保存，社区写操作按用户要求删除；余额/任务状态由独立固定 GET 客户端从 AES Cookie 只读查询，xhh 原签到/提醒/社区类不注册 |
| [MiniGG / MiniGrayGay](https://github.com/MiniGrayGay) | profile.microgg.cn；原喵喵/Enka 国服面板候选或重定向，原配置有 HTTP 地址，本项目默认 HTTPS Enka |
| [Snap.Hutao / DGP Studio](https://github.com/DGP-Studio/Snap.Hutao) 与 miao.games | enka-api.hut.ao、miao.games/profile/data、api/calendar、api/hutao；可选面板、日历/统计，不声明私有 Token 已配置或当前服务可用；“上传深渊”旧别名当前无实际上传调用 |
| 提瓦特小助手 yshelper / lelaer | `https://api.yshelper.com/ys/{getAbyssRank.php,getAbyssRank2.php}`、`https://api.lelaer.com/ys/{getRoleAvg.php,getAbyssRank2.php,getTeamResult.php,getDamageResult.php}`；配队/样本持有率与伤害。队伍请求会提交角色属性；FanSky 当前单人入口未证明使用专属 getDamageResult |
| [Alioth.wiki](https://alioth.wiki/) | json.alioth.wiki/data/gi/ch/{abyss,theater,stygian}.json、分期详情与 img.alioth.wiki；公开原神挑战配置/图片 |
| Nanoka、[Hakush.in](https://hakush.in/)、[HomDGCat](https://homdgcat.wiki/)、[Bilibili 原神 Wiki](https://wiki.biligame.com/ys/) | static.nanoka.cc、api.hakush.in/gi/data/rolecombat、homdgcat.wiki/gi/CH/maze.js 等；喵喵剧诗/角色配置候选来源，以实际调用为准 |
| [Project Amber / Yatta](https://gi.yatta.moe/) | 小火花原神图片兜底与资源来源，素材权利独立保留 |
| [非小酋](https://feixiaoqiu.com/) | search_achievement_ajax、search_box_ajax；成就/宝箱样本榜，简化探测未验证完整协议响应，不是全服数据库 |
| [monsterxcn / nonebot-plugin-gspanel](https://github.com/monsterxcn/nonebot-plugin-gspanel) | cdn.monsterx.cn/bot/gspanel/{char-data,hash-trans,calc-rule,relic-append}.json；FanSky 旧面板转换与规则，本组合不在启动时下载，配置更新限主人 |

**尚未接通**的来源包括 [墨安游戏助手](https://record.muoan.com/)。原创墨安客户端已写 `analysis/query/gacha/{export-json,import-json,verify-link,import-link}` 协议及私聊命令，但默认没有服务地址、没有有效 Key，不能宣称真实连接成功。MATOOL 快照默认 API 是明文 HTTP IP 地址，本项目拒绝使用该地址；启用须另外配置可用且核验过的公网 HTTPS 服务。主动云链接验证/导入会向该服务提交链接中的 authkey，个人 Key 只按需放入 `X-API-Key`；Cookie 不用于该客户端，敏感值不写日志或 GitHub。未安装原 MATOOL，未引入其模板与代码。

## 许可边界

原创代码采用 GPL-3.0-or-later。外部源码由用户直接安装，保留原目录、作者、版权和许可，不打包进本项目仓库，不冒称完全原创。实际分发第三方实质代码时需履行其许可证，致谢不能替代许可全文。

原神角色、武器、圣遗物、游戏图片和文字属于对应权利人；代码许可不代表素材或第三方 API 也取得相同授权。代码路径、固定版本和公开探测记录见 [完整审计](FEATURE-AUDIT.md)。

米游币协议依据米哈游 [正式兑换中心](https://webstatic.mihoyo.com/app/community-shop/index.html)及其 [production bundle](https://webstatic.mihoyo.com/app/community-shop/bundle_55d0c960b52f8ee3e1c7.js)，SHA256 `fd685f1229bd40fd94389e7ec336eb20950d44c655f993b28d35e1dab83a6222`。仅参考余额/任务状态字段，未复制商城或执行兑换/社区任务。
