//! Disk-backed SQLite owned by the existing core worker. The renderer receives
//! domain DTOs; this trusted-worker API must never be exposed over renderer IPC.
//! No database image is exported or retained for transaction rollback.

use fallible_iterator::FallibleIterator;
use napi::bindgen_prelude::{Function, Result};
use napi_derive::napi;
use rusqlite::backup::{Backup, StepResult};
use rusqlite::config::DbConfig;
use rusqlite::limits::Limit;
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Batch, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MIB: usize = 1024 * 1024;
static BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn error(message: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(message.to_string())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct Options {
    cache_ki_b: u32,
    max_query_bytes: usize,
    max_rows_bytes: usize,
    max_rows: usize,
    read_only: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { cache_ki_b: 8192, max_query_bytes: 64 * MIB, max_rows_bytes: 256 * MIB, max_rows: 1_000_000, read_only: false }
    }
}

impl Options {
    fn parse(json: Option<String>) -> Result<Self> {
        let options: Self = match json {
            Some(value) => {
                if value.len() > 8192 { return Err(error("Native SQLite options are too large")); }
                serde_json::from_str(&value).map_err(error)?
            }
            None => Self::default(),
        };
        if !(256..=65_536).contains(&options.cache_ki_b)
            || !(1024..=256 * MIB).contains(&options.max_query_bytes)
            || !(1024..=512 * MIB).contains(&options.max_rows_bytes)
            || !(1..=1_000_000).contains(&options.max_rows) {
            return Err(error("Native SQLite limits are outside the supported range"));
        }
        Ok(options)
    }
}

/// A kernel-held lease has no stale-PID deletion race. Its file remains in place;
/// closing the handle or terminating its process releases the exclusive lock.
#[napi]
pub struct WorkspaceLease {
    file: Option<fs::File>,
}

#[napi]
impl WorkspaceLease {
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        let requested = Path::new(&path);
        let filename = requested.file_name().filter(|name| !name.is_empty()).ok_or_else(|| error("Workspace lease requires a filename"))?;
        let parent = requested.parent().filter(|parent| !parent.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
        let path = fs::canonicalize(parent).map_err(error)?.join(filename);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.file_type().is_file() || metadata.file_type().is_symlink() => return Err(error("Workspace lease must be a regular file, not a symbolic link")),
            Ok(_) => {},
            Err(cause) if cause.kind() == io::ErrorKind::NotFound => {},
            Err(cause) => return Err(error(cause)),
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)] {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            // Open the reparse point itself so a symlink cannot redirect us.
            options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let file = options.open(&path).map_err(error)?;
        let metadata = file.metadata().map_err(error)?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(error("Workspace lease must be a regular file, not a symbolic link"));
        }
        match file.try_lock() {
            Ok(()) => {},
            Err(fs::TryLockError::WouldBlock) => return Err(error("Workspace is already open by another instance")),
            Err(fs::TryLockError::Error(cause)) => return Err(error(format!("Cannot lock workspace: {cause}"))),
        }
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(error)?;
        }
        Ok(Self { file: Some(file) })
    }

    #[napi]
    pub fn close(&mut self) {
        // No unlink, rename, cloned handle, or background thread can accidentally
        // separate future contenders from the inode whose lock is held here.
        drop(self.file.take());
    }
}

#[napi]
pub struct NativeDatabase {
    connection: Option<Connection>,
    path: PathBuf,
    options: Options,
}

#[napi]
impl NativeDatabase {
    #[napi(constructor)]
    pub fn new(path: String, options_json: Option<String>) -> Result<Self> {
        let options = Options::parse(options_json)?;
        let requested = Path::new(&path);
        if path.is_empty() || requested == Path::new(":memory:") || path.starts_with("file:") {
            return Err(error("Native SQLite requires an explicit regular disk file"));
        }
        let filename = requested.file_name().ok_or_else(|| error("Database path requires a filename"))?;
        let parent = requested.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
        let canonical = fs::canonicalize(parent).map_err(error)?.join(filename);
        match fs::symlink_metadata(&canonical) {
            Ok(metadata) if !metadata.file_type().is_file() || metadata.file_type().is_symlink() => return Err(error("Database must be a regular file, not a symbolic link")),
            Ok(_) => {},
            Err(e) if e.kind() == io::ErrorKind::NotFound && !options.read_only => create_private_file(&canonical)?,
            Err(e) => return Err(error(e)),
        }
        for suffix in ["-wal", "-shm", "-journal"] {
            match fs::symlink_metadata(sidecar(&canonical, suffix)) {
                Ok(metadata) if !metadata.file_type().is_file() || metadata.file_type().is_symlink() => return Err(error("Database sidecars must be regular files, not symbolic links")),
                Ok(_) => {},
                Err(e) if e.kind() == io::ErrorKind::NotFound => {},
                Err(e) => return Err(error(e)),
            }
        }
        let access = if options.read_only { OpenFlags::SQLITE_OPEN_READ_ONLY } else { OpenFlags::SQLITE_OPEN_READ_WRITE };
        let connection = Connection::open_with_flags(&canonical, access | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE | OpenFlags::SQLITE_OPEN_NOFOLLOW).map_err(error)?;
        connection.busy_timeout(Duration::from_millis(2000)).map_err(error)?;
        connection.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false).map_err(error)?;
        connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true).map_err(error)?;
        // SAFETY: the worker owns this connection and SQLite retains no pointer.
        let code = unsafe { rusqlite::ffi::sqlite3_enable_load_extension(connection.handle(), 0) };
        if code != rusqlite::ffi::SQLITE_OK { return Err(error("Cannot disable SQLite extension loading")); }
        connection.set_limit(Limit::SQLITE_LIMIT_LENGTH, (64 * MIB) as i32).map_err(error)?;
        connection.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, MIB as i32).map_err(error)?;
        connection.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0).map_err(error)?;
        connection.set_limit(Limit::SQLITE_LIMIT_WORKER_THREADS, 0).map_err(error)?;
        connection.pragma_update(None, "cache_size", -(i64::from(options.cache_ki_b))).map_err(error)?;
        connection.pragma_update(None, "mmap_size", 0_i64).map_err(error)?;
        connection.pragma_update(None, "temp_store", "FILE").map_err(error)?;
        connection.pragma_update(None, "foreign_keys", true).map_err(error)?;
        if options.read_only {
            connection.pragma_update(None, "query_only", true).map_err(error)?;
        } else {
            connection.pragma_update(None, "journal_mode", "DELETE").map_err(error)?;
            connection.pragma_update(None, "synchronous", "FULL").map_err(error)?;
        }
        Ok(Self { connection: Some(connection), path: canonical, options })
    }

    /// Trusted worker SQL only. Without parameters this accepts migration batches.
    #[napi]
    pub fn run(&mut self, sql: String, params_json: Option<String>) -> Result<u32> {
        self.validate_sql(&sql)?;
        let connection = self.connection()?;
        if params_json.is_none() {
            connection.execute_batch(&sql).map_err(error)?;
        } else {
            let parameters = decode_parameters(params_json)?;
            let mut batch = Batch::new(connection, &sql);
            while let Some(mut statement) = batch.next().map_err(error)? {
                bind(&mut statement, &parameters)?;
                let mut rows = statement.raw_query();
                while rows.next().map_err(error)?.is_some() {}
            }
        }
        u32::try_from(connection.changes()).map_err(error)
    }

    /// SQL.js-compatible exec result. Empty SELECTs produce no result entry.
    #[napi]
    pub fn query(&mut self, sql: String, params_json: Option<String>) -> Result<String> {
        self.validate_sql(&sql)?;
        let parameters = params_json.map(|value| decode_parameters(Some(value))).transpose()?;
        let mut output = LimitedOutput::new(self.options.max_query_bytes);
        output.write_all(b"[").map_err(error)?;
        let mut batch = Batch::new(self.connection()?, &sql);
        let mut first_result = true;
        let mut row_count = 0_usize;
        while let Some(mut statement) = batch.next().map_err(error)? {
            if let Some(parameters) = &parameters { bind(&mut statement, parameters)?; }
            let columns: Vec<String> = statement.column_names().iter().map(|name| (*name).to_owned()).collect();
            let mut rows = statement.raw_query();
            let mut first_row = true;
            while let Some(row) = rows.next().map_err(error)? {
                row_count += 1;
                if row_count > self.options.max_rows { return Err(error("Native SQLite query row limit exceeded; use pagination")); }
                if first_row {
                    if !first_result { output.write_all(b",").map_err(error)?; }
                    output.write_all(b"{\"columns\":").map_err(error)?;
                    serde_json::to_writer(&mut output, &columns).map_err(error)?;
                    output.write_all(b",\"values\":[").map_err(error)?;
                } else { output.write_all(b",").map_err(error)?; }
                output.write_all(b"[").map_err(error)?;
                for index in 0..columns.len() {
                    if index > 0 { output.write_all(b",").map_err(error)?; }
                    write_value(&mut output, row.get_ref(index).map_err(error)?)?;
                }
                output.write_all(b"]").map_err(error)?;
                first_row = false;
            }
            if !first_row {
                output.write_all(b"]}").map_err(error)?;
                first_result = false;
            }
        }
        output.write_all(b"]").map_err(error)?;
        output.into_string()
    }

    /// Streams one object at a time; no Rust array of every result row is built.
    /// The callback is synchronous and exceptions abort the scan immediately.
    #[napi]
    pub fn query_rows(&mut self, sql: String, params_json: String, callback: Function<'_, String, ()>) -> Result<()> {
        self.walk_rows(&sql, Some(params_json), |row| callback.call(row))
    }

    #[napi]
    pub fn backup(&mut self, destination: String) -> Result<()> {
        self.backup_to(Path::new(&destination))
    }

    /// All changes are already persisted by SQLite COMMIT in FULL mode.
    #[napi]
    pub fn flush(&mut self) -> Result<()> {
        if !self.connection()?.is_autocommit() { return Err(error("Cannot flush an unfinished SQLite transaction")); }
        Ok(())
    }

    #[napi]
    pub fn close(&mut self) -> Result<()> {
        if let Some(connection) = self.connection.take() {
            if let Err((connection, cause)) = connection.close() {
                self.connection = Some(connection);
                return Err(error(cause));
            }
        }
        Ok(())
    }
}

impl NativeDatabase {
    fn connection(&self) -> Result<&Connection> {
        self.connection.as_ref().ok_or_else(|| error("Native SQLite database is closed"))
    }

    fn validate_sql(&self, sql: &str) -> Result<()> {
        if sql.len() > MIB { return Err(error("Native SQLite SQL text limit exceeded")); }
        if sql.as_bytes().contains(&0) { return Err(error("Native SQLite SQL contains a NUL byte")); }
        Ok(())
    }

    fn walk_rows(&self, sql: &str, params_json: Option<String>, mut receive: impl FnMut(String) -> Result<()>) -> Result<()> {
        self.validate_sql(sql)?;
        let parameters = decode_parameters(params_json)?;
        let mut statement = self.connection()?.prepare(sql).map_err(error)?;
        bind(&mut statement, &parameters)?;
        let columns: Vec<String> = statement.column_names().iter().map(|name| (*name).to_owned()).collect();
        let mut rows = statement.raw_query();
        let mut consumed = 0_usize;
        let mut row_count = 0_usize;
        while let Some(row) = rows.next().map_err(error)? {
            row_count += 1;
            if row_count > self.options.max_rows { return Err(error("Native SQLite query row limit exceeded; use pagination")); }
            let mut output = LimitedOutput::new(self.options.max_rows_bytes.saturating_sub(consumed));
            output.write_all(b"{").map_err(error)?;
            for (index, name) in columns.iter().enumerate() {
                if index > 0 { output.write_all(b",").map_err(error)?; }
                serde_json::to_writer(&mut output, name).map_err(error)?;
                output.write_all(b":").map_err(error)?;
                write_value(&mut output, row.get_ref(index).map_err(error)?)?;
            }
            output.write_all(b"}").map_err(error)?;
            consumed += output.bytes.len();
            receive(output.into_string()?)?;
        }
        Ok(())
    }

    fn backup_to(&self, destination: &Path) -> Result<()> {
        let connection = self.connection()?;
        if !connection.is_autocommit() { return Err(error("Backups require a committed SQLite transaction")); }
        let filename = destination.file_name().ok_or_else(|| error("Backup path requires a filename"))?;
        let parent = destination.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
        let parent = fs::canonicalize(parent).map_err(error)?;
        let destination = parent.join(filename);
        if destination == self.path || ["-wal", "-shm", "-journal"].iter().any(|suffix| destination == sidecar(&self.path, suffix)) {
            return Err(error("Backup path conflicts with the source database"));
        }
        ensure_new_backup(&destination)?;
        let staging_directory = private_backup_directory(&parent)?;
        let staging = staging_directory.join("snapshot.sqlite");
        let result = (|| {
            create_private_file(&staging)?;
            let mut target = Connection::open_with_flags(&staging, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW).map_err(error)?;
            target.pragma_update(None, "cache_size", -(i64::from(self.options.cache_ki_b))).map_err(error)?;
            target.pragma_update(None, "mmap_size", 0_i64).map_err(error)?;
            target.pragma_update(None, "synchronous", "FULL").map_err(error)?;
            {
                let backup = Backup::new(connection, &mut target).map_err(error)?;
                let deadline = Instant::now() + Duration::from_secs(30);
                loop {
                    match backup.step(64).map_err(error)? {
                        StepResult::Done => break,
                        StepResult::More => {},
                        StepResult::Busy | StepResult::Locked => std::thread::sleep(Duration::from_millis(5)),
                        _ => return Err(error("SQLite backup failed to complete")),
                    }
                    if Instant::now() >= deadline { return Err(error("SQLite backup timed out")); }
                }
            }
            let valid: String = target.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(error)?;
            if valid != "ok" { return Err(error("SQLite backup validation failed")); }
            target.close().map_err(|(_, cause)| error(cause))?;
            ensure_new_backup(&destination)?;
            // Publishing via hard link cannot overwrite a path inserted by a
            // competing process. SQLite never opens caller-owned sidecar paths.
            fs::hard_link(&staging, &destination).map_err(error)?;
            #[cfg(unix)]
            fs::File::open(&parent).and_then(|directory| directory.sync_all()).map_err(error)?;
            Ok(())
        })();
        let _ = fs::remove_dir_all(&staging_directory);
        result
    }
}

fn bind(statement: &mut rusqlite::Statement<'_>, parameters: &[Value]) -> Result<()> {
    if statement.parameter_count() != parameters.len() {
        return Err(error(format!("SQLite parameter count mismatch: expected {}, received {}", statement.parameter_count(), parameters.len())));
    }
    for (index, value) in parameters.iter().enumerate() { statement.raw_bind_parameter(index + 1, value).map_err(error)?; }
    Ok(())
}

fn decode_parameters(json: Option<String>) -> Result<Vec<Value>> {
    let Some(json) = json else { return Ok(Vec::new()); };
    if json.len() > 64 * MIB { return Err(error("Native SQLite parameter byte limit exceeded")); }
    let values: Vec<serde_json::Value> = serde_json::from_str(&json).map_err(error)?;
    if values.len() > 32_766 { return Err(error("Too many SQLite parameters")); }
    values.into_iter().map(|value| match value {
        serde_json::Value::Null => Ok(Value::Null),
        serde_json::Value::String(value) => Ok(Value::Text(value)),
        serde_json::Value::Number(value) => {
            if let Some(integer) = value.as_i64() { Ok(Value::Integer(integer)) }
            else { value.as_f64().filter(|number| number.is_finite()).map(Value::Real).ok_or_else(|| error("Invalid SQLite numeric parameter")) }
        }
        serde_json::Value::Object(mut value) if value.len() == 1 && value.contains_key("$blob") => {
            let bytes: Vec<u8> = serde_json::from_value(value.remove("$blob").expect("checked blob key")).map_err(error)?;
            Ok(Value::Blob(bytes))
        }
        _ => Err(error("SQLite parameters must be null, strings, numbers, or {$blob:[bytes]}")),
    }).collect()
}

struct LimitedOutput { bytes: Vec<u8>, limit: usize }
impl LimitedOutput {
    fn new(limit: usize) -> Self { Self { bytes: Vec::new(), limit } }
    fn into_string(self) -> Result<String> { String::from_utf8(self.bytes).map_err(error) }
}
impl Write for LimitedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(io::Error::other("Native SQLite query byte limit exceeded; use pagination"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> { Ok(()) }
}

#[derive(Serialize)]
struct Blob<'a> { #[serde(rename = "$blob")] bytes: &'a [u8] }
fn write_value(output: &mut LimitedOutput, value: ValueRef<'_>) -> Result<()> {
    match value {
        ValueRef::Null => output.write_all(b"null").map_err(error),
        ValueRef::Integer(value) => serde_json::to_writer(output, &value).map_err(error),
        ValueRef::Real(value) => {
            if !value.is_finite() { return Err(error("Non-finite SQLite numeric result cannot be serialized")); }
            serde_json::to_writer(output, &value).map_err(error)
        }
        ValueRef::Text(value) => serde_json::to_writer(output, std::str::from_utf8(value).map_err(error)?).map_err(error),
        ValueRef::Blob(bytes) => serde_json::to_writer(output, &Blob { bytes }).map_err(error),
    }
}

fn create_private_file(path: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    drop(options.open(path).map_err(error)?);
    Ok(())
}
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string(); name.push(suffix); PathBuf::from(name)
}
fn ensure_new_backup(path: &Path) -> Result<()> {
    for candidate in std::iter::once(path.to_path_buf()).chain(["-wal", "-shm", "-journal"].map(|suffix| sidecar(path, suffix))) {
        match fs::symlink_metadata(candidate) {
            Ok(_) => return Err(error("Backup destination or sidecar already exists")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {},
            Err(e) => return Err(error(e)),
        }
    }
    Ok(())
}
fn private_backup_directory(parent: &Path) -> Result<PathBuf> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(error)?.as_nanos();
    for _ in 0..16 {
        let sequence = BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".law-node-backup-{}-{stamp}-{sequence}", std::process::id()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
        match builder.create(&path) {
            Ok(()) => return Ok(path),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {},
            Err(e) => return Err(error(e)),
        }
    }
    Err(error("Could not create a private SQLite backup directory"))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let id = BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("law-node-test-{}-{stamp}-{id}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> PathBuf { self.0.join(name) }
        fn open(&self) -> NativeDatabase { NativeDatabase::new(self.path("business.sqlite").to_string_lossy().into(), None).unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn parse(value: String) -> serde_json::Value { serde_json::from_str(&value).unwrap() }

    #[test]
    fn disk_transaction_rollback_retains_prior_committed_rows() {
        let fixture = Fixture::new();
        let mut database = fixture.open();
        database.run("CREATE TABLE records(id INTEGER PRIMARY KEY,payload TEXT NOT NULL UNIQUE); INSERT INTO records VALUES(1,'original');".into(), None).unwrap();
        database.run("BEGIN IMMEDIATE".into(), None).unwrap();
        database.run("UPDATE records SET payload=? WHERE id=1".into(), Some(r#"["replacement"]"#.into())).unwrap();
        assert!(database.run("INSERT INTO records VALUES(2,'replacement')".into(), None).is_err());
        database.run("ROLLBACK".into(), None).unwrap();
        database.close().unwrap();
        let mut reopened = fixture.open();
        assert_eq!(parse(reopened.query("SELECT id,payload FROM records".into(), None).unwrap())[0]["values"], serde_json::json!([[1,"original"]]));
    }

    #[test]
    fn query_preserves_order_null_unicode_blob_and_multi_statement() {
        let fixture = Fixture::new(); let mut database = fixture.open();
        database.run("CREATE TABLE records(id INTEGER PRIMARY KEY,payload,missing);".into(), None).unwrap();
        database.run("INSERT INTO records VALUES(?,?,?)".into(), Some(r#"[2,{"$blob":[0,1,128,255]},null]"#.into())).unwrap();
        database.run("INSERT INTO records VALUES(?,?,?)".into(), Some(r#"[1,"中文 ไทย 😀",null]"#.into())).unwrap();
        let result = parse(database.query("SELECT id,payload,missing FROM records ORDER BY id; SELECT 5 AS count; SELECT 1 WHERE 0;".into(), None).unwrap());
        assert_eq!(result, serde_json::json!([
            {"columns":["id","payload","missing"],"values":[[1,"中文 ไทย 😀",null],[2,{"$blob":[0,1,128,255]},null]]},
            {"columns":["count"],"values":[[5]]}
        ]));
    }

    #[test]
    fn streaming_rows_do_not_preload_results_and_callback_errors_propagate() {
        let fixture = Fixture::new(); let mut database = fixture.open();
        database.run("CREATE TABLE records(id PRIMARY KEY); INSERT INTO records VALUES(1),(2),(3);".into(), None).unwrap();
        let mut observed = Vec::new();
        let result = database.walk_rows("SELECT id FROM records ORDER BY id", None, |row| {
            observed.push(row); if observed.len() == 2 { Err(error("cancel callback")) } else { Ok(()) }
        });
        assert!(result.unwrap_err().reason.contains("cancel callback"));
        assert_eq!(observed, vec![r#"{"id":1}"#, r#"{"id":2}"#]);
        assert!(database.run("INSERT INTO records VALUES(4)".into(), None).is_ok());
    }

    #[test]
    fn result_bounds_fail_explicitly_without_truncating() {
        let fixture = Fixture::new();
        let mut database = NativeDatabase::new(fixture.path("bounded.sqlite").to_string_lossy().into(), Some(r#"{"maxQueryBytes":1024,"maxRowsBytes":1024,"maxRows":2}"#.into())).unwrap();
        assert!(database.query("SELECT hex(zeroblob(1000)) AS payload".into(), None).unwrap_err().reason.contains("byte limit"));
        assert!(database.query("SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3".into(), None).unwrap_err().reason.contains("row limit"));
        assert!(database.walk_rows("SELECT hex(zeroblob(1000)) AS payload", None, |_| panic!("oversized row must not be delivered")).unwrap_err().reason.contains("byte limit"));
        assert_eq!(parse(database.query("SELECT 1 AS ok".into(), None).unwrap())[0]["values"][0][0], 1);
    }

    #[test]
    fn backup_includes_committed_rows_and_refuses_overwrite_or_foreign_sidecars() {
        let fixture = Fixture::new(); let mut database = fixture.open();
        database.run("CREATE TABLE records(id); INSERT INTO records VALUES(1),(2);".into(), None).unwrap();
        let snapshot = fixture.path("snapshot.sqlite");
        database.backup(snapshot.to_string_lossy().into()).unwrap();
        let original = fs::read(&snapshot).unwrap();
        assert!(database.backup(snapshot.to_string_lossy().into()).is_err());
        assert_eq!(fs::read(&snapshot).unwrap(), original);
        let blocked = fixture.path("blocked.sqlite");
        fs::write(sidecar(&blocked, "-journal"), b"caller-owned-journal").unwrap();
        assert!(database.backup(blocked.to_string_lossy().into()).is_err());
        assert!(!blocked.exists());
        assert_eq!(fs::read(sidecar(&blocked, "-journal")).unwrap(), b"caller-owned-journal");
        let checked = Connection::open(&snapshot).unwrap();
        assert_eq!(checked.query_row("SELECT COUNT(*) FROM records", [], |row| row.get::<_, i64>(0)).unwrap(), 2);
        assert!(!fs::read_dir(&fixture.0).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().starts_with(".law-node-backup-")));
    }

    #[test]
    fn backup_uses_online_api_for_wal_and_refuses_uncommitted_state() {
        let fixture = Fixture::new(); let mut database = fixture.open();
        database.run("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records(id); INSERT INTO records VALUES(7);".into(), None).unwrap();
        assert!(sidecar(&fixture.path("business.sqlite"), "-wal").exists());
        let snapshot = fixture.path("wal-snapshot.sqlite");
        database.backup(snapshot.to_string_lossy().into()).unwrap();
        let checked = Connection::open(&snapshot).unwrap();
        assert_eq!(checked.query_row("SELECT id FROM records", [], |row| row.get::<_, i64>(0)).unwrap(), 7);
        database.run("BEGIN; INSERT INTO records VALUES(8);".into(), None).unwrap();
        assert!(database.backup(fixture.path("pending.sqlite").to_string_lossy().into()).unwrap_err().reason.contains("committed"));
        assert!(database.flush().is_err());
        database.run("ROLLBACK".into(), None).unwrap(); database.flush().unwrap();
    }

    #[test]
    fn read_only_open_does_not_change_legacy_database_bytes() {
        let fixture = Fixture::new(); let mut database = fixture.open();
        database.run("CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(7);".into(), None).unwrap();
        database.close().unwrap();
        let before = fs::read(fixture.path("business.sqlite")).unwrap();
        let mut readonly = NativeDatabase::new(fixture.path("business.sqlite").to_string_lossy().into(), Some(r#"{"readOnly":true}"#.into())).unwrap();
        assert_eq!(parse(readonly.query("SELECT version FROM schema_version".into(), None).unwrap())[0]["values"][0][0], 7);
        assert!(readonly.run("DELETE FROM schema_version".into(), None).is_err());
        readonly.close().unwrap();
        assert_eq!(fs::read(fixture.path("business.sqlite")).unwrap(), before);
    }

    #[test]
    fn policy_is_disk_bounded_and_extensions_and_attach_are_disabled() {
        let fixture = Fixture::new(); let mut database = fixture.open();
        let result = parse(database.query("PRAGMA cache_size; PRAGMA mmap_size; PRAGMA foreign_keys; PRAGMA journal_mode; PRAGMA synchronous; PRAGMA trusted_schema;".into(), None).unwrap());
        assert_eq!(result[0]["values"][0][0], -8192); assert_eq!(result[1]["values"][0][0], 0);
        assert_eq!(result[2]["values"][0][0], 1); assert_eq!(result[3]["values"][0][0], "delete");
        assert_eq!(result[4]["values"][0][0], 2); assert_eq!(result[5]["values"][0][0], 0);
        assert!(database.query("SELECT load_extension('unavailable')".into(), None).is_err());
        assert!(database.run("ATTACH DATABASE ':memory:' AS alternate".into(), None).is_err());
    }

    #[test]
    fn close_is_idempotent_and_invalid_parameters_fail() {
        let fixture = Fixture::new(); let mut database = fixture.open();
        assert!(database.query("SELECT ?".into(), Some("[]".into())).is_err());
        assert!(database.query("SELECT ?".into(), Some("[true]".into())).is_err());
        assert!(database.query("SELECT ?".into(), Some(r#"[{"$blob":[256]}]"#.into())).is_err());
        database.close().unwrap(); database.close().unwrap();
        assert!(database.query("SELECT 1".into(), None).unwrap_err().reason.contains("closed"));
    }

    #[test]
    fn kernel_workspace_lease_is_exclusive_until_close_or_drop() {
        let fixture = Fixture::new();
        let filename = fixture.path(".workspace-writer.lock").to_string_lossy().into_owned();
        let mut first = WorkspaceLease::new(filename.clone()).unwrap();
        assert!(WorkspaceLease::new(filename.clone()).err().unwrap().reason.contains("already open"));
        first.close(); first.close();
        let second = WorkspaceLease::new(filename.clone()).unwrap();
        assert!(Path::new(&filename).is_file());
        drop(second);
        let mut third = WorkspaceLease::new(filename.clone()).unwrap(); third.close();
        assert!(Path::new(&filename).is_file(), "A lease must never unlink its lock file");
    }

    #[cfg(unix)]
    #[test]
    fn kernel_workspace_lease_refuses_symbolic_links() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let target = fixture.path("caller-file"); fs::write(&target, b"unchanged").unwrap();
        let link = fixture.path(".workspace-writer.lock"); symlink(&target, &link).unwrap();
        assert!(WorkspaceLease::new(link.to_string_lossy().into()).is_err());
        assert_eq!(fs::read(target).unwrap(), b"unchanged");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_and_creates_private_database_permissions() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};
        let fixture = Fixture::new(); let mut database = fixture.open();
        assert_eq!(fs::metadata(fixture.path("business.sqlite")).unwrap().permissions().mode() & 0o777, 0o600);
        database.close().unwrap();
        let link = fixture.path("link.sqlite"); symlink(fixture.path("business.sqlite"), &link).unwrap();
        assert!(NativeDatabase::new(link.to_string_lossy().into(), None).is_err());
        let sidecar_link = sidecar(&fixture.path("business.sqlite"), "-journal");
        symlink(fixture.path("other.sqlite"), &sidecar_link).unwrap();
        assert!(NativeDatabase::new(fixture.path("business.sqlite").to_string_lossy().into(), None).is_err());
    }
}
