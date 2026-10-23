# Third-party dependencies

LawAgent source is licensed under Apache-2.0. Dependencies retain their own licenses and notices. Install the exact dependency set using the committed `package-lock.json` and inspect each package's LICENSE / NOTICE files when preparing a distribution.

The application uses Electron / Chromium, React, sql.js, PDF.js, Tesseract.js, JSZip, @napi-rs/canvas, SSH2, and other packages. Their source, native components, data, and build tools may carry different license terms. Package metadata is a useful inventory, not a substitute for the distributed license texts.

JSZip offers alternative licensing terms; its published package records `(MIT OR GPL-3.0-or-later)`. Transitive build dependencies also include licenses such as MPL-2.0 and attribution-licensed data. Preserve the notices required by the terms applicable to the components you redistribute.

This source repository does not vendor `node_modules`, Electron / Chromium binaries, OCR trained-data models, customer documents, or retrieved legal databases. A binary release must carry the licenses and attribution notices for the components it actually bundles; this root license alone does not cover them.

Remote model APIs, knowledge services, professional databases, official-site material, and customer contracts are governed separately by their respective terms and permissions.
