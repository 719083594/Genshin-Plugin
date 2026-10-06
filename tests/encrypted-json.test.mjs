import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encryptJson, decryptJson, EncryptedJsonError } from '../lib/encrypted-json.mjs';

const AAD = 'Teyvat-Plugin/gacha/v1/100000001';
const errorCode = code => error => error instanceof EncryptedJsonError && error.code === code;

test('whole JSON payload roundtrips with fresh nonces and no plaintext identity/credential fields', () => {
  const key = randomBytes(32), originalKey = Buffer.from(key);
  const value = { owner: 'synthetic-private-owner', uid: 'synthetic-private-uid', records: [{ name: 'synthetic-private-record' }], token: 'synthetic-test-token' };
  const first = encryptJson(value, { key, aad: AAD }), second = encryptJson(value, { key, aad: AAD });
  assert.deepEqual(decryptJson(first, { key, aad: AAD }), value);
  assert.notEqual(first.iv, second.iv); assert.notEqual(first.ciphertext, second.ciphertext);
  for (const secret of [value.owner, value.uid, value.token, value.records[0].name, AAD]) assert.equal(JSON.stringify(first).includes(secret), false);
  assert.deepEqual(key, originalKey);
  assert.deepEqual(Object.keys(first).sort(), ['algorithm', 'ciphertext', 'iv', 'tag', 'version']);
});

test('hex and base64 keys decode compatibly without mutating caller buffers', () => {
  const key = randomBytes(32), aad = Buffer.from(AAD);
  const envelope = encryptJson([1, true, null, '中文'], { key: key.toString('hex'), aad });
  assert.deepEqual(decryptJson(envelope, { key: key.toString('base64'), aad }), [1, true, null, '中文']);
  assert.equal(aad.toString(), AAD);
});

test('wrong key/AAD and tag/ciphertext tampering fail without changing original envelope', () => {
  const key = randomBytes(32), envelope = encryptJson({ value: 'synthetic-secret' }, { key, aad: AAD }), before = JSON.stringify(envelope);
  for (const action of [() => decryptJson(envelope, { key: randomBytes(32), aad: AAD }),
    () => decryptJson(envelope, { key, aad: AAD + '/other-owner' }),
    () => decryptJson({ ...envelope, tag: randomBytes(16).toString('base64') }, { key, aad: AAD }),
    () => decryptJson({ ...envelope, ciphertext: randomBytes(30).toString('base64') }, { key, aad: AAD })])
    assert.throws(action, errorCode('DECRYPT_FAILED'));
  assert.equal(JSON.stringify(envelope), before);
});

test('invalid keys/context/envelopes fail with fixed messages rather than exposing sensitive content', () => {
  const key = randomBytes(32);
  assert.throws(() => encryptJson({}, { key: 'synthetic-invalid-secret', aad: AAD }), error => {
    assert.ok(errorCode('INVALID_KEY')(error)); assert.equal(error.message.includes('synthetic-invalid-secret'), false); return true;
  });
  for (const aad of [undefined, '', Buffer.alloc(0)]) assert.throws(() => encryptJson({}, { key, aad }), errorCode('INVALID_CONTEXT'));
  const good = encryptJson({}, { key, aad: AAD });
  for (const bad of [null, [], { ...good, version: 2 }, { ...good, algorithm: 'plaintext' }, { ...good, iv: 'not-base64' },
    { ...good, tag: Buffer.alloc(15).toString('base64') }, { ...good, ciphertext: good.ciphertext + '\n' }])
    assert.throws(() => decryptJson(bad, { key, aad: AAD }), errorCode('DECRYPT_FAILED'));
});

test('size limits apply before encryption and before oversized ciphertext decoding', () => {
  const key = randomBytes(32);
  assert.throws(() => encryptJson({ text: 'x'.repeat(300) }, { key, aad: AAD, maxBytes: 64 }), errorCode('SIZE_LIMIT'));
  const envelope = encryptJson({ text: 'x'.repeat(300) }, { key, aad: AAD });
  assert.throws(() => decryptJson(envelope, { key, aad: AAD, maxBytes: 64 }), errorCode('SIZE_LIMIT'));
});

test('non-JSON values and serialization cycles are rejected rather than silently dropping fields', () => {
  const key = randomBytes(32), cycle = {}; cycle.self = cycle;
  for (const value of [undefined, { n: NaN }, { missing: undefined }, { fn: () => {} }, { n: 1n }, cycle])
    assert.throws(() => encryptJson(value, { key, aad: AAD }), errorCode('INVALID_JSON'));
});
