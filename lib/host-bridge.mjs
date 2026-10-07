export class HostRendererBridgeError extends Error{
  constructor(){super('宿主命名 puppeteer 渲染实例未就绪，请检查宿主渲染器配置。');this.name='HostRendererBridgeError';this.code='HOST_PUPPETEER_UNAVAILABLE';}
}

/** TRSS getRenderer() may return the dispatching loader itself. Select only
 * the already-registered named instance; never initialize, construct, fall back
 * to the dispatcher, or require a warm/truthy Browser during module loading. */
export function resolveHostPuppeteer(loader){
  try{
    if(!loader||typeof loader.getRenderer!=='function')throw new HostRendererBridgeError();
    const renderer=loader.getRenderer('puppeteer');
    if(!renderer||renderer===loader||typeof renderer!=='object'||typeof renderer.browserInit!=='function'||!('browser' in renderer))throw new HostRendererBridgeError();
    return renderer;
  }catch{throw new HostRendererBridgeError();}
}
