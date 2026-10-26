# Native business storage validation

The business storage transition keeps the Electron/Node application and existing TypeScript workflows while replacing the `sql.js` whole-file database with a Rust N-API SQLite connection. The default storage backend is `rust`; `LAW_AGENT_STORAGE_BACKEND=sqljs` is an explicit regression and measurement reference. A missing native binary must produce an error, rather than silently loading a second runtime strategy.

This is a storage integration milestone. It does not remove Electron, migrate document processing into Rust, or control the memory used by a customer's local model. The separate `native/law-core` synthetic CLI experiment is not the business database implementation.

## Data preservation checks

`tests/native-business-storage.test.ts` builds a new, closed schema-7 workspace through the real legacy `AppStore`, then opens it through the default native backend. Its fixture includes a Chinese/English/Thai DOCX with bold text, a header and an existing Word revision; a saved review; and a previously accepted change.

The checks cover:

- The original workspace ID, document blocks, review and approved proposal survive the handoff.
- `workspace.sqlite.pre-rust-backup` contains the byte-identical pre-handoff database and is not replaced on restart.
- A tracked DOCX export includes new insertions/deletions and keeps the original revision, bold text and unchanged original file.
- Restart preserves the export record, review and accepted proposal.
- After native close, the explicit legacy backend can still read the review and new export with intact foreign keys.
- A transaction that fails after its first write rolls back that write, including after reopening the database.
- A native owner prevents both native and explicit legacy processes from opening a competing writer; terminating the owner releases the operating-system lease.
- Terminating a process with an actual, spilled, uncommitted transaction leaves a rollback journal that the next native opening recovers without losing historical data or the original backup.
- First activation refuses an unrelated existing rollback file, including an empty SQLite file that can pass `quick_check`; both original and conflicting backup remain unchanged.

The existing migration and business regression suites remain required. These focused checks add the schema-7 backend handoff; they do not replace earlier schema upgrade, export, backup, language or business workflow tests. All fixtures are synthetic and use temporary directories. No real workspace is opened by these tests.

## Full desktop comparison protocol

After building the native adapter and application, run:

```sh
node --import tsx --test tests/native-business-storage.test.ts
node --import tsx scripts/measure-business-storage-memory.mjs \
  --history-mib 64 --documents 161 --window-seconds 3 --interval-ms 100 \
  --output output/playwright/native-business-storage/comparison.json
```

The measurement harness creates an empty synthetic workspace, populates it through the legacy business store, closes it, and copies the same database and original file into separate backend workspaces. It checks the database hashes before either application starts. The database contains 161 contract records, an original review and proposal, and at least 64 MiB of synthetic audit JSON. The large history deliberately exercises database-size sensitivity while opening and reviewing one small contract; it is not a claim that every contract occupies this much storage.

Both runs use the same production-built `out/` through development Electron, the same hidden-window settings, and no forced garbage collection. Each run traverses contract and original-text pages, imports the same new DOCX, performs a local review, configures a loopback mock model, indexes a local policy, performs a model review with a matched original-source citation, accepts one change and rejects another, exports tracked Word and a cited report, then restarts and verifies persisted results.

The only model endpoint is a loopback fixture. No actual cloud or local inference model is called. Public web retrieval is disabled. Native folder and export dialogs are supplied deterministic synthetic paths through the application's normal IPC boundary.

On macOS/Linux, the harness samples the entire application process tree with `ps` and also records Electron process metrics. On Windows, comparison rows explicitly use the Electron working-set sum instead. Worker threads share their owning process and are not counted twice as separate processes. Playwright, fixture creation and copying run outside the application process tree.

## Observed result on 2026-10-23

The paired run passed on an Apple M3 Max with 36 GiB RAM, macOS kernel release 27.0.0, arm64. It used one legacy run followed by one native run, with 3-second minimum windows and 100 ms requested sampling. The actual schema-7 database was 71,172,096 bytes and contained 161 document records plus 4,111 synthetic audit rows carrying 67,124,408 payload bytes. Both copies started with SHA-256 `c0c0df4a046ac7620ef5221ee2b011f814838c9164f1f54f378e2af669ee71e6`.

The table reports **sampled whole-application process-tree RSS peaks**, in MiB; each run had four processes:

| Phase | Legacy `sql.js` | Rust SQLite | Observed difference |
| --- | ---: | ---: | ---: |
| Initial idle with historical workspace | 725.05 | 644.53 | 80.52 |
| Contract and original-text pagination | 727.34 | 652.14 | 75.20 |
| New DOCX import | 816.41 | 668.53 | 147.88 |
| Local review | 839.06 | 691.59 | 147.47 |
| Mock model review with matched local citation | 855.69 | 710.00 | 145.69 |
| Propose, accept and reject changes | 867.70 | 720.13 | 147.58 |
| Tracked DOCX and cited report export | 870.89 | 726.38 | 144.52 |
| Idle after complete review | 866.16 | 721.58 | 144.58 |
| Restart and persisted-data verification | 712.34 | 556.75 | 155.59 |

The largest sampled peak in each complete run was **870.89 MiB versus 726.38 MiB**, a difference of **144.52 MiB (16.59%)** on this fixture. The first native activation includes snapshot and validation work and retained more RSS than the restart phase; these phases should not be presented as interchangeable idle baselines.

All contract/text page traversal, actual UI import and selected-document rendering, local review, mock API review, matched citation, accepted/rejected proposal, Word insertion/deletion, prior-revision/format preservation, cited report and restart assertions passed. No renderer page errors or HTTP requests occurred. The only HTTP request in each application flow was the configured loopback model call made by the Core worker.

The raw report and screenshots are local generated artifacts under `output/playwright/native-business-storage/`: `comparison.json`, `sqljs-completed-review.png` and `rust-completed-review.png`. The report contains all per-sample metrics and build-file hashes. The paired runs used unchanged `out/` and native binaries; hashes were recorded immediately afterward, before a later frontend selection-race guard was rebuilt. That guard suppresses stale view responses without changing the storage workload; the final rebuilt application receives a separate complete-flow check.

| Measured component | SHA-256 |
| --- | --- |
| `out/main/index.js` | `c4ace7302604750fda3b9f399e10fb6debec2f02d573334e63622ca680716343` |
| `out/main/core-worker.js` | `8998404f6e7aa0bedfbcda51708a82aaaa75eb27416fabf705dfc5895523f28e` |
| Renderer JavaScript `index-CfBpkF0t.js` | `df3c05af1748619ccf53b3773e073dd7c5ec32b288597f67dca7558e5329f016` |
| Whole `out/` manifest | `d694534a6bdf70a83f6fb712ec36bbc59d24e19f8d0c80023340020791b2872d` |
| Native macOS ARM64 adapter | `df6e5c5a6f5386eb1feb45c3eee24a3b1a339d1afaeb1dc699b4713f40ea3a8a` |

Future harness runs record the build manifest before measurement and verify it again at the end, rejecting a comparison if application output or the native binding changes between runs.

## Final-build small-workspace check

A second complete paired run used the final rebuilt application on the same host, with **three existing documents, no added synthetic audit payload, and a 552,960-byte database**. Both copies began with SHA-256 `03ceb9912e173a08a8b0e3ff5bccc348aa87547147c0a37f05a1f56c51ee2823`. This run used **Rust first, then `sql.js`**, 2-second minimum windows and 100 ms requested sampling. It checked the build manifest both before and after the run.

| Phase | Legacy `sql.js` peak MiB | Rust peak MiB | Observed difference MiB |
| --- | ---: | ---: | ---: |
| Initial idle | 574.91 | 548.63 | 26.28 |
| Contract and original-text pagination | 571.69 | 545.31 | 26.38 |
| New DOCX import | 595.48 | 566.52 | 28.97 |
| Local review | 622.45 | 583.58 | 38.88 |
| Configure model and local index | 619.44 | 585.52 | 33.92 |
| Mock model review with matched local citation | 649.83 | 607.25 | 42.58 |
| Propose, accept and reject changes | 661.16 | 613.16 | 48.00 |
| Tracked DOCX and cited report export | 667.34 | 617.70 | 49.64 |
| Idle after complete review | 667.31 | 612.95 | 54.36 |
| Restart and persisted-data verification | 569.95 | 540.72 | 29.23 |

The largest sampled peaks were **667.34 MiB versus 617.70 MiB**, a difference of **49.64 MiB (7.44%)**. This is a smaller improvement than the larger-history case. The result supports reducing storage overhead; Electron and the remaining application still dominate the small-workspace footprint.

Both complete final-build flows passed, including actual UI import, rendered review, citation IDs/quotes/file hashes, individual acceptance/rejection, tracked export retaining original revisions and bold formatting, cited report export and restart. Four screenshots per backend show the complete-review view, proposal decisions, expanded persisted export history and cited-review view. They are under `output/playwright/native-business-storage/final-small-workspace/` alongside `comparison.json`.

The final `out/` manifest SHA-256 was `5d2a2164cd4a7aab8e3c01eb92bbbebfae82c1115c3491c406935f7df6ab8ef8`; the main entry was `2cd40b1efdbcb083b08b71b5bd365cf9454c6980216b1f4fdd72f5179737e894`, and renderer JavaScript `index-CQO0rBhf.js` was `affa976f8b4f1c2e685615132ab510fb791b5786820f41850653afbfa3f40449`. The Core-worker and native-adapter hashes match the larger-workspace comparison above.

After all measured applications exited, read-only aggregate checks confirmed that both larger-workspace copies retained all **4,111 historical synthetic audit rows and 67,124,408 payload bytes**. These checks ran outside the measured application processes and are recorded in the raw reports. A process-list check confirmed that all 32 recorded application process IDs from the two paired runs had exited; the loopback servers were also closed.

## Subsequent pagination compatibility acceptance

A later Library compatibility fix gives the manual-annotation source selector its own bounded pages. It preserves original source IDs selected on other pages and removes duplicate option IDs when one long Unicode paragraph is displayed as multiple fragments. The main document pane's current page is not treated as the complete list of annotation sources.

`scripts/smoke-library-source-pages.mjs` exercised the actual desktop multi-select against **125 synthetic paragraphs**, including a **17,038-code-point Unicode paragraph**. The first source page contained 100 display fragments but only 99 unique original source IDs. The UI selected the long original block on the first page and original block 111 on the second, returned to the first page, and saved while the second selection was off-screen. It then closed Library, changed the main document display page, reopened the annotation, saved another revision while the first selection was off-screen, and restarted the application.

Both original source IDs survived every step. Backend effective-finding validation matched the complete original quote from block 111; neither the original DOCX nor the saved review changed. The UI smoke passed with no page errors, model calls or HTTP requests. Its result and two inspected screenshots are under `output/playwright/native-business-storage/library-source-pages/`. The smoke recorded build-manifest SHA-256 `631c5c28c478832319ec64a1454135ec6a4c324f1b8259c557155148175fede8` and verified it remained unchanged throughout the test.

Run the compatibility check after building the current application:

```sh
node --import tsx scripts/smoke-library-source-pages.mjs
```

This is an independent functional acceptance check, **not a new memory measurement**. The two memory comparisons above retain their exact measured build hashes. Subsequent native-startup transaction hardening is checked separately by `tests/native-lifecycle.test.ts`; it must not be presented as included in those earlier measured builds.

## Interpretation limits

Summed RSS or working set can count shared pages more than once; it is not an exclusive physical-memory footprint. Sampling begins after application readiness and therefore excludes startup peaks. Short allocation peaks may also occur between samples. The report states the requested interval and actual sample counts.

The same application build includes pagination in both reference and native runs, so the backend comparison isolates storage behavior rather than conflating it with an old frontend build. Electron, Node, React and the knowledge worker remain in both runs. A substantial native storage improvement does not establish that the complete application is already suitable for a particular office PC.

The loopback mock does not model inference RAM, GPU allocations or CPU contention. A 64 MiB business-history fixture does not certify a 1 TB knowledge corpus. Target Windows devices, large contracts, PDF/OCR, repeated opening/closing and packaged installers still require their own measurements. Legal and language correctness remains subject to professional acceptance.


## Final engineering checks

After the measured builds, the independent annotation-selector compatibility repair and native startup atomicity hardening received their own regression checks. Startup now keeps workspace/rule/provider initialization and interrupted-task updates in one native transaction, so a failed rule-version insert cannot leave a partial seed. Concurrent transactions are serialized, and close waits for accepted writes. These later changes are not assigned new memory-reduction percentages.

The final source passed:

- **413 TypeScript/Node tests**, including original migrations/workflows, cross-page source selection, real subprocess crash recovery, backup sidecar rejection and native startup failure/queued-close cases.
- **34 Rust tests** across the synthetic core (22) and production adapter (12).
- **6 actual Node N-API tests**, including callback exceptions, Unicode/BLOB values, process locks and interrupted SQLite recovery.
- Type checking and the production Electron/Vite build.
- A final real-desktop smoke on the rebuilt source: native DOCX import (10 blocks), local review, model connection, loopback model review, source navigation, report export, restart with both reviews, and Chinese/English/Thai PDF import (3 blocks). Its log is `output/native-business-desktop-final.log`.
- An isolated unsigned macOS ARM64 package resource inventory and actual packaged-Electron Node-mode runtime probe: 43 resources verified, including Rust SQLite/Unicode transactions, native Canvas, FTS5 and offline OCR core loading. This verifies resource inclusion and runtime loading; it is not a signed/notarized installer or Windows acceptance claim. The package check used the same native adapter and was independent of the later UI-only selector repair.

Generated logs, screenshots, databases and app directories are ignored local artifacts. The source allowlist audit includes the native crates and scripts while excluding customer data, compiler caches, bindings and binaries. No customer workspace was opened by these validation runs.
