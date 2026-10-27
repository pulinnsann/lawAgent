# Current iteration and remaining work

Reviewed on **2026-10-27** against the original requirements, the v0.2 completion record, the multilingual implementation and the P0 resource-control update. Source version remains 0.3.0. Historical gap audits describe their recorded dates; they are not current lists of unimplemented features.

The subsequently confirmed [offline licensing iteration](offline-licensing.md) adds required activation for official builds, 100 device-bound 90-day trials and a separate operator issuer. Issuer Windows ACL qualification, non-trial license types and revocation remain separate follow-ups. Licensing does not replace the physical 8 GB acceptance work below.

The [installable Rust/Tauri issuer](license-issuer-desktop.md) now provides an independent administrator window and locally built macOS arm64 DMG, reusing the original ledger without Node or a browser server. Native Windows ACL code and an NSIS workflow are implemented; their Windows build and acceptance remain open. Full TypeScript/Node regression now passes 606 tests, with 20 additional native issuer/host/permissions tests and ephemeral-key cross-language activation checks. No official seat was consumed by these tests.

The principal contract import, cited review, human disposition, drafting, controlled learning, Word modification/export, report and multilingual workflows have running implementations. Engineering implementation, target-environment acceptance and professional legal/language acceptance remain separate statuses.

## Current iteration: selected-document and asset-history overhead

Two further low-memory changes are implemented:

- **Word inspection metadata:** the modification workspace retains at most one short-lived, compact source-inspection entry, bounded to 1 MiB of serialized metadata and 30 idle seconds by default. It retains paragraph/segment hashes and geometry, not original ZIP bytes, XML trees, paragraph text or a complete business workspace. Cold inspections share a serial queue bounded to 32 requests. A cold unprotected inspection reads protection and targets from the same package parse.
- **Fresh source validation:** every metadata reuse still freshly hashes the managed original through a fixed 64 KiB buffer. Source reads pin a regular managed-file descriptor, enforce the existing 50 MiB ceiling, compare file identity/version around the read and reject source replacement, truncation, growth and hash mismatch. Matching timestamps alone never authorize reuse. A source read needed for actual patching still loads the original bytes and verifies them.
- **Fresh human state:** proposal decisions, revisions, exports and editable-copy authorization come from current storage. Cache keys bind the document version, original artifact/hash and authorization mode; callers receive independent metadata. Existing optimistic edits while a model suggestion is pending remain available. Shutdown waits for active inspection work and rejects queued or late inspection results.
- **Asset current-version queries:** SQL selects the newest journal row before returning the body. Current reads and save checks no longer parse every superseded version. Creation ordering, tombstones, append-only audit, optimistic revisions, workspace isolation and explicit full-history requests are retained. The schema and saved records are unchanged.

The regression suite passes **527 TypeScript/Node tests**, including 27 added cases for compact inspection reuse, real file tampering/races, human decisions, bounded latest-version reads and failure-safe shutdown. The asset tests also pass with both Rust SQLite and the SQL.js reference. A synthetic history test verifies that about 5 MiB of obsolete bodies are not returned during current reads/save checks; it does not claim an equivalent whole-process memory reduction. If inspector or knowledge cleanup fails, shutdown still awaits the other cleanup, releases the business-store writer lease and reports the error; regression tests reopen the same workspace afterward.

This does not eliminate every allocation during manual Word changes. Actual patch validation, ZIP generation and exported-file round-trip checks remain intact. Current asset lists can still return many live bodies, and explicitly requesting full history still returns its complete payload. Further paging or patch-validation reuse needs its own compatibility work.

## Remaining priorities

| Priority | Work | Present status and next concrete step |
| --- | --- | --- |
| P0 | Physical Windows 8 GB, remote API and Office coexistence | Acceptance pending. Run the [Windows protocol](windows-8gb-acceptance.md), separate UI response from network latency and record the actual build/hardware. macOS tests cannot close this item. |
| P0 | Independently deployed local model API on the same machine | Acceptance pending. Compare the model/Office baseline with the same settings plus LawAgent; record app overhead separately. Do not start another inference model or silently reduce customer model settings. |
| P0 | Windows delivered-package validation | Existing workflow builds/tests/packages Windows, but installed/portable runtime behavior needs more evidence. Next add final-ZIP extraction/runtime checks, actual Windows DPAPI round-trip/tamper tests and a Windows collector self-test, then native-window and installation/uninstallation tests. CI is engineering evidence, not physical 8 GB certification. |
| P1 | Selected Word editing peaks | Inspection reuse is implemented. Next measure representative complex/large originals, then consider reusing successful immutable patch-validation results without weakening export validation or blocking manual edits behind a pending model draft. |
| P1 | Live-asset and explicit-history scale | Current-version historical scans are removed. Next introduce bounded summaries/history pages where consumers can use them, rather than changing all callers or silently truncating results. |
| P1 | 1 TB knowledge corpus and remote storage | Existing FTS/incremental/SFTP/shared-folder/index-node connectors are implemented. Next build a reproducible scale harness, move large SFTP manifests from whole JSON/maps to disk-backed state, and test interruption/recovery and representative enterprise permissions. Small fixtures do not close this capacity requirement. |
| P1 | Real legal retrieval services | Official catalogue/original readers and generic read-only MCP/index API mappings exist. Qualify an actual authorized provider and its fields, returned quotations, limits and source provenance; disclose uncovered material. A complete legal database is outside scope. |
| Acceptance | Microsoft Word, Windows credentials/install/upgrade, Intel Mac | Verify the target applications and OS versions, original/new revisions, supported formatting, data retention and credential persistence. Build configurations alone do not establish these results. |
| Professional acceptance | Legal conclusions and Chinese/English/Thai quality | The user's lawyer and language reviewers evaluate realistic cases, omissions, false positives, legal applicability and drafting/report quality. Engineering tests provide no legal sign-off. |
| Later migration | More Rust business/knowledge code | Port narrow measured hot paths while preserving data, cancellation and provenance. A full rewrite is not a prerequisite or a proven saving on its own. |

No new business-policy choice blocks the current iteration. Real hardware, authorized real endpoints and professional samples are needed when their respective acceptance runs begin; they are not silently substituted with mock results.

## Retained scope decisions

Keep mainland-China legal scope, Chinese/English/Thai input and interface/report workflows, single-user local-first storage, user-configured local/remote model APIs, Windows/macOS support and existing data compatibility. No default resident embedding, inference or reranking service is added.

Brave remains deferred. Independent consultation, SaaS subscriptions, multi-user approvals/SSO, automatic fine-tuning, a proprietary complete legal database and automatic high-fidelity bilingual layout are not added to this backlog as confirmed first-version promises.

See [resource-control boundaries](p0-resource-control.md), [architecture and development](development.md) and [multilingual workflows](multilingual.md).
