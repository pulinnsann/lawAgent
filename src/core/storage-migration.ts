import { mkdir, mkdtemp, copyFile, lstat, rename, rm, chmod, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../shared/workspace-schema';
import { openNativeDatabase, openLegacyDatabase, retainClosedSnapshot, selectedStorageBackend, syncFile, syncDirectory, type StorageDatabase } from './storage-backend';

/** Migrate a closed copy first. A failed schema migration never changes the
 * caller's existing file. Version backups retain their established filenames. */
export class BusinessDatabaseOpening {
  private constructor(public db: StorageDatabase, readonly path: string, readonly existed: boolean,
    private original: Uint8Array | undefined, private originalVersion: number, private stage: string | null) {}

  static async prepare(dataDir: string): Promise<BusinessDatabaseOpening> {
    await mkdir(dataDir, { recursive: true });
    const path = join(dataDir, 'workspace.sqlite');
    const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('业务库必须是普通文件，不能使用符号链接。');
    const backend = selectedStorageBackend();
    const marker = await lstat(join(dataDir, '.native-storage.json')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    let nativeRestart = false;
    if (marker) {
      if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 4096) throw new Error('原生存储标记无效，原数据库未改写。');
      const metadata = JSON.parse(await readFile(join(dataDir, '.native-storage.json'), 'utf8'));
      if (metadata.format !== 'law-agent-native-storage-v1' || metadata.schemaVersion !== CURRENT_WORKSPACE_SCHEMA_VERSION) throw new Error('原生存储标记版本不受支持，原数据库未改写。');
      nativeRestart = true;
    }
    let hasSidecars = false;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = await lstat(`${path}${suffix}`).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      if (sidecar && (!sidecar.isFile() || sidecar.isSymbolicLink())) throw new Error('业务库事务旁路文件无效，原数据库未改写。');
      hasSidecars ||= Boolean(sidecar);
    }
    if (hasSidecars) {
      if (backend !== 'rust' || !nativeRestart || !info) throw new Error('首次迁移需要已关闭且完成事务恢复的业务库；请先关闭旧版本并完成恢复后重试。');
      // The OS writer lease is held. Let SQLite roll back its own hot journal;
      // raw-copying the main file here would lose committed recovery semantics.
      const recovery = openNativeDatabase(path);
      try { if (recovery.exec('PRAGMA quick_check')[0]?.values[0]?.[0] !== 'ok') throw new Error('事务恢复后的业务库完整性校验失败。'); }
      finally { recovery.close(); }
      for (const suffix of ['-wal', '-shm', '-journal']) if (await lstat(`${path}${suffix}`).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; })) throw new Error('业务库仍在由其他程序使用，无法安全打开。');
    }
    if (backend === 'sqljs') {
      const bytes = info ? await readFile(path) : undefined;
      return new BusinessDatabaseOpening(await openLegacyDatabase(bytes), path, Boolean(info), bytes, 0, null);
    }
    let version = 0;
    if (info) {
      const inspection = openNativeDatabase(path, true);
      try {
        version = Number(inspection.exec('SELECT MAX(version) FROM schema_version')[0]?.values[0]?.[0] ?? 0);
        if (!Number.isInteger(version) || version < 1 || version > CURRENT_WORKSPACE_SCHEMA_VERSION) throw new Error('业务数据库来自更新或不受支持的软件版本，当前版本不能打开。');
        if (inspection.exec('PRAGMA quick_check')[0]?.values[0]?.[0] !== 'ok') throw new Error('业务数据库完整性校验失败，原数据库已保留。');
      } finally { inspection.close(); }
      await retainClosedSnapshot(path, `${path}.pre-rust-backup`, !nativeRestart);
    }
    if (info && version === CURRENT_WORKSPACE_SCHEMA_VERSION) {
      return new BusinessDatabaseOpening(openNativeDatabase(path), path, true, undefined, version, null);
    }
    const stage = await mkdtemp(join(dataDir, '.rust-migration-'));
    try {
      await chmod(stage, 0o700);
      const stagedPath = join(stage, 'workspace.sqlite');
      if (info) { await copyFile(path, stagedPath, constants.COPYFILE_EXCL); await chmod(stagedPath, 0o600); }
      return new BusinessDatabaseOpening(openNativeDatabase(stagedPath), path, Boolean(info), undefined, version, stage);
    } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  }

  async retainVersion(version: number): Promise<void> {
    if (!this.existed) return;
    const destination = `${this.path}.v${version}-backup`;
    const existing = await lstat(destination).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('业务库版本备份不是普通文件，原数据库未改写。');
      return;
    }
    if (this.db.backend === 'rust') {
      if (this.originalVersion === version) await retainClosedSnapshot(this.path, destination);
      else this.db.backup(destination);
    } else {
      const { writeFile } = await import('node:fs/promises');
      const backup = this.originalVersion && this.originalVersion === version ? this.original! : this.db.export();
      this.db.run('PRAGMA foreign_keys=ON');
      try { await writeFile(destination, backup, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }

  setInitialVersion(version: number): void { if (this.db.backend === 'sqljs') this.originalVersion = version; }

  async publish(): Promise<StorageDatabase> {
    if (!this.stage) { if (this.db.backend === 'rust') await this.markNative(); return this.db; }
    if (this.db.exec('PRAGMA foreign_key_check').some(result => result.values.length)) throw new Error('业务数据库关系校验失败，原数据库已保留。');
    const stage = this.stage;
    this.db.close();
    await rename(join(stage, 'workspace.sqlite'), this.path);
    await syncDirectory(dirname(this.path));
    this.db = openNativeDatabase(this.path);
    this.stage = null;
    await rm(stage, { recursive: true, force: true });
    await this.markNative();
    return this.db;
  }

  private async markNative(): Promise<void> {
    const marker = join(dirname(this.path), '.native-storage.json');
    const temporary = `${marker}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ format: 'law-agent-native-storage-v1', schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION }), { mode: 0o600, flag: 'wx' }); await syncFile(temporary); await rename(temporary, marker); await syncDirectory(dirname(marker)); }
    finally { await rm(temporary, { force: true }); }
  }

  async abort(): Promise<void> {
    try { this.db.close(); } finally { if (this.stage) await rm(this.stage, { recursive: true, force: true }); }
  }
}
