# Data and security boundaries

LawAgent is a single-user local desktop application. It does not provide SaaS accounts, multi-user authorization, SSO, or a shared approval server.

## Data sent to configured services

Local indexing works without a model. A model review, comparison, draft, or report translation sends the selected task data to the model endpoint configured by the user. A local Codex CLI connection can still contact that account's remote model service.

Configured external knowledge, MCP, remote index, and web retrieval endpoints receive their respective queries. SFTP mirrors copy authorized remote documents into a local cache for indexing. These are explicit connections, not an assertion that all processing stays offline.

## Credentials

The privileged desktop backend binds saved keys to their endpoints; the Tauri Rust host uses the operating system's protection service for encryption. Startup opens the application window before attempting to unlock credentials. An unavailable or timed-out system service can fall back to session-only replacement credentials without overwriting previously encrypted files. There is no plaintext fallback. Legacy Electron ciphertext is retained unchanged, and the interface asks for one-time key re-entry into the separate Tauri vault namespace.

Do not include keys in business context, enterprise rules, knowledge documents, advisor prompts, or bug reports. Task preparation rejects known credential collisions in reference assets. Unknown backend errors may retain their original message for diagnosis; use redacted, synthetic reproductions when reporting issues.

## Untrusted documents and model outputs

Contracts, retrieved pages, templates, advisor packages, and model output are task data. They cannot grant tool permissions or request arbitrary shell execution. Parsers and model responses have bounded sizes and structured checks. HTML, Markdown, CSV, and OOXML export use escaping and other format-specific protections.

A matched quotation proves text traceability only. Authenticity, effectivity, applicability, priority text, and risk acceptance remain separate human records. Tool checks do not replace legal review.

## Repository contents

Source publication excludes customer contracts, local workspaces, knowledge corpora, keys, databases, caches, screenshots, OCR models, and installers. The dependency lockfile remains committed for reproducibility. Historical private implementation notes and customer-specific investigation records are not part of the public documentation set.

Do not post production documents or credentials in public issues. Provide a synthetic or explicitly authorized redacted reproduction instead.

## Closing and reopening

Closing cancels active model, retrieval, generation and indexing operations before waiting for cleanup. Native PDF admission stops and its owned print/WebView resources are cancelled while the application event loop still runs. Read-only preflight does not disable the ordinary shutdown deadline. Critical backup, restoration and index-publication phases finish or roll back before writer ownership is released. An open request arriving during shutdown is remembered and reopened after the previous instance releases its ownership. Startup errors are reported as ordinary failures rather than deliberately aborting the process.
