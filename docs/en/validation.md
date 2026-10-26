# Engineering validation: source version 0.3.0

This page records the pre-migration feature validation. For the 2026-10-26 Tauri migration, process-memory comparison and rapid-reopen tests, see [Tauri desktop validation](tauri-desktop-validation.md).

Validated on 2026-10-23 using synthetic documents, isolated temporary workspaces, and local mock model APIs. No customer workspace, real API credential, or paid model request was used.

## Automated checks

- Full regression: **393 tests passed, 0 failed, 0 skipped**.
- TypeScript check and production build passed.
- Existing contract import, editing, tracked changes, indexing, standards, reporting, backup, and credential tests remain part of the regression.
- New coverage includes source-bound multilingual mappings, same-paragraph ranges, optimistic revisions, priority-text evidence, snapshot bounds, report translation tokens, human approval, stale-dependency rejection, model ledgers, interface localization, and credential collisions.

## Actual desktop workflows

- Alignment: conservative candidates, manual source / priority-text confirmation, explicit mock-model comparison, independent human review, version history, unaligned text, and frozen review snapshots.
- Reports: English and Thai, each exported through DOCX, PDF, HTML, Markdown, and CSV; PDF output was rendered and visually inspected. Target-language approval and stale-source gates were exercised.
- Long report cancellation: one completed translation batch followed by a deliberately waiting second batch; clicking cancel retained the original translation revision, saved no partial candidate, and dispatched no subsequent batch.
- Interface: all nine feature-center entries in Chinese, English, and Thai, plus settings / setup and library subpages. Wide and narrow windows (1440, 760, and 390 pixels) were checked. Language preference survives reload; switching it does not rewrite user fields, original documents, saved reviews, or the independent report-language selection.

Mock translations validate routing, protection, persistence, and export; they are not language-quality samples. Visual checks on this development machine do not certify every font, printer, operating system, or Word version.

## Acceptance still required

Qualified practitioners must assess legal applicability, missing / incorrect findings, citation relevance, drafting advice, semantic equivalence, priority-language interpretation, and Chinese / English / Thai terminology. The application's human approval records do not establish a reviewer's professional qualification.

Windows installation / upgrade / removal, native Intel hardware, target Microsoft Word formatting and revisions, actual enterprise retrieval credentials / networks, and a 1 TB knowledge corpus require their own environment-specific acceptance. Source version 0.3.0 does not ship new prebuilt installers in this source commit.
