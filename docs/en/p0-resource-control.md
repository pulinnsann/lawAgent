# P0 production resource control

Source version remains **0.3.0**. This update connects cooperative task admission, native memory-pressure samples and idle knowledge-worker recycling to the existing desktop application. The default shell remains Tauri, with one bundled Node business engine and Rust SQLite storage. It adds no local inference, embedding or reranking model.

The aim is to leave more headroom for a customer's independently managed local model, including on an ordinary Windows office computer. The policy controls when integrated application work starts. It does not impose an application RSS limit or manage model weights, context size, KV cache, VRAM or other programs.

## Admission policy

`src/core/resource-scheduler.ts` implements the production scheduler used by `ContractService`. There is **one active lease across the integrated model, foreground-heavy and background-index task classes**. Pending work is ordered by model, then foreground-heavy, then index priority; requests of the same class retain arrival order. The default queue holds at most 32 pending requests. Queue overflow, duplicate identities and requests after close fail explicitly.

An active foreground or model task finishes its owned cleanup before the next task starts. A new foreground or model request asks an active background index to cancel cooperatively, then waits for its actual cleanup. Priority does not interrupt a running foreground export or promise that background tasks cannot wait under a continuous stream of model work. The existing limit on review task records is separate from execution: two reviews may be represented, but their admitted model work is serial.

| Integrated task class | Current operations |
| --- | --- |
| Model | Contract review, description generation, change suggestions, reference/report translation, model clause comparison, capability probes and model API connection tests. |
| Foreground-heavy | Local review, contract import/version import, derived-document preparation, explicit knowledge search/original-chunk reading, report construction, confirmed-draft and revised-DOCX export, PDF text/OCR conversion, OCR language downloads, template preparation and connection synchronization. |
| Background index | Local knowledge folder indexing, including scheduled incremental updates. |
| Native PDF | A private parent/Core lease spans the system WebView export and its native cleanup. |

Queued reviews retain bounded document headers and identifiers; full contract text is read after admission. Work nested inside an admitted operation reuses its scope instead of waiting for a second lease. For example, parallel local/remote evidence requests inside a review remain part of that review's lease. Serialization applies between admitted operations, rather than requiring every internal request or worker thread to run sequentially.

## Memory pressure and the Windows office-PC policy

The Tauri host reads OS state through `native/law-desktop/src/platform/resource_pressure.rs`. The private `resourcePressure` host operation returns a level and source, with capacity fields only when available. The Node host validates these fields and adds the observation time. Production sampling starts at launch and repeats every five seconds, without overlapping reads; it pauses during maintenance and stops on shutdown.

| Fresh effective pressure | Admission behavior |
| --- | --- |
| `normal` | Admit the next task according to serial priority. |
| `warning` | Keep model API tasks available; defer new foreground-heavy and index allocations. |
| `critical` | Hold all new integrated work. An active task retains ownership until its real cleanup finishes. |
| `unknown` | Continue the bounded serial policy; missing measurements are not interpreted as zero available RAM. |

On macOS, the probe reads `kern.memorystatus_vm_pressure_level`: 1, 2 and 4 map to normal, warning and critical. `hw.memsize` can supply total physical RAM. The probe does not invent an available-memory figure from a different metric. Unsupported values or failed reads produce an unavailable/unknown pressure sample.

Windows uses `GlobalMemoryStatusEx` and reports actual total/available physical bytes. Its pressure labels are **heuristics**, not a native Windows pressure classification:

- Critical requires **both** memory load at least 95% **and** less than 256 MiB available.
- Otherwise, warning means memory load at least 90% **or** less than 768 MiB available.
- Otherwise, the sample is normal. Invalid capacities or a failed API call produce unknown pressure.

This policy is intended to avoid blocking a resident model merely because much of an 8 GiB-class machine is occupied. High load with ample available headroom remains warning, allowing the configured model API while delaying document/OCR/PDF allocations. It is not a special 8 GiB mode or a claim that any particular model will fit. The thresholds still require measurement on real Windows 8 GiB hardware with the customer's actual model.

Samples expire after 30 seconds. A stale sample becomes effectively unknown; a timer reconsiders queued work even if the monitor disappears. Expiration prevents a lost monitor from leaving an old warning or critical sample as a permanent admission block. It does not prove that memory has recovered. Pressure changes do not silently reduce model settings or terminate an active model request.

## Ownership, cancellation and cleanup

A lease covers the actual operation, source/index cleanup and relevant I/O. A cancellation request alone does not release it. The service's `finally` boundary also awaits a snapshot from `KnowledgePort.waitForIdle()` before releasing ownership. A search can reject its caller immediately after cancellation while its worker still cleans up; that internal drain remains visible until the final response, actual worker exit or awaited termination. Later status polling is excluded from an earlier drain snapshot.

Pending requests can be cancelled before admission without sending a late model request or starting the queued download/conversion. Desktop preflight checks cancellation again after credential selection and native save dialogs, so a dialog returning late cannot restart cancelled processing. Active work continues to use its established cancellation and persistence rules.

PDF export crosses the parent/Core boundary: the desktop parent requests `acquireResource` using an opaque UUID, invokes native `renderPdf`, validates the resulting PDF and calls `releaseResource` in `finally`. These controls are private Core messages, not arbitrary renderer resource-management commands. The native PDF layer retains its separate one-export permit, offline rendering policy, 10 MiB HTML/40 MiB PDF limits and 90-second ordinary export timeout. During application close, its existing native cancellation and cleanup barrier runs while the event loop is alive.

Closing the service closes admission and cancels queued work, signals owned active tasks, and **starts knowledge-worker cleanup before awaiting extension or resource drains**. That order avoids waiting for a drain that itself needs worker shutdown. The business store and writer ownership are released after the tracked cleanup boundaries. Critical backup/restore publication keeps its existing finish-or-rollback policy.

## Idle knowledge-worker recycling

`KnowledgeWorkerClient` starts its worker on demand and recycles it after **60 seconds with no internally pending operations**. State reads count as activity. A long sync, source read or caller-cancelled search still awaiting cleanup cannot be mistaken for idle work.

Recycling first sends the ordinary close command so the index can close gracefully. Its existing shutdown grace defaults to ten seconds; a noncooperative worker is then terminated, and actual termination is awaited. Requests arriving during retirement queue behind that barrier before a fresh worker opens the same persisted index. Expected retirement is distinct from an unexpected worker failure, which remains an explicit error requiring restart.

The constructor keeps its existing third positional shutdown-timeout argument. A fourth options argument provides `idleTimeoutMs`; zero disables recycling. Idle timers are unreferenced and cleared on permanent close, which remains idempotent. Recycling preserves committed FTS data, original files and citation identifiers; it does not clear or silently rebuild the index.

## Scope and exceptions

This is a production **application admission policy in TypeScript**, supported by native OS samples. The separate Rust reservation experiment in `native/law-core/src/resources.rs` has not replaced it, and the Node business/knowledge modules have not become a complete Rust implementation.

Lightweight metadata reads, state/configuration operations, native dialogs, credential protection and environment diagnostics do not each acquire a heavy lease. Standalone retrieval/official-source connection diagnostics retain their existing bounded I/O and cancellation paths rather than becoming a universal network scheduler. Backup, restoration and index maintenance use their separate close-workers, exclusive workspace-lease and recovery gates. The explicit Electron reference uses the shared serial service policy but does not supply the Tauri native pressure probe.

The modification-workspace APIs `getChanges`, `saveChange`, `decideChange` and `enableEditableCopy` also remain outside global admission so a person can inspect and edit proposals while model drafting is pending. A subsequent iteration adds a bounded, short-lived compact inspection cache and fresh streaming source-hash verification, reducing repeated ZIP inspection without retaining raw source buffers. Actual patch validation and export still read/rebuild the selected DOCX; these paths are not guaranteed to be allocation-free, and their peaks must be included in target-device measurements. See [current iteration and backlog](iteration-backlog.md).

The scheduler does not count every allocation in the UI, Node, native bindings or system WebViews. A queued PDF may already have its report HTML, and internal work can still allocate buffers within an admitted task. No model-process detector, automatic customer-model tuning or GPU-memory policy is added. A newly opened or actively polled knowledge view can legitimately keep its worker in use.

## Validation and remaining acceptance

The integrated TypeScript/Node regression suite passed **500 tests**, and the frontend/backend/runtime preparation build passed. Focused coverage includes scheduler exclusivity and priority, pressure expiry, queued cancellation, index cleanup before admission, private PDF ownership, cancelled preflight, shutdown drains, and real persisted FTS reopening after worker retirement. PDF failure coverage includes a lost/failed acquisition acknowledgement and immediate retry of a cancelled resource identity, so neither case leaves an orphaned lease. Native mapping tests exercise macOS fallback and Windows threshold boundaries without assuming the test machine's pressure state.

Engineering validation on **2026-10-26**, macOS arm64, Apple M3 Max with 36 GiB physical RAM, using the bundled Node 24.22.1:

| Check | Result and scope |
| --- | --- |
| TypeScript/Node regression | 500 passed, zero failed or skipped; synthetic workspaces and loopback API mocks. |
| Rust tests | 51 passed: 22 Core, 12 storage adapter and 17 desktop, including six pressure-mapping tests. |
| Actual N-API binding | Six passed with the bundled Node runtime. |
| Native-window workflow | Passed import, persisted local indexing, source-cited mock review, individual adoption/rejection, tracked DOCX export, Chinese/English/Thai PDF export and restart persistence. |
| Live pressure/cleanup | The real Tauri host returned a fresh macOS normal-pressure sample. After the workflow, the scheduler had no active lease and no queued tasks. |
| Native lifecycle | 21 scenarios over three cycles passed, including active model/index/PDF close, cancellation, startup failure and overlapping relaunch; no observed owned survivors, new WebKit survivors or matching new crash reports. |
| Packaged runtime components | 7,005 files verified, including Canvas, SQLite FTS5, Rust business SQLite and offline OCR; no Electron runtime bundled. |
| Production build | Unsigned macOS arm64 app bundle built successfully; the production binary excludes the diagnostic report command and injected shutdown-delay hook. Windows packaging/runtime acceptance remains pending. |

Native workflow and lifecycle tests use a diagnostic-feature build with isolated temporary workspaces and a loopback model mock. Reproduce them with `scripts/smoke-tauri-desktop.mjs` and `scripts/smoke-tauri-lifecycle.mjs`; local reports under `output/playwright/p0-resource/` contain build identities and are excluded from public source. These macOS checks do not establish Windows 8 GB responsiveness, real-provider behavior or real-model resource headroom. The workflow's sampled RSS is a single synthetic run, not a paired memory-reduction benchmark.

Useful focused checks are:

```sh
node --import tsx --test tests/resource-scheduler.test.ts tests/service-resource-scheduling.test.ts tests/knowledge-client-lazy.test.ts tests/workspace-preflight-cancel.test.ts
npm run typecheck
npm run build
npm run native:test:desktop
```

Tests that start loopback mocks need permission to listen locally. These tests use synthetic temporary workspaces; engineering checks do not establish legal correctness.

**Still pending:** real Windows 8 GiB and Intel Mac acceptance, sustained runs with a real customer local model, representative OCR/PDF workloads and a 1 TB knowledge corpus. The previous [Tauri memory measurements](tauri-desktop-validation.md) remain historical measurements of their recorded builds. This update does not relabel those numbers as a new P0 benchmark or claim a measured memory saving for the new scheduler.
