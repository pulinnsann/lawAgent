# Memory-first native migration

LawAgent may share an ordinary Windows office computer with an independently deployed local model server. Lower idle memory and processing peaks take priority over installer size. Zero overhead is not achievable. User-selected local/cloud APIs remain the model boundary; do not load another inference, embedding or reranking model by default, or silently change model context/output settings to meet an app resource target.

## Current implementation

The default desktop shell now uses Tauri; the TypeScript business workflows remain in a bundled Node sidecar. Business storage now defaults to **Rust disk SQLite through `native/law-node`**, loaded directly into the existing Core worker via N-API. There is no additional resident storage service. The database stays at schema 7 with the same IDs, triggers, source hashes and original files. The remaining business logic is not yet a complete Rust port. The production [P0 resource-control policy](p0-resource-control.md) now serializes integrated work, uses native OS pressure samples and recycles idle knowledge workers. See [Tauri desktop migration](tauri-desktop-migration.md) for the shell, platform boundaries and historical measured validation.

Developers need Node 24+, Rust 1.89+ and a native C toolchain. `npm run dev`, `npm test` and `npm run build` automatically verify/build the matching binding. Installed users do not need compilers. Missing/incompatible bindings fail explicitly; there is no silent WASM fallback. `LAW_AGENT_STORAGE_BACKEND=sqljs` selects the regression/measurement reference after other instances are closed. Both current backends hold the same kernel writer lease.

| Module | Responsibility |
| --- | --- |
| `native/law-node` | Native connection, actual transactions, bounded row callbacks, read-only validation, online backup and OS-held writer lease. |
| `src/core/storage-backend.ts` | App-owned binding resolution, tagged BLOB conversion, streamed rows, snapshot verification and explicit legacy reference. |
| `src/core/storage-migration.ts` | Closed legacy handoff, first rollback snapshot, staged schema migration, version backups and native hot-journal recovery. |
| `src/core/storage.ts` | Existing repositories, serialized native transactions, close-after-writes coordination and source-only review access. |
| `src/core/storage-pages.ts` | Cursor-paged lists, bounded text windows, cross-page finding lookup and lightweight review history. |
| `src/core/workspace-maintenance.ts` | Read-only native backup inspection, paginated original-asset hash checks and rejection of unmanifested SQLite sidecars. |

See [Native business-storage validation](native-business-storage-validation.md) for import/review/edit/export/restart evidence and the whole-desktop comparison. The [earlier baseline](lightweight-baseline.md) distinguishes historical installers, Electron runtime and synthetic CLI measurements.

## Data preservation and recovery

First activation of an existing workspace retains a byte-identical `workspace.sqlite.pre-rust-backup`. Source and backup hashes are compared through streams; an unrelated, empty or linked existing backup is rejected without replacing either file. After activation, that original snapshot stays unchanged as the compatible main database evolves. Restoring the first snapshot discards later changes, so current backups/exports remain necessary.

Schemas 1–6 migrate on a private disk copy and retain their established `.vN-backup` images. Migrations validate foreign keys before publication; failure leaves the original main database unchanged. New databases are also initialized on a private copy. `.native-storage.json` identifies activation and contains no credentials or contract text. Snapshot files and activation metadata are synchronized before normal writes, with directory sync where supported. This is not a universal power-loss guarantee for every filesystem.

Native transactions use DELETE journaling and FULL synchronization. A kernel file lock prevents current instances from sharing a data root; close or process termination releases it. The app never recovers a lease by deleting a stale PID file. Known native startup lets SQLite recover its hot journal under that lease. First legacy handoff requires a closed single-file source without WAL/SHM/journal sidecars. Older apps and external database tools do not implement this lease: close them before opening the same workspace.

Main-process maintenance stops workers, holds the lease through backup/restore/index maintenance, then releases it before restarting the Core worker. Backup inspection checks the manifest, rejects unlisted database sidecars, opens SQLite read-only and validates original-asset references in bounded batches. It no longer loads an entire backup into WASM.

Model/retrieval credentials remain in their existing vault/session boundaries; Rust storage neither reinterprets ciphertext nor persists API keys. Immutable snapshots, approval histories, DOCX formatting and existing/new Word revisions retain their established business logic. Legal/language acceptance remains with qualified reviewers.

## Bounded data access

The previous SQL.js backend loaded the entire business file, retained a complete rollback image per transaction and exported the database again on persistence. Native SQLite uses its disk pager and real transactions; native `flush()` does not serialize the database. The explicit reference backend retains its copy pattern for measurement.

SQLite's default 8 MiB cache setting is a suggestion, not an RSS cap; mmap is disabled. See [SQLite cache_size](https://www.sqlite.org/pragma.html#pragma_cache_size). Native metadata queries default to a 64 MiB result guard and row callbacks to a 256 MiB cumulative guard. Oversized operations fail explicitly rather than silently truncating. These guards do not cover every allocator/browser/model allocation.

| API | Bound and behavior |
| --- | --- |
| `listDocumentsPage` | `(createdAt,id)` cursor, default 50/max 100, workspace and lifecycle filtering before pagination. |
| `getDocumentBlocks` | Max 100 items, 512 KiB serialized page envelope, 16K Unicode-code-point windows. Large paragraphs continue via explicit cursors without rewriting originals. |
| `getDocumentReviews` | Default 25/max 50 summaries; mode/count from normalized metadata, without fetching report bodies. |
| `getDocumentView` / `getReview` | Initial source/history page; only the selected full review is loaded. |
| `getDocumentForReview` | Complete source for an actual operation, with `reviews:[]`; unrelated report history is omitted. |

The compatibility `getDocument()` still returns full source/history for explicit callers; it is not the default UI refresh. Display-window coordinates do not replace immutable original anchors or the established UTF-16 patch semantics. Chinese, English, Thai and emoji text remain reconstructible across pages. The modification panel loads targets on expansion, releasing rebuildable data when collapsed while preserving unsaved edits/running work. Selection request ordering suppresses stale replies.

## Priority for the customer's model

Model review reserves startup state, cancels an existing index job and waits for actual cleanup before proceeding. The production scheduler now grants one active lease across integrated model, foreground-heavy and background-index operations, with model priority and a bounded waiting queue. Manual indexing is rejected with a resumable explanation while a model review starts/runs; automatic refresh defers during reviews. Scope changes and closing still cancel correctly. See [P0 resource control](p0-resource-control.md) for the exact operation inventory and exceptions.

The production policy is implemented in the TypeScript business service, rather than a complete native governor. Contract and local review, generation, editing, translations, OCR/conversion, reports, explicit knowledge operations and native PDF now share cooperative admission boundaries. Native macOS/Windows pressure samples influence new admission; unknown or stale samples use the serial fallback. Review task bookkeeping can still contain two reviews, but admitted model execution is serial. Lightweight reads, diagnostic paths and maintenance retain their documented separate boundaries. There is no automatic third-party model activity detection; the app does not manage model weights, KV cache, VRAM or batch configuration.

`native/law-core/src/resources.rs` remains a separate cooperative admission experiment. Its default 64 MiB reservation budget, one-model/one-heavy mutual exclusion, explicit priority guard and externally supplied pressure levels are tested in isolation; they are not the production scheduler or a desktop RSS guarantee. Production leases likewise remain held until actual operation and knowledge-worker cleanup, including cancelled-search drains. Idle knowledge workers now close after 60 seconds without pending work and reopen their committed index on demand. Release builds use `panic=abort`; unwind tests do not establish in-process production panic recovery.

## Next stages

1. Accept the integrated adapter on target Windows hardware and representative histories, retaining the regression oracle and reversible data gates.
2. Port remaining services behind narrow Rust commands, preserving cancellation, bounded downloads and source snapshots. Do not move privileged code into the renderer.
3. The default shell replacement is implemented. [Tauri uses the OS WebView](https://v2.tauri.app/concept/architecture/), which still needs resources and may create multiple processes. Keep measuring the retained Node sidecar and all system WebView processes; qualify Windows and realistic local-model workloads separately.
4. Preserve native dialogs, lazy vault unlock/session fallback, canonical filesystem authority, HTTP DNS/redirect/SSRF policy, Codex subprocess cancellation, silent PDF exports and Word revisions.
5. Port the knowledge worker with versioned multilingual tokenization, streaming scans and restartable increments. Its index already uses disk SQLite; 1 TB of source files is not loaded into RAM at once. Never silently reuse an incompatible index.
6. Validate the implemented [P0 admission and native-pressure integration](p0-resource-control.md) on ordinary Windows 8 GiB hardware with an actual local model, then measure packaged process trees and optional-engine peaks. Extend uncovered paths when evidence warrants it. Representative 1 TB acceptance remains separate from small fixtures.

## Commands

```sh
npm run native:binding
npm run native:test
npm run native:test:binding
npm run build
npm run measure:business-memory
```

The wrapper discovers Cargo or honors `LAW_AGENT_CARGO`. Project caches are `.local/rust-cargo` and `.local/rust-target`, overridable through `LAW_AGENT_CARGO_CACHE` and `LAW_AGENT_CARGO_TARGET`. It does not install a global toolchain. Compile the binding on the target OS/architecture; stable N-API supports the existing Node/Electron boundary. Packages include the matching `.node` resource.

The earlier synthetic `law-core` CLI remains available through `npm run native:benchmark`. Its seed writes only an empty/marked experiment, capped at 256 MiB payload. Its schema-check reads a selected closed copy's marker only. Its backup uses [SQLite online backup](https://www.sqlite.org/backup.html) and private staging/non-overwriting hard-link publication, requiring same-filesystem hard-link support. CLI-only peaks must not be presented as complete desktop savings.
