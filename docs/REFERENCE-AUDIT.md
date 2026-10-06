# 五个参考插件的原神功能审计

审计日期：2026-10-07（Asia/Shanghai）。本报告核对真实仓库源码、命令注册与默认配置；没有运行这些仓库的安装脚本或插件代码，没有使用任何游戏账号凭证。API 可用性只是无凭证公开接口的当次探测，不代表账号功能已验证。

## 1. 固定源码快照与许可

| 代号 | 用户指定来源 | 已取得 commit | 许可证据 | 使用边界 |
| --- | --- | --- | --- | --- |
| X | https://gitee.com/longhengmu/xhh-TL | `1b5e5644c9351fcfd950acabf2c791060a7c44b6` | `LICENSE`：MIT，Copyright (c) 2026 cchanlan | 可安装/参考/改编自身代码，分发实质代码时保留版权与MIT全文；图源与其他依赖另有权利。README同时有学习交流、勿商用的声明，不能把MIT当成所有素材授权。 |
| M | https://github.com/yoimiya-kokomi/miao-plugin | `b01d77483268eb2236876ad0995fab27052c09ad` | `LICENSE`：MIT，Copyright (c) 2023 Yoimiya | 可合法组合其完整实现；代码授权不代表米哈游游戏素材或第三方API授权。 |
| A | https://github.com/Muoan/MATOOL-Plugin | `fc3275598f382f93703de42600b904f8ad605066` | 当前快照未发现 LICENSE，package.json 也未声明 license | 仅审计功能与公开接口；不要复制其代码/模板再发布为新插件。原创实现可以参考功能概念和接口协议，并致谢。 |
| P | https://github.com/rainbowwarmth/GamePush-Plugin | `43a9c547ef6cfb687ef6bf9eb8a188beb28473f8` | `LICENSE`：MIT，Copyright (c) 2025 RainBow | 改编/分发实质代码要保留MIT与版权。 |
| F | https://github.com/AFanSKyQs/FanSky_Qs | `86d002866114fa1dd1c765325fde621925938adc` | `LICENSE`：Apache License 2.0 | 如实际分发改编代码，要附许可证、保留版权等相关通知、标示改动；不能仅写感谢就替代许可义务。 |

本地快照位于本报告旁边各仓库目录。GitHub 固定版本链接可用 `https://github.com/<owner>/<repo>/blob/<commit>/<path>`；X 的固定版本可用 `https://gitee.com/longhengmu/xhh-TL/blob/1b5e5644c9351fcfd950acabf2c791060a7c44b6/<path>`。下列代码路径均相对对应快照根目录。Gitee 网页在浏览器抓取工具中不可访问，但 git clone 成功，所以 X 不是未核实来源。

## 2. xhh-TL 的原神功能映射

主入口 `index.js` 导出明确类；`config/default_config.yaml` 和 `utils/modules.js` 控制模块。没有 miao-plugin 时，8 个依赖角色模型的功能会变成空规则占位类，日志明确提示禁用。

| ID | 功能与代表命令 | 真实实现路径 | 数据/依赖 | 备注 |
| --- | --- | --- | --- | --- |
| X01 | 原神实时体力 `#原神体力` / `#体力` / `#ystl`，支持 @他人 | `apps/TL.js` | 官方 widget/dailyNote；既有绑定库的 CK / stoken | 需本人有效凭证；不能把单纯UID绑定当成已完成便笺授权。 |
| X02 | 多账号合并/独立出图；超过张数合并转发 | `apps/TL.js`，`utils/renderImage.js` | 与 X01 同源 | classic/portrait/widget 三种卡片样式。 |
| X03 | 卡片UID显示开关、单UID屏蔽/恢复、屏蔽列表、原神总览显示开关 | `apps/TL.js` | Redis偏好与本地绑定 | 与解绑不同，不会删除凭证。 |
| X04 | 小组件限时活动进度/倒计时 | `apps/TL.js` | 官方 `act_calendar` | `tl_widget_activity_limit` 控制条数。 |
| X05 | 原神参量质变仪状态 | `apps/TL.js` | 官方 cookie 版 `dailyNote` | 纯stoken请求拿不到该行时隐藏。 |
| X06 | 群内原神主号/全号体力阈值推送、关闭/列表 | `apps/resinPush.js` | 与X01同源，定时检查 | 达标只提醒一次，回落后重新武装；主号与全号互斥。 |
| X07 | 参量质变仪、洞天宝钱到期提醒 | `utils/resinTimer.js`，`apps/resinPush.js` | 已取得的便笺快照 | 到期时间落盘，重启恢复；至少查过一次且开体力推送。 |
| X08 | 手动原神签到、多账号签到、每日自动签到订阅/关闭/列表 | `apps/autoSign.js`，`utils/signClient.js` | 官方 event/luna/info、sign；cookie_token | 原神 act_id=`e202311201442471`。不是仅UID即可签到。 |
| X09 | 米游币手动任务、余额、自动任务订阅/列表 | `apps/autoBbsCoin.js`，`utils/bbsCoinClient.js` | 官方社区 API；stoken | 原神版块 gids=2/forumId=26；该模块也会操作星铁/绝区零版块，原神专用版应限制范围。 |
| X10 | `#全部深渊` 深境螺旋+危战+剧诗合图 | `apps/gsAllAbyss.js` | 官方 `spiralAbyss`、`hard_challenge`、`role_combat`，miao角色模型 | 真实个人战绩需完整CK。 |
| X11 | `#小剧诗`、上期小剧诗，关键关汇总 | `apps/miniRoleCombat.js` | 官方 `role_combat` | 可选浅色/深色主题。 |
| X12 | `#幻想角色`、下期/指定月份可用角色与限制元素 | `apps/role_combat.js`，`utils/alioth.js` | Alioth theater；miao角色资料；有CK时本人角色池 | 按持有、元素、特邀、等级>=70筛选，开幕试用角色补80级；无CK可显示通用表。 |
| X13 | `#深渊配队` / 组队 | `apps/abyssTeam.js`，`utils/yshelperApi.js` | 提瓦特小助手 getAbyssRank；miao练度模型 | 无CK可查榜，有CK按本人练度排序并灰显未持有。 |
| X14 | `#危战配队` / 组队 | `apps/hardTeam.js`，`utils/yshelperApi.js` | 提瓦特小助手 getAbyssRank2 | 上/中/下三半区数据。 |
| X15 | `#持有率` | `apps/holdRate.js`，`utils/yshelperApi.js` | getAbyssRank 的 has_list | 属于统计样本持有率，不能称所有原神玩家真实持有率。 |
| X16 | `#队伍伤害` 及帮助；角色/武器/命座/精炼/套装/天赋替换、可选手法 | `apps/teamDamage.js`，`utils/teyvatDamage.js` | 本地miao面板缓存 -> lelaer getTeamResult POST | 每个角色要先更新面板；替换沿用原圣遗物词条，为估算；接口只录入部分套路，存在不可计算队伍。 |
| X17 | `#版本深渊` / 剧诗 / 危战，列表/上期/下期/第N期/月份 | `apps/nanokaAbyss.js`，`utils/alioth.js` | Alioth abyss/theater/stygian | 公共挑战配置，无需账号；不能与个人战绩混称。 |
| X18 | 清理临时文件/缓存，定时清理 | `apps/tmpCleaner.js` | 文件系统 | 需要确认只处理当前插件及明确宿主渲染缓存；不应无审计复制其清理范围。 |
| X19 | 小火花帮助、插件更新、模块开关、Guoba配置 | `apps/help.js`、`apps/TL.js`、`guoba.support.js` | 本地配置/更新源 | 修改定时相关开关后需重载/重启。 |
| X20 | CK失效时用stoken刷新、删除CK残留记录兼容 | `utils/ckAutoRefresh.js`、`apps/delCkHook.js` | 官方账号API；既有本机凭证 | ckAutoRefresh在入口顶层导入后补丁到genshin MysInfo.checkCode，属于跨插件行为，要纳入安装评估。 |
| X21 | 手工验证码处理、服务状态/部署、自动验证码重试 | `apps/captchaNotice.js`、`apps/solverDeploy.js`、`utils/mysVerify.js` | 验证码/本机solver服务 | 与普通游戏数据查询分开。solver分支包含AGPL依赖，不能误以为整个配套服务都MIT，也不能在未经验证的生产安装里默认执行自动安装服务。 |

X 非原神功能（不计原神专用插件缺失）：星铁/绝区零/鸣潮体力及推送；星铁四挑战战绩汇总；星铁stoken免链接抽卡记录/导入/完整链接逐抽；星铁版本挑战配置；鸣潮gsuid_core数据库借用。源码 `apps/srGachaLog.js` 明确把原神抽卡链接交回 genshin，不能声称 X 本身提供原神抽卡拉取。

## 3. miao-plugin 的原神功能映射

以 `apps/profile.js`、`apps/stat.js`、`apps/gacha.js`、`apps/wiki.js`、`apps/character.js`、`apps/alias.js` 注册为准。`config/help_default.js` / `config/system/help_system.js` 会把云崽 genshin 本体功能写进帮助，不能据帮助页把它们算成 miao 的直接实现。

| ID | 真实功能 | 命令例子 | 实现路径 | 数据/依赖 |
| --- | --- | --- | --- | --- |
| M01 | 已获取面板角色列表 | `#面板` / `#面板列表` | `apps/profile/ProfileList.js` | 本地Player面板缓存。 |
| M02 | UID展示柜面板更新/全角色更新 | `#更新面板` / `#更新全部面板` | `apps/profile/ProfileList.js`，`models/serv/*` | Enka等面板服务；国服服务可重定向。 |
| M03 | 米游社面板更新 | `#米游社更新面板` | `apps/profile/ProfileList.js` | 官方账号数据，需宿主MysApi/有效CK。 |
| M04 | 详细角色面板/武器信息 | `#雷神面板` / `#雷神武器` | `apps/profile/ProfileDetail.js`、`ProfileWeapon.js` | 本地面板+角色/武器元数据。 |
| M05 | 角色伤害分项、伤害加成明细 | `#雷神伤害` / 伤害序号 | `apps/profile/ProfileDetail.js`，`models/dmg/*` | 本地伤害计算，不能假设外部API代算。 |
| M06 | 圣遗物评分与词条详情 | `#雷神圣遗物` | `apps/profile/ProfileDetail.js`、`models/Artifact*` | 喵喵自己的评分模型。 |
| M07 | 圣遗物列表及筛选 | `#圣遗物列表` | `apps/profile/ProfileArtis.js` | 本地已有面板。 |
| M08 | 面板假设换装计算 | `#雷神换六命换精5薙草之稻光` | `apps/profile/ProfileChange.js` | 角色/武器/圣遗物/天赋/等级替换；词条仍需真实面板来源。 |
| M09 | 群内最强/排名榜、重置/刷新/开关 | `#雷神排名` / `#群最强雷神` | `apps/profile/ProfileRank.js` | 本地群用户面板与评分。 |
| M10 | 练度、角色/武器/五星列表统计 | `#练度统计` / `#五星列表` | `apps/profile/ProfileStat.js` | 米游社角色+本地面板。 |
| M11 | 天赋统计、强制刷新天赋 | `#天赋列表` / `#刷新所有天赋` | `apps/profile/ProfileStat.js` | 官方养成数据。 |
| M12 | 指定月份幻想剧诗角色/练度统计 | `#202607幻想角色列表` | `apps/profile/ProfileStat.js` | Nanoka / Hakush.in / HomDGCat / Bilibili Wiki等候选源。 |
| M13 | 敌人等级设置 | `#敌人等级100` | `apps/profile/ProfileUtils.js` | 修改本地伤害计算目标。 |
| M14 | 上传/列表/删除面板立绘、普通角色写真 | `#上传雷神面板图` / `#雷神面板图列表` | `apps/character/ImgUpload.js` | 本地图源/用户上传图片。 |
| M15 | 删除全部面板、缓存重新加载 | `#删除面板` / `#重载面板` | `apps/profile/ProfileList.js` | 本地缓存。 |
| M16 | 面板使用帮助 | `#面板帮助` | `apps/profile/ProfileCommon.js` | 本地帮助模板。 |
| M17 | 角色持有率及命座分布 | `#角色持有率` / `#角色0命` | `apps/stat/AbyssStat.js`、`HutaoApi.js` | lelaer角色均值+yshelper has_list。 |
| M18 | 深渊/危战角色出场率与使用率 | `#深渊使用率` / `#幽境出场率` | `apps/stat/AbyssStat.js`、`HutaoApi.js` | yshelper深渊、lelaer危战。 |
| M19 | 深渊配队 | `#深渊配队` | `apps/stat/AbyssTeam.js` | yshelper统计+本人角色池。与X13重名。 |
| M20 | 个人深渊汇总；保留“上传深渊”命令别名 | `#深渊` / `#上传深渊数据` | `apps/stat/AbyssSummary.js`、`HutaoApi.js` | 当前快照AbyssSummary只查询/渲染，未调用uploadData。HutaoApi仍有上传方法，但全仓未找到调用；不能把命令名当成真正完成上传。 |
| M21 | 个人幻想真境剧诗，本期/上期 | `#幻想` / `#上期幻想` | `apps/stat/RoleCombatSummary.js` | 官方 role_combat。 |
| M22 | 月谕圣牌收藏、群内换牌匹配 | `#月谕圣牌` / `#月谕圣牌交换` | `apps/stat/RoleCard.js` | 官方剧诗记录+本地群用户收藏。 |
| M23 | 个人幽境危战，单人/多人/合作/最佳 | `#幽境` / `#上期危战` | `apps/stat/HardChallengeSummary.js` | 官方 hard_challenge。 |
| M24 | 角色卡片、照片、原图 | `#刻晴` / `#甘雨照片` / 回复图片`#原图` | `apps/character/AvatarCard.js`、`apps/profile/ProfileUtils.js` | 元数据/本地图源/米游社角色。 |
| M25 | 老婆/老公/其他关系卡片、设置/添加/查询/随机名单 | `#老婆` / `#老婆设置心海,雷神` | `apps/character/AvatarWife.js` | 本机用户偏好+角色信息。 |
| M26 | 戳一戳角色展示 | 戳机器人 | `apps/poke.js` | avatarPoke开关控制。 |
| M27 | 角色/武器图鉴、天赋、命座、材料说明 | `#心海图鉴` / `#夜兰天赋` | `apps/wiki/CharWiki.js`、`CharTalent.js`、`CharMaterial.js` | 本地角色/武器元数据；部分图鉴由宿主插件接管。 |
| M28 | 今日/明日/每周天赋与材料表 | `#今日素材` / `#周三素材` | `apps/wiki/TodayMaterial.js` | 本地材料与本人角色池。 |
| M29 | 原神活动日历/列表 | `#日历` / `#日历列表` | `apps/wiki/Calendar.js` | 官方公告 getAnnList/getAnnContent + miao.games日历补充。 |
| M30 | 本地原神抽卡记录详情与统计，多卡池/版本分类 | `#抽卡记录` / `#角色统计` | `apps/gacha/Gacha.js`、`GachaData.js` | 使用已有本地抽卡记录；并非该文件自己从authkey拉取。 |
| M31 | 卡池信息、指定版本/上下半、角色武器历史卡池查询 | `#6.0卡池` / `#雷神卡池` | `apps/gacha/Gacha.js`、`GachaPool.js` | 本地卡池配置。 |
| M32 | 原神自定义角色别名/删除/列表 | `#喵喵别名原神设置` | `apps/alias.js` | 本地别名。 |
| M33 | 帮助/主题、版本/日志/设置、插件与增量图片更新 | `#喵喵帮助` / `#喵喵设置` | `apps/help*`、`apps/admin.js` | 更新命令会运行git；新增图库会下载miao-res-plus。 |

M 帮助页中的 `#绑定UID`、CK绑定/删除、体力、签到、原石札记、模拟十连/定轨、表情添加，以及部分攻略，是宿主 genshin 或其他插件功能；要覆盖它们必须核实宿主实现，不能仅安装 M 后报告全部完成。星铁面板/遗器/日历/抽卡不计原神专用范围。

## 4. MATOOL-Plugin 的原神功能映射

所有记录远程存取均通过墨安助手API。README称 `record.muoan.com`；实际默认 `data/API/MOANAPI.yaml` 是 `http://111.170.175.22:5213/api`。宣传域名与默认请求地址的差异应在配置里说明，不能未经确认把账户Key/authkey通过明文HTTP发送到该默认地址。

| ID | 功能 | 实现路径 | API/凭证 | 行为要点 |
| --- | --- | --- | --- | --- |
| A01 | 无Key抽卡分析图 | `apps/gacha.js` | GET `/analysis?uid=&game=gs` | 以UID查墨安已有云记录，不能凭此取得游戏内全部历史。 |
| A02 | 文字抽卡记录 | `apps/gacha.js` | GET `/query?uid=&game=gs` | 同源已有云记录。 |
| A03 | 每QQ个人Key绑定、获取Key说明 | `apps/set.js`、`components/Cfg.js` | 本机Key配置 | Key只应私聊接收并脱敏，不同步GitHub。 |
| A04 | 主人公用Key设置、个人/公用模式切换 | `apps/set.js` | 本机公用Key | 个人Key优先，不能误把所有用户数据上传到主人账户。 |
| A05 | UIGF文件导出 v4.2 / v2.2 | `apps/records.js`、`apps/api.js` | POST `/gacha/export-json`，X-API-Key | 需Key。 |
| A06 | UIGF文件导入 | `apps/records.js`、`apps/api.js` | POST `/gacha/import-json`，X-API-Key | 与游戏内authkey拉取不同。 |
| A07 | 云端拉取写本地genshin/miao目录 | `apps/records.js` | GET `/fetch` / POST `/gacha/export-json`；验证URL归属 | 个人Key优先。 |
| A08 | 单UID本地记录上传云端 | `apps/upload.js` | POST `/gacha/import-json` | 正则实际命令为 `#<UID>记录上传云端`，与README `#上传<UID>云端` 不完全相同。 |
| A09 | 主人全部本地记录上传 | `apps/upload.js` | POST `/gacha/import-json` | 包含原神+星铁，原神专用版要限制原神。 |
| A10 | 抽卡链接自动解析/导入 | `apps/import.js`、`apps/api.js` | POST `/gacha/import-link`，X-API-Key | 将完整authkey链接提交第三方服务；需用户明确选择云服务。 |
| A11 | 链接有效性/UID归属验证 | `apps/api.js` | POST `/gacha/verify-link` | 不导入记录，但同样提交authkey URL。 |
| A12 | 主人启用/禁用链接解析 | `apps/set.js` | 本地开关 | 防止抢占其他插件链接。 |
| A13 | 帮助/版本/更新/强制更新 | `apps/help.js`、`apps/update.js` | 本地/git | 可原创实现这些管理概念。 |

A 非原神功能：星铁/绝区零的相同记录功能；全部上传还遍历星铁。因无明确许可，不建议原样分发该仓库代码。

## 5. GamePush-Plugin 的原神功能映射

| ID | 功能 | 实现路径 | 数据/依赖 | 行为要点 |
| --- | --- | --- | --- | --- |
| P01 | 正式版/预下载版本查询 | `model/commands.js`、`model/games.js` | 官方HoYoPlay getGameBranches | 原神可省游戏前缀。 |
| P02 | 主人手动版本监控 | `model/commands.js`、`model/api.js` | 同P01 | 比对Redis状态。 |
| P03 | 主人当前群开启/关闭版本推送 | `model/commands.js` | botId/groupId本地配置 | 只有群聊能配置。 |
| P04 | 定时监测、首次/变化去重，预下载通知 | `model/tasks.js`、`model/api.js`、`model/notice.js` | HoYoPlay，Redis | 默认3:00–23:55每5分钟；时区取宿主，需要固定Asia/Shanghai。 |
| P05 | 正式/预下载全包和增量包体积 | `model/games.js` | 官方sophon getBuild / POST getPatchBuild | 计算时排除en/ja/ko语音包。 |
| P06 | 历史版本包体列表、指定版本详情 | `model/commands.js`、`lib/runtime/sqlite-db.js` | 本地node:sqlite历史数据库 | 同时可拉远端数据库。 |
| P07 | Redis主/预下载状态删除与设置 | `model/commands.js` | Redis | 主人操作。 |
| P08 | 远端历史数据库稳定版/测试版更新合并 | `lib/runtime/sqlite-db.js`、`apps/set.js` | cnb.cool/rainbowwarmth/resources | 初次启动也拉远端DB；如不希望自动网络可替换为明确更新指令。 |
| P09 | 图片/文字推送、默认/简约模板、快捷按钮 | `model/notice.js`、`lib/runtime/buttons.js` | 宿主渲染器 | 推送配置含消息类型、模板、日志开关、cron。 |
| P10 | Guoba/Karin-Web/Yunzai-NG配置、六框架运行时 | `lib/runtime/*` | Miao/TRSS/MangoCat/JiuLi/Karin/NG | 不包括NoneBot。 |

**原神正式版/预下载直链命令并未注册**：`model/commands.js` 的 `DOWNLOAD_GAMES` 只有 sr/zzz/ww/zmd，README也写原神与崩坏3不支持。虽然内部可取packages描述符，不能把其他游戏的直链命令列为原神已有功能。其他5款游戏监控不计原神专用范围。

## 6. FanSky_Qs 的原神功能映射

| ID | 功能 | 实现路径 | 数据/依赖 | 真实完成状态 |
| --- | --- | --- | --- | --- |
| F01 | 队伍伤害与详细过程/全图，UID或@绑定角色 | `apps/Teyvat/BotEntry.js`、`getTeam.js` | 本地miao角色面板 -> lelaer getTeamResult | 已有实现；API套路覆盖限制依然存在。 |
| F02 | 单人评级命令入口 | `apps/Teyvat/BotEntry.js`、`getTeam.js`、`GetData/getTeyvatData.js` | 当前入口走getTeamResult；旧函数留有getDamageResult | BotEntry把单人评级路由到RequestSelect('Local')再调用team()，并未证明当前入口会调用单人专用getDamageResult；必须单独验收其评级行为。 |
| F03 | 小助手规则配置更新 | `apps/Teyvat/LoadOther/LoadOther.js` | monsterx CDN char-data/hash-trans/calc-rule/relic-append | 源码CDN与nonebot-plugin-gspanel来源需要致谢。 |
| F04 | 非小酋成就排名/统计 | `apps/Teyvat/ChestAndAcheTop/AchieveTop.js` | feixiaoqiu search_achievement_ajax；官方/Enka补充 | 第三方样本排行榜，不等于全服数据库。 |
| F05 | 非小酋宝箱排名/统计 | `apps/Teyvat/ChestAndAcheTop/ChestTop.js` | feixiaoqiu search_box_ajax；官方/Enka补充 | 同F04。 |
| F06 | 群内成就排行榜 | `apps/Teyvat/ChestAndAcheTop/AchieveGroupTop.js` | 本地已采样用户文件 | 前15名，非实时遍历所有群成员账号。 |
| F07 | 群内宝箱排行榜 | `apps/Teyvat/ChestAndAcheTop/ChestGroupTop.js` | 本地已采样用户文件 | 同F06。 |
| F08 | 历史队伍伤害查询 | `apps/Teyvat/BotEntry.js:68` | 本地历史记录 | **仅回复“正在开发中”**；不能列为完整已有功能。 |
| F09 | 队伍面板/缓存命令 | `apps/Teyvat/BotEntry.js:45` | 本地缓存 | **命令注册已注释**；旧README示例不能当现成功能。 |
| F10 | 派蒙星光考察/猜角色 | README旧示例 | 未发现当前apps注册实现 | **README写暂缓；当前快照不可验证**。 |

F 的非原神功能（明确单独列出，原神专用新插件不应自动接管现有通用机器人）：OpenAI聊天/人设/模型/代理/群AI/额度；打卡冒泡、魔晶加减/首次打卡/统计、emoji猜成语与卡牌开发；猫眼票房；QQ点赞；发病文学；丁真/鸡哥/龙图/弔图/文字抽象/化学/拼音；群清屏/批量撤回/黑白名单；每日清理；插件帮助/设置/更新。证据在 `apps/Help/ReturnHelpData.js` 与对应 `apps/OpenAI*`、`apps/MagicCrystal*`、`apps/SmallFunctions*`、`apps/GroupManager*`。这些是通用聊天/群管理功能，不能因仓库有“原神”标题就全部归到原神功能。

## 7. API真实来源与致谢清单

| 提供者 | 实际端点/用途 | 代码证据 | 需在致谢说明 |
| --- | --- | --- | --- |
| 米哈游 / 米游社 / HoYoLAB | 国服 `api-takumi-record.mihoyo.com/game_record/app/genshin/api/{index,spiralAbyss,role_combat,hard_challenge,hard_challenge/popularity,character/list,character/detail,dailyNote,act_calendar}` | X `utils/mysClient.js:146-191`；M `models/MysApi.js` | 游戏账户与战绩/便笺/角色资料数据接口，应用同源接口而非官方公开开发者SDK。 |
| 米哈游 | `api-takumi-record.mihoyo.com/game_record/genshin/aapi/widget/v2`；`api-takumi.miyoushe.com/binding/api/getUserGameRolesByStoken` | X `apps/TL.js:242,445` | stoken体力与角色绑定源。 |
| 米哈游 | `api-takumi.mihoyo.com/event/luna/{info,sign}`、public-data device-fp；`bbs-api.mihoyo.com`任务/论坛接口；passport-api stoken换CK | X `utils/signClient.js`、`bbsCoinClient.js`、`auth.js` | 游戏签到/社区任务/设备指纹；凭证留在本机。 |
| 米哈游 / HoYoPlay | `hyp-api.mihoyo.com/hyp/hyp-connect/api/{getGameBranches,getGamePackages,getGames}`；`api-takumi.mihoyo.com/downloader/sophon_chunk/api/{getBuild,getPatchBuild}` | P `model/games.js:37-45` | 版本/包体/预下载元数据。原神id=`1Z8W5NHUQb`，biz=`hk4e_cn`。 |
| 米哈游 | `hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/{getAnnList,getAnnContent}` | M `apps/wiki/Calendar.js` | 活动公告/日历。 |
| Enka.Network / algoinde | `https://enka.network/api/uid/<UID>` | M `config/system/profile_system.js`、README授权issue63 | 原神展示柜面板；国服服务可能重定向MiniGG。 |
| MiniGG / MiniGrayGay | `http://profile.microgg.cn/api/uid/<UID>`，README可选择 | M `config/system/profile_system.js`、`profile_default.js` | 国服/B服面板服务；HTTP默认地址需要审慎配置。 |
| Snap.Hutao / DGP Studio | `http://enka-api.hut.ao/<UID>`；miao代理 `/api/hutao?api=/Statistics/Overview`、`/Record/UploadData` | M `config/system/profile_system.js`、`apps/stat/HutaoApi.js` | 可选面板/胡桃统计来源；未验证当前可用性。 |
| miao.games / 喵喵服务 | `/profile/data`、`/api/calendar`、`/api/info`、`/api/hutao` | M配置、Calendar/HutaoApi/admin | 可选面板私有Token/日历/胡桃代理；默认HTTP不能当安全账户服务。 |
| 提瓦特小助手 / yshelper、lelaer | `https://api.yshelper.com/ys/{getAbyssRank.php,getAbyssRank2.php}`；`https://api.lelaer.com/ys/{getRoleAvg.php,getAbyssRank2.php,getTeamResult.php,getDamageResult.php}` | X `yshelperApi.js`、`teyvatDamage.js`；M HutaoApi；F GetData | 深渊/危战样本统计、配队、持有率、队伍/单人伤害。 |
| Alioth.wiki | `https://json.alioth.wiki/data/gi/ch/{abyss,theater,stygian}.json`，`.../<id>.json`；`https://img.alioth.wiki/gi/...` | X `utils/alioth.js` | 公开挑战版本/月份资料和图片。 |
| Nanoka / Hakush.in / HomDGCat / Bilibili Wiki | static.nanoka.cc manifest/gi/rolecombat，api.hakush.in/gi/data/rolecombat，homdgcat.wiki/gi/CH/maze.js，wiki.biligame.com/ys/幻想真境剧诗 | M `apps/profile/ProfileStat.js` | 剧诗角色/版本辅助来源；只有实现实际调用者才写“使用”，其余写参考。 |
| Project Amber / Yatta | gi.yatta.moe | X README、图源兜底代码 | 游戏图片兜底源；素材版权单独注意。 |
| 非小酋 / feixiaoqiu.com | `/search_achievement_ajax/`、`/search_box_ajax/` | F ChestAndAcheTop | 第三方成就/宝箱样本榜。 |
| monsterxcn / nonebot-plugin-gspanel | `https://cdn.monsterx.cn/bot/gspanel/{char-data,hash-trans,calc-rule,relic-append}.json` | F LoadOther/LoadOther.js | 小助手数据转换/计算规则参考。 |
| 墨安游戏助手 / Muoan | README https://record.muoan.com；实际默认 http://111.170.175.22:5213/api；analysis/query/fetch/gacha/* | A `data/API/MOANAPI.yaml`、`apps/api.js` | 抽卡分析/云记录服务及协议参考；不应默认外传凭证。 |
| rainbowwarmth resources | `https://cnb.cool/rainbowwarmth/resources/-/git/raw/main/GamePush-Plugin/GamePush-Plugin-{version.json,db}` | P sqlite-db | 历史版本数据库。 |

只把真正调用的API写为“数据/API提供者”；只审计而没调用的源写为“参考实现/功能设计”，避免致谢暗示授权或实际集成。

## 8. 无凭证公开接口探测证据

2026-10-07 从当前Windows网络读取，未发送Cookie/Token/Key。执行只读HTTP请求，最长20秒；不以这些检查替代真实QQ命令、账户登录与图片渲染验收。

| 端点 | 当次结果 | 说明 |
| --- | --- | --- |
| HoYoPlay getGameBranches 原神国服 | HTTP200，JSON retcode=0，906字符 | 版本源可用。 |
| yshelper getAbyssRank | HTTP200，183242字符，has_list/result等字段 | 深渊配队/持有率源可解析。 |
| yshelper getAbyssRank2 | HTTP200，169892字符，has_list/result等字段 | 危战源可解析。 |
| lelaer getRoleAvg | HTTP200，266339字符，result/last_update等字段 | 角色均值源可解析。 |
| Alioth gi/ch/abyss.json | HTTP200，Phases/HP/Index/Latest | 深渊公开索引可解析。 |
| Alioth gi/ch/theater.json | HTTP200，Phases/Index/HP/Latest | 剧诗公开索引可解析。 |
| feixiaoqiu achievement 简化查询 | HTTP200，但PowerShell解析只见Length，不满足源实现预期 | 不能报告成就榜可用；需完整参数和真实响应核验。 |

## 9. 集成验收必须区分的状态

1. “源码有实现”不等于“新插件已实现”，也不等于“生产bot能用”。
2. 需要CK/stoken/Key的功能只有用户交互授权/绑定完成后才可验收；不能用占位配置称“所有参数已配置”。
3. 比较参照应覆盖 X01–X21、M01–M33、A01–A13、P01–P10、F01–F07 的原神实作；F08–F10是上游未完成/不可验证，不得伪造。
4. 重名命令：miao/xhh都注册深渊配队，xhh/FanSky都注册队伍伤害；新插件要显式路由/统一前缀或关掉重复上游注册，不能盲装五仓库就声称全部能用。
5. 原神专用版默认不启用其他游戏、通用群管/娱乐/AI聊天；账户、凭证、群/QQ、日志和生产配置不入GitHub，公开来源URL与版权通知应保留。
