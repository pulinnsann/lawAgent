//! Offline administrator signer. Only public keys belong in the application.
//! Opening an issuer never creates or resets its ledger; the operator selects
//! the existing, complete signing directory, including its identity marker.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use ed25519_dalek::{pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePublicKey}, Signature, Signer, SigningKey, VerifyingKey};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs::{self, Metadata, OpenOptions}, io::Read, path::{Path, PathBuf}, time::Duration};
use uuid::Uuid;

const LIMIT: usize = 100;
const TRIAL_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const FUTURE_MS: i64 = 365 * 24 * 60 * 60 * 1000;
const MAX_DB: u64 = 16 * 1024 * 1024;
const APP_ID: i64 = 0x4c415731;
const META_SQL: &str = "CREATE TABLE issuer_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), kid TEXT NOT NULL, public_key_sha256 TEXT NOT NULL)";
const LICENSE_SQL: &str = "CREATE TABLE licenses (license_id TEXT PRIMARY KEY NOT NULL, seat INTEGER NOT NULL UNIQUE CHECK(seat BETWEEN 1 AND 100), device_code TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL, starts_at TEXT NOT NULL, expires_at TEXT NOT NULL, token TEXT NOT NULL)";
const LEDGER_ERROR: &str = "签发记录不可用或未通过校验。请保留完整签发资料，不要删除或重置记录。";
const KEY_ERROR: &str = "签发私钥不可用或与本发行版的公钥不匹配。";
const INPUT_ERROR: &str = "请核对设备码，并将开始时间留空或选择当前时间之后的未来 365 天以内。";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LicenseSummary {
    pub license_id: String,
    pub seat: usize,
    pub device_code: String,
    pub issued_at: String,
    pub starts_at: String,
    pub expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuerState {
    pub limit: usize,
    pub issued: usize,
    pub remaining: usize,
    pub key_id: String,
    pub public_key_sha256: String,
    pub licenses: Vec<LicenseSummary>,
}

#[derive(Debug, Serialize)]
pub struct IssuedLicense {
    pub license: LicenseSummary,
    pub token: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payload {
    version: u8,
    product: String,
    license_id: String,
    seat: usize,
    device_code: String,
    issued_at: String,
    starts_at: String,
    expires_at: String,
}

impl Payload {
    fn summary(&self) -> LicenseSummary {
        LicenseSummary { license_id: self.license_id.clone(), seat: self.seat,
            device_code: self.device_code.clone(), issued_at: self.issued_at.clone(),
            starts_at: self.starts_at.clone(), expires_at: self.expires_at.clone() }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity { version: u8, key_id: String, public_key_sha256: String }

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity(u64, u64);

#[cfg(unix)]
fn identity(path: &Path) -> Result<FileIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let stat = fs::symlink_metadata(path).map_err(|_| LEDGER_ERROR)?;
    if stat.file_type().is_symlink() { return Err(LEDGER_ERROR.into()); }
    Ok(FileIdentity(stat.dev(), stat.ino()))
}

#[cfg(windows)]
fn identity(path: &Path) -> Result<FileIdentity, String> {
    let value = crate::permissions::file_identity(path)?;
    Ok(FileIdentity(value[0], value[1]))
}

fn unchanged(a: &Metadata, b: &Metadata) -> bool {
    #[cfg(unix)] {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino() && a.len() == b.len()
            && a.mtime() == b.mtime() && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec()
    }
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        a.file_size() == b.file_size() && a.creation_time() == b.creation_time()
            && a.last_write_time() == b.last_write_time() && a.file_attributes() == b.file_attributes()
    }
}

/// Bounded, no-follow reads with path/handle consistency checks. Bytes are
/// never rendered, logged, or returned through a desktop command.
fn read_private(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    crate::permissions::check_file(path)?;
    let original_id = identity(path)?;
    let before = fs::symlink_metadata(path).map_err(|_| LEDGER_ERROR)?;
    if before.len() == 0 || before.len() > maximum { return Err(LEDGER_ERROR.into()); }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)] {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let mut file = options.open(path).map_err(|_| LEDGER_ERROR)?;
    let pinned = file.metadata().map_err(|_| LEDGER_ERROR)?;
    let handle_id = crate::permissions::handle_identity(&file)?;
    if !unchanged(&before, &pinned) || FileIdentity(handle_id[0], handle_id[1]) != original_id {
        return Err(LEDGER_ERROR.into());
    }
    let mut bytes = Vec::with_capacity((before.len() + 1) as usize);
    let result = (&mut file).take(maximum + 1).read_to_end(&mut bytes);
    let validated = (|| {
        let after = file.metadata().map_err(|_| LEDGER_ERROR)?;
        let final_stat = fs::symlink_metadata(path).map_err(|_| LEDGER_ERROR)?;
        if result.is_err() || bytes.len() as u64 != before.len() || !unchanged(&before, &after)
            || !unchanged(&after, &final_stat) || identity(path)? != original_id {
            return Err(LEDGER_ERROR.to_owned());
        }
        crate::permissions::check_file(path)
    })();
    if let Err(error) = validated { bytes.fill(0); return Err(error); }
    Ok(bytes)
}

fn utc(value: &str) -> Option<i64> {
    if !matches!(value.len(), 20 | 24) || !value.ends_with('Z') || !value.is_ascii() { return None; }
    let date = DateTime::parse_from_rfc3339(value).ok()?.with_timezone(&Utc);
    let canonical = date.to_rfc3339_opts(SecondsFormat::Millis, true);
    let expected = if value.len() == 20 { format!("{}.000Z", &value[..19]) } else { value.to_owned() };
    (canonical == expected).then_some(date.timestamp_millis())
}

fn iso(milliseconds: i64) -> Result<String, String> {
    DateTime::<Utc>::from_timestamp_millis(milliseconds)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true)).ok_or_else(|| INPUT_ERROR.into())
}

fn device_valid(value: &str) -> bool {
    value.len() == 72 && value.starts_with("LAWDEV1-")
        && value.as_bytes()[8..].iter().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn uuid_valid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.get_version_num() == 4
        && id.get_variant() == uuid::Variant::RFC4122 && id.to_string() == value)
}

pub struct Issuer {
    directory: PathBuf,
    directory_identity: FileIdentity,
    database_identity: FileIdentity,
    db: Connection,
    private_key: SigningKey,
    public_key: VerifyingKey,
    kid: String,
    fingerprint: String,
    now: Box<dyn Fn() -> i64 + Send>,
}

impl Issuer {
    pub fn open(directory: &Path) -> Result<Self, String> {
        Self::open_with(directory, crate::OFFICIAL_KEY_ID, crate::OFFICIAL_PUBLIC_KEY_PEM, || Utc::now().timestamp_millis())
    }

    #[cfg(feature = "issuer-smoke")]
    pub fn open_diagnostic(directory: &Path, public_key_pem: &str, now_ms: i64) -> Result<Self, String> {
        Self::open_with(directory, crate::OFFICIAL_KEY_ID, public_key_pem, move || now_ms)
    }

    fn open_with(directory: &Path, kid: &str, expected_public_pem: &str, now: impl Fn() -> i64 + Send + 'static) -> Result<Self, String> {
        if !directory.is_absolute() || !valid_kid(kid) { return Err(LEDGER_ERROR.into()); }
        crate::permissions::check_directory(directory)?;
        let directory = directory.canonicalize().map_err(|_| LEDGER_ERROR)?;
        crate::permissions::check_directory(&directory)?;
        let directory_identity = identity(&directory)?;
        let key_path = directory.join("issuer-private.pem");
        let mut private_bytes = read_private(&key_path, 2048).map_err(|_| KEY_ERROR)?;
        let key_result = std::str::from_utf8(&private_bytes).ok()
            .and_then(|pem| SigningKey::from_pkcs8_pem(pem).ok());
        private_bytes.fill(0);
        let private_key = key_result.ok_or(KEY_ERROR)?;
        let public_key = VerifyingKey::from_public_key_pem(expected_public_pem).map_err(|_| KEY_ERROR)?;
        if private_key.verifying_key() != public_key { return Err(KEY_ERROR.into()); }
        let public_der = public_key.to_public_key_der().map_err(|_| KEY_ERROR)?;
        let fingerprint = format!("{:x}", Sha256::digest(public_der.as_bytes()));
        let marker: Identity = serde_json::from_slice(&read_private(&directory.join("issuer-identity.json"), 1024)?)
            .map_err(|_| LEDGER_ERROR)?;
        if marker.version != 1 || marker.key_id != kid || marker.public_key_sha256 != fingerprint {
            return Err(LEDGER_ERROR.into());
        }
        let database_path = directory.join("licenses.sqlite");
        crate::permissions::check_file(&database_path)?;
        let metadata = fs::symlink_metadata(&database_path).map_err(|_| LEDGER_ERROR)?;
        if metadata.len() == 0 || metadata.len() > MAX_DB { return Err(LEDGER_ERROR.into()); }
        let database_identity = identity(&database_path)?;
        // SQLite can recover journals while opening a database, before the
        // first SELECT. Refuse linked/unowned sidecars before that can happen.
        check_sidecars(&directory)?;
        // Existing ledger only: SQLITE_OPEN_CREATE is intentionally absent.
        let db = Connection::open_with_flags(&database_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW)
            .map_err(|_| LEDGER_ERROR)?;
        db.busy_timeout(Duration::from_secs(5)).map_err(|_| LEDGER_ERROR)?;
        db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;")
            .map_err(|_| LEDGER_ERROR)?;
        let issuer = Self { directory, directory_identity, database_identity, db, private_key, public_key,
            kid: kid.to_owned(), fingerprint, now: Box::new(now) };
        issuer.guard()?;
        issuer.records()?;
        Ok(issuer)
    }

    pub fn directory(&self) -> &Path { &self.directory }

    fn guard(&self) -> Result<(), String> {
        crate::permissions::check_directory(&self.directory)?;
        if identity(&self.directory)? != self.directory_identity || self.directory.canonicalize().map_err(|_| LEDGER_ERROR)? != self.directory {
            return Err(LEDGER_ERROR.into());
        }
        let path = self.directory.join("licenses.sqlite");
        crate::permissions::check_file(&path)?;
        if identity(&path)? != self.database_identity || fs::symlink_metadata(&path).map_err(|_| LEDGER_ERROR)?.len() > MAX_DB {
            return Err(LEDGER_ERROR.into());
        }
        let marker: Identity = serde_json::from_slice(&read_private(&self.directory.join("issuer-identity.json"), 1024)?)
            .map_err(|_| LEDGER_ERROR)?;
        if marker.version != 1 || marker.key_id != self.kid || marker.public_key_sha256 != self.fingerprint { return Err(LEDGER_ERROR.into()); }
        check_sidecars(&self.directory)
    }

    fn records(&self) -> Result<Vec<IssuedLicense>, String> {
        let mut schema = self.db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").map_err(|_| LEDGER_ERROR)?;
        let objects = schema.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
            .map_err(|_| LEDGER_ERROR)?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| LEDGER_ERROR)?;
        if objects != vec![("table".into(), "issuer_meta".into(), META_SQL.into()), ("table".into(), "licenses".into(), LICENSE_SQL.into())] { return Err(LEDGER_ERROR.into()); }
        for (query, expected) in [("PRAGMA application_id", APP_ID), ("PRAGMA user_version", 1)] {
            if self.db.query_row(query, [], |row| row.get::<_, i64>(0)).map_err(|_| LEDGER_ERROR)? != expected { return Err(LEDGER_ERROR.into()); }
        }
        let mut metadata = self.db.prepare("SELECT id,version,kid,public_key_sha256 FROM issuer_meta").map_err(|_| LEDGER_ERROR)?;
        let meta = metadata.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))
            .map_err(|_| LEDGER_ERROR)?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| LEDGER_ERROR)?;
        if meta != vec![(1, 1, self.kid.clone(), self.fingerprint.clone())] { return Err(LEDGER_ERROR.into()); }
        let mut statement = self.db.prepare("SELECT license_id,seat,device_code,issued_at,starts_at,expires_at,token FROM licenses ORDER BY seat LIMIT 101").map_err(|_| LEDGER_ERROR)?;
        let records = statement.query_map([], |row| Ok(IssuedLicense {
            license: LicenseSummary { license_id: row.get(0)?, seat: row.get::<_,u32>(1)? as usize, device_code: row.get(2)?, issued_at: row.get(3)?, starts_at: row.get(4)?, expires_at: row.get(5)? }, token: row.get(6)?,
        })).map_err(|_| LEDGER_ERROR)?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_| LEDGER_ERROR)?;
        if records.len() > LIMIT { return Err(LEDGER_ERROR.into()); }
        let mut devices = std::collections::HashSet::new();
        for (index, record) in records.iter().enumerate() {
            let license = &record.license;
            let times = (utc(&license.issued_at), utc(&license.starts_at), utc(&license.expires_at));
            let (Some(issued), Some(start), Some(expiry)) = times else { return Err(LEDGER_ERROR.into()); };
            if !uuid_valid(&license.license_id) || license.seat != index + 1 || !device_valid(&license.device_code)
                || !devices.insert(&license.device_code) || issued > start || expiry.checked_sub(start) != Some(TRIAL_MS) {
                return Err(LEDGER_ERROR.into());
            }
            if self.verify_token(&record.token)? != *license { return Err(LEDGER_ERROR.into()); }
        }
        Ok(records)
    }

    fn verify_token(&self, token: &str) -> Result<LicenseSummary, String> {
        if token.len() > 4096 { return Err(LEDGER_ERROR.into()); }
        let pieces: Vec<_> = token.split('.').collect();
        if pieces.len() != 4 || pieces[0] != "LAW1" || pieces[1] != self.kid { return Err(LEDGER_ERROR.into()); }
        let bytes = URL_SAFE_NO_PAD.decode(pieces[2]).map_err(|_| LEDGER_ERROR)?;
        let signature_bytes = URL_SAFE_NO_PAD.decode(pieces[3]).map_err(|_| LEDGER_ERROR)?;
        if bytes.len() > 2048 || signature_bytes.len() != 64 || URL_SAFE_NO_PAD.encode(&bytes) != pieces[2]
            || URL_SAFE_NO_PAD.encode(&signature_bytes) != pieces[3] { return Err(LEDGER_ERROR.into()); }
        let signature = Signature::from_slice(&signature_bytes).map_err(|_| LEDGER_ERROR)?;
        let prefix = pieces[..3].join(".");
        self.public_key.verify_strict(prefix.as_bytes(), &signature).map_err(|_| LEDGER_ERROR)?;
        let payload: Payload = serde_json::from_slice(&bytes).map_err(|_| LEDGER_ERROR)?;
        if payload.version != 1 || payload.product != "law-agent" { return Err(LEDGER_ERROR.into()); }
        Ok(payload.summary())
    }

    pub fn state(&self) -> Result<IssuerState, String> {
        self.guard()?;
        let licenses: Vec<_> = self.records()?.into_iter().map(|record| record.license).collect();
        Ok(IssuerState { limit: LIMIT, issued: licenses.len(), remaining: LIMIT - licenses.len(),
            key_id: self.kid.clone(), public_key_sha256: self.fingerprint.clone(), licenses })
    }

    pub fn issue(&mut self, device_code: String, starts_at: Option<String>) -> Result<IssuedLicense, String> {
        let now = (self.now)();
        if !device_valid(&device_code) || now < 0 || now > 253402300799999 - FUTURE_MS - TRIAL_MS { return Err(INPUT_ERROR.into()); }
        let start = match starts_at { Some(value) => utc(&value).ok_or(INPUT_ERROR)?, None => now };
        if start < now || start - now > FUTURE_MS { return Err(INPUT_ERROR.into()); }
        self.guard()?;
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(|_| LEDGER_ERROR)?;
        let outcome = (|| {
            let records = self.records()?;
            if records.iter().any(|record| record.license.device_code == device_code) {
                return Err("此设备已签发体验许可，请在历史记录中取回原激活码。".into());
            }
            if records.len() >= LIMIT { return Err("100 份体验许可已全部签发，请保留本机签发记录。".into()); }
            let license = LicenseSummary { license_id: Uuid::new_v4().to_string(), seat: records.len() + 1, device_code,
                issued_at: iso(now)?, starts_at: iso(start)?, expires_at: iso(start + TRIAL_MS)? };
            let payload = Payload { version: 1, product: "law-agent".into(), license_id: license.license_id.clone(),
                seat: license.seat, device_code: license.device_code.clone(), issued_at: license.issued_at.clone(),
                starts_at: license.starts_at.clone(), expires_at: license.expires_at.clone() };
            let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).map_err(|_| LEDGER_ERROR)?);
            let prefix = format!("LAW1.{}.{}", self.kid, encoded);
            let signature = self.private_key.sign(prefix.as_bytes());
            let token = format!("{}.{}", prefix, URL_SAFE_NO_PAD.encode(signature.to_bytes()));
            if self.verify_token(&token)? != license { return Err(KEY_ERROR.into()); }
            self.db.execute("INSERT INTO licenses(license_id,seat,device_code,issued_at,starts_at,expires_at,token) VALUES(?,?,?,?,?,?,?)",
                params![license.license_id, license.seat as u32, license.device_code, license.issued_at, license.starts_at, license.expires_at, token])
                .map_err(|_| LEDGER_ERROR)?;
            self.guard()?;
            self.db.execute_batch("COMMIT").map_err(|_| LEDGER_ERROR)?;
            Ok(IssuedLicense { license, token })
        })();
        if outcome.is_err() { let _ = self.db.execute_batch("ROLLBACK"); }
        outcome
    }

    pub fn get_token(&self, license_id: String) -> Result<String, String> {
        if !uuid_valid(&license_id) { return Err("未找到此签发记录。".into()); }
        self.guard()?;
        self.records()?.into_iter().find(|record| record.license.license_id == license_id)
            .map(|record| record.token).ok_or_else(|| "未找到此签发记录。".into())
    }
}

fn valid_kid(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().enumerate().all(|(index, byte)|
        byte.is_ascii_alphanumeric() || index != 0 && matches!(byte, b'_' | b'-'))
}

fn check_sidecars(directory: &Path) -> Result<(), String> {
    for suffix in ["-journal", "-wal", "-shm"] {
        let sidecar = directory.join(format!("licenses.sqlite{suffix}"));
        match fs::symlink_metadata(&sidecar) {
            Ok(stat) => {
                crate::permissions::check_file(&sidecar)?;
                if stat.len() > MAX_DB { return Err(LEDGER_ERROR.into()); }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(LEDGER_ERROR.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::pkcs8::EncodePrivateKey;
    const NOW: i64 = 1_792_980_000_000;
    const KID: &str = "lawagent-trial-v1";

    struct Fixture { _temporary: tempfile::TempDir, directory: PathBuf, public: String }
    impl Fixture {
        fn new() -> Self {
            let temporary = tempfile::tempdir().unwrap();
            let directory = temporary.path().join("issuer");
            crate::permissions::secure_directory(&directory).unwrap();
            // This deterministic synthetic key exists only inside a disposable
            // test directory. Tests never read the operator's real issuer.
            let key = SigningKey::from_bytes(&[41; 32]);
            let public = key.verifying_key().to_public_key_pem(Default::default()).unwrap();
            let private = key.to_pkcs8_pem(Default::default()).unwrap();
            crate::permissions::create_private_file(&directory.join("issuer-private.pem"), private.as_bytes()).unwrap();
            let fingerprint = format!("{:x}", Sha256::digest(key.verifying_key().to_public_key_der().unwrap().as_bytes()));
            let marker = serde_json::json!({"version":1,"keyId":KID,"publicKeySha256":fingerprint});
            crate::permissions::create_private_file(&directory.join("issuer-identity.json"), &serde_json::to_vec(&marker).unwrap()).unwrap();
            crate::permissions::create_private_file(&directory.join("licenses.sqlite"), b"").unwrap();
            let db = Connection::open(directory.join("licenses.sqlite")).unwrap();
            db.execute_batch(META_SQL).unwrap(); db.execute_batch(LICENSE_SQL).unwrap();
            db.execute_batch(&format!("PRAGMA application_id={APP_ID}; PRAGMA user_version=1;")).unwrap();
            db.execute("INSERT INTO issuer_meta VALUES(1,1,?,?)", params![KID,fingerprint]).unwrap();
            drop(db);
            Self { _temporary: temporary, directory, public }
        }
        fn open(&self) -> Issuer { Issuer::open_with(self.directory.as_path(), KID, &self.public, || NOW).unwrap() }
    }

    fn device(index: usize) -> String { format!("LAWDEV1-{index:064x}") }

    #[test]
    fn signed_tokens_survive_restart_and_retrieval_without_new_seats() {
        let fixture = Fixture::new();
        let mut issuer = fixture.open();
        assert_eq!(issuer.state().unwrap().issued, 0);
        let result = issuer.issue(device(1), None).unwrap();
        assert_eq!(result.license.seat, 1);
        assert_eq!(utc(&result.license.expires_at).unwrap() - NOW, TRIAL_MS);
        assert_eq!(issuer.verify_token(&result.token).unwrap(), result.license);
        let license_id = result.license.license_id.clone();
        assert_eq!(issuer.get_token(license_id.clone()).unwrap(), result.token);
        drop(issuer);
        let reopened = fixture.open();
        assert_eq!(reopened.state().unwrap().issued, 1);
        assert_eq!(reopened.get_token(license_id).unwrap(), result.token);
    }

    #[test]
    fn all_hundred_slots_verify_and_next_issue_is_refused() {
        let fixture = Fixture::new(); let mut issuer = fixture.open();
        for index in 1..=100 {
            let result = issuer.issue(device(index), None).unwrap();
            assert_eq!(result.license.seat, index);
            assert_eq!(issuer.verify_token(&result.token).unwrap(), result.license);
        }
        assert!(issuer.issue(device(101), None).unwrap_err().contains("100"));
        let state = issuer.state().unwrap();
        assert_eq!(state.issued, 100); assert_eq!(state.remaining, 0);
    }

    #[test]
    fn duplicate_and_invalid_requests_never_consume_a_slot() {
        let fixture = Fixture::new(); let mut issuer = fixture.open();
        issuer.issue(device(1), None).unwrap();
        assert!(issuer.issue(device(1), None).is_err());
        for invalid in ["", "LAWDEV1-a", &format!("LAWDEV1-{}", "A".repeat(64))] {
            assert!(issuer.issue(invalid.into(), None).is_err());
        }
        for invalid in ["yesterday".to_owned(), iso(NOW-1).unwrap(), iso(NOW+FUTURE_MS+1).unwrap(), "2026-10-27T12:00:00+00:00".into()] {
            assert!(issuer.issue(device(2), Some(invalid)).is_err());
        }
        assert_eq!(issuer.state().unwrap().issued, 1);
        let future = issuer.issue(device(2), Some(iso(NOW+FUTURE_MS).unwrap())).unwrap();
        assert_eq!(utc(&future.license.expires_at).unwrap(), NOW+FUTURE_MS+TRIAL_MS);
    }

    #[test]
    fn missing_marker_or_database_never_reinitializes_the_ledger() {
        for missing in ["issuer-identity.json", "licenses.sqlite"] {
            let fixture = Fixture::new(); fs::remove_file(fixture.directory.join(missing)).unwrap();
            assert!(Issuer::open_with(fixture.directory.as_path(), KID, &fixture.public, || NOW).is_err());
            assert!(!fixture.directory.join(missing).exists());
        }
    }

    #[test]
    fn wrong_key_or_marker_is_rejected_without_modification() {
        let fixture = Fixture::new();
        let wrong_public = SigningKey::from_bytes(&[42;32]).verifying_key().to_public_key_pem(Default::default()).unwrap();
        assert!(Issuer::open_with(fixture.directory.as_path(), KID, &wrong_public, || NOW).is_err());
        let marker = fixture.directory.join("issuer-identity.json");
        fs::write(&marker, b"{\"version\":1,\"keyId\":\"wrong\",\"publicKeySha256\":\"wrong\"}").unwrap();
        assert!(Issuer::open_with(fixture.directory.as_path(), KID, &fixture.public, || NOW).is_err());
    }

    #[test]
    fn tampered_rows_tokens_and_schema_fail_closed() {
        for statement in [
            "UPDATE licenses SET token=token || 'x'",
            "UPDATE licenses SET expires_at='2099-01-01T00:00:00.000Z'",
            "UPDATE issuer_meta SET public_key_sha256='changed'",
            "CREATE TABLE unexpected (id INTEGER)",
            "PRAGMA application_id=1",
        ] {
            let fixture = Fixture::new(); let mut issuer = fixture.open();
            issuer.issue(device(1), None).unwrap();
            issuer.db.execute_batch(statement).unwrap();
            assert!(issuer.state().is_err(), "{statement}");
            assert!(issuer.issue(device(2), None).is_err(), "{statement}");
            assert_eq!(issuer.db.query_row("SELECT count(*) FROM licenses", [], |row| row.get::<_,i64>(0)).unwrap(),1);
        }
    }

    #[test]
    fn write_failure_returns_no_token_and_rolls_back() {
        let fixture = Fixture::new(); let mut issuer = fixture.open();
        issuer.db.execute_batch("PRAGMA query_only=ON").unwrap();
        assert!(issuer.issue(device(1), None).is_err());
        assert_eq!(issuer.state().unwrap().issued, 0);
        issuer.db.execute_batch("PRAGMA query_only=OFF").unwrap();
        assert_eq!(issuer.issue(device(1), None).unwrap().license.seat, 1);
    }

    #[test]
    fn competing_connections_keep_contiguous_unique_seats() {
        let fixture = Fixture::new();
        let mut first = fixture.open(); let mut second = fixture.open();
        for index in 1..=12 {
            let issuer = if index%2 == 0 { &mut first } else { &mut second };
            assert_eq!(issuer.issue(device(index), None).unwrap().license.seat, index);
        }
        assert_eq!(first.state().unwrap().issued,12);
        assert_eq!(second.state().unwrap().issued,12);
    }

    #[test]
    fn simultaneous_connections_serialize_quota_admission() {
        let fixture = Fixture::new();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut threads = Vec::new();
        for worker in 0..2 {
            let directory = fixture.directory.clone(); let public = fixture.public.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                let mut issuer = Issuer::open_with(&directory, KID, &public, || NOW).unwrap();
                barrier.wait();
                (1..=4).map(|index| issuer.issue(device(worker*4+index), None).unwrap().license.seat).collect::<Vec<_>>()
            }));
        }
        barrier.wait();
        let mut seats: Vec<_> = threads.into_iter().flat_map(|thread| thread.join().unwrap()).collect();
        seats.sort_unstable();
        assert_eq!(seats, (1..=8).collect::<Vec<_>>());
        assert_eq!(fixture.open().state().unwrap().issued,8);
    }

    #[cfg(unix)]
    #[test]
    fn linked_journal_is_rejected_before_sqlite_recovery() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let target = fixture.directory.join("unrelated-private-file");
        crate::permissions::create_private_file(&target, b"do not modify").unwrap();
        symlink(&target, fixture.directory.join("licenses.sqlite-journal")).unwrap();
        assert!(Issuer::open_with(&fixture.directory, KID, &fixture.public, || NOW).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"do not modify");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_and_replaced_ledger_paths_are_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new(); let issuer = fixture.open();
        let original = fixture.directory.join("licenses.sqlite");
        let moved = fixture.directory.join("moved.sqlite");
        fs::rename(&original, &moved).unwrap(); symlink(&moved, &original).unwrap();
        assert!(issuer.state().is_err());
        fs::remove_file(&original).unwrap(); fs::copy(&moved, &original).unwrap();
        assert!(issuer.state().is_err());
    }

    #[test]
    fn strict_times_and_identifiers_reject_ambiguous_values() {
        assert!(utc("2026-02-30T00:00:00.000Z").is_none());
        assert!(utc("2026-01-01T00:00:00.00Z").is_none());
        assert!(utc("2026-01-01T00:00:00+00:00").is_none());
        assert!(utc("2026-01-01T00:00:00Z").is_some());
        assert!(!uuid_valid("00000000-0000-4000-0000-000000000000"));
        assert!(!valid_kid("-bad")); assert!(!valid_kid("bad.key"));
    }
}
