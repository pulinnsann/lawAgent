//! A local, opaque device binding for offline licenses. No account names,
//! network addresses or raw platform identifiers cross the native boundary.
use serde::Serialize;
use sha2::{Digest, Sha256};

const DOMAIN: &[u8] = b"law-agent:device:v1\0";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    device_code: Option<String>,
}

fn normalize_identifier(raw: &str) -> Option<String> {
    if raw.len() > 128 { return None; }
    let raw = raw.trim_matches(|c: char| c.is_ascii_whitespace());
    let raw = if raw.starts_with('{') && raw.ends_with('}') { &raw[1..raw.len() - 1] } else { raw };
    // Only the documented UUID forms are accepted. Names, MAC addresses,
    // arbitrary registry strings and URNs must not become accidental bindings.
    let valid = match raw.len() {
        32 => raw.bytes().all(|byte| byte.is_ascii_hexdigit()),
        36 => raw.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) { byte == b'-' } else { byte.is_ascii_hexdigit() }
        }),
        _ => false,
    };
    if !valid { return None; }
    let uuid = uuid::Uuid::parse_str(raw).ok()?;
    if uuid.as_bytes().iter().all(|byte| *byte == 0) || uuid.as_bytes().iter().all(|byte| *byte == 255) { return None; }
    Some(uuid.hyphenated().to_string())
}

fn from_identifier(platform: &str, raw: Option<&str>) -> DeviceIdentity {
    let device_code = raw.and_then(normalize_identifier).map(|normalized| {
        let mut digest = Sha256::new();
        digest.update(DOMAIN);
        digest.update(platform.as_bytes());
        digest.update(b"\0");
        digest.update(normalized.as_bytes());
        format!("LAWDEV1-{:x}", digest.finalize())
    });
    DeviceIdentity { device_code }
}

#[cfg(target_os = "macos")]
fn platform_identifier() -> Option<String> {
    unsafe extern "C" { fn law_device_identity(output: *mut std::ffi::c_char, capacity: usize) -> i32; }
    let mut buffer = [0_u8; 128];
    if unsafe { law_device_identity(buffer.as_mut_ptr().cast(), buffer.len()) } != 1 { return None; }
    std::ffi::CStr::from_bytes_until_nul(&buffer).ok()?.to_str().ok().map(str::to_owned)
}

#[cfg(any(windows, test))]
fn decode_registry_identifier(buffer: &[u16], byte_count: u32) -> Option<String> {
    let bytes = usize::try_from(byte_count).ok()?;
    if bytes < 2 || bytes % 2 != 0 || bytes > buffer.len() * 2 { return None; }
    let value = &buffer[..bytes / 2];
    if value.last() != Some(&0) || value[..value.len() - 1].contains(&0) { return None; }
    String::from_utf16(&value[..value.len() - 1]).ok()
}

#[cfg(windows)]
fn platform_identifier() -> Option<String> {
    use windows::{core::w, Win32::{Foundation::ERROR_SUCCESS, System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
    }}};
    let mut buffer = [0_u16; 128];
    let mut bytes = std::mem::size_of_val(&buffer) as u32;
    // Read the machine-wide 64-bit view even from a future 32-bit build. This
    // API opens/closes its own read handle and never requests elevation/writes.
    let status = unsafe { RegGetValueW(HKEY_LOCAL_MACHINE, w!("SOFTWARE\\Microsoft\\Cryptography"), w!("MachineGuid"),
        RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, None, Some(buffer.as_mut_ptr().cast()), Some(&mut bytes)) };
    if status != ERROR_SUCCESS { return None; }
    decode_registry_identifier(&buffer, bytes)
}

pub fn sample() -> DeviceIdentity {
    #[cfg(target_os = "macos")]
    { from_identifier("macos", platform_identifier().as_deref()) }
    #[cfg(windows)]
    { from_identifier("windows", platform_identifier().as_deref()) }
    #[cfg(not(any(target_os = "macos", windows)))]
    { DeviceIdentity { device_code: None } }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SYNTHETIC: &str = "12345678-9abc-4def-8123-456789abcdef";

    #[test]
    fn documented_uuid_forms_normalize_to_one_binding() {
        for value in [SYNTHETIC.to_owned(), SYNTHETIC.to_uppercase(), format!(" \t{{{}}}\r\n", SYNTHETIC.to_uppercase()), SYNTHETIC.replace('-', "")] {
            assert_eq!(normalize_identifier(&value).as_deref(), Some(SYNTHETIC));
            assert_eq!(from_identifier("macos", Some(&value)).device_code, from_identifier("macos", Some(SYNTHETIC)).device_code);
        }
    }

    #[test]
    fn invalid_missing_placeholder_and_non_uuid_sources_have_no_fallback() {
        for value in ["", "\0", "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", "User's Mac", "00:11:22:33:44:55", "urn:uuid:12345678-9abc-4def-8123-456789abcdef", "{12345678-9abc-4def-8123-456789abcdef", "12345678-9abc-4def-8123-456789abcdef\0", "1234567g-9abc-4def-8123-456789abcdef", "123456789-abc-4def-8123-456789abcdef"] {
            assert!(from_identifier("windows", Some(value)).device_code.is_none());
        }
        assert!(normalize_identifier(&"a".repeat(129)).is_none());
        assert!(from_identifier("macos", None).device_code.is_none());
        assert!(from_identifier("windows", None).device_code.is_none());
    }

    #[test]
    fn hash_is_versioned_and_separated_by_platform() {
        let mac = from_identifier("macos", Some(SYNTHETIC)).device_code.unwrap();
        let windows = from_identifier("windows", Some(SYNTHETIC)).device_code.unwrap();
        assert_eq!(mac, "LAWDEV1-84766880ff982b087091e69019225e08f5cba050ea562d3276ab9672f939e0cb");
        assert_eq!(windows, "LAWDEV1-df0eac0d3d79cd4cb0a1e9fe52f4244242d46aaa0949b7754e8a3e6464c681aa");
        assert_eq!(mac.len(), 72);
        assert!(mac.starts_with("LAWDEV1-"));
        assert!(mac[8..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        assert_ne!(mac, windows);
        assert_ne!(mac, format!("LAWDEV1-{:x}", Sha256::digest(SYNTHETIC.as_bytes())));
        assert!(!mac.contains(SYNTHETIC));
    }

    #[test]
    fn registry_buffer_requires_bounded_complete_utf16_without_hidden_suffixes() {
        let mut buffer: Vec<u16> = SYNTHETIC.encode_utf16().collect(); buffer.push(0);
        assert_eq!(decode_registry_identifier(&buffer, (buffer.len() * 2) as u32).as_deref(), Some(SYNTHETIC));
        for bytes in [0, 1, (buffer.len() * 2 - 1) as u32, (buffer.len() * 2 + 2) as u32] { assert!(decode_registry_identifier(&buffer, bytes).is_none()); }
        assert!(decode_registry_identifier(&buffer, (buffer.len() * 2 - 2) as u32).is_none());
        assert!(decode_registry_identifier(&[b'a' as u16, 0, b'b' as u16, 0], 8).is_none());
        assert!(decode_registry_identifier(&[0xd800, 0], 4).is_none());
    }

    #[test]
    fn serialization_exposes_only_the_opaque_code_or_null() {
        let value = serde_json::to_value(from_identifier("macos", Some(SYNTHETIC))).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 1);
        assert!(value["deviceCode"].as_str().unwrap().starts_with("LAWDEV1-"));
        assert!(!value.to_string().contains(SYNTHETIC));
        assert_eq!(serde_json::to_value(from_identifier("macos", None)).unwrap(), serde_json::json!({"deviceCode":null}));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_macos_probe_is_stable_and_returns_only_an_opaque_binding() {
        // This read-only IOKit probe does not request keychain or network access.
        // No raw value is printed, serialized or included in assertions.
        let first = sample(); let second = sample();
        assert_eq!(first.device_code, second.device_code);
        if let Some(code) = first.device_code {
            assert_eq!(code.len(), 72);
            assert!(code.starts_with("LAWDEV1-"));
        }
    }
}
