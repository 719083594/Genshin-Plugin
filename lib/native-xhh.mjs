import * as AccountBridge from './native-accounts.mjs';

// Audited source: xhh-TL utils/mysClient.js, default LiteMysApi export.
// Constructor only assigns uid/cookie/game/server/device; all HTTP, FP, Redis
// response caching and automatic FP requests live inside its getData method.
const installed = new WeakMap();
const READ_APIS = new Set(AccountBridge.nativeAccountSource.readApis);
const games = new Set(['gs', 'ys', 'genshin', 'hk4e_cn', 'hk4e_global']);
const denied = () => ({ retcode: -1, message: '此原生原神查询未完成；请通过加密核心核验本人授权，或在官方 App 完成安全验证。', data: {} });

/**
 * queryScoped is the existing ALS bridge's (uid, api, data) facade. Never pass
 * HoyolabClient.query directly: the facade verifies owner, group policy and UID.
 * The original client is never called, including outside a live account scope.
 */
export function installNativeXhhGuard({ LiteMysApi, queryScoped = AccountBridge.queryNativeScoped } = {}) {
  if (typeof LiteMysApi !== 'function' || !LiteMysApi.prototype || typeof LiteMysApi.prototype.getData !== 'function') {
    throw new TypeError('xhh-TL LiteMysApi 客户端不可用。');
  }
  if (typeof queryScoped !== 'function') throw new TypeError('加密账户会话查询桥未配置。');
  const target = LiteMysApi.prototype;
  const previous = installed.get(target);
  if (previous) { previous.query = queryScoped; return { installed: 0, restore() {} }; }
  const state = { query: queryScoped };
  const getDataDescriptor = Object.getOwnPropertyDescriptor(target, 'getData');
  const cookieDescriptor = Object.getOwnPropertyDescriptor(target, 'cookie');
  for (const descriptor of [getDataDescriptor, cookieDescriptor]) {
    if (descriptor && descriptor.configurable === false) throw new TypeError('原生客户端方法无法安全安装会话保护。');
  }
  Object.defineProperty(target, 'getData', {
    configurable: true, writable: true,
    value: async function (api, data = {}) {
      try {
        if (!games.has(this.game ?? 'gs') || !READ_APIS.has(api)) return denied();
        const result = await state.query(String(this.uid), api, data);
        // No raw upstream failures or false success may escape the adapter.
        return result && result.retcode === 0 && result.data && typeof result.data === 'object' ? result : denied();
      } catch { return denied(); }
    }
  });
  Object.defineProperty(target, 'cookie', { configurable: true, get: () => '', set: () => {} });
  installed.set(target, state);
  let restored = false;
  return {
    installed: 2,
    restore() {
      if (restored || installed.get(target) !== state) return;
      restored = true;
      if (getDataDescriptor) Object.defineProperty(target, 'getData', getDataDescriptor); else delete target.getData;
      if (cookieDescriptor) Object.defineProperty(target, 'cookie', cookieDescriptor); else delete target.cookie;
      installed.delete(target);
    }
  };
}

export const nativeXhhSource = Object.freeze({
  module: 'xhh-TL/utils/mysClient.js', export: 'default',
  limitations: ['只桥接 LiteMysApi.getData；TL 自身裸 fetch/finishNote 定时器须由加载层另行接入', 'runtimeAdapter 需标记 _xhhLiteMysApi:true，避免 ensureRuntime 重装原客户端']
});
