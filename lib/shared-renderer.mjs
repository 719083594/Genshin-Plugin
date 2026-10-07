/** Optional, lazy AI-Plugin rendering assistance. Every plugin also ships its
 * own strict SVG renderer; no AI core, account, browser or configuration loads. */
import { createNativeCardRenderer, NativeCardRenderError } from './native-card-renderer.mjs';

const CODES = new Set(['INVALID_NATIVE_CARD', 'UNSAFE_NATIVE_SVG', 'INVALID_NATIVE_IMAGE',
  'NATIVE_IMAGE_LIMIT', 'NATIVE_RENDER_BUSY', 'NATIVE_BACKEND_UNAVAILABLE', 'NATIVE_RENDER_FAILED']);
const RECOVERABLE = new Set(['NATIVE_BACKEND_UNAVAILABLE', 'NATIVE_RENDER_FAILED']);
const MAX_JPEG_BYTES = 8 * 1024 * 1024;

/** Recognize the stable contract across separate plugin module copies. */
export function isNativeCardRenderError(error) {
  try { return CODES.has(error?.code); } catch { return false; }
}
function safeError(error) {
  return new NativeCardRenderError(isNativeCardRenderError(error) ? error.code : 'NATIVE_RENDER_FAILED');
}
function validImage(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 4 && bytes.length <= MAX_JPEG_BYTES &&
    bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
}

export function createSharedNativeCardRenderer({
  loadService = () => import('../../AI-Plugin/src/rendering/index.mjs'),
  loadSharp = () => import('sharp'), onMetrics = null, preferShared = true
} = {}) {
  if (typeof loadService !== 'function' || typeof loadSharp !== 'function' ||
    typeof preferShared !== 'boolean' || onMetrics !== null && typeof onMetrics !== 'function') {
    throw new TypeError('INVALID_SHARED_RENDERER_OPTIONS');
  }
  const renderLocal = createNativeCardRenderer({ loadSharp, onMetrics });
  let pending;
  async function sharedRenderer() {
    if (!pending) pending = Promise.resolve().then(loadService).then(service => {
      if (typeof service?.createNativeCardRenderer !== 'function') throw new NativeCardRenderError('NATIVE_BACKEND_UNAVAILABLE');
      const render = service.createNativeCardRenderer({ loadSharp, onMetrics });
      if (typeof render !== 'function') throw new NativeCardRenderError('NATIVE_BACKEND_UNAVAILABLE');
      return render;
    }).catch(() => {
      // A missing optional plugin must not poison future rendering requests.
      pending = undefined;
      throw new NativeCardRenderError('NATIVE_BACKEND_UNAVAILABLE');
    });
    return pending;
  }
  return async card => {
    if (preferShared) {
      try {
        const bytes = await (await sharedRenderer())(card);
        if (!validImage(bytes)) throw new NativeCardRenderError('INVALID_NATIVE_IMAGE');
        return Buffer.from(bytes);
      } catch (error) {
        const safe = safeError(error);
        // Await settlement before local retry. Input/asset rejections and queue
        // admission errors never escape their limits by switching providers.
        if (!RECOVERABLE.has(safe.code)) throw safe;
      }
    }
    try { return await renderLocal(card); }
    catch (error) { throw safeError(error); }
  };
}
