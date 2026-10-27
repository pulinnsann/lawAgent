//! Ephemeral-key interop probe, excluded from normal builds and installers.
use law_license_issuer::issuer::Issuer;
use serde::Deserialize;
use std::io::{Read, Write};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input { directory: std::path::PathBuf, public_key_pem: String, now_ms: i64, device_code: String, starts_at: Option<String> }
fn main() {
    let result = (|| {
        let mut bytes = Vec::new(); std::io::stdin().take(8193).read_to_end(&mut bytes).map_err(|_| "input")?;
        if bytes.len() > 8192 { return Err("input".into()); }
        let input: Input = serde_json::from_slice(&bytes).map_err(|_| "input")?;
        let mut issuer = Issuer::open_diagnostic(&input.directory, &input.public_key_pem, input.now_ms)?;
        let before = issuer.state()?;
        let issued = issuer.issue(input.device_code, input.starts_at)?;
        let retrieved = issuer.get_token(issued.license.license_id.clone())?;
        if retrieved != issued.token { return Err("retrieval".into()); }
        let after = issuer.state()?;
        Ok::<_, String>(serde_json::json!({ "before": before, "issued": issued, "after": after }))
    })();
    match result {
        Ok(value) => { let _ = writeln!(std::io::stdout(), "{value}"); }
        Err(_) => { eprintln!("Ephemeral issuer diagnostic failed."); std::process::exit(1); }
    }
}
