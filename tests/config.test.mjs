import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigStore, defaults, validate } from '../lib/config.mjs';

function workspace(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'teyvat-config-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(base + path.sep));
    assert.ok(path.basename(root).startsWith('teyvat-config-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return new ConfigStore(root);
}

test('new and validated configuration has no retired execution setting', t => {
  assert.equal(Object.hasOwn(defaults, 'autoSign'), false);
  const store = workspace(t);
  const current = store.init();
  assert.equal(Object.hasOwn(current, 'autoSign'), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(store.file, 'utf8')), 'autoSign'), false);
  assert.equal(Object.hasOwn(validate({ ...current, autoSign: { enabled: true } }), 'autoSign'), false);
});

test('reading legacy autoSign removes it from disk while preserving key and read-only settings', t => {
  const store = workspace(t);
  const current = store.init();
  const source = { ...current, autoSign: { enabled: true, time: '00:00', retryMinutes: 1 },
    notifications: { enabled: true, intervalMinutes: 20, resinThreshold: 160 }, masters: ['12345678'] };
  fs.writeFileSync(store.file, JSON.stringify(source));
  const result = store.read();
  const saved = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(Object.hasOwn(result, 'autoSign'), false);
  assert.equal(Object.hasOwn(saved, 'autoSign'), false);
  assert.equal(result.credentialsKey, current.credentialsKey);
  assert.equal(saved.credentialsKey, current.credentialsKey);
  assert.deepEqual(saved.notifications, source.notifications);
  assert.deepEqual(saved.masters, source.masters);
  assert.deepEqual(result.providers, current.providers);
});

test('invalid or malformed legacy configuration is retained without a partial cleanup', async t => {
  for (const mode of ['bad HTTPS URL', 'invalid key', 'malformed JSON']) await t.test(mode, t => {
    const store = workspace(t);
    const current = store.init();
    const value = { ...current, autoSign: { enabled: true } };
    if (mode === 'bad HTTPS URL') value.moan = { baseUrl: 'http://example.invalid/' };
    if (mode === 'invalid key') value.credentialsKey = 'bad';
    const source = mode === 'malformed JSON' ? '{invalid json' : JSON.stringify(value);
    fs.writeFileSync(store.file, source);
    assert.throws(() => store.read());
    assert.equal(fs.readFileSync(store.file, 'utf8'), source);
  });
});
