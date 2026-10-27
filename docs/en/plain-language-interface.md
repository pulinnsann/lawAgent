# Plain-language interface for legal professionals

The customer interface describes tasks in everyday legal-work terms before implementation details. Stable source keys, service actions, license payloads, database records and saved legal content are unchanged.

The presentation catalogue lives in `src/renderer/src/copy-lawyer-{main,setup,license,common}.json`. It provides Chinese, English and Thai wording for 262 labels and explanations. `i18n.tsx` applies these only where the interface already requests a translated label or known notification. Original translations remain available for recognizing older notifications. Contract text, retrieved quotations, user fields, model findings and saved reports are not searched and replaced.

## Wording examples

| Previous source key | Customer-facing Chinese | Intended distinction |
| --- | --- | --- |
| 开始模型审核 | 开始智能审核 | Starts the configured AI review service. |
| 本地规则检查 | 基础条款检查 | Preset local checks; not a full legal opinion. |
| 企业知识库 | 企业参考资料 | Company documents used as references. |
| 本地资料索引 | 本机参考资料 | Preparing and updating searchable company documents. |
| 模型设置 | 智能审核服务 | The customer's own model service connection. |
| 授权与体验许可 | 使用授权 | Activation, device binding and validity dates. |
| 原文块 | 段原文 | A displayed passage, with the original locator preserved. |

Use verbs that explain the next action. Keep uncertainty explicit: a source being retrieved does not establish quotation accuracy, current legal effect or applicability. Basic checks remain separate from AI analysis and qualified human judgment.

## Progressive disclosure

- License application shows the product, version, full device identifier and copy actions first. The raw JSON request and trial-policy detail are collapsed by default. Copying the request retains its exact three-field format; manual-copy fallback opens and selects the hidden request contents.
- Model response formats, compatibility parameters and token limits are under an optional advanced-settings section. Invalid hidden required fields open that section before browser validation, preserving access to corrections. Service address, model name and access key remain available for the initial connection.
- Service-capability checks, connection tool mappings and report verification values remain accessible under optional technical details. Costs and permission restrictions are retained.
- Local basic-check results lead with a short explanation of their limited purpose. The saved result is available under the check record, without changing its contents. Model-generated summaries and saved legal findings remain verbatim.

Token quantities remain service measurement units and are not relabeled as character counts. URLs, protocol requirements, source identifiers, signatures and dates retain their original values. Unknown service errors remain available rather than being guessed at or silently rewritten.

## Validation

The update passed 620 TypeScript/Node tests, including interpolation preservation, legacy-notification resolution, unchanged contract/result content, source-copy transfer and the closed-details manual-copy fallback. The native customer app is rebuilt for macOS arm64. This work changes presentation, not legal analysis, signing policy or professional acceptance requirements.
