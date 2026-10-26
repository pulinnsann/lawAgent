# Lightweight migration: measured baseline and acceptance protocol

The priority is lower working memory on ordinary office computers. Installer size is a secondary measure. A Rust rewrite is accepted only after the same document, database and indexing workloads are measured; changing the shell alone does not establish lower memory use.

## Scope and measurement rules

The distribution baseline below uses the actual **0.2.0** release artifacts and their unpacked applications. The current source is **0.3.0**. These are different versions; the 0.2.0 package measurements must not be presented as 0.3.0 installer measurements. Development `node_modules`, Cargo `target/`, caches, customer workspaces and source repositories are excluded from user package totals.

Measurements use bytes and MiB (`1 MiB = 1,048,576 bytes`). Installed payload means the sum of regular file lengths in the unpacked application. It excludes filesystem allocation overhead and user data. macOS framework symlinks are not followed or counted repeatedly. ASAR file accounting includes its physical header, packed members and the actual signed sizes of unpacked native files, with no duplicate counting.

No customer workspace or real model API is required. Results do not certify legal accuracy, translation quality, Word compatibility or 1 TB performance.

## Actual released package sizes

Measured on 2026-10-23, with byte totals reconciled against the actual unpacked applications:

| 0.2.0 target | Primary installer | ZIP | Installed regular files | Shell and platform resources |
| --- | ---: | ---: | ---: | ---: |
| Windows x64 | 150.59 MiB (NSIS EXE) | 203.98 MiB | 551.61 MiB | 356.87 MiB |
| macOS Apple Silicon | 170.69 MiB (DMG) | 170.87 MiB | 435.54 MiB | 250.47 MiB |
| macOS Intel | 179.24 MiB (DMG) | 179.41 MiB | 447.95 MiB | 257.62 MiB |

The shell category contains Electron, Chromium, Node and platform resources. Their combined binaries are not split into invented per-engine values. Windows measurements are file inspections on macOS, not Windows runtime or installed-machine acceptance. The Intel application was inspected as an x64 distribution; architecture emulation is not native Intel performance evidence.

The following table counts the actual packaged application payload, including the native files unpacked alongside ASAR:

| Component | Apple Silicon | Windows x64 |
| --- | ---: | ---: |
| Compiled application JS, CSS, HTML and migrations | 2.20 MiB | 2.21 MiB |
| Tesseract primary packages | 44.48 MiB | 44.48 MiB |
| PDF.js package | 32.89 MiB | 32.89 MiB |
| sql.js package | 29.70 MiB | 29.70 MiB |
| Canvas packages and target native library | 28.30 MiB | 38.02 MiB |
| Other production dependencies | 45.93 MiB | 45.87 MiB |
| ASAR header and integrity metadata | 1.57 MiB | 1.57 MiB |

OCR language models are separately downloaded and are not included. OCR transitive dependencies can appear under other production dependencies. The full packaged `lucide-react` package alone accounts for 23.13 MiB in the Apple Silicon archive even though frontend icons are also bundled into the renderer. This is a packaging optimization candidate, not a claim that 23.13 MiB is resident in RAM.

These numbers support two separate actions:

1. Replace the always resident Electron shell and backend runtime where functional parity permits.
2. Audit optional PDF/OCR engines and unused production files separately. Keeping the same engines or a permanent Node sidecar in a Tauri bundle retains much of their cost.

Static file sizes cannot predict resident memory. Disk resources are often loaded on demand; a smaller archive does not establish a smaller live working set.

### Reproduce distribution accounting

After `npm ci`, point the script at an explicitly selected unpacked distribution, never a user workspace:

```sh
node scripts/measure-distribution.mjs \
  --app /path/to/unpacked/LawAgent.app \
  --artifact /path/to/release.dmg \
  --artifact /path/to/release.zip \
  --output output/size-baseline/mac-arm64.json
```

For Windows, pass the unpacked directory containing the EXE and `resources/app.asar`. The script reads files only; it does not launch the application. It requires the existing `@electron/asar` development dependency, but measures only selected packaged files.

## Runtime memory protocol

Use a fresh synthetic-only workspace for every run. Keep the existing user application and customer data untouched. Use the same machine, power settings, architecture, viewport and build profile for both implementations. Run three independent repetitions and publish medians plus the worst sampled peak. Run packaged release builds for the final comparison; development builds are exploratory evidence.

`scripts/measure-runtime-memory.mjs` launches and closes only its own Electron instance. It records `app.getAppMetrics()` and, on macOS/Linux, a `ps` descendant tree rooted at that instance. The Playwright driver is outside the application process tree. Node worker threads belong to their owning process and are not counted again as independent processes.

```sh
npm run build
node --import tsx scripts/measure-runtime-memory.mjs \
  --window-seconds 20 --interval-ms 500 \
  --index-files 100 --file-bytes 16384 \
  --output output/playwright/memory-baseline/current.json
```

For an actual packaged release, add `--executable /path/to/app/executable`. A packaged Electron run must use its own matching build and version; do not compare an old package to new source without recording that difference.

The stages are empty idle, built-in DOCX import, local rules review, opening and closing the function menu, initial local knowledge indexing, one-file incremental update and idle after indexing. Each stage is observed for at least the selected window; longer operations continue to be sampled until completion. Index sources are 100 deterministic synthetic TXT files of at least 16 KiB each, containing Chinese, English and Thai text. The exact file count and actual byte total are recorded. No model, internet or remote KB is used. The first build processes all files; the incremental stage modifies one existing file.

The UI window is hidden and background throttling is disabled to avoid disrupting the user's current work. This is a controlled engineering baseline, not a claim about every foreground usage scenario. No forced GC is used. `readyMs` includes Playwright attach and bridge discovery and is not a certified cold-start or first-paint measurement.

[Electron's memory structure](https://www.electronjs.org/docs/latest/api/structures/memory-info) reports KiB. A process-tree RSS or working-set sum counts shared pages more than once. It must be labelled as a **sum**, never as unique physical footprint. Windows private bytes, macOS physical footprint and RSS are different metrics and must not be compared as though interchangeable. Report per-process values alongside aggregates. Sampled maxima can miss brief peaks between intervals.

### Current exploratory runtime result

A successful exploratory run on 2026-10-23 used current **0.3.0 production-built `out/`** with the development Electron executable (no Vite server), on an Apple M3 Max with 36 GiB RAM, macOS kernel release 27.0.0, arm64. Each of eight stages used a 10-second minimum window and 500 ms requested sampling interval. This is one run, not the final three-repetition packaged acceptance described above.

| Stage | Process-tree RSS sum, median | Process-tree RSS sum, sampled peak |
| --- | ---: | ---: |
| Empty idle | 575.38 MiB | 578.03 MiB |
| Built-in DOCX import | 578.14 MiB | 578.56 MiB |
| Local rules review | 595.70 MiB | 600.11 MiB |
| Function menu open | 583.20 MiB | 587.14 MiB |
| Function menu closed | 584.83 MiB | 585.11 MiB |
| Initial knowledge build | 607.14 MiB | 607.69 MiB |
| One-file incremental update | 610.11 MiB | 610.12 MiB |
| Idle after indexing | 604.22 MiB | 604.22 MiB |

The process tree had four processes throughout. At the final sample, its components were Browser 297.25 MiB, GPU 97.67 MiB, Utility 48.20 MiB and renderer 161.09 MiB. These are resident-set figures with shared-page duplication; they cannot be read as four unique physical allocations. Core worker threads are included in the Browser process and are not independent lines in this table.

The fixture contained exactly 100 files and 1,643,690 bytes. Initial build indexed 100 files with zero unchanged; the one-file update indexed one and skipped 99 unchanged. End-to-end observed operations were about 314 ms and 109 ms respectively, including polling and IPC. These short operations can peak between the 500 ms samples, so the table is not proof of their exact peak. The synthetic local review took about 79 ms. Bridge-ready time was about 478 ms, subject to the startup measurement limitations above.

The run completed with zero page errors and zero HTTP(S) renderer requests. No model was configured, and no customer data was read. The raw report is `output/playwright/memory-baseline/current-v0.3.0.json`; reproducible raw reports are local ignored artifacts, not customer data or committed release packages. Windows runtime memory, ordinary-office hardware and 1 TB knowledge workloads have not been measured here.

## Native storage strategy experiment

A separate experiment on the same host compares the proposed native storage strategy with the current AppStore copy pattern. It is a **backend-only** test. The native candidate is a release-built Rust CLI using disk SQLite through `rusqlite`, an 8 MiB configured SQLite cache, disabled memory mapping and WAL transactions. The SQL.js child uses Node 25.8.1, loads SQLite into WASM memory, takes a full-database preimage before each transaction, then exports and atomically writes the full database after each commit, following `src/core/storage.ts`. Its close path also flushes, as AppStore does. No forced GC is used.

The fixture has 4,096 rows containing exactly 16,384 ASCII payload bytes each: **67,108,864 bytes (64 MiB) of payload** in a **69,222,400-byte SQLite file**. A separate native seed process exits before copying the database. The harness verifies that no WAL, SHM or rollback-journal sidecar remains, then copies the same closed file to two independent targets and confirms all three SHA-256 hashes are identical. Seeding, compilation, hashing and parent-process copy allocations are outside both measured child processes.

Both children execute the same operations: start after ID 0, read four advancing keyset pages of 64 rows, release each page, update row 1 to the same 30-byte string after every page, and wait 250 ms after each update. They each read **256 rows and 4,194,304 payload bytes (4 MiB)**, keep 4,096 stored rows and finish with row 1 at revision 5. This workload reads selected pages from a 64 MiB payload database; it does not read all payloads into query results.

`/usr/bin/time -l` measured each exercised child process's maximum RSS in bytes. Two exploratory runs reversed backend execution order. After hardening the independent backup path, the final release build was measured again in both orders:

| Build / run order | Rust disk SQLite peak RSS | SQL.js AppStore copy-pattern peak RSS |
| --- | ---: | ---: |
| Exploratory, native first | 6,946,816 bytes (6.625 MiB) | 443,826,176 bytes (423.265625 MiB) |
| Exploratory, SQL.js first | 6,946,816 bytes (6.625 MiB) | 444,874,752 bytes (424.265625 MiB) |
| Final, native first | 6,946,816 bytes (6.625 MiB) | 444,792,832 bytes (424.1875 MiB) |
| Final, SQL.js first | 6,930,432 bytes (6.609375 MiB) | 443,695,104 bytes (423.140625 MiB) |

All four runs passed input-hash and logical-result assertions. The final native executable SHA-256 is `aa83bbff90118bcf540dc987e0a30851125348006db7e601c5bfa3bee734ad9c`; the final reports also record executable size, baseline-script hash and Cargo lock hash. The result demonstrates a lower peak for this bounded, disk-backed storage strategy on this workload. It compares runtime and application storage choices together; it is not a language microbenchmark. Each child deliberately includes a common 1,000 ms total hold, so elapsed time is not presented as a throughput or speed comparison.

The experiment does not include the desktop UI, WebView, contract parser, PDF/OCR engines, model integration, full AppStore schema/semantics, enterprise accounts or a 1 TB corpus. These individual backend peaks and the earlier desktop process-tree RSS sums are different workloads and measurement scopes; they do not establish a complete application's future memory consumption. Production databases are never selected by these scripts.

Reproduce after building the native release executable:

```sh
npm run native:build
node scripts/measure-storage-memory.mjs \
  --output output/storage-memory/final-64mib-native-first.json
node scripts/measure-storage-memory.mjs --order sqljs-first \
  --output output/storage-memory/final-64mib-sqljs-first.json
```

The harness calls `scripts/storage-memory-sqljs.mjs` only for a newly generated, authorized synthetic target. The raw JSON and time outputs remain in local ignored `output/storage-memory/` run directories. On Linux, `time -v` KiB values are converted to bytes; on unsupported systems or with `--no-time`, missing peak metrics remain `null`. A separate small `--no-time` control passed logical checks and reported no fabricated RSS values.

## Integrated business-storage follow-up

Business storage now defaults to the Rust `native/law-node` binding in the existing Electron Core worker, with paginated frontend data access. This is separate from the earlier synthetic `law-core` CLI above. See [Native business-storage validation](native-business-storage-validation.md) for the same-build, whole-desktop comparison and import/review/edit/export/restart evidence. The historical numbers on this page retain their original version and workload scope.

## Rust implementation acceptance gates

Record both the baseline and candidate for each workload; a CLI-only Rust database probe cannot establish a full desktop application's memory consumption.

| Workload | Required observations |
| --- | --- |
| Empty startup and 20-second idle | Time to usable window, complete process tree, per-process and summed RSS/working set, platform private/physical metric where available |
| One normal and one long DOCX review | Parse and review duration, peak and settled memory, task cancellation, returned block IDs and citations |
| Open/close large report and alignment panels repeatedly | Retained heap or native allocations, settled memory after closing, no retained full document copies across IPC |
| Business database growth | Same synthetic rows and average payload size, 50-row pagination, bounded cache, one-record mutation, transaction and backup parity |
| Knowledge initial build and one-file increment | Same exact file corpus, bytes read, indexed files/chunks, peak RSS, settled RSS, duration, cancellation and restart correctness |
| PDF and OCR | Separate optional-engine cold/warm runs with the same pages, DPI and languages; record engine process exit after use |
| SFTP/shared directories | Bounded transfers, temporary storage and memory, disconnect/retry behavior, original file hashes and citation provenance |
| Offline installation | Main app, optional packs and WebView runtime costs reported separately, including offline WebView bootstrap/fixed-runtime policy on Windows |

The 100-file text fixture is a quick reproducible probe. Increase corpus size independently from single-file size; include many small files, large DOCX/PDF files, deleted files and repeated updates. A 1 TB target requires a real or representative corpus on target Windows hardware. Do not extrapolate a small fixture into a 1 TB guarantee.

The migration should keep parsing/OCR workers lazy and disposable, paginate database results, cap indexed extraction buffers and concurrency, and keep UI IPC DTOs small. Tauri uses a system WebView and still creates browser-related processes; replacing Electron is an architectural opportunity, not a measured memory percentage. Retaining a permanent Node compatibility backend should be labelled transitional and measured explicitly.

No complete Rust/Tauri desktop replacement has been measured. The separate integrated validation record measures the current Electron application with its native Rust storage adapter and explicit SQL.js reference. Neither those results nor this earlier CLI experiment establish Tauri savings or target-Windows/1 TB acceptance.
