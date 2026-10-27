import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface ManagedDocumentArtifact { artifactUri: string; sha256: string; byteSize: number }
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const UNREADABLE = '合同原件已变化或不可读取，无法安全生成修改稿。';
const MISMATCH = '合同原件与审核版本不一致，已阻止修改。请重新导入并审核。';
class ManagedSourceError extends Error {}

function contained(root: string, path: string): boolean {
  const delta = relative(root, path);
  return Boolean(delta) && !isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`);
}
function sameFileVersion(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}
function validFile(file: BigIntStats, expectedSize: number): void {
  if (!file.isFile() || file.isSymbolicLink() || file.size > BigInt(MAX_SOURCE_BYTES)) throw new ManagedSourceError(UNREADABLE);
  if (file.size !== BigInt(expectedSize)) throw new ManagedSourceError(MISMATCH);
}

/** Pin one ordinary managed file and freshly hash its exact expected bytes.
 * Metadata detects races, but never substitutes for reading and hashing. No
 * buffer, file descriptor or digest is retained after the operation. */
async function checkedSource(dataDir: string, artifact: ManagedDocumentArtifact, retainBytes: boolean): Promise<Buffer | undefined> {
  let handle: FileHandle | undefined;
  try {
    if (!artifact || typeof artifact.artifactUri !== 'string' || !artifact.artifactUri || artifact.artifactUri.includes('\0')
      || !Number.isSafeInteger(artifact.byteSize) || artifact.byteSize < 0 || artifact.byteSize > MAX_SOURCE_BYTES
      || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new ManagedSourceError(UNREADABLE);
    const root = await realpath(dataDir);
    const selected = resolve(root, artifact.artifactUri);
    if (!contained(root, selected)) throw new ManagedSourceError('合同原件不在受管目录中。');
    const selectedFile = await lstat(selected, { bigint: true });
    validFile(selectedFile, artifact.byteSize);
    const canonical = await realpath(selected);
    if (!contained(root, canonical)) throw new ManagedSourceError('合同原件已移出受管目录。');
    // O_NOFOLLOW pins the final component without following a replacement
    // symlink where supported; identity checks also cover platform fallbacks.
    handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    validFile(before, artifact.byteSize);
    if (!sameFileVersion(selectedFile, before)) throw new ManagedSourceError(MISMATCH);
    const openedPath = await realpath(selected);
    if (!contained(root, openedPath) || openedPath !== canonical) throw new ManagedSourceError('合同原件已移出受管目录。');
    const pinnedPath = await lstat(canonical, { bigint: true });
    validFile(pinnedPath, artifact.byteSize);
    if (!sameFileVersion(before, pinnedPath)) throw new ManagedSourceError(MISMATCH);

    const bytes = retainBytes ? Buffer.allocUnsafe(artifact.byteSize) : undefined;
    const scratch = retainBytes ? undefined : Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const digest = createHash('sha256');
    let offset = 0;
    while (offset < artifact.byteSize) {
      const length = Math.min(READ_CHUNK_BYTES, artifact.byteSize - offset);
      const destination = bytes ?? scratch!;
      const destinationOffset = bytes ? offset : 0;
      const read = await handle.read(destination, destinationOffset, length, offset);
      if (read.bytesRead <= 0 || read.bytesRead > length) throw new ManagedSourceError(MISMATCH);
      digest.update(destination.subarray(destinationOffset, destinationOffset + read.bytesRead));
      offset += read.bytesRead;
    }

    const after = await handle.stat({ bigint: true });
    validFile(after, artifact.byteSize);
    if (!sameFileVersion(before, after)) throw new ManagedSourceError(MISMATCH);
    // Renaming/replacing a path must not let a verified, now-unlinked handle
    // authorize later work against a different file at the managed location.
    const finalCanonical = await realpath(selected);
    if (!contained(root, finalCanonical) || finalCanonical !== canonical) throw new ManagedSourceError('合同原件已移出受管目录。');
    const finalPath = await lstat(canonical, { bigint: true });
    validFile(finalPath, artifact.byteSize);
    if (!sameFileVersion(before, finalPath) || digest.digest('hex') !== artifact.sha256) throw new ManagedSourceError(MISMATCH);
    return bytes;
  } catch (error) {
    if (error instanceof ManagedSourceError) throw error;
    // Do not return raw OS errors containing file paths or internal handles.
    throw new ManagedSourceError(UNREADABLE);
  } finally {
    if (handle) await handle.close().catch(() => { throw new ManagedSourceError(UNREADABLE); });
  }
}

export async function readManagedDocumentSource(dataDir: string, artifact: ManagedDocumentArtifact): Promise<Buffer> {
  return (await checkedSource(dataDir, artifact, true))!;
}

export async function verifyManagedDocumentSource(dataDir: string, artifact: ManagedDocumentArtifact): Promise<void> {
  await checkedSource(dataDir, artifact, false);
}
