import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const { deriveNsisNativeIdentity } = createRequire(import.meta.url)('../scripts/nsis-native-identity.mjs') as {
  deriveNsisNativeIdentity(source: Buffer): {
    bytes: number; sourceSha256: string; sha256: string; patchedBytes: Buffer;
    patch: { markerOffset: number; from: string; to: string; framework: string };
  };
};

const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('NSIS identity applies only the pinned bundle marker patch and leaves input unchanged', () => {
  const source = Buffer.concat([Buffer.from([0, 1, 2]), marker, Buffer.from([3, 4, 5])]);
  const before = Buffer.from(source), identity = deriveNsisNativeIdentity(source);
  const expected = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS'), Buffer.from([3, 4, 5])]);
  assert.deepEqual(source, before);
  assert.deepEqual(identity.patchedBytes, expected);
  assert.equal(identity.sourceSha256, digest(source));
  assert.equal(identity.sha256, digest(expected));
  assert.equal(identity.bytes, source.length);
  assert.equal(identity.patch.markerOffset, 3);
});

test('NSIS identity rejects absent or ambiguous markers', () => {
  assert.throws(() => deriveNsisNativeIdentity(Buffer.alloc(32)), /exactly one/u);
  assert.throws(() => deriveNsisNativeIdentity(Buffer.concat([marker, marker])), /exactly one/u);
  assert.throws(() => deriveNsisNativeIdentity(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS')), /exactly one/u);
});

test('NSIS identity retains full-byte tamper detection outside and inside the marker', () => {
  const identity = deriveNsisNativeIdentity(Buffer.concat([Buffer.alloc(4), marker, Buffer.alloc(4)]));
  for (const offset of [0, identity.patch.markerOffset, identity.bytes - 1]) {
    const tampered = Buffer.from(identity.patchedBytes); tampered[offset] ^= 1;
    assert.notEqual(digest(tampered), identity.sha256);
  }
});
