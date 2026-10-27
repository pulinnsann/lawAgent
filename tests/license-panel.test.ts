import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LICENSE_TOKEN_MAX_BYTES, type LicenseState } from '../src/shared/licensing';
import LicensePanel, { activateLicenseToken, copyLicenseInfo, createLicenseRequestInfo, LicenseStatusView, licenseStatusLabels, readLicenseState, selectLicenseCopyFallback } from '../src/renderer/src/LicensePanel';
import { createPreviewBridge } from '../src/renderer/src/preview-bridge';
import { I18nProvider, translate, type InterfaceLocale } from '../src/renderer/src/i18n';

function translatedHtml(key: string, locale: InterfaceLocale = 'en'): string {
  return renderToStaticMarkup(createElement('span', null, translate(locale, key))).replace(/^<span>|<\/span>$/gu, '');
}
function includesTranslation(html: string, key: string, locale: InterfaceLocale = 'en'): void {
  assert.ok(html.includes(translatedHtml(key, locale)), `Missing translated interface text: ${key}`);
}

const checkedAt = '2026-10-27T00:00:00.000Z';
const deviceCode = `LAWDEV1-${'a'.repeat(64)}`;
function state(patch: Partial<LicenseState> = {}): LicenseState {
  return { mode: 'required', status: 'missing', canCreate: false, canViewExport: true, deviceCode, license: null, checkedAt, message: '', ...patch };
}
function active(): LicenseState {
  return state({ status: 'active', canCreate: true, license: { licenseId: '00000000-0000-4000-8000-000000000001', seat: 37, issuedAt: checkedAt, startsAt: '2026-11-01T00:00:00.000Z', expiresAt: '2027-01-30T00:00:00.000Z' } });
}
function render(value: LicenseState | null, locale: InterfaceLocale = 'en', extras: { error?: string; stateUnavailable?: boolean; loading?: boolean; activating?: boolean; token?: string } = {}) {
  return renderToStaticMarkup(createElement(I18nProvider, { initialLocale: locale, children: createElement(LicenseStatusView, {
    state: value, loading: extras.loading ?? false, activating: extras.activating ?? false, error: extras.error ?? '', stateUnavailable: extras.stateUnavailable, notice: '', token: extras.token ?? '',
    onTokenChange: () => {}, onRefresh: () => {}, onActivate: () => {}, onCopy: () => {},
  }) }));
}

test('expired licensing preserves viewing/export guidance and shows its actual saved validity dates', () => {
  const expired = { ...active(), status: 'expired', canCreate: false } satisfies LicenseState;
  const html = render(expired);
  assert.match(html, /license-status-expired/); includesTranslation(html, '许可已到期');
  includesTranslation(html, '已有资料仍可查看与导出。');
  includesTranslation(html, '没有有效许可时，不能新建导入、审核或合同生成任务。');
  includesTranslation(html, '许可开始时间'); includesTranslation(html, '许可到期时间'); assert.match(html, /2026/); assert.match(html, /2027/);
  assert.match(html, /<dd>37<\/dd>/); assert.match(html, /90 days/);
  includesTranslation(html, '本次体验计划最多签发 100 份许可，每份绑定 1 台设备。'); assert.match(html, /100/);
  includesTranslation(html, '此页面只显示本机许可状态，不显示全部许可的剩余名额。'); assert.doesNotMatch(html, /99 licenses remaining|remaining 99|99\/100/u);
  assert.ok(html.includes(`aria-label="${translatedHtml('本机设备码')}"`)); assert.ok(html.includes(deviceCode));
});

test('all license states and their controls are localized in English and Thai', () => {
  for (const locale of ['en', 'th'] as const) for (const status of Object.keys(licenseStatusLabels) as LicenseState['status'][]) {
    const value = status === 'development' ? state({ mode: 'development', status, canCreate: true, deviceCode: null }) : state({ status, canCreate: status === 'active', license: status === 'active' ? active().license : null });
    const html = render(value, locale);
    assert.doesNotMatch(html, /[\p{Script=Han}]/u, `${locale}: ${status} has untranslated interface text`);
    assert.match(html, /role="status"/); assert.match(html, /Apache-2\.0/);
  }
});

test('development preview cannot pretend to activate a device or display a fictitious device license', () => {
  const html = render(state({ mode: 'development', status: 'development', canCreate: true, deviceCode: null }));
  assert.match(html, /Development and UI preview/); assert.match(html, /do not use real activation codes or create official licenses/);
  assert.doesNotMatch(html, /<textarea|license-activation-token|LAWDEV1-/);
});

test('unavailable license state stays actionable without inventing a device code, and stale active messages are suppressed', () => {
  const loading = render(null, 'en', { loading: true });
  includesTranslation(loading, '正在检查许可…'); assert.match(loading, /aria-busy="true"/);
  includesTranslation(loading, '暂未取得设备码'); assert.match(loading, /type="submit"[^>]*disabled=""/);
  const failed = render({ ...active(), message: '本机试用授权有效。' }, 'en', { error: 'Synthetic <script>unsafe()</script>' });
  assert.match(failed, /license-status-unavailable/); assert.doesNotMatch(failed, /license-status-active/); assert.ok(!failed.includes(translatedHtml('本机试用授权有效。')));
  assert.match(failed, /role="alert"/); assert.match(failed, /&lt;script&gt;/); assert.doesNotMatch(failed, /<script>/);
  includesTranslation(failed, '已有资料仍可查看与导出。');
});

test('a rejected replacement code does not erase the displayed previously verified license', () => {
  const html = render({ ...active(), message: '本机试用授权有效。' }, 'en', { error: 'Replacement code was rejected', stateUnavailable: false });
  assert.match(html, /Replacement code was rejected/); assert.match(html, /license-status-active/);
  assert.doesNotMatch(html, /license-status-unavailable/); includesTranslation(html, '本机试用授权有效。');
  includesTranslation(html, '许可到期时间');
});

test('the license window exposes a named accessible modal, close control and activation help', () => {
  const html = renderToStaticMarkup(createElement(I18nProvider, { initialLocale: 'en', children: createElement(LicensePanel, {
    bridge: createPreviewBridge(), initialState: state(), onClose: () => {}, onStateChange: () => {},
  }) }));
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="license-title"/);
  assert.match(html, /id="license-title"/); assert.ok(html.includes(`aria-label="${translatedHtml('关闭许可窗口')}"`));
  assert.match(html, /for="license-activation-token"/); assert.match(html, /aria-describedby="license-token-help"/);
  assert.match(html, /id="license-token-help"/);
});

test('activation submits only the trimmed code through the dedicated workspace action and preserves the host decision', async () => {
  const calls: unknown[] = [];
  const expected = active();
  const bridge = { async runWorkspaceCommand(input: unknown) { calls.push(input); return structuredClone(expected); } };
  const result = await activateLicenseToken(bridge, '  synthetic-license-code\n');
  assert.deepEqual(calls, [{ action: 'workspace.licenseActivate', payload: { token: 'synthetic-license-code' } }]);
  assert.deepEqual(result, expected);
  assert.equal(result.license?.startsAt, expected.license?.startsAt); assert.equal(result.license?.expiresAt, expected.license?.expiresAt);
});

test('empty or oversized activation input is rejected before any workspace request, including a UTF8 byte overflow', async () => {
  let calls = 0; const bridge = { async runWorkspaceCommand() { calls++; return active(); } };
  await assert.rejects(activateLicenseToken(bridge, ' \n '), /粘贴/u);
  await assert.rejects(activateLicenseToken(bridge, 'x'.repeat(LICENSE_TOKEN_MAX_BYTES + 1)), /过长/u);
  await assert.rejects(activateLicenseToken(bridge, '泰'.repeat(Math.floor(LICENSE_TOKEN_MAX_BYTES / 3) + 1)), /过长/u);
  assert.equal(calls, 0);
});

test('license refresh never grants access from malformed, inconsistent or incomplete host responses', async () => {
  for (const value of [null, {}, { ...state(), mode: 'optional' }, { ...state(), status: 'unrecognized' }, { ...state(), canViewExport: false }, { ...state(), checkedAt: 'invalid' }, { ...state(), deviceCode: 'other-device' }, { ...state(), deviceCode: deviceCode.toUpperCase() }, { ...state(), deviceCode: `${deviceCode}\n` }, { ...state(), deviceCode: deviceCode + 'a' }, { ...state(), status: 'expired', canCreate: true }, { ...active(), license: null }, { ...active(), license: { ...active().license, seat: 101 } }, { ...state(), mode: 'development', status: 'development', canCreate: false }]) {
    await assert.rejects(readLicenseState({ async runWorkspaceCommand() { return value; } }), /许可状态响应无效/u);
  }
  const expected = state({ status: 'expired', license: active().license });
  const calls: unknown[] = [];
  const result = await readLicenseState({ async runWorkspaceCommand(input) { calls.push(input); return expected; } });
  assert.deepEqual(result, expected); assert.equal(result.canCreate, false);
  assert.deepEqual(calls, [{ action: 'workspace.licenseState', payload: {} }]);
});

test('issuance information is an allowlisted request with exact device binding and actual app version', () => {
  const source = { ...active(), activationToken: 'synthetic-secret-token', modelApiKey: 'synthetic-model-secret', rawMachineUuid: '12345678-9abc-4def-8123-456789abcdef', hostname: 'synthetic-host' };
  const info = createLicenseRequestInfo(source, '0.3.0-beta.1+build.2');
  assert.deepEqual(JSON.parse(info!), { product: 'law-agent', appVersion: '0.3.0-beta.1+build.2', deviceCode });
  assert.doesNotMatch(info!, /synthetic-secret|synthetic-model|rawMachine|12345678|hostname|licenseId|expiresAt|seat/u);
  assert.equal(JSON.parse(info!).deviceCode.length, 72);
});

test('no request is fabricated for unavailable, development, missing-device or malformed device information', () => {
  assert.equal(createLicenseRequestInfo(null), null);
  assert.equal(createLicenseRequestInfo(state(), '0.3.0', true), null);
  assert.equal(createLicenseRequestInfo(state({ mode: 'development', status: 'development', canCreate: true })), null);
  assert.equal(createLicenseRequestInfo(state({ deviceCode: null })), null);
  assert.equal(createLicenseRequestInfo(state({ deviceCode: deviceCode + '\n' })), null);
  for (const value of ['', '0.3.0\nInjected: value', 'x'.repeat(65), 'unknown']) assert.equal(createLicenseRequestInfo(state(), value), null);
  assert.ok(createLicenseRequestInfo(state({ status: 'expired', license: active().license }), '0.3.0'));
});

test('copying issuance information writes the complete allowlisted block without fallback selection', async () => {
  const info = createLicenseRequestInfo(state(), '0.3.0');
  const copies: string[] = []; let selected = 0;
  const result = await copyLicenseInfo(info, { async writeText(value) { copies.push(value); } }, () => selected++);
  assert.equal(result, 'copied'); assert.deepEqual(copies, [info]); assert.equal(selected, 0);
});

test('clipboard refusal or absence selects the matching field while unavailable information never invokes copy', async () => {
  let selected = 0, calls = 0;
  assert.equal(await copyLicenseInfo(deviceCode, { async writeText() { calls++; throw new Error('Synthetic clipboard denial.'); } }, () => selected++), 'selected');
  assert.equal(await copyLicenseInfo(createLicenseRequestInfo(state()), undefined, () => selected++), 'selected');
  assert.equal(await copyLicenseInfo(null, { async writeText() { calls++; } }, () => selected++), 'unavailable');
  assert.equal(calls, 1); assert.equal(selected, 2);
});

test('issuance card is prominent and fully localized, with a wrapping device code and separate full information copy', () => {
  for (const locale of ['en', 'th'] as const) {
    const html = render(state(), locale);
    assert.doesNotMatch(html, /[\p{Script=Han}]/u);
    assert.match(html, /id="license-device-title"/);
    assert.match(html, /<textarea[^>]*id="license-device-code"[^>]*readonly=""/iu);
    assert.match(html, /<textarea[^>]*id="license-request-info"[^>]*readonly=""/iu);
    assert.ok(html.indexOf('license-device-title') < html.indexOf('license-access-note'));
    assert.match(html, /&quot;product&quot;: &quot;law-agent&quot;/u);
    assert.equal((html.match(new RegExp(deviceCode, 'gu')) ?? []).length, 2);
  }
  const html = render(state(), 'en');
  includesTranslation(html, '签发所需本机信息'); includesTranslation(html, '复制签发信息'); includesTranslation(html, '复制设备码');
});

test('stale information is hidden and copy actions are disabled while the last license state is unavailable', () => {
  const html = render(active(), 'en', { error: 'Synthetic unavailable status', stateUnavailable: true });
  assert.doesNotMatch(html, /LAWDEV1-|&quot;product&quot;/u);
  for (const key of ['复制设备码', '复制签发信息']) {
    const label = translatedHtml(key);
    const button = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/gu)].map(match => match[0]).find(value => value.includes(label));
    assert.ok(button); assert.match(button!, /disabled=""/u);
  }
});

test('the browser preview reports development state and refuses real activation without modifying its sample data', async () => {
  const bridge = createPreviewBridge();
  const before = await bridge.getState(); const license = await readLicenseState(bridge);
  assert.equal(license.mode, 'development'); assert.equal(license.status, 'development'); assert.equal(license.canCreate, true);
  assert.equal(license.deviceCode, null); assert.equal(license.license, null); assert.equal(license.canViewExport, true);
  await assert.rejects(activateLicenseToken(bridge, 'synthetic-official-token'), /不使用真实激活码/u);
  assert.deepEqual(await bridge.getState(), before);
});


test('raw request and trial details are closed by default while the copy request action remains visible', () => {
  const html = render(state());
  const request = html.match(/<details id="license-request-details"[^>]*>[\s\S]*?<\/details>/u)?.[0];
  assert.ok(request); assert.doesNotMatch(request, /<details[^>]*\sopen(?:=|\s|>)/u);
  assert.match(request, /id="license-request-info"/u);
  includesTranslation(request, '查看申请信息内容（可选）');
  const copy = html.indexOf(translatedHtml('复制签发信息'));
  assert.ok(copy >= 0 && copy < html.indexOf('<details id="license-request-details"'));
  const plan = html.match(/<details class="license-plan"[^>]*>[\s\S]*?<\/details>/u)?.[0];
  assert.ok(plan); assert.doesNotMatch(plan, /<details[^>]*\sopen(?:=|\s|>)/u);
  assert.match(plan, /90 days|90/); assert.match(plan, /100/); assert.match(plan, /Apache-2\.0/);
});

test('manual request copying reveals the optional contents before focusing and selecting it', async () => {
  const events: string[] = []; let opened = false;
  const details = { get open() { return opened; }, set open(value: boolean) { opened = value; events.push('open'); } };
  const requestField = { focus() { assert.equal(opened, true); events.push('focus'); }, select() { assert.equal(opened, true); events.push('select'); } };
  const deviceField = { focus() { events.push('device-focus'); }, select() { events.push('device-select'); } };
  const container = { querySelector(selector: string) { return selector === '#license-request-details' ? details : selector === '#license-request-info' ? requestField : deviceField; } } as unknown as Pick<HTMLElement, 'querySelector'>;
  assert.equal(await copyLicenseInfo(createLicenseRequestInfo(state()), undefined, () => selectLicenseCopyFallback(container, 'request')), 'selected');
  assert.deepEqual(events, ['open', 'focus', 'select']);
  events.length = 0; opened = false;
  selectLicenseCopyFallback(container, 'device');
  assert.deepEqual(events, ['device-focus', 'device-select']); assert.equal(opened, false);
});
