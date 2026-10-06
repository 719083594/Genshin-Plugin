/** Pure AES-256-GCM JSON codec; callers own safe paths, locking and migration. */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const DEFAULT_LIMIT = 8 * 1024 * 1024, HARD_LIMIT = 32 * 1024 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export class EncryptedJsonError extends Error {
  constructor(code, message) { super(message); this.name = 'EncryptedJsonError'; this.code = code; }
}
function parameters({ key, aad, maxBytes = DEFAULT_LIMIT } = {}) {
  let bytes;
  if (Buffer.isBuffer(key) || key instanceof Uint8Array) bytes = Buffer.from(key);
  else if (typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key)) bytes = Buffer.from(key, 'hex');
  else if (typeof key === 'string' && /^[a-zA-Z0-9+/]{43}=$/.test(key)) {
    const decoded = Buffer.from(key, 'base64'); if (decoded.toString('base64') === key) bytes = decoded;
  }
  if (!bytes || bytes.length !== 32) { bytes?.fill(0); throw new EncryptedJsonError('INVALID_KEY', 'JSON加密密钥必须为32字节或有效的hex/base64编码。'); }
  let context;
  if (typeof aad === 'string') context = Buffer.from(aad, 'utf8');
  else if (Buffer.isBuffer(aad) || aad instanceof Uint8Array) context = Buffer.from(aad);
  if (!context?.length || context.length > 4096 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_LIMIT) {
    bytes.fill(0); throw new EncryptedJsonError('INVALID_CONTEXT', 'JSON加密需明确的非空AAD与有效大小上限。');
  }
  return { key: bytes, aad: context, maxBytes };
}
function decodeBase64(value, expected, maxBytes) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (expected !== undefined && bytes.length !== expected)) throw new Error();
  if (bytes.length > maxBytes) throw new EncryptedJsonError('SIZE_LIMIT', '加密JSON超过大小上限。');
  return bytes;
}

/** aad should include plugin/version + storage kind + owner/UID as appropriate. */
export function encryptJson(value, options) {
  const context = parameters(options); let plaintext;
  try {
    let json;
    try {
      json = JSON.stringify(value, (_name, item) => {
        if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) throw new Error();
        return item;
      });
      if (typeof json !== 'string') throw new Error();
    } catch { throw new EncryptedJsonError('INVALID_JSON', '只能加密完整的有效JSON数据。'); }
    plaintext = Buffer.from(json, 'utf8');
    if (plaintext.length > context.maxBytes) throw new EncryptedJsonError('SIZE_LIMIT', 'JSON数据超过加密大小上限。');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', context.key, iv); cipher.setAAD(context.aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  } finally { context.key.fill(0); plaintext?.fill(0); }
}

/** Wrong key/AAD, malformed envelope and tampering fail without mutating input. */
export function decryptJson(envelope, options) {
  const context = parameters(options); let first, plaintext;
  try {
    if (!isObject(envelope) || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error();
    const iv = decodeBase64(envelope.iv, 12, 12), tag = decodeBase64(envelope.tag, 16, 16);
    if (typeof envelope.ciphertext === 'string' && envelope.ciphertext.length > Math.ceil(context.maxBytes / 3) * 4)
      throw new EncryptedJsonError('SIZE_LIMIT', '加密JSON超过大小上限。');
    const ciphertext = decodeBase64(envelope.ciphertext, undefined, context.maxBytes);
    const decipher = createDecipheriv('aes-256-gcm', context.key, iv); decipher.setAAD(context.aad); decipher.setAuthTag(tag);
    first = decipher.update(ciphertext); plaintext = Buffer.concat([first, decipher.final()]);
    if (plaintext.length > context.maxBytes) throw new EncryptedJsonError('SIZE_LIMIT', '加密JSON超过大小上限。');
    return JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    if (error instanceof EncryptedJsonError && error.code === 'SIZE_LIMIT') throw error;
    throw new EncryptedJsonError('DECRYPT_FAILED', 'JSON解密或完整性验证失败，请保留原密钥与文件。');
  } finally { context.key.fill(0); first?.fill(0); plaintext?.fill(0); }
}
