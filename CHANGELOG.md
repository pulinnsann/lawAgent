# Change log

This log describes source updates. A source update does not imply a signed installer or a GitHub Release. The application version remains **0.3.0** for this milestone.

## Unreleased — P0 resource control and 8 GB Windows acceptance preparation

- Collect current macOS arm64 and Windows x64 customer test installers with architecture/version checks, production-hook exclusion, runtime verification, SHA-256 checksums and installation instructions. Verify the actual macOS DMG payload; keep Windows artifacts on the manual Actions run without creating a public Release.
- Verify actual Windows NSIS payloads against the complete executable hash after only Tauri's documented bundle-type marker patch. Check all 7,024 extracted runtime files and their correspondence with the Windows-executed engine probes. Produce both customer installers locally with checksums; commercial code signing, Apple notarization and Windows physical-device acceptance remain outstanding.
- Pass 638 Windows engineering tests with 15 platform-specific skips, 30 Core/adapter Rust tests, 29 native desktop Rust tests and six actual N-API checks. Pass 653 local engineering tests and three focused NSIS identity tests, including rejection of ambiguous markers and unrelated byte changes.
- Make the Windows regression fixtures honor native process-signal semantics, close service/database owners before deleting temporary workspaces, and normalize ASAR API paths without changing saved source names or weakening native-resource rejection checks.
- Add bounded, privacy-allowlisted local problem logs and a Chinese/English/Thai export panel available without activation and when the Core worker is faulted. Retain structured lifecycle/task/error categories instead of raw payloads, console streams or error text. Add native startup journals and limited startup-failure export; preserve original files with create-new saves and keep cancellation/closing behavior explicit.
- Pass 653 TypeScript/Node tests, 87 Rust tests, native log export/privacy/restart checks alongside the contract workflow, and 21 native lifecycle scenarios. Rebuild the ordinary macOS production app without diagnostic hooks and verify a real UI log export while retaining the activated trial and saved workspace.
- Add 262 Chinese/English/Thai presentation overrides for legal professionals, with everyday task labels and optional advanced disclosures for authorization JSON, model compatibility, service tool mapping and report verification values. Retain stable action keys and verbatim contract/source/saved-report content. Pass 620 TypeScript/Node regressions, including manual-copy fallback through closed details and unchanged legal text.
- Display a prominent local issuance-information card with product, actual app version and a wrapping device code; add raw-code and whole-information copying with manual selection fallback. Hide stale information when license state is unavailable. Let the native issuer accept the exact bounded information block while signing only the existing device-bound payload. Keep Chinese/English/Thai text and offline authorization rules intact.
- Pass 615 TypeScript/Node regressions after the issuance-information update, including the actual customer-copy to native-issuer input transfer and clipboard fallback. Preserve the unchanged native license format and quota; tests consume no official seats.
- Add a separate installable Rust/Tauri administrator license issuer with no Node sidecar or HTTP listener. Continue the existing key/SQLite/identity marker, enforce the original 100-device/90-day policy, retrieve original codes, and save new activation text files through a native dialog. Build an unsigned macOS arm64 app and DMG; prepare a manual macOS/Windows installer workflow with Windows compilation and ACL acceptance still pending. Keep all private signing material outside installers.
- Pass 606 TypeScript/Node regressions and 20 new native issuer/host/permissions tests. Verify legacy Node-to-Rust ledger continuity, real client activation of a Rust-signed token, and subsequent Node issuance using only ephemeral keys. Inspect the native unconfigured window and consume no official trial seats. See [desktop issuer installation](docs/en/license-issuer-desktop.md).
- Add required offline trial licensing to official distributions: Ed25519 verification, opaque single-device binding, 90 signed days, read/export access after expiry and admission checks before new work. Keep already admitted work and saved results intact.
- Add a separate loopback-only operator issuer with a transactional 100-seat ledger, one trial per device, existing-token retrieval, private-key separation and lost-ledger protection. Its first signing environment is macOS; Windows client support remains, while Windows issuer ACL qualification is pending. The Apache-2.0 source license remains unchanged.
- Pass 594 TypeScript/Node tests, 61 Rust tests, the renewed device-context/native-window workflow and 21 lifecycle scenarios. Isolate Core/nested-worker diagnostic streams from the private JSON protocol and prevent a native request from being registered after fault cleanup has drained its reply map.
- Reduce repeated selected-DOCX inspection with one bounded, short-lived compact metadata entry, fresh source hashing on every reuse and a serialized inspection queue. Pin and bound source reads; reject changed/replaced originals. Preserve manual edits during model drafting, current human decisions, existing revisions and full patch/export checks.
- Query only current workspace-asset bodies with SQL, preserving append-only history, ordering, tombstones and optimistic revisions. Avoid returning obsolete bodies during current reads/save checks; keep explicit history available.
- Pass 527 TypeScript/Node tests after these changes, including two cleanup-failure/writer-release regressions. Record current development and target/professional acceptance separately in the [iteration backlog](docs/en/iteration-backlog.md).
- Add a production Core scheduler with one active lease, a bounded queue, model-task priority, cancellable waiting and deferred background indexing. Integrate reviews, generation, model tools, document imports, OCR/conversion, reporting and exports, including private admission for the native PDF renderer. Keep interactive reads and human edits available.
- Retain leases until actual cleanup completes. Draining a cancelled knowledge request, shutting down a worker, or publishing a terminal review status cannot prematurely admit the next heavy operation.
- Retire knowledge workers after 60 idle seconds and reopen their persistent index on demand. Preserve committed chunks, source citations and incremental-update state.
- Sample native macOS pressure and Windows physical-memory load/headroom without a new resident service. Defer new document/index work under warning pressure and all new scheduled work under critical pressure; treat unavailable or stale readings as unknown. Add a Chinese / English / Thai task-and-resource panel.
- Register cancellable model/conversion requests before credential prompts and file dialogs, so late preflight results cannot start cancelled work.
- Preserve debug information in release host build dependencies to avoid malformed stripped macOS proc-macro images; shipped application stripping remains enabled.
- Add an explicit-PID process-tree collector and a [physical Windows 8 GB acceptance plan](docs/en/windows-8gb-acceptance.md), covering remote and independently deployed local model APIs, Office coexistence, installation, data retention and Word exports. Actual target-device performance and real-model pressure acceptance remain pending. No additional local inference engine or hard RSS/VRAM guarantee is introduced.
- Pass 500 TypeScript/Node tests, 51 Rust tests, six actual N-API checks, the real macOS window workflow and 21 native lifecycle scenarios. Verify the live native pressure sample and complete resource cleanup after cited mock review and multilingual PDF export. These checks use synthetic data and do not certify Windows 8 GB performance.

See [P0 resource control](docs/en/p0-resource-control.md) for integration boundaries and validation evidence.

## 2026-10-26 — Tauri desktop and memory-first Rust storage

### Desktop runtime

- Make Tauri 2 and the operating system WebView the default desktop shell. Keep Electron as an explicit development and comparison reference.
- Bundle a checksum-pinned official Node 24 runtime for the existing contract, document, retrieval and reporting engines. Connect the Rust host and the sidecar over inherited private pipes, with bounded frames and request admission.
- Preserve all 47 desktop commands and task-update events through the constrained renderer bridge, native file dialogs and validated workspace access.
- Add OS-protected credentials in a separate namespace: Keychain-backed authenticated encryption on macOS and current-user DPAPI on Windows. Preserve legacy encrypted credential files and show a one-time re-entry notice.
- Export offline PDFs with native system WebViews, including temporary-view cleanup and licensed embedded Thai fonts. Retain source quotations and the existing human approval requirements for translated reports.

### Storage and resource use

- Use Rust N-API disk SQLite for the actual business database, owned by the existing Core worker. Retain schema 7, document originals, identifiers, review history and export records.
- Preserve a validated, byte-identical pre-Rust database backup on first activation; migrate older schemas on closed staged copies. Protect the data root with an operating-system writer lease.
- Page contracts, source blocks and review summaries; load selected reports and the modification workspace when requested. Preserve cross-page source selection and original text anchors.
- Initialize knowledge indexing lazily. Cancel and finish active indexing before model review, and defer new indexing while that review is active.
- Keep model deployment under the user's control. No resident local model, embedding engine or reranker is introduced by this migration. The review and document engines still use Node; the earlier Rust CLI policy experiment is not a production hard memory limit.

### Startup and shutdown fixes

- Handle initialization failures through a controlled error and exit instead of returning an error into the Tauri setup callback and causing a panic.
- Stop admitting new work during shutdown; cancel model requests, connection tests, indexing and native PDF activity, then drain owned workers and release the database lease.
- Correct cancellation and worker-close ordering, track asynchronous work until completion, and bound ordinary shutdown while allowing critical maintenance publication or rollback to finish.
- Handle a second launch or macOS Dock reopen during exit by starting a replacement after single-instance cleanup.
- Isolate diagnostic builds from ordinary user instances and exclude test hooks from production builds. Wait for development assets before opening the local development page.

### Build and compatibility

- Add reproducible Tauri assets, runtime preparation, Rust dependency locking, license notices and native resource verification.
- Update the manual Windows x64 workflow to build native storage, run engineering checks and collect an NSIS installer, portable ZIP and checksums. It does not publish a release automatically.
- Target Windows 10+ with WebView2 and macOS 13.5+, matching the bundled Node runtime. Preserve the previous `law-agent-desktop` workspace directory; development uses `.local/data/`.
- Document Rust/Node boundaries, data migration, measurement methods, target-device limitations and the code changes required to adapt the mainland-China legal scope to another jurisdiction.

### Validation and measured scope

- Passed 437 TypeScript/Node tests, 45 Rust tests (22 Core, 12 storage adapter and 11 desktop), and 6 actual N-API checks.
- Passed the real macOS arm64 window workflow: legacy-data handoff, DOCX import, API configuration, local knowledge indexing, source-cited review, item-by-item adoption, tracked DOCX export, Chinese / English / Thai PDF export and restart persistence.
- Passed 21 lifecycle scenarios covering early exit, idle exit, active model requests, cancellation, indexing, pending PDF export, injected startup failure and overlapping relaunch. No owned Rust/Node survivors or matching new macOS crash reports were observed in that run.
- Verified 7,005 bundled runtime files and native Canvas, SQLite FTS5, Rust SQLite transactions and offline OCR components. Built an unsigned macOS arm64 production app without diagnostic hooks.
- Paired migration-build measurements showed initial idle summed process RSS reductions of 24.67% for a 3-document workspace and 24.02% for a 161-document synthetic-history workspace. These individual macOS measurements used a mock model; shared memory may be counted more than once. Subsequent lifecycle fixes have separate validation and build identities.

See [Tauri migration](docs/en/tauri-desktop-migration.md), [complete validation and measurements](docs/en/tauri-desktop-validation.md), and [native storage validation](docs/en/native-business-storage-validation.md).

Windows and Intel Mac runtime acceptance, signed/notarized distribution, real local-model memory pressure, a 1 TB knowledge corpus, and professional legal/language acceptance remain outstanding. Brave search remains deferred. Public source excludes customer contracts, workspaces, credentials, build caches and local diagnostic artifacts.

## Previous source baseline — 0.3.0

The previous public source includes contract review and generation, local and remote knowledge connections, official-source retrieval, Word tracked changes, configurable enterprise standards, human-approved experience, source-bound bilingual/trilingual alignment, English/Thai report preparation and a Chinese/English/Thai interface. See the [earlier engineering record](docs/en/validation.md) and [multilingual workflow guide](docs/en/multilingual.md).
