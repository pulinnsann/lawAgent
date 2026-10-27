# Third-party dependencies

LawAgent source is licensed under Apache-2.0. Dependencies retain their own licenses and notices. Install the exact dependency set using the committed `package-lock.json` and inspect each package's LICENSE / NOTICE files when preparing a distribution.

The application uses Tauri / Wry, the system WebView, a bundled Node.js runtime, React, sql.js, PDF.js, Tesseract.js, JSZip, @napi-rs/canvas, SSH2, and other packages. Their source, native components, data, and build tools may carry different license terms. Package metadata is a useful inventory, not a substitute for the distributed license texts.

JSZip offers alternative licensing terms; its published package records `(MIT OR GPL-3.0-or-later)`. Transitive build dependencies also include licenses such as MPL-2.0 and attribution-licensed data. Preserve the notices required by the terms applicable to the components you redistribute.

This source repository does not vendor `node_modules`, Electron / Chromium binaries, OCR trained-data models, customer documents, or retrieved legal databases. A binary release must carry the licenses and attribution notices for the components it actually bundles; this root license alone does not cover them.

The native components use the exact Rust dependency graph in `Cargo.lock`, including `rusqlite` with bundled SQLite, `napi` / `napi-derive` / `napi-build`, `serde` and `serde_json`. Crates and downloaded native build inputs retain their own license texts. Cargo registries and compiled outputs are not vendored in this repository. Any native binary distribution must include the notices required by the components it actually ships; the desktop shell now includes Tauri and Wry. Electron / Chromium remain development-only reference dependencies and are not included in Tauri installers.

Remote model APIs, knowledge services, professional databases, official-site material, and customer contracts are governed separately by their respective terms and permissions.

Noto Sans Thai Regular and Bold are vendored, unmodified fonts from the Noto Project, under SIL Open Font License 1.1. The exact sources and SHA-256 values are listed in `native/law-desktop/platform/fonts/README.md`; the license is in `OFL.txt` alongside the files and included in binary runtime notices. They are embedded only for offline PDF rendering.

Tauri packages include the official Node.js runtime LICENSE, production dependency license files, and generated license texts from the locked Cargo graph under `runtime/licenses/`.

The separate Rust license issuer does not bundle Node.js or the document runtime. Its installer carries this notice, the project license and generated locked-Cargo notices under `licenses/`. It additionally uses Ed25519-dalek, curve25519-dalek and their supporting crates; their original license texts are included in those generated notices.
