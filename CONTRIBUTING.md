# Contributing

Please use English for public issues, pull requests, and documentation. Product translations and language-specific legal fixtures may contain Chinese or Thai.

1. Describe the concrete behavior and provide a synthetic or authorized redacted reproduction. Do not upload contracts, knowledge bases, access keys, personal information, or local databases.
2. Keep mainland-China legal scope explicit. A new language is not a new jurisdiction. Read the jurisdiction adaptation section in the README before proposing foreign-law support.
3. Preserve originals, source locations, immutable review snapshots, human approval states, credential boundaries, and visible uncertainty.
4. Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. Add meaningful tests for behavioral changes; legal and translation examples need practitioner review as well as engineering checks.
5. For interface changes, update Chinese / English / Thai messages and verify narrow and wide windows. Never apply interface translation to customer text or saved model output.
6. Explain the problem, resulting behavior, validation, and remaining limitations in the pull request.

Contributions are subject to the repository's Apache-2.0 license. Dependencies and user-provided materials retain their own terms. Maintainers review changes; a successful automated test does not constitute legal approval.
