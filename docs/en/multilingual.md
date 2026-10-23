# Multilingual workflows

## Three independent languages

The interface supports Chinese, English, and Thai. Its top-bar preference is saved on the current computer and updates native dialog labels. Thai interface dates explicitly use the Gregorian calendar and Latin digits; changing the interface must not reinterpret contractual dates or monetary values.

A contract retains its original language and text. A report has an independent `settings.language`. Neither changes the mainland-China legal scope.

## Clause alignment

Open **Feature center → Bilingual / trilingual clause alignment** after importing a contract. Sources can be different language passages in one file or explicitly selected versions of the same contract.

Generate conservative numbering / sequence candidates, or create a mapping manually. Each language may contain multiple source blocks. Same-paragraph bilingual text uses explicit, non-overlapping character ranges. Source file hashes, full-block hashes, ranges, and locators are validated server-side.

Mappings are candidates until a person confirms them. Unaligned text is listed separately. Numerical / currency / date tokens and obligation markers are comparison hints, not proof that clauses differ legally or mean the same thing.

A priority-text agreement can be unspecified, pending, or human-confirmed. Confirmation requires the selected language, a reason, and original contract evidence. The model cannot select the legally prevailing text on the user's behalf.

An explicitly requested comparison uses the user's configured model, budget, cancellation, and ledger. Its output stays a candidate and must reference supplied passages. Mapping and difference-review histories are preserved. Newly imported versions are visible without silently replacing expressly selected sources.

Reviews rebuild their alignment snapshot from trusted local assets. Large snapshots have explicit bounds, counts, limitations, and a source-state digest; omitted material must not be represented as checked. Later mapping or priority-text changes produce a known-update notice for previous reviews.

## English and Thai reports

Open **Reports and work summaries**, choose a scope, style, and report language, then prepare a translation workspace.

Fixed labels are localized. Narrative, findings, recommendations, facts, and human comments use distinct translation units. Generate candidates through your configured API or edit them manually. The software uses immutable tokens for recorded source quotations, known source / metadata names, IDs, hashes, and supported numeric / date spans. It does not recognize every entity name or number written out in words; other narrative facts and word-written amounts or dates require human comparison with the source.

Keep every protection token exactly once. Missing units or invalid tokens prevent approval. A human must confirm the complete translation before target-language export. Editing a translation withdraws its approval; changes to known source records or dependencies make it stale. Prepare a fresh translation rather than overwriting the old source snapshot.

DOCX, PDF, HTML, Markdown, and CSV share the confirmed target-language mapping. Original quotations remain in the original language, accompanied by translation provenance. DOCX language and complex-script font settings, HTML language, and Thai font fallbacks are included. Actual fonts and page layout still depend on the target device.

## Data and limits

Alignment uses `clause_alignment` versioned workspace assets; report translations use `report_translation`. No additional SQL migration or external translation service is required. Managed permanent cleanup includes assets that reference the removed contract; separately exported files and backups remain separately managed.

This feature does not promise full-contract translation, automatic legal equivalence, foreign-law coverage, or reproduction of a publisher's multilingual page layout. Linguistic and legal quality require human acceptance.
