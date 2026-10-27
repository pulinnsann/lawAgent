use std::{collections::BTreeMap, fs, path::PathBuf};

fn main() {
    // Reuse the client's public verification key; signing material is never a
    // build input and is never copied into an installer.
    let source = PathBuf::from("../../src/core/license-trusted-keys.ts");
    println!("cargo:rerun-if-changed={}", source.display());
    let text = fs::read_to_string(source).expect("Read public license keys");
    let json = text.split_once("= ").expect("Public key declaration").1.trim().trim_end_matches(';');
    let keys: BTreeMap<String, String> = serde_json::from_str(json).expect("Public license key map");
    let kid = "lawagent-trial-v1";
    let pem = keys.get(kid).expect("Pinned trial verification key");
    let output = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("trusted_keys.rs");
    fs::write(output, format!("pub const OFFICIAL_KEY_ID: &str = {kid:?};\npub const OFFICIAL_PUBLIC_KEY_PEM: &str = {pem:?};\n")).expect("Write public key constants");
    tauri_build::build();
}
