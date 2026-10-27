import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DiagnosticsPanel, { DiagnosticsContentView, requestDiagnosticsExport, type DiagnosticsExportFeedback, type DiagnosticsExportResult } from '../src/renderer/src/DiagnosticsPanel';
import { I18nProvider, type InterfaceLocale } from '../src/renderer/src/i18n';
import { createPreviewBridge } from '../src/renderer/src/preview-bridge';

function render(feedback: DiagnosticsExportFeedback = 'idle', locale: InterfaceLocale = 'en', isPreview = false, result: DiagnosticsExportResult | null = null) {
  return renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: createElement(DiagnosticsContentView, { isPreview, feedback, result, onExport: () => {} }) }));
}

test('diagnostics export uses the parent-side action without requiring license or Core state and returns only confirmed save metadata', async () => {
  const calls: unknown[] = [];
  const saved = await requestDiagnosticsExport({ async runWorkspaceCommand(input) {
    calls.push(input); return { path: '/synthetic/export/log.json', fileName: 'log.json', bytes: 100, activationToken: 'must-not-be-returned', contract: 'must-not-be-returned' };
  } });
  assert.deepEqual(calls, [{ action: 'maintenance.exportDiagnostics', payload: {} }]);
  assert.deepEqual(saved, { path: '/synthetic/export/log.json', fileName: 'log.json', bytes: 100 });
});

test('cancelling the native picker is distinct from a saved file', async () => {
  assert.equal(await requestDiagnosticsExport({ async runWorkspaceCommand() { return null; } }), null);
  const html = render('cancelled', 'en', false, { path: '/synthetic/old-result.json' });
  assert.match(html, /Saving was cancelled/); assert.match(html, /No new log file was created/);
  assert.doesNotMatch(html, /The log was saved|old-result|diagnostics-feedback success/);
});

test('preview export is rejected before invoking a native bridge and the preview button remains disabled', async () => {
  let called = false;
  await assert.rejects(requestDiagnosticsExport({ async runWorkspaceCommand() { called = true; return { path: '/synthetic/file.json' }; } }, true), /已安装的软件/u);
  assert.equal(called, false);
  const html = render('idle', 'en', true);
  assert.match(html, /This is a preview/); assert.match(html, /<button[^>]*disabled=""/u);
  assert.doesNotMatch(html, /The log was saved/);
});

test('malformed native results never invent a success path or echo returned content', async () => {
  for (const value of [undefined, false, '', [], {}, { path: '' }, { path: 'relative.json' }, { path: '/secret\u0000/file' }, { path: '/' + 'a'.repeat(32_768) }, { path: '/synthetic/file.json', bytes: -1 }, { path: '/synthetic/file.json', bytes: 0.5 }, { path: '/synthetic/file.json', fileName: '' }]) {
    await assert.rejects(requestDiagnosticsExport({ async runWorkspaceCommand() { return value; } }), error => {
      assert.match((error as Error).message, /日志未能保存/u);
      assert.doesNotMatch((error as Error).message, /secret|relative/u); return true;
    });
  }
});

test('confirmed macOS, Windows and network-save paths are retained without rewriting the selected location', async () => {
  for (const path of ['/synthetic/律师工作/问题日志.json', 'C:\\Users\\Synthetic\\问题日志.json', '\\\\server\\private\\problem-log.json']) {
    assert.deepEqual(await requestDiagnosticsExport({ async runWorkspaceCommand() { return { path }; } }), { path });
  }
});

test('a failed export can be retried and failure guidance exposes no raw connector errors', async () => {
  let count = 0;
  const bridge = { async runWorkspaceCommand() { if (++count === 1) throw new Error('synthetic-service-key-and-contract-text'); return { path: '/synthetic/retry.json', bytes: 1 }; } };
  await assert.rejects(requestDiagnosticsExport(bridge));
  assert.deepEqual(await requestDiagnosticsExport(bridge), { path: '/synthetic/retry.json', bytes: 1 });
  const html = render('failed');
  assert.match(html, /role="alert"/); assert.match(html, /Try another location/);
  assert.doesNotMatch(html, /synthetic-service-key|contract-text|The log was saved|disabled=""/);
});

test('saving feedback disables duplicate export and describes the still-cancellable system dialog', () => {
  const html = render('saving');
  assert.match(html, /aria-busy="true"/); assert.match(html, /<button[^>]*disabled=""/u);
  assert.match(html, /Saving log/); assert.match(html, /Choose a location in the save window, or cancel/);
  assert.doesNotMatch(html, /The log was saved/);
});

test('only a confirmed save shows the filename and a safely escaped optional location', () => {
  const html = render('saved', 'en', false, { path: '/synthetic/<script>unsafe</script>.json', fileName: '<b>problem</b>.json', bytes: 100 });
  assert.match(html, /The log was saved/); assert.match(html, /&lt;b&gt;problem&lt;\/b&gt;\.json/);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>|<b>problem/);
  assert.match(html, /<details><summary>View saved location/);
  assert.doesNotMatch(render('saved', 'en', false, null), /The log was saved/);
});

test('the diagnostics panel has a named modal and explicit close control without a license prerequisite', () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en', children: createElement(DiagnosticsPanel, { bridge: createPreviewBridge(), isPreview: false, onClose: () => {} }) }));
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="diagnostics-title"/);
  assert.match(html, /aria-label="Close problem log window"/); assert.match(html, /Save log file/);
  assert.match(html, /even if access has expired/); assert.doesNotMatch(html, /Activate a valid license|disabled=""/);
});

test('diagnostics help and every state are fully localized with explicit local-only privacy guidance', () => {
  for (const locale of ['en', 'th'] as const) {
    for (const feedback of ['idle', 'saving', 'cancelled', 'failed', 'saved'] as const) {
      const html = render(feedback, locale, false, { path: '/synthetic/problem.json' });
      assert.doesNotMatch(html, /[\p{Script=Han}]/u, `${locale}: ${feedback}`);
    }
    assert.doesNotMatch(render('idle', locale, true), /[\p{Script=Han}]/u);
  }
  const html = render();
  assert.match(html, /does not include contract text, activation codes or service keys/);
  assert.match(html, /not uploaded automatically/); assert.match(html, /You decide whether to share it/);
});
