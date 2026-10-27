# Windows 8 GB acceptance protocol

**Current result: pending. No actual Windows 8 GB acceptance run has been recorded for this update.** Parser tests, synthetic pressure tests, macOS results and Linux runs establish different evidence. They cannot mark this protocol passed.

The target is an ordinary Windows office computer with **8 GB of installed physical RAM**. Record the usable memory Windows reports, including hardware reservations. Test Windows 10 or later on the intended x64 hardware with its normal security software and page-file policy. A VM restricted to 8 GB is useful additional evidence; it does not replace the physical office computer.

Two model routes must be qualified separately:

| Route | Required setup | What must remain responsive |
| --- | --- | --- |
| Remote API | User-configured remote model endpoint; no local inference server required. LawAgent must not start a local model, embedding service or reranker. | Navigation, typing, viewing source text, scrolling, progress, cancellation and normal office work while the network request waits. This route should provide a fluid experience on the target computer. |
| Local model API | An independently deployed local model server suitable for the available hardware. LawAgent connects through its API. | The same interactions, with the app's additional resource use measured separately from the model server's own RAM, shared GPU memory and inference work. |

Record the selected model, provider/runtime version, quantization where applicable, context/output limits, CPU/GPU allocation and background workload. Keep them constant during paired runs. LawAgent must not silently change model settings to satisfy a resource target. A model workload that already exhausts the computer when LawAgent is closed must be identified separately; the app cannot reserve memory by shrinking an independently managed model.

## Test setup and isolation

Use a dedicated test account or machine, synthetic contracts and a new test workspace. Close existing LawAgent instances normally before launching the isolated run; a second instance may forward to the existing window. Do not point tests at a customer's workspace, copy their credentials, terminate unrelated processes or disable normal office/security software to obtain a better result.

For a manual isolated launch in PowerShell, use the actual installed executable path:

~~~powershell
$env:LAW_AGENT_DATA_DIR = Join-Path $env:TEMP ("law-agent-8gb-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $env:LAW_AGENT_DATA_DIR | Out-Null
& "<path-to-installed-law-agent-desktop.exe>"
~~~

Confirm that the running app uses the new directory before importing fixtures. Keep the override only in this test shell. Installed users do not need a source checkout, npm, Rust or a separately installed Node runtime.

Prepare and record hashes for:

- A small editable DOCX, a representative 20-page DOCX, and a document with tables, original Word revisions, bold text and supported complex segments.
- Chinese, English and Thai text PDFs, plus a small scanned PDF. Download OCR language packs explicitly before offline conversion tests.
- A synthetic knowledge directory with a known citation and one-file add/change/delete cases. Begin with a small corpus, then repeat with a representative larger corpus. The original 1 TB requirement needs its own scaled acceptance record.
- A test Word document, a synthetic Excel workbook and a fixed small set of browser pages for the office workload. Record their sizes and counts; keep these applications open consistently across paired runs.

A controlled model stub can test delays, failures and cancellation. Also run each intended real API route; stub results do not establish real-model performance or provider compatibility. The operator enters any real API credential through the app's credential field and authorizes those calls. Reports and logs must not contain keys, command-line secrets or personnel/customer records.

## Measurement and provisional interaction targets

Separate these timings:

1. **UI response:** user action to the next visible UI response, including typing, focus, opening a section, paging source text and acknowledging a cancellation request.
2. **Queue wait:** admission delay while another task or resource cleanup holds the slot.
3. **Task work:** document/OCR processing, model HTTP latency, first output and complete output.
4. **Cleanup:** actual transport/worker/renderer cleanup and the later release of the resource slot.

A slow model response must not be counted as slow UI input. Conversely, a responsive progress label does not prove the model task finished or that its memory was released. Intentionally disabled controls should show their workflow/queue reason; test the controls that remain available.

**Proposed engineering target, awaiting agreement and measurement:** p95 enabled UI interactions at or below **200 ms** during ordinary remote-API use and the agreed local-model workload. Collect at least 30 interactions per scenario, use the same timing method and record median, p95 and maximum. Screen-recording estimates and instrumented next-paint timings must be identified separately. Do not claim this target passed from subjective observation alone.

No installer-size, launch-time or RSS/working-set limit is promised by this document. Establish those budgets from actual Windows measurements. Mandatory functional criteria include no lost input, no application crash, no incorrect output publication after a preflight cancellation, preserved source files/history and successful recovery after controlled failure.

### Process-memory collector

The acceptance operator can use Node 24+ and the source checkout to run this read-only tool. Select LawAgent's main executable PID from Task Manager; do not select the local model server's PID accidentally.

~~~powershell
$lawAgentPid = 12345
node .\scripts\collect-desktop-baseline.mjs --pid $lawAgentPid --duration-seconds 120 --interval-ms 1000 --output .\output\windows-8gb\remote-review-01.json
~~~

Replace the example PID and use a new output filename for every run. The collector does not start or stop the application, call a model, open a workspace or overwrite an existing report. Duration is bounded to 30 minutes, intervals to at least 250 ms, and collection stops when the target process exits or its creation identity changes.

The report records OS/architecture/CPU/physical memory, selected process names, creation identities, actual sample times, available samples and peak/mean values. Sampling failure or an unavailable Windows working set remains unknown, not a measured zero. Windows uses CIM **WorkingSetSize in bytes**, not private working set; macOS/Linux use process RSS. Shared pages can appear more than once in sums. See [Microsoft's Win32_Process reference](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process).

Only the selected tree and previously observed owned children are attributed. Unseen reparented WebKit/WebView2 processes can be missed, so the report explicitly marks attribution incomplete and must not be described as complete whole-application memory. Record any additional Task Manager evidence separately. The sampler itself can affect host resources; use the same sampler settings in paired runs.

The collector records OS-reported total physical memory; record installed capacity and hardware reservations separately. It does not collect a continuous Windows available-memory series. Record the app's pressure sample/source and available-memory values from the resource panel, and supplement with Task Manager or an approved system counter when needed. Avoid exporting a full system process dump, user names, executable paths, command lines, document text or keys.

### Paired baseline sequence

Run each phase at least three times under the same power, display and background-work conditions:

| Phase | Setup | Measurements |
| --- | --- | --- |
| Office baseline | LawAgent closed; fixed Word/Excel/browser workload. | System available memory and responsiveness. |
| Remote idle | Same workload; LawAgent open with remote API configured, no active task. | App process memory and UI interactions; confirm no app-started inference/embedding/reranking process. |
| Remote active | Same fixture/request; remote model waits or returns output. | UI response separately from HTTP/task latency, cancellation and processing peaks. |
| Local-model baseline | Same office workload; selected model server runs the agreed inference workload while LawAgent is closed. | Model/server memory, system headroom, CPU/GPU activity and office interactions. Use a separate explicitly selected model PID if collecting its process tree. |
| Local-model plus app | Same settings and workload with LawAgent connected to that server. | App overhead, model overhead and host headroom as distinct observations; UI/task timings and cleanup. |
| Return to idle | Tasks finish; leave the app open without ongoing knowledge requests. | Observe cleanup and knowledge-worker retirement, then re-open knowledge and verify lazy restart. |

Do not add app and model process sums and present the result as unique physical RAM. Keep cold/warm model state, fixture hashes, sample interval and repeat count in the record.

## Manual acceptance matrix

Every result starts **pending**. Attach build/installer hashes and evidence before marking pass or fail.

| ID | Scenario | Required observations | Initial status |
| --- | --- | --- | --- |
| W01 | Actual 8 GB Windows target | Installed and usable RAM, Windows build, architecture, CPU, GPU/shared-memory configuration, page-file policy, power mode, WebView2 and Office versions. | Pending |
| W02 | Remote API with office applications open | Idle and active app memory; no app-started local inference/embedding/reranker; ordinary navigation/typing/source paging remains fluid. Record interaction timings. | Pending |
| W03 | Slow/failed remote API | Continue typing and viewing while a controlled request is delayed. Exercise timeout, disconnect and retry settings. Separate HTTP delay from UI delay. | Pending |
| W04 | Early and active cancellation | Cancel while queued, before the first model request, during cold credential preparation, and during output. No late paid call after preflight cancellation; no partial result published as completed. Verify terminal state and actual cleanup. | Pending |
| W05 | Representative local model API | Repeat the office/model-only baseline and app-plus-model scenario without changing model settings. Identify app overhead independently; verify the same enabled UI interactions. | Pending |
| W06 | Import, cited review and knowledge update | Import fixture originals, build the directory, change one file, retrieve the known quote and open its source. Verify hashes/locations and disclosed omissions; test external/remote services only with explicitly configured test connections. | Pending |
| W07 | Competing heavy tasks | Request review, indexing, OCR/report work and native PDF export. Check serial admission, model priority, cancellation, index cleanup, queue reasons and continued light UI access. No task may claim its slot was freed before cleanup finishes. | Pending |
| W08 | Worker idle/restart | After knowledge activity stops, wait beyond the configured 60-second idle period and allow actual cleanup. Verify retirement, intact index/data and successful lazy restart. Avoid leaving a knowledge-state poller active during this measurement. | Pending |
| W09 | Actual pressure samples | Resource panel shows Windows source, observation time, available/total values and queue effects. Unknown/expired samples remain explicit. Use controlled diagnostic pressure tests separately; never exhaust a customer's machine merely to force a branch. | Pending |
| W10 | Word editing and revisions | Propose/accept/reject changes, export clean and tracked DOCX, open them in target Microsoft Word. Verify original/new revisions, supported formatting, original hashes and exclusion of rejected changes. Unsupported structures must remain clearly blocked. | Pending |
| W11 | PDF/OCR and three-language reports | Export Chinese/English/Thai through actual WebView2 PDF rendering; visually inspect pagination/fonts and original quotations. Check OCR text and partial-page handling against the source; do not assume PDF layout/signatures were reproduced. | Pending |
| W12 | Display scaling and keyboard use | Test typical laptop resolution and supported narrow window at 100%, 125%, 150% and 200% scaling as applicable. Check clipped actions, scrolling, focus, text input and cancellation access. | Pending |
| W13 | Rapid close/reopen and restart | Repeat idle, active review, indexing and export close/reopen cycles; record counts and elapsed cleanup. No crash dialog, stuck singleton or surviving owned sidecar after normal cleanup. Saved history and originals remain intact. | Pending |
| W14 | DPAPI credential persistence | Save a synthetic test credential, close/reopen in the same Windows account and verify transport authentication. Keys remain encrypted and absent from renderer state/logs/exports. Cross-account DPAPI portability is not assumed. | Pending |
| W15 | Install, upgrade and uninstall | Fresh current-user installation, upgrade from a supported prior build with synthetic data, restart, uninstall and reinstall. Verify data-retention behavior explicitly; do not infer Tauri behavior from the former Electron installer setting. Record any explicit data-removal option separately. | Pending |
| W16 | WebView2 online/offline dependency | With WebView2 present, test ordinary offline launch and native PDF export. On a clean offline image without WebView2, verify a clear dependency outcome: the configured download bootstrapper needs network access. Fully offline initial deployment requires a separately qualified distribution policy. | Pending |

For W07/W09, confirm the policy from the tested build rather than treating these expectations as completed Windows evidence. The current design samples native pressure approximately every 5 seconds, expires samples after 30 seconds, serializes integrated heavy work and gives model work priority. Under warning pressure new document/index work waits; critical pressure pauses new admission. Unknown/stale pressure retains conservative serial admission. Running tasks release only after real cleanup. These scheduling hints do not impose a hard RSS limit or manage model weights, KV cache, VRAM or third-party applications.

For Windows pressure classification in the current source, critical requires reported load of at least 95% **and** less than 256 MiB available; warning includes load of at least 90% or less than 768 MiB available. Record actual raw values and the resulting state. Branch tests with injected samples are engineering coverage, not measurements from the acceptance machine. See the [resource scheduler](../../src/core/resource-scheduler.ts), [native pressure mapping](../../native/law-desktop/src/platform/resource_pressure.rs) and [knowledge-worker lifecycle](../../src/core/knowledge-client.ts).

## Validation record

Use one record per hardware/build/API-route combination. Preserve failed and pending results.

| Field | Recorded value |
| --- | --- |
| Record ID / date / operator | Pending |
| Build commit / executable hash / installer hash | Pending |
| Physical Windows machine / installed 8 GB / usable RAM | Pending |
| Windows / CPU / GPU / page file / WebView2 / Office / scaling | Pending |
| Route: remote API or local model API | Pending |
| Provider/runtime/model settings, without credentials | Pending |
| Fixture hashes / knowledge corpus size / office workload | Pending |
| Repeat count / cold or warm / sampling and interaction timing method | Pending |
| App process metric / coverage limitations / available samples | Pending |
| Model/server metric and system headroom recorded separately | Pending |
| UI median / p95 / maximum, separate from queue/HTTP/work/cleanup times | Pending |
| W01–W16 result and evidence for each | Pending |
| Overall engineering outcome: pass / fail / pending | **Pending — actual Windows 8 GB run not completed** |
| Remaining defects and repeat-test conditions | Pending |

An engineering pass does not establish contract-law accuracy, translation correctness or permission to sign a generated document. The planned professional legal/language acceptance remains a separate record. See [validation scope](validation.md) and [Tauri desktop validation](tauri-desktop-validation.md) for the evidence already obtained in other environments.
