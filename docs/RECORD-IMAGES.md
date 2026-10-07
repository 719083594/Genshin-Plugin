# 本人游戏记录图片

原神查询默认使用独立原生图片：深渊、剧诗、危战采用靛蓝与金色挑战卡片，便笺、资料、角色、活动、札记、七圣召唤、养成材料与米游币采用米白与金色资料卡片。排版借鉴米游社的分区、指标、队伍与空记录层次，SVG 排版与装饰由本项目原创，不截取用户截图当作模板。

`lib/record-cards.mjs` 将官方响应通过 `buildRecordModel(kind,data,metadata)` 转为固定字段的展示模型。未知字段、Cookie、授权对象与原始 JSON 不进入视图。头像候选 URL 仅保留官方图片域名的 HTTPS 地址，去除查询参数；外层公开素材解析器取得图片后，视图只接受 PNG/JPEG 内存数据。下载失败或没有头像时使用原生绘制的角色占位图，保留角色名与等级。

`buildRecordCards({model},{assets})` 返回 `{svg,width,height,private:true,title}` 数组；`assets.avatars` 以角色 ID 为键。模型也可直接作为第一个参数。模块不启动浏览器、不调用模型 API、不下载素材、不写本人图片。独立原生渲染器即可生成 JPEG；可选的 AI 插件增强服务由外层渲染桥选择，视图没有 AI 依赖。

覆盖的类型为 `dailyNote`、`index`、`spiralAbyss`、`role_combat`、`hard_challenge`、`character`、`detail`、`act_calendar`、`ledger`、`gcg/basicInfo`、`deckList`、`tcgCards`、`compute`、`blueprint`、`blueprintCompute`、`coinBalance`、`coinMissions`。不支持的接口不会被当作任意 JSON 截图。

深渊第一页呈现最深抵达、战斗次数、实际返回的星数和六类角色排行；后续每页至多两层，按间保留上下半队伍、角色等级、星数和挑战时间。星数、等级或时间未返回时显示「—」或对应说明，不根据层数猜测星数，不将空列表解释为满星，不补造战绩。空记录会生成专门的空态图片。

其他记录按角色、活动、收入来源或材料需求分组；长列表分页，每次最多八张图片，超过时明确提示可使用文字入口查看完整资料。`buildRecordText(model)` 输出同一展示模型的人类可读文字，无原始 JSON。原命令末尾加「文字」可使用文字入口。本人数据的私聊检查由核心在请求之前执行，图片发送层再次检查 `private:true`。

测试覆盖缺失字段、真实零值、空深渊、上下半队伍和各间保留、字段脱敏、外网图片拒绝、XML 转义、分页上限与原生渲染语法。发布预览只能使用明确标为合成的资料，不使用真实 UID、昵称、凭据或本人记录。
