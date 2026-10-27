fn main() {
    tauri_build::build();
    #[cfg(target_os = "macos")]
    {
        let mut native = cc::Build::new();
        native.file("platform/macos.m").flag("-fobjc-arc");
        if std::env::var_os("CARGO_FEATURE_DESKTOP_SMOKE").is_some() { native.define("LAW_DESKTOP_SMOKE", None); }
        native.compile("law_desktop_platform");
        for framework in ["Cocoa", "WebKit", "Security", "LocalAuthentication", "IOKit"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rerun-if-changed=platform/macos.m");
    }
}
