# 墨安云祈愿协议客户端

`lib/cloud.mjs` 为原创原神客户端，参考 [Muoan/MATOOL-Plugin 的公开 API 定义](https://github.com/Muoan/MATOOL-Plugin/blob/fc3275598f382f93703de42600b904f8ad605066/apps/api.js) 中的请求结构编写，没有复制其代码或模板。服务提供方为 [墨安游戏助手](https://record.muoan.com/)，协议参考及 API 提供方均在此致谢。本模块只支持 `game=gs`、`game_biz=hk4e_cn` 和受支持的原神国服 UID。

## 配置与当前实测状态

调用者必须明确传入已核验的 HTTPS API 基址，例如服务方确认可用的 `https://record.muoan.com/api`。模块没有默认服务地址；缺失地址、HTTP、localhost、私网/保留 IP、带账户密码或查询参数的基址均拒绝。MATOOL 当前审计快照的配置文件含明文 HTTP 地址，本模块不会回退到该地址发送 Key 或 authkey。

2026-10-07 从当前 Windows 网络无凭据只读检查 `https://record.muoan.com/` 与 `/api/`，均遇到连接异常；网页读取工具同样未能读取根页面。这个结果不证明服务在所有网络都不可用，也不能证明上述 HTTPS 基址已完成真实业务验收。**目前只有协议实现与离线测试通过，没有使用真实 Key、authkey、用户记录完成云操作验收。** 部署时先从 Bot 所在网络核实服务和运营方提供的配置。

```js
import { CloudClient } from './lib/cloud.mjs';

// 从实例私有配置和当前用户的加密凭据中取值，不写入源码。
const cloud = new CloudClient({
  baseUrl: instance.cloudBaseUrl,
  key: currentUser.cloudKey,
  timeoutMs: 20000
});
const result = await cloud.query(currentAccount.uid);
```

构造参数为 `{baseUrl, key, fetch, timeoutMs}`。`key` 可省略，用于无需 Key 的公开分析/查询；导出、上传、验证链接和链接导入必须有本人 Key。超时范围为 1000–120000 毫秒；超时、未配置、连接失败时明确失败，不返回假成功。Key 仅存在于客户端私有字段及需要授权请求的 `X-API-Key` 请求头，不进入 URL、返回结果、公开对象或本地文件。

## 方法与真实请求结构

| 方法 | 请求 | 返回/边界 |
| --- | --- | --- |
| `analysis(uid)` | GET `/analysis?uid=...&game=gs` | 已有云记录的分析 JSON；不发送 Key，不等同于参考插件的 `/analysis/render` 图片接口 |
| `query(uid)` | GET `/query?uid=...&game=gs` | 已有云祈愿 JSON；不发送 Key，不等同于带 Key 的 `/fetch` |
| `export(uid, {format:'v42'})` | POST `/gacha/export-json`，`{uid,game_biz:'hk4e_cn',format}` | 支持 `v42`、`v22`；结果 `data` 为云端返回文件内容，使用本地 UIGF 模块再验证/导入 |
| `upload(uid, records)` | POST `/gacha/import-json`，`{uid,game_biz:'hk4e_cn',records}` | 检查 UID、原神卡池、时间、精确字符串记录 ID；去掉额外私有字段后上传 |
| `verifyLink(link, expectedUid)` | POST `/gacha/verify-link`，`{link}` | `expectedUid` 必填；上游必须明确返回同一国服 UID 与 `game_biz:'hk4e_cn'` |
| `importLink(link, expectedUid)` | 先调用 verify-link，通过后 POST `/gacha/import-link`，`{link}` | 每次导入前重新验证；无法证明 UID/gamebiz 时不发送导入请求；导入结果也必须匹配 |

基址如含 `/api`，以上路径追加到该基址下。方法不支持调用者提供其他游戏、任意端点或重定向 URL。上传需要 1–100000 条记录、总量最多 5 MiB；响应最多 8 MiB。记录不会替用户取得权限，调用者仍需检查本地记录属于当前 QQ 与当前已绑定 UID。

普通返回形状为：

```js
{ uid, game: 'gs', game_biz: 'hk4e_cn', data, sourceUrl }
```

`upload`、`importLink` 另有 `imported`；`importLink` 另有 `verified:true`。`verifyLink` 仅返回已证明的 UID/gamebiz：

```js
{ uid, game: 'gs', game_biz: 'hk4e_cn', verified: true,
  data: { uid, game_biz: 'hk4e_cn' }, sourceUrl }
```

`sourceUrl` 不含查询串或凭据。递归过滤凭据、联系方式及账号元数据，拒绝其他 UID/游戏资料；空的其他游戏 UIGF 分区会去除，非空则拒绝。上游错误正文和错误消息不回显，仅保留安全代码/固定提示。`CloudError` 的 `code` 可供命令层映射提示，HTTP 或业务数值可出现在 `status` / `upstreamCode`，没有完整链接、Key、authkey 或原始错误对象。

## 链接白名单与导入顺序

仅允许 HTTPS、默认端口、无 URL 账户密码的以下官方国服地址：

- [原神历史记录 API](https://public-operation-hk4e.mihoyo.com/gacha_info/api/getGachaLog)：路径 `/gacha_info/api/getGachaLog`。
- [官方祈愿页面](https://webstatic.mihoyo.com/hk4e/event/e20190909gacha/index.html)：对应固定路径。
- [官方新版祈愿页面](https://webstatic.mihoyo.com/hk4e/event/e20190909gacha-v3/index.html)：对应固定路径。

链接必须含唯一、非空的 `authkey`。域名后缀匹配、短链、其他路径、国际服、星铁/绝区零链接均不接受。若包含 `game_biz` 必须为 `hk4e_cn`；若包含 `region` 必须为 `cn_gf01` 或 `cn_qd01`。参数采用明确白名单，重复或未知参数拒绝；官方以后新增结构需核验后更新，不能放宽为任意含 authkey 的 URL。允许官方页面常见 `#/`、`#/log` 锚点，提交前去除。

调用顺序：先由命令层确定当前本人已绑定的原神 UID，再把完整链接与该 UID 传入 `verifyLink` / `importLink`。链接中的 UID（若存在）、当前账户 UID、上游验证返回 UID 必须一致。只验证“是某个原神 UID”不够；接口未返回 UID 或 gamebiz 时拒绝继续。`importLink` 在发送任何 import POST 之前完成核对，不能复用无归属的缓存验证结果。

云服务将在验证和链接导入时收到完整 authkey 链接；这是用户主动选择的第三方服务操作。命令层必须先取得本人私聊同意，确认用户理解这个数据去向。客户端不替命令层建立 QQ 所有权、收集同意或存储凭据，不自动处理聊天中的 URL，也不上传所有用户记录。

导入是云端写入：若上游先写入后返回错误 UID/gamebiz，本模块拒绝宣称成功，但无法回滚第三方服务器已经执行的动作。优先使用可靠、已核验的服务；调用者不能将异常响应当作成功记账。

## 传输与 Bot 接入

默认生产传输在请求前核查全部 DNS 地址，拒绝本机、私网、链路本地与保留地址，并固定本次核验的公网地址连接，同时保留原域名进行 TLS 证书校验。禁止跟随重定向。Key 只在私有 POST 的请求头中发送；两个公开 GET 不发送 Key。

`fetch` 可用于测试或自定义传输，仍会进行地址检查并收到 `redirect:'error'`；自定义真实传输必须维持证书和地址固定等约束。额外 `resolveHost` 注入点供离线测试使用；生产应使用默认 DNS 和传输。该模块不修改 Bot 配置、文件或会话。

Bot 接入需要独立完成：逐 QQ 加密保存本人 Key、私聊确认第三方数据去向、校验当前绑定 UID/本地记录所有权、检查实例云上传开关、私聊发送个人文件、清理导出及脱敏同步。没有通过这些步骤的实例不能宣称“云端已配置完成”。

离线测试运行 `node --test tests/cloud.test.mjs`，覆盖 HTTPS/私网/DNS/重定向边界、六种请求载荷、Key 隔离、错误隐藏、链接白名单、UID/gamebiz 预检查及导入结果核对。测试不访问网络或使用真实凭据；HTTPS 服务连接、个人 Key、真实导出与导入仍待本人授权验收。
