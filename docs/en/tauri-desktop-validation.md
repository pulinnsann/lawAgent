# Tauri desktop migration validation

The default desktop shell is Tauri 2 with the operating system WebView. A private, framed stdin/stdout connection joins the Rust host to one bundled Node review process. The existing TypeScript document, model, retrieval and reporting workflows remain in that process and its worker threads. Business SQLite still uses the Rust N-API adapter. This milestone removes the resident Electron shell from the normal application; it does not claim that every business module has been rewritten in Rust or that Node has been removed.

The Node sidecar is bundled, so an installed application does not require a separate Node installation. The staged macOS arm64 runtime used for these checks is Node **24.22.1**, verified against the official distribution checksums. No local model, embedding engine or reranker is started by this migration. Knowledge indexing initializes its worker only when it is used. The existing model-review priority and index cancellation rules remain in the shared Core service.

## Compatibility and data preservation

The desktop bridge retains all **47 commands and the task-update subscription**. The bridge parity test executes the real Electron preload with a controlled transport and compares every command, argument shape, default and result to the Tauri implementation. Event listeners are installed before the bridge is exposed; normal browser preview and the explicit Electron reference remain available. A failed desktop connection displays an error instead of silently opening an in-memory preview.

The production workspace remains `law-agent-desktop` under the platform application-data directory. An isolated probe of the previous packaged Electron app confirmed that its default macOS path was `~/Library/Application Support/law-agent-desktop`; it did not run the original application, open its database or access its credentials. `LAW_AGENT_DATA_DIR` remains the explicit override, and development retains `.local/data`. The schema-7 database, original documents, review history, approved changes and export records use their existing formats. The writer lease, closed-file handoff checks and byte-identical `workspace.sqlite.pre-rust-backup` remain in force. Close the previous desktop application before opening the same workspace in Tauri.

Electron-encrypted credential files are retained byte for byte. Their encryption format is not reused as a Tauri vault. The UI identifies credentials requiring re-entry; model names, endpoints and contract data are preserved. New credentials use a separate encrypted file and native OS protection: Keychain-backed authenticated encryption on macOS and DPAPI on Windows. The renderer receives key-presence information rather than stored secret values. The synthetic native acceptance run saves a key, restarts the application, and verifies that a subsequent loopback model request uses the same decrypted credential. Its Keychain key uses a UUID-isolated test namespace and is deleted after the run.

PDF export uses a temporary native WebView and system print-to-PDF on macOS, and WebView2 PDF export on Windows. It does not start Electron to print a report. The native HTML policy blocks external loading, and the temporary export WebView is released. English and Thai reports continue through the existing separate translation preparation and human-confirmation gate. Test translations are explicitly synthetic; they do not constitute language or legal acceptance.

Windows and macOS packaging paths remain supported. The macOS installer now declares the actual **13.5 minimum** required by the bundled official Node runtime, rather than advertising 12.x support that the sidecar cannot provide. See the [Node supported-platform requirements](https://github.com/nodejs/node/blob/v24.22.1/BUILDING.md#platform-list). Windows requires Windows 10 or later with WebView2; the installer can bootstrap WebView2. These local results are macOS arm64 results. Windows runtime behavior, Intel macOS, signing, notarization and a production installer are separate acceptance checks.

## Automated and native-window checks

The frozen build passed:

- **426** TypeScript/Node tests, including bridge parity, credential rollback, cancellation, source anchoring, multilingual workflows, database migration and backup/restore regressions.
- **42** Rust tests: 22 Core policy/storage tests, 12 N-API storage tests and 8 desktop host/PDF/credential tests.
- **6** actual Node N-API tests, including native SQLite transactions, interrupted journal recovery and the operating-system writer lease.
- TypeScript checking, Electron reference build, Tauri renderer/backend build and the optimized native smoke-feature build.
- The real framed sidecar protocol smoke: fresh migrations, closed schema-7 handoff, preserved review, tracked export, credential restart and legacy ciphertext retention, unauthorized-path rejection, backup inspection/restore, worker restart and clean shutdown.
- Release-resource verification of **7,005** staged runtime files. The bundled official Node process exercised Canvas raster/PNG, SQLite FTS5, Rust business SQLite with Unicode and transactions, and the offline Tesseract worker/core. The verifier confirmed that Electron is absent from this runtime.

Each real desktop run opens the actual application window and exercises the same synthetic workflow through the ordinary bridge and DOM controls:

1. Open a closed legacy schema-7 workspace and traverse paged contracts and source blocks; compare the full historical review by value.
2. Click native contract import, render a new DOCX, save a model API configuration and an OS-encrypted synthetic key, and test a loopback connection.
3. Select an authorized knowledge folder, build its local index and run both a local review and a model review from the UI. Check live task events and a citation matched to the stored original policy text and file hash.
4. Display the changes panel, accept one edit and reject another, then export Word-native tracked changes. Inspect the DOCX ZIP/XML for new insertions/deletions, the original revision author, bold formatting and absence of rejected text; verify that the original source bytes remain unchanged.
5. Export a cited Markdown report and paginated Chinese, English and Thai PDFs. Parse PDF pages and verify all three scripts, the original contract quote and the original Thai knowledge-source quotation. Thai PDF extraction comparisons normalize SARA AM decomposition and line wrapping; the original source file hash is checked separately.
6. Import a trilingual text PDF and restart the application. Verify full saved reviews, accepted/rejected decisions, tracked export history, original documents, pre-handoff database backup and the decrypted API credential. A successful report followed by forced termination is treated as a failure.

The native runner is compiled only with `desktop-smoke`. Its initialization script and diagnostic report command are unavailable in normal production builds. It exposes no localhost service or general renderer filesystem API. All fixtures and report destinations are temporary and synthetic. Customer workspaces and real model accounts are not used.

## Reproduction and measurement method

Build the Electron reference and Tauri assets, then build the native test binary:

```sh
npm run build:electron
npm run build:tauri
node scripts/native-core.mjs build -p law-agent-desktop --release --locked --features desktop-smoke
node --import tsx scripts/smoke-tauri-desktop.mjs \
  --shells electron,tauri --history-mib 0 --documents 3 \
  --window-ms 3000 --interval-ms 100 \
  --output output/playwright/tauri-desktop/small/result.json
node --import tsx scripts/smoke-tauri-desktop.mjs \
  --shells electron,tauri --history-mib 64 --documents 161 \
  --window-ms 3000 --interval-ms 100 \
  --output output/playwright/tauri-desktop/history/result.json
```

The sampler sums process RSS for the native/Electron host and all descendants. On macOS, WebKit WebContent, Networking and GPU processes can be reparented to `launchd`; all new WebKit processes observed since each isolated launch are conservatively included and their PIDs recorded. The temporary PDF WebContent is included while it exists. A new unrelated WebKit launch during a run can inflate this attribution. Shared pages can be counted more than once by an RSS sum, so these results are not unique physical footprint or a hard memory limit.

Sampling starts after application readiness, excludes startup peaks, and uses a nominal 100 ms pause between samples, plus sampling overhead. Every phase has at least a three-second observation window. Both applications receive independent copies of the same closed synthetic workspace and use the default Rust business storage. The local HTTP mock supplies identical source-backed model results and a 750 ms response delay. No real local model is resident, and no forced garbage collection is requested. The script records exact build file hashes and rejects changes to the measured build during a comparison.

The host is Apple M3 Max with 36 GiB RAM, macOS 27.0.1 (Darwin 27.0.0) arm64. Results on an ordinary Windows office computer and with an actual local model must be measured separately; this migration leaves that model's memory policy under the customer's control. These small contract and synthetic-history fixtures do not validate a 1 TB knowledge corpus, sustained memory pressure, OCR throughput or multilingual legal correctness.

## Recorded results

Both comparisons completed on **2026-10-26**. The small run used a 552,960-byte schema-7 database containing 3 documents. The history run used a 71,180,288-byte database containing 161 documents and 4,111 synthetic audit rows with 67,124,408 bytes of retained payload. These are closed copies of the same fixture within each comparison; both shells use native storage. They are different fixtures from the earlier SQL.js-versus-Rust storage comparison.

Values below are **summed process RSS in MiB**. Idle rows use the phase median; review and full-flow rows use the sampled peak.

| Small workspace | Electron | Tauri | Reduction |
| --- | ---: | ---: | ---: |
| Initial idle | 557.30 | 419.83 | 137.47 MiB / 24.67% |
| Cited model review peak | 619.45 | 540.95 | 78.50 MiB / 12.67% |
| Full-flow peak, including native PDF export | 1,065.98 | 590.53 | 475.45 MiB / 44.60% |
| Idle after the full workflow | 626.16 | 578.36 | 47.80 MiB / 7.63% |
| Idle after restart | 540.81 | 398.38 | 142.44 MiB / 26.34% |

| History workspace | Electron | Tauri | Reduction |
| --- | ---: | ---: | ---: |
| Initial idle | 636.38 | 483.55 | 152.83 MiB / 24.02% |
| Cited model review peak | 715.58 | 618.56 | 97.02 MiB / 13.56% |
| Full-flow peak, including native PDF export | 954.67 | 645.41 | 309.27 MiB / 32.39% |
| Idle after the full workflow | 726.88 | 635.30 | 91.58 MiB / 12.60% |
| Idle after restart | 538.88 | 408.50 | 130.38 MiB / 24.19% |

Electron normally had 4 measured processes; Tauri had 5, including the Rust host, bundled Node process and 3 WebKit XPC processes. Both reached 6 processes during PDF export. Temporary export WebContent was included and disappeared before the next phase. No renderer errors occurred in any of the 8 application launches across the two comparisons. Every launch completed without forced termination. All 12 exported PDFs parsed successfully: Chinese reports had 7 pages and English/Thai reports 6 pages each. The original Thai policy quote, all three scripts, contract quote and stored provenance checks passed for both shells and both fixtures.

The largest full-flow savings occurred during PDF export and must not be described as the model-review saving. Garbage collection and native framework caching remain nondeterministic; the measurements are individual runs rather than a statistical performance guarantee. In particular, post-workflow idle retains more memory than a freshly restarted application.

The local, ignored evidence paths are:

- `output/playwright/tauri-desktop/small/result.json`, `electron-run.json` and `tauri-run.json`.
- `output/playwright/tauri-desktop/history/result.json`, `electron-run.json` and `tauri-run.json`.
- Each per-shell file includes every sampled process PID, parent PID, RSS, executable and attribution reason, together with all intermediate and restarted application reports.

SHA-256 identities for the measured build and evidence:

| Artifact | SHA-256 |
| --- | --- |
| Optimized native smoke-feature binary | `5208e30699b61acc9b1264faf61c766666d304ce1ae1e352b24ee664b6f5d314` |
| Official bundled Node 24.22.1 binary | `6f32069480ec14d52b6d7b1f3c7124cfbbc46203abf5ddf5c65b127435f3f329` |
| Staged runtime manifest | `ba3cf0da6227162cbf8047ebb2c6de021d386e6af86964f3e481ad1ebf7417d7` |
| Rust SQLite N-API binary | `df6e5c5a6f5386eb1feb45c3eee24a3b1a339d1afaeb1dc699b4713f40ea3a8a` |
| Electron main entry | `4027204c58d72f6c25db114236b06eb654af2b07e4f8c27bf58845ea23c03bd7` |
| Tauri sidecar main entry | `491c941a61885f3a8e37210bea95cea05dfb014bbba4a89b95f3a7caa181f952` |
| Electron renderer main asset | `9253a834ff9d677f311d60abc394cc012175af006ec7d026772123ecd003b073` |
| Tauri renderer main asset | `43f0dea4c089279672515ff0fe7c7a355f30aec6e506faf209b9f3c84aec1030` |
| Small closed fixture database | `477fdcf0d47c41f2667114307a656df8c9e5c9b34b496dbeae894b3f9c4a6cdb` |
| History closed fixture database | `4cc4b64818f2fe281dbc491aa8046eb09ba519e2f3f818371e84b35c54523e73` |
| Small result JSON | `0b7166c3b95819eb0c7e0972d2cad9a098dae3b6ff4339eea63f3da297e69738` |
| History result JSON | `32f019778814ba1cb4d87f77a3d68900b67d857162c44e44234772888dbfe597` |

The small run's build-inventory hash is `30950b77f5d2dfad2346459a9d7a0fdf73b425dfef6fc0d5e7f59ce61c7242c2`. Before the history run the inventory was expanded to include the actual staged backend, Node binary, adapter and runtime manifest, giving `0ee20c36fb12f935e806f661f9d1f302a00aa6c2ca02163c15ea4df10516220d`. All **55 shared build entries** matched between the two inventories; no measured application file changed during either run or between the two fixtures. The separately completed staged-resource verifier covers the runtime copy used in the small run as well.

These hashes identify the optimized diagnostic-feature build. A normal production build omits the diagnostic script, report command and test Keychain namespace. Subsequent package metadata, signing or native release builds have different identities and must not be represented as these exact measured binaries.

## Lifecycle follow-up validation

After the memory comparison, startup and shutdown handling was strengthened. Startup initialization failures now produce an ordinary controlled error and nonzero exit instead of returning an error into Tauri's setup callback and raising a Rust panic. Shutdown closes work admission, cancels model/index/native-PDF activity, drains in-flight frames, joins the owned workers and releases the workspace writer before the application exits. A second launch while cleanup is running is remembered and opens a replacement after single-instance ownership has been released. macOS Dock reopen requests use the same lifecycle state.

The follow-up build passed **437 TypeScript/Node tests** and **11 desktop Rust tests**, in addition to the unchanged 34 Rust Core/adapter and 6 actual N-API checks. The native lifecycle test controller uses the bundled **Node 24.22.1**. Its local HTTP fixture handles listener errors as rejected promises, so a denied loopback bind does not become an unhandled server error. Diagnostic-feature builds use a separate application identifier, protecting any normally running user application from test single-instance requests.

Run the native lifecycle loop after building with `desktop-smoke`:

```sh
.local/tauri-runtime/bin/node --import tsx scripts/smoke-tauri-lifecycle.mjs \
  --cycles 3 --output output/playwright/tauri-desktop/lifecycle-final/result.json
```

The final loop passed **21 recorded scenarios** in one unique synthetic workspace:

- Three quits before the renderer bridge/Core was ready.
- Three normal idle closes and three closes during actual held model HTTP responses.
- Three immediate model-cancel/close sequences and three active knowledge-index closes over a 180-file synthetic folder.
- Three real main-window closes after a native PDF job was admitted and while its export promise was still pending. A feature-only event establishes admission; it does not rely on an arbitrary sleep before starting the close.
- One intentionally injected startup failure, expected to exit with code 1 and no signal/panic, followed by a successful same-workspace reopen with the document count retained.
- One overlapping second launch during a model-related close. The duplicate process forwarded its request and exited normally; a distinct automatically spawned replacement reached Core-ready, retained the workspace and closed normally. A bounded one-second diagnostic-only shutdown hold makes this race deterministic; production has no such delay.

There were **zero** remaining owned Rust/Node processes, **zero** newly remaining WebKit processes and **zero** new macOS crash reports matching the observed owned process IDs after a four-second post-exit observation. Seven actual held model requests were observed. All successful hosts and the duplicate exited with code 0 and no signal. The only stderr output was the intentional startup-failure message. Every reopen also checked that a previous-session review had not remained permanently queued/running.

On this host, ordinary warm launch-to-exit totals ranged from about **433 ms to 1.34 s**; the first cold early-close path took **1.99 s**. The overlap sequence took **3.83 s**, including two one-second diagnostic holds. These are observed test timings rather than a cross-platform shutdown SLA.

The lifecycle result is `output/playwright/tauri-desktop/lifecycle-final/result.json` (SHA-256 `ba0668edd312ce2658d961c8244a4098756a701a247c0b4613e1e7c7564136e4`). It records the exact native, Node, backend, Core-worker and runtime-manifest hashes before and after the run and rejects a build change. Its native binary SHA-256 is `a2e40f240e1829d923a958ed7139e5e15e3f67dfe72293b3960ba336a51528d5`; staged backend is `8b2844bd7705705f69a6217a7b85402a019253ec292efd7913e83f4689f677c0`; Core worker is `0319a0505bb87335901661be82ba37ab299cda63931dff3be27ea0c824790955`; runtime manifest is `ce51431c11d25b61d5f698abc1a1305ff652bb102c928e1fc03dc30943a53191`. These identities intentionally differ from the earlier memory benchmark.

The complete import, source-cited review, tracked-change export, three-language native PDF and restart workflow also **passed** on this lifecycle build, with no renderer errors. Its evidence is recorded separately under `output/playwright/tauri-desktop/post-lifecycle/`; it is a functional regression check, not a new paired Electron-versus-Tauri memory claim. Both native application launches closed normally, the temporary credential key was cleaned up, and the Chinese/English/Thai PDFs again had 7/6/6 pages with the protected original source quotations intact.

The post-lifecycle result JSON SHA-256 is `862d289f64051b5fac66f00a8207ffd10f87129b6f7ca43750974ec4b68d5cbd`, and its complete build-inventory hash is `26fe286081fedd4049d7e9ac5b5eca7f6e3e26ac288254791ed2ddd2abcb1e75`. Its native/runtime identities match the final lifecycle loop above.

## Production bundle and developer launch

The ordinary Tauri development command was exercised through `scripts/smoke-tauri-dev.mjs` using a fresh isolated workspace. Its built-in server at `http://127.0.0.1:1430` loaded the real React interface and native Rust-backed state, then exited cleanly. Development navigation accepts only the exact configured loopback origin; production retains its local application URL policy. The developer hook waits for frontend/backend preparation before launch.

A production macOS arm64 bundle was generated with `node scripts/tauri.mjs build --bundles app --no-sign --ci`, omitting `desktop-smoke`. The unsigned application is `.local/rust-target/release/bundle/macos/合同工作台.app` (330.19 MiB), with identifier `com.lawagent.desktop` and minimum macOS 13.5. Its native executable SHA-256 is `2229c54e0ce512644cf5f8919d2698f3606e9e66edda9746a1c8ff2ee95a5903`. Binary inspection found neither the diagnostic report command nor the diagnostic shutdown-delay environment hook. These production identities differ from the diagnostic-feature workflow and memory runs.

The actual Node executable inside the application bundle verified all 7,005 runtime-manifest files and exercised native Canvas, SQLite FTS5, Rust business SQLite Unicode transactions, and the offline OCR worker/core. No Electron runtime was included. Results are in `output/tauri-production-package.json` and `output/tauri-packaged-runtime-resources.json`. Packaging and resource probes do not establish signing/notarization or Windows/Intel machine acceptance. The manual Windows workflow builds the native target, runs regressions, and produces NSIS plus portable ZIP artifacts without public release publication; it was not run on Windows during this macOS session.
