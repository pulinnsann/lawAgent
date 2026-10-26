# Change log

This log describes source updates. A source update does not imply a signed installer or a GitHub Release. The application version remains **0.3.0** for this milestone.

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
