# Local problem logs and export

Customers can choose **Export problem log** from the sidebar or the work-tools menu, then **Save log file**. A system save dialog creates a new UTF-8 `.log` file that the customer can choose to send to support. The software does not upload or email the file. Cancelling the dialog creates no export and is not reported as success. Existing files are never overwritten.

The export action remains available without an active trial, after expiry, during maintenance and after a Core worker fault. It does not acquire a model/review lease, unlock credentials, send a model request or consume a license seat.

## Recorded information

The logger accepts only fixed event names and allowlisted metadata: application/Node version, OS family, architecture, runtime, storage type, command/action names, task stages/status, duration, bounded counts, exit status and a fixed error category or HTTP status. Error text can be examined briefly to choose a category, but its text and stack are never retained. Unknown errors receive a generic category.

No contract text, document titles, file paths, URLs, prompts, model responses, API keys, activation tokens, device codes, raw hardware identifiers, usernames, task IDs or document IDs are accepted. Console output and worker streams are not copied into logs; Core/nested-worker stdout and stderr remain captured and discarded so they cannot corrupt the private desktop pipe or retain source/credential fragments.

Saved log rows are validated again during export. Unknown fields, invalid values, corrupted records and incomplete trailing lines cannot be used to copy arbitrary local-file contents into the export. The header contains only generated dates and the same allowlisted technical context. The customer-selected export location is returned to the interface but is not inserted into the log contents.

## Storage and resource limits

Logs live in `diagnostics/` under the selected application data root. The Node logger retains at most four 512 KiB files (`app.jsonl` and three rotations), with at most 128 queued records and no resident timer or open descriptor. Repeated progress records for the same phase can be coalesced. A storage error disables logging rather than failing contract work. Unix diagnostic directories/files use owner-only modes and are checked for link/replacement hazards.

The native Tauri launcher separately retains two approximately 128 KiB fixed-schema journals. Its events include start/readiness, backend termination, orderly shutdown, startup failure and a fixed panic marker. No panic message or OS crash report is copied. Combined automatic retention is approximately 2.25 MiB; manual exported copies remain wherever the user saves them.

Normal export appends the launcher's validated journal to the Node log. If the desktop backend has not become ready or has stopped, a native fallback exports only the launcher context and its readable journal. A controlled native startup-failure dialog also offers to save a startup log before closing. These fallbacks do not guarantee that a complete history exists after an abrupt crash, a power failure or inaccessible storage. They preserve the established startup-failure and shutdown behavior.

## Implementation

- `src/main/diagnostic-log.ts`: bounded asynchronous storage, privacy allowlists, safe error categories and revalidated export.
- `src/desktop/runtime.ts`, `index.ts` and `protocol.ts`: structured lifecycle/operation events and parent-side export before Core/maintenance/license gates.
- `native/law-desktop/src/diagnostics.rs` and `host.rs`: a separate fixed-event launcher journal, private journal-read operation and failure export.
- `src/renderer/src/DiagnosticsPanel.tsx`: plain-language Chinese/English/Thai export instructions and distinct saved/cancelled/failed feedback.
- The Electron reference parent also records structured events and supports the export action. Official desktop acceptance remains centered on Tauri.

These logs are troubleshooting aids, not legal audit evidence, a complete trace, a performance benchmark or a substitute for professional review. No crash-monitoring service or additional resident model is introduced.

## Validation

The macOS arm64 update passed 653 TypeScript/Node tests and 87 Rust tests. The native-window workflow exported a log after a synthetic invalid request, verified omission of credentials, contract filenames, input values and device codes, then exported again after restart with the earlier failure and orderly-close records retained. The same flow retained cited review, tracked Word export, Chinese/English/Thai PDF export and saved data.

A separate 21-scenario startup/shutdown run finished with no observed owned-process or newly attributed WebKit survivors. The normal production build was then rebuilt without `desktop-smoke`, opened on the existing workspace with its active trial and saved sample result intact, and its ordinary save dialog produced an actual readable problem log. These are macOS engineering checks; Windows installation, real-device responsiveness and legal correctness retain their separate acceptance requirements.
