# Installable administrator license issuer

The standalone **LawAgent License Issuer 0.1.0** uses Rust, SQLite and the system WebView through Tauri. Installed operators do not need Node.js, npm, Rust, the LawAgent customer app or a browser server. It makes no model, search or remote licensing requests and does not start a Node sidecar.

The policy remains 100 trial licenses through one retained issuance ledger, one device per license, and 90 elapsed days from the signed start time. A license can be retrieved later without changing its expiry or consuming another seat. There is no reset, delete, renewal or replacement-key button. The customer app and this administrator utility have distinct application IDs, icons and data locations.

## Install and connect existing signing material

The current build produces a macOS arm64 DMG. Open it, drag **LawAgent License Issuer** into Applications, and launch it. The unsigned development installer has not been notarized by Apple; operating-system acceptance remains part of release qualification. macOS 13.5 or later is the configured minimum. Intel macOS builds must be produced and checked separately on the appropriate target.

On first launch, choose **Select existing issuance directory**. Select the retained directory that contains:

- `issuer-private.pem`: the existing PKCS#8 Ed25519 private key.
- `licenses.sqlite`: the existing issuance ledger.
- `issuer-identity.json`: the ledger identity marker.
- `issuer-public.pem` may remain alongside these files; the app obtains its trusted public key from the same source declaration as the customer client.

For the current maintainer checkout, the retained directory is `.local/license-issuer/` below the repository root. Hidden directories can be reached through the macOS folder chooser's **Command–Shift–G** shortcut. The app opens the directory in place; it does not duplicate the key or create another ledger. An empty directory, wrong key, missing database/marker, incompatible schema or unsafe permissions cannot enable signing.

The directory location alone is saved in `issuer-location.json` inside the operating system's per-user configuration location for `com.lawagent.license-issuer`. Signing material remains in the selected directory outside the application bundle. Updating, moving or removing the app does not reset the allowance or delete that selected directory. Keep the full private signing directory backed up together through your own controlled administrator backup. Do not distribute it to customers.

## Issue and deliver a code

1. Ask the customer to open LawAgent's **License and trial access** panel. Its local issuance card shows the product, running app version and full device code, with separate **Copy device code** and **Copy issuance information** buttons.
2. Paste the raw `LAWDEV1-…` code or the entire copied JSON block into the issuer. The native form accepts the exact three-field LawAgent information format and extracts only the device code. Leave the optional start time blank for immediate commencement, or choose a future start within 365 days. The app version is informational and is not added to the license binding.
3. Click **Issue and generate activation code**. The token is returned only after the SQLite transaction commits.
4. Copy the string, or save a new `.lawlicense` text file through the system save dialog. Existing files are never overwritten by this action. The customer pastes the file's text into the activation panel.
5. Use the history table to retrieve a previously issued code. Counts and dates come from the retained ledger.

If a state refresh fails after a successful commit, the already obtained code remains copyable while new issuance is disabled. Reconnect or refresh before issuing another license. A healthy connected session cannot switch to a different directory through the UI.

## Build commands

From the repository root, with the existing Node/Rust build prerequisites installed:

```sh
npm run license:desktop       # Develop the separate native utility
npm run license:native:test   # Ephemeral-key signer, permissions and host tests
npm run license:pack:mac      # Run on macOS: app + DMG
npm run license:pack:win      # Run on Windows: NSIS setup executable
node --import tsx scripts/smoke-license-issuer.mjs
```

The frontend is static local HTML/CSS/JavaScript. Production installers contain neither the browser issuer server nor the full document/OCR/model runtime. The public client verification key is the sole key build input, read from `src/core/license-trusted-keys.ts`. The diagnostic interop executable requires `issuer-smoke`; normal production builds do not enable it or ship it.

The manual [installer build workflow](../../.github/workflows/license-issuer-build.yml) prepares macOS arm64 and Windows x64 artifacts without signing material or a public release. It is not triggered automatically and has not been executed as part of the local macOS build. Windows uses the system WebView2 runtime; its installer can download the official bootstrapper when required. A Windows runner and physical Windows acceptance are still required before describing a Windows installer as released or qualified.

## Validation and limits

The macOS arm64 iteration passed 606 TypeScript/Node regressions and 81 Rust tests across the workspace, including 20 native issuer, permissions and host tests. The delivered DMG is about 2.9 MiB; the app is about 10.3 MiB including the generated dependency license texts. Installer checksums and a short installation note are collected under `release/license-issuer/` without publishing them automatically.

macOS checks cover legacy Node-ledger to Rust continuity, Rust-token activation through the real client verifier, subsequent Node-ledger reads and issuance, quota exhaustion, concurrent admission, rollback, restart, malformed records, stable file identity, linked journal refusal, owner-only permissions and macOS extended ACL refusal. Tests use temporary keys and ledgers and consume no official seats. The native window was opened and visually inspected in its unconfigured state; actual official-key signing was not performed for UI verification.

Windows owner/SYSTEM ACL validation and protected private-file creation are implemented in Rust but have not been compiled or executed on Windows in this iteration. The legacy Node browser issuer continues to fail closed on Windows. Strict native signing-directory permissions apply independently of the nonsecret settings-file location. Do not loosen them merely to make a transferred directory open.

The offline cap is a property of one retained ledger. A signing-key owner can deliberately clone or roll back their entire environment, and an Apache-2.0 source fork can alter the program. This utility does not introduce a global inventory server, remote revocation, a hardware-replacement policy or formal paid-license types. Customer-app expiry behavior remains unchanged: existing data can be viewed/exported, and new reviews/generation are stopped.
