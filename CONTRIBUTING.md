# Contributing

Please use English for public issues, pull requests, and documentation. Product translations and language-specific legal fixtures may contain Chinese or Thai.

1. Describe the concrete behavior and provide a synthetic or authorized redacted reproduction. Do not upload contracts, knowledge bases, access keys, personal information, or local databases.
2. Keep mainland-China legal scope explicit. A new language is not a new jurisdiction. Read the jurisdiction adaptation section in the README before proposing foreign-law support.
3. Preserve originals, source locations, immutable review snapshots, human approval states, credential boundaries, and visible uncertainty.
4. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. Add meaningful tests for behavioral changes; legal and translation examples need practitioner review as well as engineering checks.
5. For interface changes, update Chinese / English / Thai messages and verify narrow and wide windows. Never apply interface translation to customer text or saved model output.
6. Explain the problem, resulting behavior, validation, and remaining limitations in the pull request.

The business-store binding needs Rust 1.89+; the Tauri desktop host requires Rust 1.90+ and a native C toolchain. Run `npm run native:test` and `npm run native:test:binding` for native changes. Dev/build/test commands verify the local binding automatically. Use the Tauri same-build comparison described in [Tauri desktop migration](docs/en/tauri-desktop-migration.md) for shell claims; `npm run measure:business-memory` remains the Electron storage reference; `npm run native:benchmark` measures only the earlier synthetic CLI. Keep measurements separate from customer workspaces. Read [Memory-first native migration](docs/en/rust-low-memory-migration.md) before changing the runtime boundary or data format.

Contributions are subject to the repository's Apache-2.0 license. Dependencies and user-provided materials retain their own terms. Maintainers review changes; a successful automated test does not constitute legal approval.
