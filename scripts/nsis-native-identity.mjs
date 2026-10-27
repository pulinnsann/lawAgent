import { createHash } from 'node:crypto';

// Tauri CLI 2.12.4 stamps this marker before NSIS packaging, then restores the
// source executable. Model exactly that patch; never ignore arbitrary PE bytes.
// https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle.rs#L35-L89
const unknown = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
const nsis = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function deriveNsisNativeIdentity(source) {
  if (!Buffer.isBuffer(source)) throw new TypeError('Expected the complete native executable as a Buffer.');
  const markerOffset = source.indexOf(unknown);
  if (markerOffset < 0 || source.indexOf(unknown, markerOffset + 1) !== -1) throw new Error('Expected exactly one unpatched Tauri bundle-type marker.');
  const patchedBytes = Buffer.from(source);
  nsis.copy(patchedBytes, markerOffset);
  return {
    bytes: source.length,
    sourceSha256: sha256(source),
    sha256: sha256(patchedBytes),
    patch: { markerOffset, from: unknown.toString('ascii'), to: nsis.toString('ascii'), framework: 'tauri-cli-2.12.4' },
    patchedBytes,
  };
}

export const expectedNsisNativeIdentity = deriveNsisNativeIdentity;
