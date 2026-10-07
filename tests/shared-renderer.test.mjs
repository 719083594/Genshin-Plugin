import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSharedNativeCardRenderer, isNativeCardRenderError } from '../lib/shared-renderer.mjs';
import { createNativeCardRenderer, NativeCardRenderError, getNativeRenderStatus } from '../lib/native-card-renderer.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const jpeg = () => Buffer.from([255, 216, 255, 217]);
const card = (privatePage = true) => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100" viewBox="0 0 320 100"><rect width="320" height="100" fill="#17313d"/></svg>',
  width: 320, height: 100, private: privatePage
});
function backend({ gate = null, error = null } = {}) {
  const calls = [];
  const sharp = (input, options) => {
    calls.push({ input, options });
    return {
      jpeg() { return this; }, timeout() { return this; },
      async toBuffer() {
        if (gate) await gate;
        if (error) throw error;
        return { data: jpeg(), info: { format: 'jpeg', width: 320, height: 100 } };
      }
    };
  };
  sharp.versions = { sharp: '0.35.5' };
  sharp.cache = () => {}; sharp.concurrency = () => {};
  return { sharp, calls };
}

test('optional shared service loads once on demand, preserves privacy and uses the plugin backend', async () => {
  let imports = 0, factories = 0, localLoads = 0;
  const cards = [], loadSharp = () => { localLoads++; return backend().sharp; }, metrics = () => {};
  const output = jpeg();
  const render = createSharedNativeCardRenderer({ loadSharp, onMetrics: metrics, loadService: async () => {
    imports++;
    return { createNativeCardRenderer: options => {
      factories++; assert.equal(options.loadSharp, loadSharp); assert.equal(options.onMetrics, metrics);
      return async value => { cards.push(value); return output; };
    } };
  } });
  assert.equal(imports, 0);
  const own = card(true), pub = card(false), images = await Promise.all([render(own), render(pub)]);
  assert.equal(imports, 1); assert.equal(factories, 1); assert.equal(localLoads, 0);
  assert.deepEqual(cards, [own, pub]);
  for (const image of images) { assert.deepEqual(image, output); assert.notEqual(image, output); }
});

test('missing or unusable optional AI service falls back to the strict standalone renderer', async () => {
  for (const service of [null, {}, { createNativeCardRenderer: () => null }]) {
    const b = backend(), render = createSharedNativeCardRenderer({ loadService: async () => service, loadSharp: () => b.sharp });
    for (const privatePage of [false, true]) assert.deepEqual(await render(card(privatePage)), jpeg());
    assert.equal(b.calls.length, 2);
  }
  const b = backend(), render = createSharedNativeCardRenderer({ loadService: async () => { throw Error('synthetic-private-path'); }, loadSharp: () => b.sharp });
  assert.deepEqual(await render(card()), jpeg()); assert.equal(b.calls.length, 1);
});

test('failed optional import is retried so later AI installation can assist without restarting the caller', async () => {
  let imports = 0, assisted = 0;
  const b = backend(), render = createSharedNativeCardRenderer({ loadSharp: () => b.sharp, loadService: async () => {
    if (++imports === 1) throw Error('synthetic missing plugin');
    return { createNativeCardRenderer: () => async value => { assert.equal(value.private, true); assisted++; return jpeg(); } };
  } });
  await render(card()); await render(card()); await render(card());
  assert.equal(imports, 2); assert.equal(assisted, 2); assert.equal(b.calls.length, 1);
});

test('standalone selection never imports the optional service and rejects missing privacy before backend load', async () => {
  let imports = 0, loads = 0;
  const render = createSharedNativeCardRenderer({ preferShared: false, loadService: () => { imports++; }, loadSharp: () => { loads++; return backend().sharp; } });
  for (const privatePage of [undefined, null, 1, 'true']) await assert.rejects(render({ ...card(), private: privatePage }), error => error.code === 'INVALID_NATIVE_CARD');
  assert.equal(loads, 0); await render(card(false)); assert.equal(loads, 1); assert.equal(imports, 0);
});

test('local retry waits until shared failure settles; backend and native failure are recoverable', async () => {
  let reject, sharedCalls = 0;
  const gate = new Promise((resolve, fail) => { reject = fail; }), b = backend();
  const render = createSharedNativeCardRenderer({ loadSharp: () => b.sharp, loadService: async () => ({ createNativeCardRenderer: () => async () => { sharedCalls++; return gate; } }) });
  const job = render(card()); await flush(); assert.equal(sharedCalls, 1); assert.equal(b.calls.length, 0);
  reject(Object.assign(Error('synthetic upstream path'), { code: 'NATIVE_RENDER_FAILED' }));
  assert.deepEqual(await job, jpeg()); assert.equal(b.calls.length, 1);
  for (const code of ['NATIVE_BACKEND_UNAVAILABLE', 'NATIVE_RENDER_FAILED']) {
    const local = backend(), retry = createSharedNativeCardRenderer({ loadSharp: () => local.sharp,
      loadService: async () => ({ createNativeCardRenderer: () => async () => { throw Object.assign(Error('synthetic token'), { code }); } }) });
    assert.deepEqual(await retry(card()), jpeg()); assert.equal(local.calls.length, 1);
  }
});

test('input, asset, output and queue rejections never bypass limits through local retry', async () => {
  for (const code of ['INVALID_NATIVE_CARD', 'UNSAFE_NATIVE_SVG', 'INVALID_NATIVE_IMAGE', 'NATIVE_IMAGE_LIMIT', 'NATIVE_RENDER_BUSY']) {
    let loaded = false;
    const render = createSharedNativeCardRenderer({ loadSharp: () => { loaded = true; return backend().sharp; },
      loadService: async () => ({ createNativeCardRenderer: () => async () => { throw Object.assign(Error('synthetic private response'), { code }); } }) });
    await assert.rejects(render(card()), error => error instanceof NativeCardRenderError && error.code === code && !error.message.includes('synthetic'));
    assert.equal(loaded, false);
  }
  for (const output of [null, 'file:///synthetic', Buffer.from('not an image')]) {
    let loaded = false;
    const render = createSharedNativeCardRenderer({ loadSharp: () => { loaded = true; return backend().sharp; },
      loadService: async () => ({ createNativeCardRenderer: () => async () => output }) });
    await assert.rejects(render(card()), error => error.code === 'INVALID_NATIVE_IMAGE'); assert.equal(loaded, false);
  }
});

test('AI assistance and local module copies share one active native job and two FIFO waiters', async () => {
  const peer = await import('../lib/native-card-renderer.mjs?shared-queue-contract');
  let finish; const gate = new Promise(resolve => { finish = resolve; });
  const b = backend({ gate }), next = backend(), final = backend(), overflow = backend();
  const first = createNativeCardRenderer({ loadSharp: () => b.sharp })(card()); await flush();
  const assisted = createSharedNativeCardRenderer({ loadService: async () => peer, loadSharp: () => next.sharp })(card(false)); await flush();
  const standalone = createSharedNativeCardRenderer({ preferShared: false, loadSharp: () => final.sharp })(card());
  try {
    assert.deepEqual(getNativeRenderStatus(), { active: 1, queued: 2, maxQueued: 2 });
    await assert.rejects(createSharedNativeCardRenderer({ loadService: async () => peer, loadSharp: () => overflow.sharp })(card()), error => error.code === 'NATIVE_RENDER_BUSY');
    assert.equal(overflow.calls.length, 0); assert.equal(next.calls.length, 0); assert.equal(final.calls.length, 0);
  } finally { finish(); await Promise.all([first, assisted, standalone]); }
  assert.deepEqual(getNativeRenderStatus(), { active: 0, queued: 0, maxQueued: 2 });
});

test('bridge errors are sanitized across copies and its source has no IO, browser, model or configuration API', async () => {
  const render = createSharedNativeCardRenderer({ loadService: async () => { throw Error('synthetic-cookie'); }, loadSharp: () => { throw Error('synthetic-key'); } });
  await assert.rejects(render(card()), error => isNativeCardRenderError(error) && error.code === 'NATIVE_BACKEND_UNAVAILABLE' && !/synthetic/.test(error.message));
  assert.equal(isNativeCardRenderError({ code: 'UNSAFE_NATIVE_SVG' }), true);
  assert.equal(isNativeCardRenderError(Error('raw')), false);
  const source = fs.readFileSync(new URL('../lib/shared-renderer.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|readFile|writeFile|createWriteStream|toFile|launch|exec|spawn)\s*\(/);
  assert.doesNotMatch(source, /from ['"](?:node:fs|puppeteer|.*(?:config|storage|client))/);
});
