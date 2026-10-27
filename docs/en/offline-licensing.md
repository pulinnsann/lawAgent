# Offline trial licensing and local issuer

Official distributions require an offline, issuer-signed license. The source remains under Apache-2.0; this feature does not replace the repository's source license. The issuer utility is a separate administrator tool, excluded from customer app bundles together with its private key and ledger.

## Confirmed policy

- At most **100 trial licenses** through the retained issuer ledger, each bound to one device.
- Each trial lasts exactly **90 elapsed days** from its signed `startsAt` timestamp. Pasting a code later does not restart the period. A future-dated code cannot activate before that time.
- Missing, invalid, wrong-device, expired or unverifiable licenses cannot start new imports, reviews, model tasks or business modifications. Existing documents, reports, decisions and approved drafts remain viewable and exportable. Export history and derived export copies can still be recorded.
- A task already admitted before expiry may complete and retain its result. Queued model work rechecks authorization before the actual request, so waiting in a queue does not extend the trial.
- Official Tauri hosts always select required licensing. The isolated `desktop-smoke` diagnostic feature selects development mode. Unpackaged Electron remains a development reference; packaged Electron uses required mode and the same device-code rules. Renderer input, a license file and environment variables cannot select development mode in an official host.

The client cannot know the global remaining inventory while offline. Its panel shows the signed license seat and local validity. The issuer displays the actual used/remaining counts from its one ledger.

## Client activation

Open **License and trial access** from the sidebar or Feature center. The **Device information for license issuance** card shows LawAgent, the running app version and the complete, wrapping `LAWDEV1-…` device code. Copy the code alone or use **Copy issuance information** for a JSON block containing exactly `product`, `appVersion` and `deviceCode`. The native administrator issuer accepts either form and binds only the device code, so an app upgrade does not change the binding. If clipboard access fails, the corresponding field is selected for manual copying. An unavailable status cannot expose or copy stale device information; the browser development preview does not invent a device code.

Give the code or information block to the operator through an appropriate channel. Paste the returned `LAW1.…` activation string into the client and activate it. The interface supports Chinese, English and Thai. The copied issuance block includes no activation token, raw machine identifier, username or model credential.

The device code is a product-scoped hash of a normalized operating-system machine identifier. The client does not expose the raw hardware/registry identifier, username, hostname or MAC address. Identifier lookup failure leaves required builds read-only rather than generating an unstable substitute. Reinstallation, hardware changes and cloned images need operator review; this is not biometric identification or tamper-proof device attestation.

Signature verification uses pinned Ed25519 public keys. The signature covers the format prefix, key ID and exact encoded payload. Payloads bind product, license UUID, seat 1–100, device code and UTC issue/start/expiry dates. Tokens and activation records are bounded; no private signing key is available to the client or renderer.

The local activation record is `licensing/activation.json` under the selected workspace. It is written atomically with restricted file permissions. Status responses, errors, model requests and ordinary reports do not include the token. Workspace backup/restore excludes credentials and licensing state; it is not a license-transfer or time-reset mechanism.

Dates are checked afresh at work admission. A persisted observation provides best-effort clock-rollback detection, with a one-minute tolerance and admission checkpoints at most once per minute. This is not trusted network time. Offline software cannot prevent an administrator from modifying the program, restoring old state or cloning an entire environment. There is no remote revocation service in this iteration.

## Administrator issuer

The recommended operator interface is the separate [installable Rust/Tauri issuer](license-issuer-desktop.md). It opens the existing key, database and identity marker in place; installed operators need no Node runtime or local browser server. The macOS arm64 DMG has been built locally. Windows native ACL checks and an NSIS build configuration are implemented, with Windows compilation and acceptance still pending.

The earlier browser issuer remains available on the maintainer's **macOS** machine with Node 24+ and the project dependencies. Windows/macOS clients can use its tokens. That Node implementation still deliberately refuses Windows signing; this does not disable the Windows client or establish qualification of the new native Windows implementation.

Run from the repository root:

```sh
npm run license:issuer
```

Open the printed `http://127.0.0.1:<port>` address in a local browser. The process listens only on the loopback interface, uses a random port and makes no model or external-service calls. Keep the issuer running only while needed; Ctrl+C closes it.

The operator interface shows used/remaining seats, existing license dates and device codes. Paste a device code, choose an optional future start time, and issue the token. Start time defaults to the issuer's current time; the tool fixes expiry at 90 days. Copy the token for delivery. Existing tokens can be retrieved without changing their dates or consuming another seat. The tool has no reset, delete, revoke or reissue endpoint; a device can receive only one trial through this ledger.

The current issuer uses:

| File | Purpose |
| --- | --- |
| `.local/license-issuer/issuer-private.pem` | Maintainer-only PKCS#8 Ed25519 signing key. Never distribute or commit it. |
| `.local/license-issuer/issuer-public.pem` | Local public counterpart. The client trusts the public key pinned in `src/core/license-trusted-keys.ts`. |
| `.local/license-issuer/licenses.sqlite` | Transactional issuance ledger, including issued tokens. |
| `.local/license-issuer/issuer-identity.json` | Ledger identity/fingerprint marker. Keep it with the database. |

The private key and issuer directory must have owner-only POSIX permissions; the macOS implementation also rejects extended ACLs on signing and ledger paths. It does not change ACLs for the operator. A different key, damaged ledger, missing database/marker or incomplete initialization fails closed. It never silently starts a new inventory over an existing identity marker.

**Back up the private key, ledger and identity marker together through a controlled operator backup.** If the key is lost, the public key cannot reconstruct it. If a previously used ledger is lost, do not create a replacement ledger and describe its counter as the original remaining inventory. A fresh source checkout intentionally has no official signing private key; authorized maintainers must import their retained key and ledger. Fork maintainers must configure their own trust/key pair rather than receiving the official private key.

The 100-seat check and insert run in one SQLite `BEGIN IMMEDIATE` transaction with full synchronous commits. Multiple issuer processes share the same limit and unique seat/device constraints. A token is returned only after commit. This protects normal issuance and concurrent operators using that one ledger; it cannot prevent a signing-key owner from deliberately duplicating, rolling back or replacing the issuer environment. Use one retained ledger, not independently copied issuers.

The browser receives only public summaries and the requested signed token. It cannot select a key path, read the private key, change the cap/duration or reset the inventory. Exact Host/Origin checks, a session CSRF nonce, JSON/body limits and a fixed static-file allowlist protect the local HTTP surface. No automatic customer messaging or license delivery is performed.

## Validation and remaining acceptance

Tests use ephemeral signing keys, synthetic device codes and temporary ledgers. They cover verification, wrong-device and malformed codes, exact expiry, queued/admitted work, retained export access, missing-ledger refusal and concurrent issuance. A 100-token test verifies every emitted token through the real client verifier and rejects the 101st issuance.

The complete suite passed **594 TypeScript/Node tests** and **61 Rust tests** on macOS arm64. The native diagnostic window passed opaque device-code transport and explicit development-mode checks, cited mock review, tracked DOCX/trilingual PDF exports and restart persistence. The renewed lifecycle run passed 21 scenarios with no observed owned-process/WebKit survivors or matching new crash reports. These window tests use a diagnostic build, not an activated official customer trial.

The real local issuer opened with **0 issued / 100 remaining**; no official license was issued for interface verification. Public-source preparation scans the allowlisted tool source and excludes local signing/activation files. Worker console/stream output is isolated from the private desktop protocol, and faulted native reply registration is covered by deterministic tests; earlier incomplete unbundled-window diagnostics are retained separately and not relabeled as successful runs.

Windows machine identity, DPAPI/WebView2 behavior, installer use and responsiveness on a physical 8 GB computer still require the [Windows acceptance protocol](windows-8gb-acceptance.md). Native issuer Windows ACL implementation and packaging require a Windows build and acceptance; formal non-trial license types, revocation and hardware-replacement policy remain later work. See the [desktop issuer guide](license-issuer-desktop.md) for the additional native and cross-language validation.
