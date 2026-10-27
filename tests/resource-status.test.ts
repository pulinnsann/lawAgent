import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResourceStatusView } from '../src/renderer/src/ResourceStatusPanel';
import { I18nProvider, type InterfaceLocale } from '../src/renderer/src/i18n';
import type { ResourceOperation, ResourceSnapshot } from '../src/shared/resources';

const stamp = '2026-10-27T01:02:03.000Z';
function snapshot(patch: Partial<ResourceSnapshot> = {}): ResourceSnapshot {
  return { policy: 'serial-model-priority', closed: false, active: null, queued: [], maxQueue: 32,
    pressure: { level: 'unknown', effectiveLevel: 'unknown', source: 'unavailable', observedAt: stamp, stale: false, availableBytes: null, totalBytes: null },
    limitations: ['仅串行管理已接入的应用任务，不是应用 RSS、系统内存或客户模型显存的硬性上限。'], ...patch };
}
function render(value: ResourceSnapshot | null, locale: InterfaceLocale = 'en', error = '', loading = false) {
  return renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: createElement(ResourceStatusView, { snapshot: value, error, loading, onRefresh: () => {} }) }));
}

test('resource status distinguishes unavailable and expired system evidence without inventing zero available memory', () => {
  const unavailable = render(snapshot()); assert.match(unavailable, /Memory pressure unknown/); assert.match(unavailable, /System sample unavailable/); assert.doesNotMatch(unavailable, /0 GiB/);
  const stale = render(snapshot({ pressure: { level: 'critical', effectiveLevel: 'unknown', source: 'windows', observedAt: stamp, stale: true, availableBytes: 1024 ** 3, totalBytes: 8 * 1024 ** 3 } }));
  assert.match(stale, /Windows system sample/); assert.match(stale, /sample has expired/); assert.match(stale, /resource-pressure-unknown/); assert.doesNotMatch(stale, /resource-pressure-critical/); assert.match(stale, /1 GiB/); assert.match(stale, /8 GiB/);
  assert.match(stale, /does not enforce a memory limit/);
});

test('resource status shows actual cancellation cleanup and bounded queue reasons without exposing task IDs', () => {
  const value = snapshot({ active: { id: 'opaque-active-id', kind: 'index', operation: 'knowledge_index', queuedAt: stamp, startedAt: stamp, cancellationRequested: true },
    queued: Array.from({ length: 12 }, (_, index) => ({ id: `opaque-queued-${index}`, kind: 'model', operation: 'contract_review', queuedAt: stamp, waitReason: index === 0 ? 'index_cleanup' : 'priority' })) });
  const html = render(value); assert.match(html, /Stopping the task and finishing cleanup/); assert.match(html, /Waiting for document preparation to stop and finish cleanup/); assert.ok(html.includes('Queued tasks: 12 / 32')); assert.match(html, /4 more tasks are waiting/);
  assert.equal((html.match(/<li>/gu) ?? []).length, 8); assert.doesNotMatch(html, /opaque-active-id|opaque-queued-/);
});

test('read errors remain visible and escaped while old pressure is presented as unknown', () => {
  const value = snapshot({ pressure: { level: 'normal', effectiveLevel: 'normal', source: 'macos', observedAt: stamp, stale: false } });
  const html = render(value, 'en', 'Synthetic <script>alert(1)</script> error');
  assert.match(html, /role="alert"/); assert.match(html, /Resource status could not be updated/); assert.match(html, /Synthetic &lt;script&gt;/); assert.doesNotMatch(html, /<script>/); assert.match(html, /resource-pressure-unknown/); assert.doesNotMatch(html, /resource-pressure-normal/);
  assert.match(render(null, 'en', '', true), /Reading resource status/);
});

test('every scheduler operation and wait reason is localized in English and Thai', () => {
  const operations: ResourceOperation[] = ['contract_review', 'local_review', 'contract_generation', 'contract_change', 'reference_translation', 'report_translation', 'clause_alignment', 'model_probe', 'connection_test', 'knowledge_index', 'knowledge_search', 'document_import', 'document_conversion', 'report_render', 'document_export', 'native_pdf', 'maintenance'];
  for (const locale of ['en', 'th'] as const) for (const operation of operations) {
    const value = snapshot({ active: { id: 'opaque', kind: 'heavy', operation, queuedAt: stamp, startedAt: stamp, cancellationRequested: false }, queued: ['active_task', 'index_cleanup', 'memory_critical', 'memory_warning', 'priority'].map((waitReason, index) => ({ id: String(index), operation, kind: 'index', queuedAt: stamp, waitReason: waitReason as ResourceSnapshot['queued'][number]['waitReason'] })) });
    assert.doesNotMatch(render(value, locale), /[\p{Script=Han}]/u, `${locale}: ${operation} left untranslated interface text`);
  }
});
