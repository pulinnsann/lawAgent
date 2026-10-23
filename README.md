# LawAgent

Source version **0.3.0**.

A local-first desktop workbench for enterprise contract review, drafting, and reporting. Bring your own model API, connect your knowledge sources, and keep source documents, review decisions, and citations traceable.

LawAgent runs on Windows and macOS. It processes Chinese, English, and Thai contracts, provides a Chinese / English / Thai interface, and supports separately reviewed English and Thai reports.

**Current legal scope: mainland China law.** Contract language, interface language, and report language do not change the applicable legal scope. Legal correctness, language quality, and practical suitability require qualified human review.

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

Development requires **Node.js 24 or later** and npm. Desktop builds include their runtime; an installed desktop user does not need npm.

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

1. Choose the interface language in the top bar. The default is Chinese; the selection is saved locally.
2. Load the synthetic demonstration contract or import a document you are authorized to process.
3. Open **Model settings** and configure your own API endpoint, model, and key. A local endpoint may omit a key if its server allows this. The Codex option uses the locally installed CLI's login state.
4. Open **Environment and knowledge setup** to choose a directory, file scope, exclusions, and an incremental-update schedule. Local indexing does not require a model.
5. Confirm the contract type, your role, business context, and enterprise standard. Add facts or unresolved questions in **Review information and verification**.
6. Run **Local rule checks** or **Start model review**, inspect coverage and citations, then record human decisions.
7. Open the **Feature center** for alignment, report translations, templates, remote connections, OCR, and maintenance.

A local application can still send document text to a remote model or retrieval endpoint **you configure**. Choose endpoints and material scopes appropriate for your organization. Interface localization does not translate user documents automatically.

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

Electron's main process owns native dialogs and credentials. A Core worker performs document and review operations; indexing runs separately. React renders the desktop interface through a constrained bridge.

Business records use local SQLite storage; versioned workspace assets use the existing append-only audit mechanism. Knowledge search uses a persistent local index. Reviews and reports retain source-version snapshots instead of following mutable documents silently.

See [Architecture and development](docs/en/development.md) and [Data and security boundaries](docs/en/data-and-security.md).

## Engineering checks

```bash
npm run typecheck
npm test
npm run build
```

Synthetic integration tests use temporary workspaces and local mock APIs. Some smoke scripts open real Electron windows; optional source-reading checks access public official sites. Tests do not establish legal accuracy or certify every Windows / Word layout.

Useful focused checks:

```bash
node --import tsx --test tests/clause-alignment.test.ts tests/report-translation.test.ts tests/multilingual-service.test.ts tests/i18n.test.ts
node --import tsx scripts/smoke-clause-alignment-ui.mjs
node --import tsx scripts/smoke-multilingual-report-ui.mjs
```

Build before running UI smoke scripts. Use only synthetic or explicitly authorized documents. See [Contributing](CONTRIBUTING.md) and the [0.3.0 engineering validation record](docs/en/validation.md).

## Desktop builds and current limitations

```bash
npm run pack:win
npm run pack:mac
```

`pack:win` targets Windows x64 NSIS and ZIP. `pack:mac` builds a local macOS application directory; distribution signing and notarization need separate configuration. The Windows workflow is manually triggered and does not automatically publish a release.

This repository publishes source code. Local historical installer artifacts are excluded. Engineering checks have not replaced target-device acceptance for Windows, Intel Macs, Microsoft Word formatting / revisions, enterprise services, or a 1 TB knowledge corpus.

Independent legal consultation, multi-user approvals, SaaS subscription billing, a complete proprietary legal database, and automatic model fine-tuning are outside this version. Brave search remains deferred.

## License

[Apache License 2.0](LICENSE). Third-party dependencies retain their own licenses; this license does not relicense retrieved legal materials, customer contracts, knowledge-base content, or model services. See [Third-party dependencies](THIRD_PARTY_NOTICES.md).
