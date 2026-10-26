//! The desktop vault deliberately uses a different envelope from Electron.
//! Callers keep legacy ciphertext intact and ask the user to re-enter secrets.
use base64::{engine::general_purpose::STANDARD, Engine};

const MAX_SECRET_BYTES: usize = 128 * 1024;
const MAGIC: &[u8] = b"LAW-TAURI-VAULT\0\x01";

/// Availability does not read the keychain, prompt, or create an encryption key.
pub fn available() -> bool {
    cfg!(any(target_os = "macos", windows))
}

/// Only a smoke-feature binary can delete its UUID-isolated synthetic key.
#[cfg(all(feature = "desktop-smoke", target_os = "macos"))]
pub fn cleanup_test_key() -> Result<(), String> {
    unsafe extern "C" { fn law_vault_cleanup_test_key() -> i32; }
    if unsafe { law_vault_cleanup_test_key() } == 0 { Ok(()) }
    else { Err("Synthetic credential key cleanup failed".into()) }
}

pub fn encrypt(value: String) -> Result<String, String> {
    if value.len() > MAX_SECRET_BYTES {
        return Err("Credential exceeds the encrypted vault limit".into());
    }
    let encrypted = os::protect(value.as_bytes())?;
    let mut bytes = Vec::with_capacity(MAGIC.len() + encrypted.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&encrypted);
    Ok(STANDARD.encode(bytes))
}

pub fn decrypt(value: String) -> Result<String, String> {
    if value.len() > (MAX_SECRET_BYTES + 4096) * 2 {
        return Err("Encrypted credential exceeds the vault limit".into());
    }
    let bytes = STANDARD.decode(value).map_err(|_| "Invalid encrypted credential")?;
    let encrypted = bytes.strip_prefix(MAGIC).ok_or(
        "Legacy or unsupported credential format; re-enter the API key in Settings",
    )?;
    let decrypted = os::unprotect(encrypted)?;
    String::from_utf8(decrypted).map_err(|_| "Invalid decrypted credential".into())
}

#[cfg(target_os = "macos")]
mod os {
    use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Nonce};
    unsafe extern "C" {
        fn law_vault_key(key: *mut u8, create: bool) -> i32;
    }

    fn key(create: bool) -> Result<[u8; 32], String> {
        let mut bytes = [0_u8; 32];
        // Security.framework receives only fixed-size key bytes. No secret is
        // placed in an argument vector, environment, log, or temporary file.
        let status = unsafe { law_vault_key(bytes.as_mut_ptr(), create) };
        if status != 0 {
            return Err("The system keychain is unavailable or locked".into());
        }
        Ok(bytes)
    }

    pub fn protect(value: &[u8]) -> Result<Vec<u8>, String> {
        let mut nonce = [0_u8; 12];
        getrandom::fill(&mut nonce).map_err(|_| "Secure randomness is unavailable")?;
        let mut key_bytes = key(true)?;
        let result = seal(value, &key_bytes, &nonce);
        key_bytes.fill(0);
        result
    }
    fn seal(value: &[u8], key: &[u8; 32], nonce: &[u8; 12]) -> Result<Vec<u8>, String> {
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid encryption key")?;
        let ciphertext = cipher.encrypt(Nonce::from_slice(nonce), Payload { msg: value, aad: super::MAGIC })
            .map_err(|_| "System credential encryption failed")?;
        let mut output = Vec::with_capacity(12 + ciphertext.len());
        output.extend_from_slice(nonce);
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }

    pub fn unprotect(value: &[u8]) -> Result<Vec<u8>, String> {
        if value.len() < 28 { return Err("Invalid encrypted credential".into()); }
        let mut key_bytes = key(false)?;
        let result = open(value, &key_bytes);
        key_bytes.fill(0);
        result
    }
    fn open(value: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
        if value.len() < 28 { return Err("Invalid encrypted credential".into()); }
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid encryption key")?;
        cipher.decrypt(Nonce::from_slice(&value[..12]), Payload { msg: &value[12..], aad: super::MAGIC })
            .map_err(|_| "System credential decryption failed".into())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn authenticated_envelope_round_trips_unicode_without_accessing_keychain() {
            let source = "{\"endpoint\":\"https://example.invalid/v1\",\"apiKey\":\"synthetic-合同-สัญญา-🔑\"}".as_bytes();
            let sealed = seal(source, &[7; 32], &[9; 12]).unwrap();
            assert_eq!(open(&sealed, &[7; 32]).unwrap(), source);
            assert!(!sealed.windows(9).any(|bytes| bytes == b"synthetic"));
            assert!(open(&sealed, &[8; 32]).is_err());
        }
        #[test]
        fn tampered_nonce_and_ciphertext_are_rejected_without_accessing_keychain() {
            let sealed = seal(b"synthetic secret", &[7; 32], &[9; 12]).unwrap();
            for index in [0, 11, 12, sealed.len() - 1] {
                let mut changed = sealed.clone(); changed[index] ^= 1;
                assert!(open(&changed, &[7; 32]).is_err());
            }
            assert!(open(&sealed[..20], &[7; 32]).is_err());
        }
    }
}

#[cfg(windows)]
mod os {
    use std::ptr;
    use windows::Win32::{Foundation::{HLOCAL, LocalFree}, Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    }};

    fn transform(value: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB { cbData: value.len() as u32, pbData: value.as_ptr() as *mut u8 };
        let mut output = CRYPT_INTEGER_BLOB::default();
        let result = unsafe {
            if encrypt {
                CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            } else {
                CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            }
        };
        if result.is_err() { return Err("Windows credential protection is unavailable".into()); }
        let bytes = if output.cbData == 0 { Vec::new() } else {
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() }
        };
        unsafe {
            if !output.pbData.is_null() {
                ptr::write_bytes(output.pbData, 0, output.cbData as usize);
                let _ = LocalFree(Some(HLOCAL(output.pbData as *mut _)));
            }
        }
        Ok(bytes)
    }
    pub fn protect(value: &[u8]) -> Result<Vec<u8>, String> { transform(value, true) }
    pub fn unprotect(value: &[u8]) -> Result<Vec<u8>, String> { transform(value, false) }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod os {
    pub fn protect(_: &[u8]) -> Result<Vec<u8>, String> { Err("System credential protection is unsupported".into()) }
    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> { Err("System credential protection is unsupported".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_bytes_are_rejected_before_keychain_access() {
        assert!(decrypt(STANDARD.encode(b"v10 old Electron ciphertext")).unwrap_err().contains("re-enter"));
    }
    #[test]
    fn oversized_secrets_are_rejected_before_keychain_access() {
        assert!(encrypt("x".repeat(MAX_SECRET_BYTES + 1)).is_err());
        assert!(decrypt("x".repeat((MAX_SECRET_BYTES + 4096) * 2 + 1)).is_err());
    }
}
