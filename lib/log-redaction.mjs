const HIDDEN = '[凭据已隐藏]';
const OMITTED = '[日志内容已省略]';
const installed = new WeakMap();
const sensitiveField = /(?:cookie|token|password|passwd|authkey|authorization|secret|credential|api[_-]?key|login[_-]?ticket|geetest|challenge|^ticket$|^ltuid(?:_v2)?$|^account[_-](?:id|mid)(?:_v2)?$|^ltmid(?:_v2)?$)/i;
// Protect serialized headers/JSON and URL query assignments, too.
const assignments = /((?:["']?)(?:cookie(?:_token)?(?:_v2)?|set[-_]cookie|ltoken(?:_v2)?|stoken(?:_v2)?|(?:access_|refresh_|id_|game_)?token(?:_[a-z\d_]+)?|login_ticket|ticket|authkey|authorization|password|passwd|api[_-]?key|credentials?key|ltuid(?:_v2)?|account_(?:id|mid)(?:_v2)?|ltmid(?:_v2)?)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;,}&\]]+)/gi;
const bearer = /(\b(?:proxy[-_]authorization|authorization)\s*[:=]\s*)(?:Bearer|Basic)\s+[^\s,;\r\n]+/gi;
const base64Content = /base64:\/\/[a-z\d+/_=-]+/gi;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redactGameCredentials(value, { prefix = '#原神' } = {}) {
  prefix = typeof prefix === 'string' && prefix && prefix.length <= 100 ? prefix : '#原神';
  const command = new RegExp('(' + escape(prefix) + '\\s*(?:绑定Cookie|墨安绑定|提交验证)\\s+)[^\\r\\n]*', 'gi');
  const seen = new WeakSet();
  let remaining = 2000;
  const visit = (item, depth = 0) => {
    if (remaining-- <= 0 || depth > 10) return OMITTED;
    if (typeof item === 'string') return item.replace(command, '$1' + HIDDEN).replace(bearer, '$1' + HIDDEN).replace(assignments, '$1' + HIDDEN).replace(base64Content, 'base64://[私密文件内容已隐藏]');
    if (!item || typeof item !== 'object') return typeof item === 'function' ? '[函数已省略]' : item;
    if (seen.has(item)) return '[循环引用已省略]';
    seen.add(item);
    if (Buffer.isBuffer(item) || ArrayBuffer.isView(item)) return '[二进制日志已省略]';
    if (item instanceof Date) {
      try { return Date.prototype.toISOString.call(item); } catch { return '[日期无效]'; }
    }
    const array = Array.isArray(item);
    const result = array ? [] : {};
    const keys = array ? Array.from({ length: Math.min(item.length, 200) }, (_, index) => String(index)) : Object.getOwnPropertyNames(item).slice(0, 200);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      const privateFile = key.toLowerCase() === 'file' && descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' && /^\s*base64:\/\//i.test(descriptor.value);
      const cleaned = sensitiveField.test(key) || privateFile ? HIDDEN : descriptor && Object.hasOwn(descriptor, 'value') ? visit(descriptor.value, depth + 1) : '[访问器已省略]';
      // __proto__ stays an own data field; no inherited setter can run.
      Object.defineProperty(result, key, { value: cleaned, enumerable: true, writable: true, configurable: true });
    }
    if ((array ? item.length : Object.getOwnPropertyNames(item).length) > 200) {
      if (array) result.push(OMITTED);
      else Object.defineProperty(result, '__truncated', { value: true, enumerable: true });
    }
    return result;
  };
  return visit(value);
}

export function installLogRedaction(logger, { prefix = '#原神' } = {}) {
  if (!logger || (typeof logger !== 'object' && typeof logger !== 'function')) return;
  const previous = installed.get(logger);
  if (previous) { previous.prefix = prefix; return; }
  const state = { prefix };
  installed.set(logger, state);
  for (const name of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'mark']) {
    const original = logger[name];
    if (typeof original === 'function') logger[name] = function (...args) {
      return original.apply(this, args.map(value => redactGameCredentials(value, { prefix: state.prefix })));
    };
  }
  if (!Object.hasOwn(logger, '__teyvatCredentialRedaction')) Object.defineProperty(logger, '__teyvatCredentialRedaction', { value: true });
}
