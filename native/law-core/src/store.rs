//! Experimental, bounded-memory SQLite storage proof.
//!
//! This is not a port of the production AppStore. Writes are deliberately limited
//! to a marked synthetic database. Existing workspace databases may only be opened
//! read-only; no schema migration, credential handling, or legal logic is performed.

use rusqlite::backup::{Backup, StepResult};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MAX_ROW_LIMIT: usize = 1_000;
pub const MAX_TEXT_LIMIT: usize = 2 * 1024 * 1024;
const EXPERIMENT_MARKER: &str = "law-core-synthetic-storage-v1";
const SCHEMA_VERSION: i64 = 7;
static BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug)]
pub enum StoreError {
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    InvalidConfig(String),
    InvalidInput(String),
    UnsafePath(String),
    ReadOnly,
    SyntheticOnly,
    NotFound(i64),
    UnsupportedWorkspaceSchema(Option<i64>),
    LimitExceeded(String),
    BackupTimedOut,
    BackupValidationFailed,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(e) => write!(f, "SQLite operation failed: {e}"),
            Self::Io(e) => write!(f, "Filesystem operation failed: {e}"),
            Self::InvalidConfig(e) => write!(f, "Invalid storage configuration: {e}"),
            Self::InvalidInput(e) => write!(f, "Invalid synthetic input: {e}"),
            Self::UnsafePath(e) => write!(f, "Unsafe storage path: {e}"),
            Self::ReadOnly => write!(f, "This database is open read-only"),
            Self::SyntheticOnly => write!(f, "Experimental writes require an empty or marked synthetic database"),
            Self::NotFound(id) => write!(f, "Synthetic row {id} was not found"),
            Self::UnsupportedWorkspaceSchema(v) => write!(f, "Expected workspace schema 7, found {v:?}"),
            Self::LimitExceeded(e) => write!(f, "Storage resource limit exceeded: {e}"),
            Self::BackupTimedOut => write!(f, "SQLite online backup exceeded its time limit"),
            Self::BackupValidationFailed => write!(f, "The completed backup failed SQLite validation"),
        }
    }
}

impl Error for StoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Sqlite(e) => Some(e),
            Self::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(value: rusqlite::Error) -> Self { Self::Sqlite(value) }
}

impl From<std::io::Error> for StoreError {
    fn from(value: std::io::Error) -> Self { Self::Io(value) }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoreConfig {
    pub cache_kib: u32,
    pub mmap_bytes: u64,
    pub row_limit: usize,
    pub text_limit: usize,
}

impl Default for StoreConfig {
    fn default() -> Self {
        Self { cache_kib: 8_192, mmap_bytes: 0, row_limit: MAX_ROW_LIMIT, text_limit: MAX_TEXT_LIMIT }
    }
}

impl StoreConfig {
    fn validate(&self) -> Result<()> {
        if !(256..=65_536).contains(&self.cache_kib) {
            return Err(StoreError::InvalidConfig("cache_kib must be between 256 and 65536".into()));
        }
        if self.mmap_bytes != 0 {
            return Err(StoreError::InvalidConfig("memory mapping is disabled for this RAM-bounded experiment".into()));
        }
        if self.row_limit == 0 || self.row_limit > MAX_ROW_LIMIT {
            return Err(StoreError::InvalidConfig("row_limit must be between 1 and 1000".into()));
        }
        if self.text_limit == 0 || self.text_limit > MAX_TEXT_LIMIT {
            return Err(StoreError::InvalidConfig("text_limit must be between 1 and 2097152 bytes".into()));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StorePragmas {
    pub cache_size: i64,
    pub mmap_size: i64,
    pub temp_store: i64,
    pub foreign_keys: bool,
    pub query_only: bool,
    pub busy_timeout_ms: i64,
    pub journal_mode: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoreSummary {
    pub path: String,
    pub read_only: bool,
    pub synthetic: bool,
    pub rows: Option<u64>,
    pub schema_version: Option<i64>,
    pub page_size: u64,
    pub page_count: u64,
    pub freelist_count: u64,
    pub database_bytes: u64,
    pub wal_bytes: u64,
    pub pragmas: StorePragmas,
    pub query_plan: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyntheticRow {
    pub id: i64,
    pub payload: String,
    pub revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SeedSummary {
    pub rows_written: u64,
    pub payload_bytes_per_row: usize,
    pub total_payload_bytes: u64,
    pub committed_batches: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UpdateSummary {
    pub id: i64,
    pub revision: i64,
    pub payload_bytes: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackupSummary {
    pub path: String,
    pub byte_size: u64,
    pub pages_copied: i32,
    pub consistent_snapshot: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkspaceSchemaCheck {
    pub version: i64,
    pub read_only: bool,
    pub scope: String,
}

pub struct DiskStore {
    connection: Connection,
    path: PathBuf,
    read_only: bool,
    synthetic: bool,
    config: StoreConfig,
}

impl DiskStore {
    pub fn open(path: impl AsRef<Path>, read_only: bool) -> Result<Self> {
        Self::open_with_config(path, read_only, StoreConfig::default())
    }

    pub fn open_with_config(path: impl AsRef<Path>, read_only: bool, config: StoreConfig) -> Result<Self> {
        config.validate()?;
        let requested = path.as_ref();
        if requested.as_os_str().is_empty() || requested == Path::new(":memory:") {
            return Err(StoreError::UnsafePath("a regular disk database is required".into()));
        }
        let mut created = false;
        match fs::symlink_metadata(requested) {
            Ok(metadata) if !metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
                return Err(StoreError::UnsafePath("the database must be a regular file, not a link".into()));
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !read_only => {
                create_private_file(requested)?;
                created = true;
            }
            Err(e) => return Err(e.into()),
        }
        let opening = (|| {
            let canonical = fs::canonicalize(requested)?;
            let flags = if read_only { OpenFlags::SQLITE_OPEN_READ_ONLY } else { OpenFlags::SQLITE_OPEN_READ_WRITE }
                | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE;
            let connection = Connection::open_with_flags(&canonical, flags)?;
            connection.busy_timeout(Duration::from_millis(2_000))?;
            // Extension loading is disabled at the C API level and is never exposed
            // as a command. No extension path or arbitrary SQL is accepted by this API.
            // SAFETY: this connection is exclusively owned here. The call only
            // disables extension loading and does not retain or execute a pointer.
            // This avoids enabling rusqlite's optional extension-loading feature.
            let extension_status = unsafe {
                rusqlite::ffi::sqlite3_enable_load_extension(connection.handle(), 0)
            };
            if extension_status != rusqlite::ffi::SQLITE_OK {
                return Err(StoreError::Sqlite(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(extension_status), None,
                )));
            }
            connection.pragma_update(None, "trusted_schema", false)?;
            connection.pragma_update(None, "foreign_keys", true)?;
            connection.pragma_update(None, "cache_size", -(i64::from(config.cache_kib)))?;
            connection.pragma_update(None, "mmap_size", 0_i64)?;
            connection.pragma_update(None, "temp_store", 1_i64)?;
            if read_only { connection.pragma_update(None, "query_only", true)?; }

            let synthetic = is_synthetic(&connection)?;
            if !read_only && !synthetic {
                let count: i64 = connection.query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'", [], |row| row.get(0),
                )?;
                if count != 0 { return Err(StoreError::SyntheticOnly); }
            }
            // Read-only workspace access never changes the journal mode or schema.
            if !read_only {
                connection.pragma_update(None, "journal_mode", "WAL")?;
                connection.pragma_update(None, "synchronous", "FULL")?;
                connection.pragma_update(None, "wal_autocheckpoint", 256_i64)?;
            }
            Ok(Self { connection, path: canonical, read_only, synthetic, config })
        })();
        if opening.is_err() && created { let _ = fs::remove_file(requested); }
        opening
    }

    pub fn config(&self) -> &StoreConfig { &self.config }

    /// Reads the existing version marker only. This does not certify application
    /// semantics, migrate a workspace, or allow writes to a production database.
    pub fn check_workspace_schema7(&self) -> Result<WorkspaceSchemaCheck> {
        if !self.read_only { return Err(StoreError::ReadOnly); }
        let version = workspace_schema_version(&self.connection)?;
        if version != Some(SCHEMA_VERSION) { return Err(StoreError::UnsupportedWorkspaceSchema(version)); }
        Ok(WorkspaceSchemaCheck {
            version: SCHEMA_VERSION,
            read_only: true,
            scope: "schema_version marker only; no AppStore migration or functional compatibility claim".into(),
        })
    }

    /// Generates a reusable single-row buffer and commits at most about 1 MiB per
    /// batch. Total database contents are never accumulated in a Rust collection.
    pub fn seed_synthetic(&mut self, rows: u64, payload_bytes: usize) -> Result<SeedSummary> {
        self.assert_writeable()?;
        if payload_bytes == 0 || payload_bytes > self.config.text_limit {
            return Err(StoreError::LimitExceeded("one payload must fit the configured text limit".into()));
        }
        if rows > i64::MAX as u64 { return Err(StoreError::InvalidInput("row count exceeds SQLite integer range".into())); }
        let total_payload_bytes = rows.checked_mul(payload_bytes as u64)
            .ok_or_else(|| StoreError::LimitExceeded("total payload byte count overflow".into()))?;
        if !self.synthetic {
            let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(
                "CREATE TABLE lawcore_experiment_meta(marker TEXT PRIMARY KEY NOT NULL);
                 CREATE TABLE lawcore_synthetic_rows(
                   id INTEGER PRIMARY KEY,
                   payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 2097152),
                   revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)
                 );",
            )?;
            tx.execute("INSERT INTO lawcore_experiment_meta(marker) VALUES(?)", [EXPERIMENT_MARKER])?;
            tx.commit()?;
            self.synthetic = true;
        }
        let existing: i64 = self.connection.query_row("SELECT COUNT(*) FROM lawcore_synthetic_rows", [], |row| row.get(0))?;
        if existing != 0 { return Err(StoreError::InvalidInput("synthetic seeding requires an empty experiment".into())); }
        let payload = "x".repeat(payload_bytes);
        let rows_per_batch = (1024 * 1024 / payload_bytes).clamp(1, 64) as u64;
        let mut rows_written = 0_u64;
        let mut committed_batches = 0_u64;
        while rows_written < rows {
            let end = (rows_written.saturating_add(rows_per_batch)).min(rows);
            let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            {
                let mut insert = tx.prepare_cached("INSERT INTO lawcore_synthetic_rows(id,payload) VALUES(?,?)")?;
                for index in rows_written..end { insert.execute(params![(index + 1) as i64, &payload])?; }
            }
            tx.commit()?;
            rows_written = end;
            committed_batches += 1;
        }
        Ok(SeedSummary { rows_written, payload_bytes_per_row: payload_bytes, total_payload_bytes, committed_batches })
    }

    /// Returns metadata and an indexed query plan, never contract/report payloads.
    pub fn summarize(&self) -> Result<StoreSummary> {
        let rows = if self.synthetic {
            Some(self.connection.query_row("SELECT COUNT(*) FROM lawcore_synthetic_rows", [], |r| r.get::<_, i64>(0))? as u64)
        } else { None };
        let mut query_plan = Vec::new();
        if self.synthetic {
            let mut plan = self.connection.prepare(
                "EXPLAIN QUERY PLAN SELECT id,payload,revision FROM lawcore_synthetic_rows WHERE id>? ORDER BY id LIMIT ?",
            )?;
            let details = plan.query_map(params![0_i64, self.config.row_limit as i64], |r| r.get::<_, String>(3))?;
            for detail in details { query_plan.push(detail?); }
        }
        Ok(StoreSummary {
            path: self.path.to_string_lossy().into_owned(), read_only: self.read_only, synthetic: self.synthetic,
            rows, schema_version: workspace_schema_version(&self.connection)?,
            page_size: pragma_i64(&self.connection, "page_size")? as u64,
            page_count: pragma_i64(&self.connection, "page_count")? as u64,
            freelist_count: pragma_i64(&self.connection, "freelist_count")? as u64,
            database_bytes: fs::metadata(&self.path)?.len(),
            wal_bytes: file_length(&sidecar(&self.path, "-wal"))?,
            pragmas: StorePragmas {
                cache_size: pragma_i64(&self.connection, "cache_size")?,
                mmap_size: pragma_i64(&self.connection, "mmap_size")?,
                temp_store: pragma_i64(&self.connection, "temp_store")?,
                foreign_keys: pragma_i64(&self.connection, "foreign_keys")? != 0,
                query_only: pragma_i64(&self.connection, "query_only")? != 0,
                busy_timeout_ms: pragma_i64(&self.connection, "busy_timeout")?,
                journal_mode: self.connection.pragma_query_value(None, "journal_mode", |r| r.get(0))?,
            }, query_plan,
        })
    }

    /// Keyset pagination is bounded by both row count and cumulative UTF-8 payload
    /// bytes. A page can be shorter than `limit`; continue after its last row ID.
    pub fn page(&self, after_id: i64, limit: usize) -> Result<Vec<SyntheticRow>> {
        self.assert_synthetic()?;
        if after_id < 0 { return Err(StoreError::InvalidInput("after_id must be nonnegative".into())); }
        if limit == 0 || limit > self.config.row_limit {
            return Err(StoreError::LimitExceeded("page size exceeds the configured row limit".into()));
        }
        let mut statement = self.connection.prepare(
            "SELECT id,length(CAST(payload AS BLOB)),revision,payload FROM lawcore_synthetic_rows WHERE id>? ORDER BY id LIMIT ?",
        )?;
        let mut cursor = statement.query(params![after_id, limit as i64])?;
        let mut values = Vec::with_capacity(limit.min(64));
        let mut bytes = 0_usize;
        while let Some(row) = cursor.next()? {
            let payload_bytes: i64 = row.get(1)?;
            if payload_bytes < 0 || payload_bytes as u64 > self.config.text_limit as u64 {
                return Err(StoreError::LimitExceeded("stored row exceeds the text limit".into()));
            }
            let next_bytes = bytes.saturating_add(payload_bytes as usize);
            if next_bytes > self.config.text_limit { break; }
            values.push(SyntheticRow { id: row.get(0)?, payload: row.get(3)?, revision: row.get(2)? });
            bytes = next_bytes;
        }
        Ok(values)
    }

    /// A real SQLite transaction updates one row. No database export, full-file
    /// rollback image, or in-memory clone is made before or after the operation.
    pub fn update(&mut self, id: i64, payload: &str) -> Result<UpdateSummary> {
        self.assert_writeable()?;
        self.assert_synthetic()?;
        if id <= 0 { return Err(StoreError::InvalidInput("id must be positive".into())); }
        if payload.len() > self.config.text_limit {
            return Err(StoreError::LimitExceeded("replacement payload exceeds the text limit".into()));
        }
        let tx = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE lawcore_synthetic_rows SET payload=?,revision=revision+1 WHERE id=?", params![payload, id],
        )?;
        if changed == 0 { return Err(StoreError::NotFound(id)); }
        let revision = tx.query_row("SELECT revision FROM lawcore_synthetic_rows WHERE id=?", [id], |r| r.get(0))?;
        tx.commit()?;
        Ok(UpdateSummary { id, revision, payload_bytes: payload.len() })
    }

    /// Uses SQLite's online backup API so committed WAL pages are included. SQLite
    /// writes only inside an invocation-owned private directory. A completed file
    /// is published through a non-overwriting hard link on the same filesystem.
    /// Existing destination files and sidecars, including dangling links, fail.
    pub fn backup_to(&self, destination: impl AsRef<Path>) -> Result<BackupSummary> {
        let requested = destination.as_ref();
        let name = requested.file_name().filter(|n| !n.is_empty())
            .ok_or_else(|| StoreError::UnsafePath("backup destination needs a filename".into()))?;
        let parent = requested.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
        let parent = fs::canonicalize(parent)?;
        let target_path = parent.join(name);
        if target_path == self.path || ["-wal", "-shm", "-journal"].iter().any(|suffix| target_path == sidecar(&self.path, suffix)) {
            return Err(StoreError::UnsafePath("backup destination conflicts with the source database".into()));
        }
        ensure_new_backup_destination(&target_path)?;
        let staging_directory = create_backup_directory(&parent)?;
        let staging_path = staging_directory.join("snapshot.sqlite");
        let copying = (|| {
            create_private_file(&staging_path)?;
            let mut target = Connection::open_with_flags(
                &staging_path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            target.busy_timeout(Duration::from_millis(2_000))?;
            target.pragma_update(None, "cache_size", -(i64::from(self.config.cache_kib)))?;
            target.pragma_update(None, "mmap_size", 0_i64)?;
            target.pragma_update(None, "synchronous", "FULL")?;
            let pages_copied;
            {
                let backup = Backup::new(&self.connection, &mut target)?;
                let deadline = Instant::now() + Duration::from_secs(30);
                loop {
                    match backup.step(64)? {
                        StepResult::Done => { pages_copied = backup.progress().pagecount; break; }
                        StepResult::More => {}
                        StepResult::Busy | StepResult::Locked => std::thread::sleep(Duration::from_millis(5)),
                        _ => return Err(StoreError::BackupValidationFailed),
                    }
                    if Instant::now() >= deadline { return Err(StoreError::BackupTimedOut); }
                }
            }
            let checked: String = target.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
            if checked != "ok" { return Err(StoreError::BackupValidationFailed); }
            // Closing flushes destination metadata before its successful result is
            // returned. This is a plain SQLite backup, never a live WAL file copy.
            target.close().map_err(|(_, e)| StoreError::Sqlite(e))?;
            let byte_size = fs::metadata(&staging_path)?.len();
            ensure_new_backup_destination(&target_path)?;
            // Unlike rename, hard_link cannot replace an existing destination.
            // It also avoids opening SQLite next to a caller-owned sidecar. If
            // hard links are unavailable, fail rather than weakening ownership.
            fs::hard_link(&staging_path, &target_path)?;
            Ok(BackupSummary {
                path: target_path.to_string_lossy().into_owned(), byte_size,
                pages_copied, consistent_snapshot: true,
            })
        })();
        // No path in the caller's destination namespace is removed on failure.
        // SQLite sidecars can be cleaned safely only in our private directory.
        let _ = fs::remove_dir_all(&staging_directory);
        copying
    }

    fn assert_writeable(&self) -> Result<()> {
        if self.read_only { Err(StoreError::ReadOnly) } else { Ok(()) }
    }

    fn assert_synthetic(&self) -> Result<()> {
        if self.synthetic { Ok(()) } else { Err(StoreError::SyntheticOnly) }
    }
}

fn create_private_file(path: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    drop(options.open(path)?);
    Ok(())
}

fn ensure_new_backup_destination(path: &Path) -> Result<()> {
    for candidate in std::iter::once(path.to_path_buf())
        .chain(["-wal", "-shm", "-journal"].into_iter().map(|suffix| sidecar(path, suffix)))
    {
        match fs::symlink_metadata(&candidate) {
            Ok(_) => return Err(StoreError::UnsafePath("backup destination or sidecar already exists".into())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}

fn create_backup_directory(parent: &Path) -> Result<PathBuf> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)
        .map_err(|_| StoreError::UnsafePath("system clock cannot name backup staging directory".into()))?.as_nanos();
    for _ in 0..16 {
        let sequence = BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".lawcore-backup-{}-{stamp}-{sequence}", std::process::id()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)] {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(StoreError::UnsafePath("could not create a private backup staging directory".into()))
}

fn has_table(connection: &Connection, table: &str) -> Result<bool> {
    Ok(connection.query_row("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", [table], |_| Ok(())).optional()?.is_some())
}

fn is_synthetic(connection: &Connection) -> Result<bool> {
    if !has_table(connection, "lawcore_experiment_meta")? { return Ok(false); }
    let marker: Option<String> = connection.query_row(
        "SELECT marker FROM lawcore_experiment_meta LIMIT 1", [], |r| r.get(0),
    ).optional()?;
    if marker.as_deref() != Some(EXPERIMENT_MARKER) || !has_table(connection, "lawcore_synthetic_rows")? {
        return Err(StoreError::SyntheticOnly);
    }
    // A marker cannot authorize accidental writes to a real workspace database.
    let other_tables: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('lawcore_experiment_meta','lawcore_synthetic_rows')", [], |r| r.get(0),
    )?;
    if other_tables != 0 { return Err(StoreError::SyntheticOnly); }
    Ok(true)
}

fn workspace_schema_version(connection: &Connection) -> Result<Option<i64>> {
    if !has_table(connection, "schema_version")? { return Ok(None); }
    Ok(connection.query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))?)
}

fn pragma_i64(connection: &Connection, name: &str) -> Result<i64> {
    Ok(connection.pragma_query_value(None, name, |r| r.get(0))?)
}

fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn file_length(path: &Path) -> Result<u64> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("law-core-store-{}-{stamp}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str) -> PathBuf { self.0.join(name) }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn native_pragmas_enforce_disk_and_cache_budget() {
        let directory = TestDirectory::new();
        let config = StoreConfig { cache_kib: 4_096, ..StoreConfig::default() };
        let store = DiskStore::open_with_config(directory.file("synthetic.sqlite"), false, config).unwrap();
        let summary = store.summarize().unwrap();
        assert_eq!(summary.pragmas.cache_size, -4_096);
        assert_eq!(summary.pragmas.mmap_size, 0);
        assert_eq!(summary.pragmas.temp_store, 1);
        assert!(summary.pragmas.foreign_keys);
        assert_eq!(summary.pragmas.busy_timeout_ms, 2_000);
        assert_eq!(summary.pragmas.journal_mode, "wal");
        let extension_error = store.connection.query_row("SELECT load_extension('not-a-library')", [], |_| Ok(())).unwrap_err();
        assert!(extension_error.to_string().contains("not authorized"));
    }

    #[test]
    fn invalid_config_never_creates_database() {
        let directory = TestDirectory::new();
        for config in [
            StoreConfig { row_limit: 1_001, ..StoreConfig::default() },
            StoreConfig { text_limit: MAX_TEXT_LIMIT + 1, ..StoreConfig::default() },
            StoreConfig { mmap_bytes: 4_096, ..StoreConfig::default() },
            StoreConfig { cache_kib: 0, ..StoreConfig::default() },
        ] {
            assert!(matches!(DiskStore::open_with_config(directory.file("never.sqlite"), false, config), Err(StoreError::InvalidConfig(_))));
            assert!(!directory.file("never.sqlite").exists());
        }
    }

    #[test]
    fn page_uses_keyset_order_and_total_text_limit() {
        let directory = TestDirectory::new();
        let config = StoreConfig { row_limit: 3, text_limit: 10, ..StoreConfig::default() };
        let mut store = DiskStore::open_with_config(directory.file("synthetic.sqlite"), false, config).unwrap();
        store.seed_synthetic(5, 4).unwrap();
        let first = store.page(0, 3).unwrap();
        assert_eq!(first.iter().map(|r| r.id).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(first.iter().map(|r| r.payload.len()).sum::<usize>(), 8);
        let second = store.page(2, 3).unwrap();
        assert_eq!(second.iter().map(|r| r.id).collect::<Vec<_>>(), [3, 4]);
        assert!(matches!(store.page(0, 4), Err(StoreError::LimitExceeded(_))));
        assert!(matches!(store.page(0, 0), Err(StoreError::LimitExceeded(_))));
        assert!(matches!(store.page(-1, 1), Err(StoreError::InvalidInput(_))));
        assert!(store.page(5, 1).unwrap().is_empty());
        let summary = store.summarize().unwrap();
        assert_eq!(summary.rows, Some(5));
        assert!(summary.query_plan.iter().any(|p| p.contains("INTEGER PRIMARY KEY") && p.contains("rowid>")));
    }

    #[test]
    fn seed_is_batched_and_rejects_reseeding() {
        let directory = TestDirectory::new();
        let mut store = DiskStore::open(directory.file("synthetic.sqlite"), false).unwrap();
        let seeded = store.seed_synthetic(40, 65_536).unwrap();
        assert_eq!(seeded.rows_written, 40);
        assert_eq!(seeded.total_payload_bytes, 2_621_440);
        assert_eq!(seeded.committed_batches, 3);
        assert_eq!(store.summarize().unwrap().rows, Some(40));
        assert!(matches!(store.seed_synthetic(1, 8), Err(StoreError::InvalidInput(_))));
    }

    #[test]
    fn sqlite_transaction_rolls_back_after_later_failure() {
        let directory = TestDirectory::new();
        let mut store = DiskStore::open(directory.file("synthetic.sqlite"), false).unwrap();
        store.seed_synthetic(2, 8).unwrap();
        {
            let tx = store.connection.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
            tx.execute("UPDATE lawcore_synthetic_rows SET payload='changed',revision=revision+1 WHERE id=1", []).unwrap();
            // A real later SQL constraint failure must roll back the earlier write.
            let failed = tx.execute("INSERT INTO lawcore_synthetic_rows(id,payload) VALUES(1,'duplicate')", []);
            assert!(failed.is_err());
        }
        let rows = store.page(0, 2).unwrap();
        assert_eq!(rows[0].payload, "xxxxxxxx");
        assert_eq!(rows[0].revision, 1);
        let updated = store.update(1, "ยืนยัน").unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(store.page(0, 1).unwrap()[0].payload, "ยืนยัน");
        assert!(matches!(store.update(99, "missing"), Err(StoreError::NotFound(99))));
        assert_eq!(store.summarize().unwrap().rows, Some(2));
    }

    #[test]
    fn online_backup_contains_committed_wal_and_never_overwrites() {
        let directory = TestDirectory::new();
        let source_path = directory.file("synthetic.sqlite");
        let target_path = directory.file("snapshot.sqlite");
        let mut source = DiskStore::open(&source_path, false).unwrap();
        source.seed_synthetic(12, 1_024).unwrap();
        source.connection.pragma_update(None, "wal_autocheckpoint", 0_i64).unwrap();
        source.update(4, "committed in WAL").unwrap();
        assert!(source.summarize().unwrap().wal_bytes > 0);
        let backup = source.backup_to(&target_path).unwrap();
        assert!(backup.consistent_snapshot && backup.pages_copied > 0 && backup.byte_size > 0);
        let snapshot = DiskStore::open(&target_path, true).unwrap();
        assert_eq!(snapshot.summarize().unwrap().rows, Some(12));
        assert_eq!(snapshot.page(3, 1).unwrap()[0].payload, "committed in WAL");
        source.update(4, "later source update").unwrap();
        assert_eq!(snapshot.page(3, 1).unwrap()[0].payload, "committed in WAL");
        let target_before = fs::read(&target_path).unwrap();
        assert!(source.backup_to(&target_path).is_err());
        assert_eq!(fs::read(&target_path).unwrap(), target_before);
        assert!(matches!(source.backup_to(&source_path), Err(StoreError::UnsafePath(_))));
        assert!(matches!(source.backup_to(sidecar(&source_path, "-wal")), Err(StoreError::UnsafePath(_))));
    }

    #[test]
    fn backup_rejects_existing_destination_sidecars_without_touching_bytes() {
        let directory = TestDirectory::new();
        let mut store = DiskStore::open(directory.file("synthetic.sqlite"), false).unwrap();
        store.seed_synthetic(2, 32).unwrap();
        let before_source = store.page(0, 2).unwrap()[0].payload.clone();
        for suffix in ["-wal", "-shm", "-journal"] {
            let target = directory.file(&format!("target{}.sqlite", suffix));
            let existing_sidecar = sidecar(&target, suffix);
            let preserved = format!("preexisting independent {suffix} bytes").into_bytes();
            fs::write(&existing_sidecar, &preserved).unwrap();
            assert!(matches!(store.backup_to(&target), Err(StoreError::UnsafePath(_))));
            assert!(!target.exists());
            assert_eq!(fs::read(&existing_sidecar).unwrap(), preserved);
            assert!(fs::symlink_metadata(&existing_sidecar).unwrap().is_file());
        }
        let target = directory.file("existing-main.sqlite");
        let existing_bytes = b"unrelated existing main file";
        fs::write(&target, existing_bytes).unwrap();
        for suffix in ["-wal", "-shm", "-journal"] {
            fs::write(sidecar(&target, suffix), suffix.as_bytes()).unwrap();
        }
        assert!(matches!(store.backup_to(&target), Err(StoreError::UnsafePath(_))));
        assert_eq!(fs::read(&target).unwrap(), existing_bytes);
        for suffix in ["-wal", "-shm", "-journal"] {
            assert_eq!(fs::read(sidecar(&target, suffix)).unwrap(), suffix.as_bytes());
        }
        assert_eq!(store.page(0, 1).unwrap()[0].payload, before_source);
        assert!(!fs::read_dir(&directory.0).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".lawcore-backup-")));
    }

    #[cfg(unix)]
    #[test]
    fn backup_rejects_dangling_sidecar_links_without_removing_them() {
        use std::os::unix::fs::symlink;
        let directory = TestDirectory::new();
        let mut store = DiskStore::open(directory.file("synthetic.sqlite"), false).unwrap();
        store.seed_synthetic(1, 32).unwrap();
        let missing = directory.file("must-remain-absent");
        for (index, suffix) in ["-wal", "-shm", "-journal"].iter().enumerate() {
            let target = directory.file(&format!("dangling-{index}.sqlite"));
            let link = sidecar(&target, suffix);
            symlink(&missing, &link).unwrap();
            assert!(matches!(store.backup_to(&target), Err(StoreError::UnsafePath(_))));
            assert!(!target.exists());
            assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
            assert_eq!(fs::read_link(&link).unwrap(), missing);
        }
        assert!(!missing.exists());
    }

    #[test]
    fn schema7_workspace_is_checked_read_only_without_changing_bytes() {
        let directory = TestDirectory::new();
        let path = directory.file("workspace.sqlite");
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch("CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(7); CREATE TABLE contracts(id TEXT PRIMARY KEY,title TEXT NOT NULL); INSERT INTO contracts VALUES('synthetic','Synthetic fixture only');").unwrap();
        }
        let bytes_before = fs::read(&path).unwrap();
        {
            let mut store = DiskStore::open(&path, true).unwrap();
            let checked = store.check_workspace_schema7().unwrap();
            assert!(checked.read_only && checked.version == 7);
            let summary = store.summarize().unwrap();
            assert_eq!(summary.schema_version, Some(7));
            assert!(summary.pragmas.query_only && summary.rows.is_none());
            assert!(matches!(store.seed_synthetic(1, 8), Err(StoreError::ReadOnly)));
            assert!(matches!(store.update(1, "blocked"), Err(StoreError::ReadOnly)));
            assert!(matches!(store.page(0, 1), Err(StoreError::SyntheticOnly)));
        }
        // Byte equality is stronger than merely comparing a before/after hash.
        assert_eq!(fs::read(&path).unwrap(), bytes_before);
        assert!(matches!(DiskStore::open(&path, false), Err(StoreError::SyntheticOnly)));
        assert_eq!(fs::read(&path).unwrap(), bytes_before);
    }

    #[test]
    fn schema8_is_not_reported_as_supported_workspace() {
        let directory = TestDirectory::new();
        let path = directory.file("workspace.sqlite");
        {
            let connection = Connection::open(&path).unwrap();
            connection.execute_batch("CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(8);").unwrap();
        }
        let store = DiskStore::open(&path, true).unwrap();
        assert!(matches!(store.check_workspace_schema7(), Err(StoreError::UnsupportedWorkspaceSchema(Some(8)))));
    }

    #[cfg(unix)]
    #[test]
    fn source_links_are_rejected_and_backups_are_private() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = TestDirectory::new();
        let path = directory.file("synthetic.sqlite");
        let mut store = DiskStore::open(&path, false).unwrap();
        store.seed_synthetic(1, 10).unwrap();
        symlink(&path, directory.file("alias.sqlite")).unwrap();
        assert!(matches!(DiskStore::open(directory.file("alias.sqlite"), true), Err(StoreError::UnsafePath(_))));
        assert!(store.backup_to(directory.file("alias.sqlite")).is_err());
        let backup = directory.file("private.sqlite");
        store.backup_to(&backup).unwrap();
        assert_eq!(fs::metadata(backup).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
