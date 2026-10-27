//! Signing material and its ledger must remain private to the current account.
//! Existing ACLs are checked, never silently rewritten or made less restrictive.
use std::fs;
use std::io::Write;
use std::path::Path;

fn failure() -> String {
    "签发资料权限校验失败：需要当前用户独占的本地目录和文件，且不能使用链接。".into()
}

#[cfg(unix)]
pub fn check_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::symlink_metadata(path).map_err(|_| failure())?;
    if !meta.is_dir() || meta.file_type().is_symlink()
        || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o777 != 0o700 {
        return Err(failure());
    }
    no_extended_acl(path)
}

#[cfg(unix)]
pub fn check_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::symlink_metadata(path).map_err(|_| failure())?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.nlink() != 1
        || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o777 != 0o600 {
        return Err(failure());
    }
    no_extended_acl(path)
}

#[cfg(target_os = "macos")]
fn no_extended_acl(path: &Path) -> Result<(), String> {
    use std::{ffi::{c_char, c_int, c_void, CString}, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn acl_get_file(path: *const c_char, kind: c_int) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry: *mut *mut c_void) -> c_int;
        fn acl_valid(acl: *mut c_void) -> c_int;
        fn acl_free(value: *mut c_void) -> c_int;
    }
    let encoded = CString::new(path.as_os_str().as_bytes()).map_err(|_| failure())?;
    // Darwin's ACL_TYPE_EXTENDED and ACL_FIRST_ENTRY, from sys/acl.h. An empty
    // ACL is valid; any entry (even deny-only) is intentionally refused.
    let acl = unsafe { acl_get_file(encoded.as_ptr(), 0x100) };
    if acl.is_null() {
        // On Darwin, an existing object without an extended ACL returns NULL
        // with ENOENT. This differs from Linux's ACL iteration semantics.
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT)
            && fs::symlink_metadata(path).is_ok() { Ok(()) } else { Err(failure()) };
    }
    if unsafe { acl_valid(acl) } != 0 { unsafe { acl_free(acl); } return Err(failure()); }
    let mut entry = std::ptr::null_mut();
    let count = unsafe { acl_get_entry(acl, 0, &mut entry) };
    let error = std::io::Error::last_os_error().raw_os_error();
    unsafe { acl_free(acl); }
    // Darwin returns 0 when an entry WAS obtained, and -1/EINVAL at the end.
    if count == -1 && error == Some(libc::EINVAL) { Ok(()) } else { Err(failure()) }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn no_extended_acl(_path: &Path) -> Result<(), String> { Ok(()) }

#[cfg(unix)]
pub fn create_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new().write(true).create_new(true)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path).map_err(|_| failure())?;
    // An inherited macOS ACL may grant access despite 0600. Check before any
    // secret is written; failed creation leaves an empty file for inspection.
    check_file(path)?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| failure())?;
    check_file(path)
}

/// Creates one new directory; never repairs or replaces an existing directory.
#[cfg(unix)]
pub fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path).map_err(|_| failure())?;
    check_directory(path)
}

#[cfg(unix)]
pub fn file_identity(path: &Path) -> Result<[u64; 2], String> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::symlink_metadata(path).map_err(|_| failure())?;
    if meta.file_type().is_symlink() { return Err(failure()); }
    Ok([meta.dev(), meta.ino()])
}

#[cfg(unix)]
pub fn handle_identity(file: &fs::File) -> Result<[u64; 2], String> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(|_| failure())?;
    Ok([meta.dev(), meta.ino()])
}

#[cfg(windows)]
mod windows_permissions {
    use super::*;
    use std::{ffi::c_void, mem::{size_of, zeroed}, os::windows::{ffi::OsStrExt, fs::MetadataExt, io::{AsRawHandle, FromRawHandle}}, ptr};
    use windows::{core::{PCWSTR, PWSTR}, Win32::{
        Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree},
        Security::{
            Authorization::{ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT, SDDL_REVISION_1},
            EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorControl, GetTokenInformation,
            IsValidAcl, IsValidSid, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION,
            AclSizeInformation, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
            PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER, TokenUser,
        },
        Storage::FileSystem::{
            CreateDirectoryW, CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    }};

    struct LocalAllocation(*mut c_void);
    impl Drop for LocalAllocation {
        fn drop(&mut self) { if !self.0.is_null() { unsafe { let _ = LocalFree(Some(HLOCAL(self.0))); } } }
    }
    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle { fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } } }
    fn wide(path: &Path) -> Result<Vec<u16>, String> {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) || value.is_empty() { return Err(failure()); }
        value.push(0); Ok(value)
    }
    // u64 storage keeps TOKEN_USER aligned. The SID points into this buffer and
    // remains valid only while the returned allocation stays alive.
    fn user() -> Result<Vec<u64>, String> {
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|_| failure())?; }
        let token = OwnedHandle(token);
        let mut needed = 0;
        unsafe { let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut needed); }
        if needed < size_of::<TOKEN_USER>() as u32 || needed > 65_536 { return Err(failure()); }
        let mut storage = vec![0u64; (needed as usize + 7) / 8];
        unsafe { GetTokenInformation(token.0, TokenUser, Some(storage.as_mut_ptr().cast()), needed, &mut needed).map_err(|_| failure())?; }
        let sid = unsafe { (*(storage.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        if !unsafe { IsValidSid(sid) }.as_bool() { return Err(failure()); }
        Ok(storage)
    }
    fn user_sid(storage: &[u64]) -> PSID { unsafe { (*(storage.as_ptr().cast::<TOKEN_USER>())).User.Sid } }

    fn check_acl(path: &Path, require_protected: bool) -> Result<(), String> {
        let encoded = wide(path)?;
        let current = user()?;
        let mut owner = PSID::default(); let mut dacl: *mut ACL = ptr::null_mut();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let result = unsafe { GetNamedSecurityInfoW(PCWSTR(encoded.as_ptr()), SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, Some(&mut owner), None,
            Some(&mut dacl), None, &mut descriptor) };
        // GetNamedSecurityInfo allocates one descriptor; owner/DACL are borrowed.
        let _descriptor = LocalAllocation(descriptor.0);
        if result.0 != 0 || descriptor.0.is_null() || owner.0.is_null() || dacl.is_null()
            || !unsafe { IsValidSid(owner) }.as_bool() || unsafe { EqualSid(owner, user_sid(&current)) }.is_err()
            || !unsafe { IsValidAcl(dacl) }.as_bool() { return Err(failure()); }
        let mut control = 0; let mut revision = 0;
        unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision).map_err(|_| failure())?; }
        // The root directory must reject inherited grants. SQLite may create
        // journals with the directory's owner/SYSTEM-only inheritable entries;
        // files are safe when their complete effective allow-list is private.
        if require_protected && control & SE_DACL_PROTECTED.0 == 0 { return Err(failure()); }
        let system_text: Vec<u16> = "S-1-5-18\0".encode_utf16().collect();
        let mut system = PSID::default();
        unsafe { ConvertStringSidToSidW(PCWSTR(system_text.as_ptr()), &mut system).map_err(|_| failure())?; }
        let _system = LocalAllocation(system.0);
        let mut info: ACL_SIZE_INFORMATION = unsafe { zeroed() };
        unsafe { GetAclInformation(dacl, (&mut info as *mut ACL_SIZE_INFORMATION).cast(), size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation).map_err(|_| failure())?; }
        if info.AceCount == 0 || info.AceCount > 64 { return Err(failure()); }
        let mut has_current = false;
        for index in 0..info.AceCount {
            let mut raw = ptr::null_mut();
            unsafe { GetAce(dacl, index, &mut raw).map_err(|_| failure())?; }
            if raw.is_null() { return Err(failure()); }
            let header = unsafe { &*raw.cast::<ACE_HEADER>() };
            // Only ordinary allow ACEs, and no object/callback/conditional ACEs.
            // Refusing deny entries makes this intentionally stricter than the
            // user's effective permissions, avoiding incomplete ACL evaluation.
            if header.AceType != 0 || header.AceSize < 16 { return Err(failure()); }
            let ace = unsafe { &*raw.cast::<ACCESS_ALLOWED_ACE>() };
            let sid_bytes = unsafe { raw.cast::<u8>().add(8) };
            let sub_count = unsafe { *sid_bytes.add(1) } as usize;
            if sub_count > 15 || 8 + 8 + sub_count * 4 > header.AceSize as usize { return Err(failure()); }
            let sid = PSID(sid_bytes.cast_mut().cast());
            if !unsafe { IsValidSid(sid) }.as_bool() { return Err(failure()); }
            if unsafe { EqualSid(sid, user_sid(&current)) }.is_ok() {
                // INHERIT_ONLY ACEs do not grant this object any access.
                if header.AceFlags & 0x08 == 0 && ace.Mask != 0 { has_current = true; }
            } else if unsafe { EqualSid(sid, system) }.is_err() { return Err(failure()); }
        }
        if has_current { Ok(()) } else { Err(failure()) }
    }

    fn file_info(path: &Path) -> Result<BY_HANDLE_FILE_INFORMATION, String> {
        let encoded = wide(path)?;
        let handle = unsafe { CreateFileW(PCWSTR(encoded.as_ptr()), 0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, None, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, None).map_err(|_| failure())? };
        let handle = OwnedHandle(handle);
        let mut info = unsafe { zeroed() };
        unsafe { GetFileInformationByHandle(handle.0, &mut info).map_err(|_| failure())?; }
        Ok(info)
    }

    pub fn check_directory(path: &Path) -> Result<(), String> {
        let meta = fs::symlink_metadata(path).map_err(|_| failure())?;
        if !meta.is_dir() || meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 { return Err(failure()); }
        let info = file_info(path)?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 { return Err(failure()); }
        check_acl(path, true)
    }

    pub fn check_file(path: &Path) -> Result<(), String> {
        let meta = fs::symlink_metadata(path).map_err(|_| failure())?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 { return Err(failure()); }
        let info = file_info(path)?;
        if info.nNumberOfLinks != 1 || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 { return Err(failure()); }
        check_acl(path, false)
    }

    fn private_descriptor(directory: bool) -> Result<LocalAllocation, String> {
        let current = user()?;
        let mut string = PWSTR::null();
        unsafe { ConvertSidToStringSidW(user_sid(&current), &mut string).map_err(|_| failure())?; }
        let _string = LocalAllocation(string.0.cast());
        let sid = unsafe { string.to_string().map_err(|_| failure())? };
        // Protected DACL, no inherited broad principals. Owner is the current
        // account. SYSTEM is retained for local administration and backups.
        let inherit = if directory { "OICI" } else { "" };
        let sddl: Vec<u16> = format!("O:{sid}D:P(A;{inherit};FA;;;{sid})(A;{inherit};FA;;;SY)\0").encode_utf16().collect();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), SDDL_REVISION_1, &mut descriptor, None).map_err(|_| failure())?; }
        Ok(LocalAllocation(descriptor.0))
    }

    pub fn create_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
        let encoded = wide(path)?; let descriptor = private_descriptor(false)?;
        let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor.0, bInheritHandle: false.into() };
        let handle = unsafe { CreateFileW(PCWSTR(encoded.as_ptr()), FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0,
            FILE_SHARE_READ, Some(&attributes), CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, None).map_err(|_| failure())? };
        let mut file = unsafe { fs::File::from_raw_handle(handle.0) };
        check_file(path)?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| failure())?;
        check_file(path)
    }

    pub fn secure_directory(path: &Path) -> Result<(), String> {
        let encoded = wide(path)?; let descriptor = private_descriptor(true)?;
        let attributes = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: descriptor.0, bInheritHandle: false.into() };
        unsafe { CreateDirectoryW(PCWSTR(encoded.as_ptr()), Some(&attributes)).map_err(|_| failure())?; }
        check_directory(path)
    }

    pub fn file_identity(path: &Path) -> Result<[u64; 2], String> {
        let info = file_info(path)?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 { return Err(failure()); }
        Ok([info.dwVolumeSerialNumber as u64, ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64])
    }

    pub fn handle_identity(file: &fs::File) -> Result<[u64; 2], String> {
        let mut info = unsafe { zeroed() };
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info).map_err(|_| failure())?; }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 { return Err(failure()); }
        Ok([info.dwVolumeSerialNumber as u64, ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64])
    }
}

#[cfg(windows)]
pub use windows_permissions::{check_directory, check_file, create_private_file, file_identity, handle_identity, secure_directory};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_creation_is_exclusive_and_identity_stays_stable() {
        let temp = tempfile::tempdir().unwrap(); let directory = temp.path().join("issuer");
        secure_directory(&directory).unwrap();
        let file = directory.join("key"); create_private_file(&file, b"ephemeral fixture").unwrap();
        check_directory(&directory).unwrap(); check_file(&file).unwrap();
        let identity = file_identity(&file).unwrap();
        assert!(create_private_file(&file, b"replacement").is_err());
        assert_eq!(fs::read(&file).unwrap(), b"ephemeral fixture");
        assert_eq!(file_identity(&file).unwrap(), identity);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_broad_modes_links_and_hardlinks_without_repairing_them() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap(); let directory = temp.path().join("issuer");
        secure_directory(&directory).unwrap();
        let file = directory.join("key"); create_private_file(&file, b"ephemeral fixture").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(check_file(&file).is_err()); assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o644);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let link = directory.join("link"); symlink(&file, &link).unwrap(); assert!(check_file(&link).is_err());
        fs::remove_file(&link).unwrap(); fs::hard_link(&file, &link).unwrap(); assert!(check_file(&file).is_err());
        fs::remove_file(&link).unwrap(); check_file(&file).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o750)).unwrap(); assert!(check_directory(&directory).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn refuses_macos_extended_acl_even_when_mode_is_private() {
        use std::process::Command;
        let temp = tempfile::tempdir().unwrap(); let directory = temp.path().join("issuer"); secure_directory(&directory).unwrap();
        let file = directory.join("key"); create_private_file(&file, b"ephemeral fixture").unwrap();
        assert!(Command::new("/bin/chmod").args(["+a", "everyone allow read"]).arg(&file).status().unwrap().success());
        assert!(check_file(&file).is_err());
        assert!(Command::new("/bin/chmod").arg("-N").arg(&file).status().unwrap().success());
        check_file(&file).unwrap();
    }
}
