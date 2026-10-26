# Architecture and development

## Runtime boundaries

- `native/law-desktop/`: Tauri window, private sidecar lifecycle, native dialogs, system-protected credentials and offline native PDF rendering.
- `src/desktop/`: portable host validation, queues, credential binding and maintenance.
- `src/main/`: retained Electron reference host plus shared Core and knowledge workers.
- `src/preload/`: constrained renderer bridge.
- `src/core/service.ts`: orchestration, cancellation, workspace mutation queue, source-bound snapshots, and model-runtime wrapping.
- `src/core/storage.ts` and `src/core/migrations/`: business SQLite and version upgrades.
- `src/core/workspace-assets.ts`: versioned assets through the append-only audit journal with optimistic revisions.
- `src/core/knowledge-index.ts` and `src/main/index-node.ts`: persistent local indexing / optional remote index service.
- `src/renderer/src/`: React workbench, source-level localization, and local interface preferences.
- `src/shared/`: typed contracts and serializable domain structures.

The privileged desktop backend owns keys. Ordinary renderer state and exports do not contain API secrets. Model calls run through service-level accounting; partial stream previews stay in memory and are not successful saved reviews.

## Local development

Use Node.js 24+ and `npm ci`. Run `npm run dev` or `npm run build` followed by `npm run preview`. A browser-only preview is available through `npm run dev:web`; it cannot exercise native file access or genuine desktop model operations.

Development business data defaults to `.local/data/`. To isolate a test workspace, set `LAW_AGENT_DATA_DIR` to a new temporary directory before launch. Packaged Tauri applications reuse the original `law-agent-desktop` operating-system data directory. Do not commit either workspace.

## Persistence and upgrades

The current business schema is version 7. Older databases are migrated with retained database backups. A complete workspace backup is required before upgrading important data; a database-only file is not a complete rollback of document artifacts.

Original documents, derived files, review snapshots, source quotations, and human disposition histories are separate. Archiving / trashing preserves managed originals. Permanent cleanup requires a preview and explicit contract-name confirmation; external knowledge files, exported copies, and old backups are not silently deleted.

## Checks and builds

Run `npm run typecheck`, `npm test`, and `npm run build`. Unit and integration tests use synthetic materials. Loopback integration tests need permission to bind a local TCP socket. Real Tauri and Electron reference smoke scripts require a graphical desktop and may use Chromium / Electron libraries unavailable on a headless host.

After `npm run build`, `npm run verify:tauri` checks the bundled runtime, native Canvas, SQLite, WASM, and OCR worker resources. `npm run verify:release` remains the Electron reference resource check. Neither downloads language packs or establishes OCR accuracy. Cross-platform static packaging checks are distinct from executing the app on target hardware.

`npm run pack:win` builds a Tauri Windows NSIS installer; the manual Windows workflow also creates a portable ZIP requiring an installed WebView2 runtime. `npm run pack:mac` builds a Tauri app and DMG for the host architecture. `npm run dev:electron` and `npm run build:electron` retain the prior shell as a comparison harness. Signing and notarization are separate distribution work. `.github/workflows/windows-build.yml` is a manual Windows build workflow, not an automatic publication mechanism.
