//! Small OS memory-pressure samples for cooperative work admission. These are
//! neither an app RSS limit nor detection of local model processes, VRAM or KV
//! caches. Windows exposes capacity/load rather than macOS pressure signals;
//! its levels below are deliberately conservative heuristics.
use serde::Serialize;

const MAX_JSON_INTEGER: u64 = (1_u64 << 53) - 1;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePressure {
    level: &'static str,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    available_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_bytes: Option<u64>,
}

impl ResourcePressure {
    fn unknown() -> Self {
        Self { level: "unknown", source: "unavailable", available_bytes: None, total_bytes: None }
    }
}

#[cfg(any(target_os = "macos", test))]
fn macos_snapshot(level: Option<u32>, total_bytes: Option<u64>) -> ResourcePressure {
    let level = match level {
        Some(1) => "normal",
        Some(2) => "warning",
        Some(4) => "critical",
        _ => return ResourcePressure::unknown(),
    };
    ResourcePressure {
        level, source: "macos", available_bytes: None,
        total_bytes: total_bytes.filter(|total| *total > 0 && *total <= MAX_JSON_INTEGER),
    }
}

#[cfg(any(windows, test))]
fn windows_snapshot(load_percent: u32, total_bytes: u64, available_bytes: u64) -> ResourcePressure {
    if load_percent > 100 || total_bytes == 0 || total_bytes > MAX_JSON_INTEGER || available_bytes > total_bytes {
        return ResourcePressure::unknown();
    }
    const MIB: u64 = 1024 * 1024;
    // A resident model may legitimately occupy much of RAM. High load alone
    // must never be reported as critical while real available headroom remains.
    let level = if load_percent >= 95 && available_bytes < 256 * MIB { "critical" }
        else if load_percent >= 90 || available_bytes < 768 * MIB { "warning" }
        else { "normal" };
    ResourcePressure { level, source: "windows", available_bytes: Some(available_bytes), total_bytes: Some(total_bytes) }
}

#[cfg(target_os = "macos")]
pub fn sample() -> ResourcePressure {
    use std::ffi::{c_char, c_int, c_void, CStr};
    unsafe extern "C" {
        fn sysctlbyname(name: *const c_char, old: *mut c_void, old_len: *mut usize, new: *mut c_void, new_len: usize) -> c_int;
    }
    fn read_integer(name: &CStr, expected_size: usize) -> Option<u64> {
        let mut bytes = [0_u8; 8];
        let mut length = expected_size;
        // The destination is fixed-size, and these two read-only integer keys
        // require no process enumeration, shell subprocess or elevated access.
        let result = unsafe { sysctlbyname(name.as_ptr(), bytes.as_mut_ptr().cast(), &mut length, std::ptr::null_mut(), 0) };
        if result != 0 || length != expected_size { return None; }
        match length {
            4 => Some(u64::from(u32::from_ne_bytes(bytes[..4].try_into().ok()?))),
            8 => Some(u64::from_ne_bytes(bytes)),
            _ => None,
        }
    }
    let level = read_integer(c"kern.memorystatus_vm_pressure_level", 4).and_then(|value| u32::try_from(value).ok());
    let total = read_integer(c"hw.memsize", 8);
    macos_snapshot(level, total)
}

#[cfg(windows)]
pub fn sample() -> ResourcePressure {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut memory = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    if unsafe { GlobalMemoryStatusEx(&mut memory) }.is_err() { return ResourcePressure::unknown(); }
    windows_snapshot(memory.dwMemoryLoad, memory.ullTotalPhys, memory.ullAvailPhys)
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn sample() -> ResourcePressure { ResourcePressure::unknown() }

#[cfg(test)]
mod tests {
    use super::*;
    const MIB: u64 = 1024 * 1024;
    const TOTAL: u64 = 16 * 1024 * MIB;

    #[test]
    fn macos_maps_only_documented_pressure_levels_and_does_not_invent_available_ram() {
        for (raw, expected) in [(1, "normal"), (2, "warning"), (4, "critical")] {
            let result = macos_snapshot(Some(raw), Some(TOTAL));
            assert_eq!(result.level, expected);
            assert_eq!(result.source, "macos");
            assert_eq!(result.available_bytes, None);
            assert_eq!(result.total_bytes, Some(TOTAL));
        }
    }

    #[test]
    fn macos_denied_unknown_or_invalid_level_is_a_nonfatal_unavailable_sample() {
        for raw in [None, Some(0), Some(3), Some(5), Some(u32::MAX)] {
            assert_eq!(macos_snapshot(raw, Some(TOTAL)), ResourcePressure::unknown());
        }
        for total in [None, Some(0), Some(MAX_JSON_INTEGER + 1)] {
            let result = macos_snapshot(Some(1), total);
            assert_eq!(result.level, "normal");
            assert_eq!(result.total_bytes, None);
        }
    }

    #[test]
    fn windows_warning_thresholds_include_load_and_actual_headroom() {
        assert_eq!(windows_snapshot(89, TOTAL, 768 * MIB).level, "normal");
        assert_eq!(windows_snapshot(90, TOTAL, 768 * MIB).level, "warning");
        assert_eq!(windows_snapshot(10, TOTAL, 768 * MIB - 1).level, "warning");
    }

    #[test]
    fn windows_critical_requires_both_high_load_and_very_low_available_ram() {
        assert_eq!(windows_snapshot(95, TOTAL, 256 * MIB - 1).level, "critical");
        assert_eq!(windows_snapshot(94, TOTAL, 0).level, "warning");
        assert_eq!(windows_snapshot(95, TOTAL, 256 * MIB).level, "warning");
        assert_eq!(windows_snapshot(99, TOTAL, 4 * 1024 * MIB).level, "warning");
        assert_eq!(windows_snapshot(100, TOTAL, 0).level, "critical");
    }

    #[test]
    fn windows_invalid_or_unrepresentable_capacity_never_produces_false_pressure() {
        for (load, total, available) in [(101, TOTAL, 0), (0, 0, 0), (50, TOTAL, TOTAL + 1), (50, MAX_JSON_INTEGER + 1, 0)] {
            assert_eq!(windows_snapshot(load, total, available), ResourcePressure::unknown());
        }
    }

    #[test]
    fn serialization_has_only_native_sample_fields_and_omits_unknown_capacity() {
        let unknown = serde_json::to_value(ResourcePressure::unknown()).unwrap();
        assert_eq!(unknown, serde_json::json!({"level":"unknown","source":"unavailable"}));
        let windows = serde_json::to_value(windows_snapshot(50, TOTAL, TOTAL / 2)).unwrap();
        assert_eq!(windows, serde_json::json!({"level":"normal","source":"windows","availableBytes":TOTAL/2,"totalBytes":TOTAL}));
        assert!(windows.get("observedAt").is_none());
    }
}
