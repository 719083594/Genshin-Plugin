# 独立渲染与可选共享服务

原神插件自带 `lib/native-card-renderer.mjs`，使用已锁定的 sharp 0.35.5 将可信本地 SVG 转为 JPEG Buffer。没有 AI-Plugin 时，图片转换仍可独立工作。安装依赖只需本插件的 `npm ci`；渲染请求不自动安装依赖。

固定「登录说明」「功能」图片也自带纯 reader 和发送模块：可选复用 AI 服务，未安装时直接校验并发送随包公开 JPEG，不启动动态渲染或浏览器。

`lib/shared-renderer.mjs` 的 `createSharedNativeCardRenderer` 首次请求时尝试同级 AI-Plugin 的纯渲染入口 `src/rendering/index.mjs`。可用时复用该服务；服务未安装、工厂不可用，或原生转换工作实际失败并结束后，使用本插件的严格原生转换器。加载失败不会永久缓存，后续请求可重新尝试已安装的共享服务。两条路径均使用本插件提供的 sharp，不需要 AI 模型、密钥、聊天配置或机器人启动流程。

```js
import {createSharedNativeCardRenderer} from './lib/shared-renderer.mjs'
const render = createSharedNativeCardRenderer()
// 显式仅使用本插件：createSharedNativeCardRenderer({preferShared: false})
const image = await render({svg, width: 1080, height: 800, private: true})
```

SVG 排版、数据取舍、缺失值提示及素材由调用插件负责。共享渲染器只转换已经排好的可信卡片，不请求 AI 美化账号数据。`private` 必须显式为布尔值；它不替代账户归属和私聊权限检查。适配器应先完成权限验证，再构建、转换与发送图片。CLI 和独立查询 API 保留文字路径，调用者可自行选择图片 API。

共享与本地转换器使用同一进程级 FIFO：最多一项原生工作和两项等待，原生工作结束后才释放。输入不合法、SVG 或图片不安全、图片超限、队列已满均直接返回稳定错误码，不切换转换器绕过限制。没有浏览器重试或远程截图路径。所有个人 SVG 和 JPEG 只在内存中处理，指标只有后端、耗时和固定错误码。

图片资产只允许经过验证的内嵌 PNG/JPEG，禁止外部 URL、HTML、CSS、脚本和任意用户 SVG。画布、节点、图片字节及解码像素限制与 AI-Plugin 的 `docs/RENDERER.md` 一致。缺少 sharp 或两条转换路径均失败时，由适配器提供同权限的文字提示。

源码中的测试使用合成公开数据验证独立转换、可选共享服务、恢复、资源限制和隐私标记。实际 JPEG 转换使用固定版本 sharp；测试可通过 `AI_RENDERER_TEST_SHARP` 指向现有后端入口。
