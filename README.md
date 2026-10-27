# LawAgent

Source version **0.3.0**. Latest source update: **2026-10-27** — an installable Rust license issuer, offline trial licensing and resource control for 8 GB Windows office computers.

A local-first desktop workbench for enterprise contract review, drafting, and reporting. Bring your own model API, connect your knowledge sources, and keep source documents, review decisions, and citations traceable.

The Tauri build targets Windows 10+ with WebView2 and macOS 13.5+ (the bundled official Node 24 runtime's minimum). It processes Chinese, English, and Thai contracts, provides a Chinese / English / Thai interface, and supports separately reviewed English and Thai reports.

**Current legal scope: mainland China law.** Contract language, interface language, and report language do not change the applicable legal scope. Legal correctness, language quality, and practical suitability require qualified human review.

## Latest update

- **Export local problem logs:** an always-available support entry saves a bounded troubleshooting file without contract text, credentials, activation codes or device identifiers. No upload occurs automatically; startup failures can offer a limited launcher log. See [problem-log contents and limits](docs/en/problem-logs.md).
- **Plain-language interface for legal professionals:** use everyday task descriptions across review, references, service setup and activation. Raw authorization JSON, model compatibility settings and technical verification records are optional details. Chinese, English and Thai wording is updated while contracts, quotations and saved findings stay unchanged. See [interface wording conventions](docs/en/plain-language-interface.md).
- **Copyable local issuance information:** the customer license panel displays the product, running app version and complete device code. Copy the raw code or a compact information block; the separate native issuer accepts either without adding hardware probes or changing the device binding.
- **Installable administrator license issuer:** a separate Rust/Tauri utility continues the existing issuance ledger and supports signing, original-code retrieval, copying and activation-file export without Node.js or a local HTTP server. The macOS arm64 installer is built locally; Windows packaging is prepared for a Windows runner and still needs qualification. No signing private key is included in either installer. See [installation and operation](docs/en/license-issuer-desktop.md).
- **Offline trial licensing for official builds:** 100 single-device trial seats, each valid for 90 days from its signed start time. Expiry preserves viewing/export of existing data. A separate local operator issuer keeps the private key and issuance ledger outside customer bundles. See [activation and issuer operation](docs/en/offline-licensing.md).
- **Tauri is now the default desktop shell**, using the system WebView. The existing document and review engines run in one bundled Node sidecar; installed users do not need a separate Node installation. Electron remains a development reference.
- **Rust-backed disk SQLite and paged workspaces** reduce retained business data in memory. Knowledge workers start on demand, and model review takes priority over indexing.
- **Heavy operations now share a bounded, serial queue.** Reviews, model tools, imports, indexing, OCR and exports wait for actual cleanup before the next admitted operation starts. Knowledge workers retire after 60 idle seconds and reopen the persisted index when needed.
- **Repeated Word inspection and current-asset reads allocate less redundant data.** A short-lived bounded cache retains compact target metadata while freshly hashing the original on every reuse; current-asset SQL excludes superseded bodies. Human decisions, source checks and full export validation remain live.
- **OS memory-pressure sampling and a resource-status panel** expose running tasks and queue reasons. Elevated pressure defers new document and index tasks; critical pressure defers all new scheduled tasks. Existing local and remote model APIs remain user-configured.
- **Startup and shutdown handling** now cancels active review, indexing and PDF work, drains owned workers, releases workspace locks, and handles a second launch during exit. Startup failures exit through a controlled error path.
- **Existing workflows and data are retained**, including cited reviews, human decisions, Word tracked changes and Chinese / English / Thai reporting. Existing API secrets need one-time re-entry in the new OS-protected vault; the previous encrypted files are preserved.

In paired synthetic-workspace measurements on one macOS arm64 machine, initial idle summed process RSS changed as follows:

| Workspace | Electron reference | Tauri | Reduction |
| --- | ---: | ---: | ---: |
| Small, 3 documents | 557.30 MiB | 419.83 MiB | 24.67% |
| History, 161 documents | 636.38 MiB | 483.55 MiB | 24.02% |

These are individual migration-build runs with a loopback model mock. RSS sums can count shared pages more than once; startup peaks and a real resident local model were not measured. Subsequent lifecycle fixes were validated separately. See the [change log](CHANGELOG.md) and [measurement method, full results and limitations](docs/en/tauri-desktop-validation.md).

The current acceptance target is a **physical Windows computer with 8 GB RAM**, with particularly responsive operation when using a remote model API. A separately deployed local model remains supported through its API; the app does not start an additional inference, embedding or reranking model. Passing this target still requires Windows measurements with Office and the intended model deployment. See [resource-control scope](docs/en/p0-resource-control.md) and the [Windows 8 GB acceptance plan](docs/en/windows-8gb-acceptance.md). Scheduling is cooperative, not a hard process-memory or GPU-memory limit.

## Features

- **Contract intake and lifecycle:** DOCX and PDF import, retained originals, projects, linked versions, archive, trash, recovery, and explicit permanent cleanup.
- **Review workflows:** configurable enterprise standards, facts and assumptions, missing-information pauses, local checks, model review, long-contract batching, and human risk disposition.
- **Knowledge and retrieval:** local directory indexing and incremental updates, source quotations and locations, external knowledge APIs, SFTP mirrors, mounted shared folders, remote index nodes, and configurable read-only MCP tools.
- **Legal sources:** bounded official catalogue discovery and original-page reading, optional user-configured SearXNG search, separate retrieval coverage, and human source verification. This is not a complete statute or case database.
- **Bilingual / trilingual alignment:** source-bound Chinese / English / Thai passages, one-to-many mappings, same-paragraph character ranges, unaligned text, numerical and obligation-marker differences, explicit model comparison candidates, and human-confirmed priority-text agreements.
- **Editing:** before-and-after previews, item-by-item adoption, separate DOCX exports, native Word tracked changes, and preservation of supported original formatting and existing revisions.
- **Drafting:** descriptions or approved templates, programmatic checks, review, human confirmation, and export of the reviewed document.
- **Reports:** risk reports, management reports, executive summaries, and cross-contract work summaries; DOCX, PDF, HTML, Markdown, and CSV export. English / Thai narrative is stored separately, requires human approval, and becomes stale when known source dependencies change. Original quotations and protected amounts, dates, and identifiers remain unchanged.
- **Controlled learning:** manually approved experience, scoped conflict priorities, advisor prompt packages, test samples, regression records, and revocation. No automatic model fine-tuning.
- **Model operations:** configurable Chat Completions-compatible APIs or a locally installed Codex CLI; declared capabilities, opt-in streaming, cumulative budgets, controlled retries, cancellation, and a credential-free call ledger.
- **Local maintenance:** workspace backup and restoration, optional index exclusion, and reversible index cleanup. OCR language packs are downloaded only when requested.

## Quick start

Development requires **Node.js 24 or later**, npm, **Rust 1.90 or later**, and a native C build toolchain (Xcode Command Line Tools on macOS; MSVC Build Tools and WebView2 on Windows). Development/build/test commands prepare the native storage binding automatically. The desktop shell uses Tauri and the system WebView. The first build downloads a checksum-pinned portable Node 24 runtime; installed users do not install Node themselves. Installed desktop users do not need npm, Rust or build tools.

```bash
git clone https://github.com/pulinnsann/lawAgent.git
cd lawAgent
npm ci
npm run dev
```

To build and preview:

```bash
npm run build
npm run preview
```

1. Choose the interface language in the top bar. The default is Chinese; the selection is saved locally. For an official build, open **License and trial access**, copy the device code and activate the code supplied by the operator before starting new work. Existing data remains viewable/exportable without a valid trial.
2. Load the synthetic demonstration contract or import a document you are authorized to process.
3. Open **Model settings** and configure your own API endpoint, model, and key. A local endpoint may omit a key if its server allows this. The Codex option uses the locally installed CLI's login state.
4. Open **Environment and knowledge setup** to choose a directory, file scope, exclusions, and an incremental-update schedule. Local indexing does not require a model.
5. Confirm the contract type, your role, business context, and enterprise standard. Add facts or unresolved questions in **Review information and verification**.
6. Run **Local rule checks** or **Start model review**, inspect coverage and citations, then record human decisions.
7. Open the **Feature center** for alignment, report translations, templates, remote connections, OCR, and maintenance.

A local application can still send document text to a remote model or retrieval endpoint **you configure**. Choose endpoints and material scopes appropriate for your organization. Interface localization does not translate user documents automatically.

Installed Tauri builds reuse the previous `law-agent-desktop` data directory. Contracts, history and original files stay in place. Legacy Electron-encrypted credential files are preserved; enter API secrets once in Tauri settings to store them in the new OS-protected namespace. Source-based development continues to use `.local/data/`.

## Multilingual behavior

Interface language and report language are independent. Switching the interface does not rewrite contracts, templates, human opinions, or saved reports.

Clause alignment preserves actual source passages and their file / text hashes. Numbering and sequence produce candidates; they do not establish semantic equivalence. A priority language requires an explicit human-confirmed agreement tied to original text. Unaligned, disputed, stale, and truncated scopes remain visible.

English and Thai reports use versioned translation workspaces. Generate candidates through your configured model or edit them manually, retain all protected tokens, and approve the completed translation before export. Missing or stale translations block target-language export instead of silently emitting Chinese narrative.

See [Multilingual workflows](docs/en/multilingual.md).

## Adapting to another jurisdiction

**There is no jurisdiction-switch setting in this version. Changing UI language, report language, model, or a single prompt is insufficient to support another country's law.** A fork must adapt the complete review and evidence pipeline and validate it with qualified practitioners.

| Area | Code to inspect | What must be adapted |
| --- | --- | --- |
| Review scope and legal reasoning | [`src/core/review.ts`](src/core/review.ts), [`src/core/batched-review.ts`](src/core/batched-review.ts) | System instructions, scope limitations, legal categories, cross-batch reasoning, and human-review requirements. |
| Drafting and modifications | [`src/core/contract-generation.ts`](src/core/contract-generation.ts), [`src/core/change-drafting.ts`](src/core/change-drafting.ts) | Applicable-law assumptions, drafting instructions, unsupported-law warnings, and locally appropriate terminology. |
| Multilingual comparison | [`src/core/workspace-clause-alignment.ts`](src/core/workspace-clause-alignment.ts), [`src/core/reference-translation.ts`](src/core/reference-translation.ts) | Comparison assumptions, terminology, priority-text treatment, and language-sensitive markers. A translation must not silently change governing law. |
| Enterprise rules | [`src/core/enterprise-standards.ts`](src/core/enterprise-standards.ts), [`src/shared/assurance.ts`](src/shared/assurance.ts), [`src/core/workspace-experience-policy.ts`](src/core/workspace-experience-policy.ts) | Default standards, mandatory-law guardrails, commercial thresholds, precedence, templates, and advisor samples. Existing mainland-China experience is not automatically portable. |
| Deterministic checks | [`src/core/program-checks.ts`](src/core/program-checks.ts) | Amount and currency grammars, dates, tax assumptions, numbering, parties, references, and limitations. Some checks explicitly target CNY and Chinese financial numerals. |
| Sources and retrieval | [`src/core/official-sources.ts`](src/core/official-sources.ts), [`src/core/retrieval.ts`](src/core/retrieval.ts), [`src/shared/contracts.ts`](src/shared/contracts.ts) | Authoritative domains, permitted URLs, catalogue readers, issue-query terms, document types, effectivity metadata, and source-conflict treatment. Do not bypass access controls. |
| Knowledge and human rules | [`src/core/workspace-library.ts`](src/core/workspace-library.ts), [`src/core/workspace-advisor.ts`](src/core/workspace-advisor.ts), [`src/core/workspace-review-completion.ts`](src/core/workspace-review-completion.ts) | Jurisdiction-appropriate materials, approved rules, expected findings, source verification, conflict reasons, and freshness behavior. |
| Reports and public scope labels | [`src/core/reporting.ts`](src/core/reporting.ts), [`src/core/report-translation.ts`](src/core/report-translation.ts), [`src/shared/report-localization.ts`](src/shared/report-localization.ts), [`src/renderer/src/App.tsx`](src/renderer/src/App.tsx), `src/renderer/src/i18n-*` | Jurisdiction disclosures and explanatory text in every language. Keep source snapshots and translation provenance intact. |
| Validation | [`tests/`](tests/), [`src/core/sample.ts`](src/core/sample.ts) | Replace or extend synthetic fixtures; add authoritative-source parser tests and qualified legal / linguistic acceptance cases. Do not reuse previous jurisdiction acceptance claims. |

For a multi-jurisdiction fork, introduce an explicit, versioned jurisdiction profile and bind it to standards, sources, prompts, review snapshots, and reports. Preserve legacy scope metadata rather than reinterpreting historical reports under the new law.

See [Jurisdiction adaptation guide](docs/en/adapting-jurisdiction.md) for the development sequence.

## Architecture

Tauri owns the native window, file dialogs, system-protected credentials and offline PDF export. A bundled Node sidecar preserves the existing review and document engines, communicating only over inherited private pipes. A Core worker performs business operations; the index worker starts on demand. React uses the same constrained bridge. No Electron or Chromium distribution is included in Tauri packages.

Business records use disk SQLite through a Rust N-API binding, with one Core worker owning the connection and actual page-level transactions; versioned workspace assets use the existing append-only audit mechanism. Knowledge search uses a persistent local index. Reviews and reports retain source-version snapshots instead of following mutable documents silently.

See [Architecture and development](docs/en/development.md) and [Data and security boundaries](docs/en/data-and-security.md).

## Memory-first Rust storage

The default desktop shell now uses Tauri. Business storage defaults to `native/law-node`: Rust disk SQLite loaded into the existing Core worker, without an extra resident service. The schema and original files remain compatible. For an existing workspace, first activation retains a validated, byte-identical `workspace.sqlite.pre-rust-backup`; older schemas migrate on a closed staged copy and retain their version backups. An OS writer lease prevents current-version instances from sharing a data root and is released on process termination.

The interface pages contracts, original text and review history, loads selected reports on demand, and opens the modification workspace only when requested. Internal review/edit operations omit unrelated historical reports. Model review cancels and waits for an existing index job before proceeding; new indexing is deferred during that review. This does not control an independent model server's RAM or GPU use.

The production Core now admits integrated heavy operations through one serial lease, with model tasks ahead of document tasks and indexing. The lease lasts through actual worker cleanup, including cancellation. Small interactive reads and human edits remain available. Native OS samples guide new admissions; unavailable samples retain serial operation. This production scheduler is separate from the earlier Rust CLI governor experiment. See [P0 resource control](docs/en/p0-resource-control.md) for covered operations and limitations.

```sh
npm run native:test
npm run native:binding
npm run native:test:binding
npm run build
npm run smoke:desktop
```

The desktop comparison uses isolated synthetic data and a loopback model API. See [Tauri desktop migration](docs/en/tauri-desktop-migration.md) for architecture and compatibility, and [Tauri validation](docs/en/tauri-desktop-validation.md) for measured whole-application memory and workflow checks. See [Native business-storage validation](docs/en/native-business-storage-validation.md) for measured scope and limitations. The earlier `native/law-core` CLI remains a separate storage/admission experiment; its governor is not a complete production scheduler or hard RSS limit. The review/document engines still use Node; a complete Rust business-logic port remains a later migration stage. See [Memory-first native migration](docs/en/rust-low-memory-migration.md) and [Measured baseline](docs/en/lightweight-baseline.md).

## Engineering checks

```bash
npm run typecheck
npm test
npm run build
```

Synthetic integration tests use temporary workspaces and local mock APIs. The desktop smoke opens a real Tauri window; older reference scripts open Electron windows; optional source-reading checks access public official sites. Tests do not establish legal accuracy or certify every Windows / Word layout.

The current source passes **594 TypeScript/Node tests and 61 Rust tests**. The native-window workflow passed cited mock review, tracked DOCX export, multilingual PDF and restart persistence, with explicit native device-code/development-build checks; **21 macOS lifecycle scenarios** also passed. Six actual N-API checks were established with this storage binding. See [offline licensing](docs/en/offline-licensing.md), the [current backlog](docs/en/iteration-backlog.md), [P0 validation and boundaries](docs/en/p0-resource-control.md) and [historical migration validation](docs/en/tauri-desktop-validation.md); Windows 8 GB, real-model and Intel Mac acceptance remain outstanding.

Useful focused checks:

```bash
node --import tsx --test tests/clause-alignment.test.ts tests/report-translation.test.ts tests/multilingual-service.test.ts tests/i18n.test.ts
node --import tsx scripts/smoke-clause-alignment-ui.mjs
node --import tsx scripts/smoke-multilingual-report-ui.mjs
```

The two focused UI scripts above use the Electron reference: run `npm run build:electron` first. Use `npm run smoke:desktop` for the current Tauri workflow. Use only synthetic or explicitly authorized documents. See [Contributing](CONTRIBUTING.md) and the [earlier 0.3.0 engineering validation record](docs/en/validation.md).

## Desktop builds and current limitations

```bash
npm run pack:win
npm run pack:mac
```

Run each packaging command on its target operating system. `pack:win` builds a Tauri NSIS installer; the manual Windows x64 workflow additionally creates a portable ZIP requiring an installed WebView2 runtime. `pack:mac` builds an app and DMG for the host architecture. Distribution signing and notarization need separate configuration. The Windows workflow is manually triggered and does not automatically publish a release.

After packaging on macOS arm64 or Windows x64, run `node scripts/collect-desktop-installers.mjs` to verify and collect the current customer installer into `release/law-agent-<version>-<Shanghai-date>/`, with SHA-256 checksums, a build manifest and installation instructions. The macOS check reads the actual DMG payload. Private signing keys, issuance ledgers and customer workspaces are excluded. The Windows workflow performs collection automatically.

Windows collection uses full 7-Zip with NSIS support to inspect the installer payload; this build-time tool is not needed by customers. The workflow defaults to all application tests. Its `packaging_only` option is for packaging-script repairs after the same application code has already passed the full Windows run.

This repository publishes source code. Local historical installer artifacts are excluded. Engineering checks have not replaced target-device acceptance for Windows, Intel Macs, Microsoft Word formatting / revisions, enterprise services, or a 1 TB knowledge corpus.

Independent legal consultation, multi-user approvals, SaaS subscription billing, a complete proprietary legal database, and automatic model fine-tuning are outside this version. Brave search remains deferred.

## License

[Apache License 2.0](LICENSE). Third-party dependencies retain their own licenses; this license does not relicense retrieved legal materials, customer contracts, knowledge-base content, or model services. See [Third-party dependencies](THIRD_PARTY_NOTICES.md).

Official binaries additionally use the [offline activation policy](docs/en/offline-licensing.md). The client includes public verification keys, never the issuer private key. The administrator tool starts with `npm run license:issuer` and uses separately retained local signing material; a public source checkout cannot sign official licenses.
