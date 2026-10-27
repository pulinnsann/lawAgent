import assert from 'node:assert/strict';
import test from 'node:test';
import type { LicenseState } from '../src/shared/licensing';
import { copyLicenseInfo, createLicenseRequestInfo } from '../src/renderer/src/LicensePanel';

const { checkedIssueInput } = await import(new URL('../tools/license-issuer/desktop/app.js', import.meta.url).href) as {
  checkedIssueInput(value: string, starts: string): { deviceCode: string; startsAt?: string };
};

test('customer copied issuance information can be pasted into the native issuer without changing the device binding', async () => {
  const deviceCode = `LAWDEV1-${'b'.repeat(64)}`;
  const state: LicenseState = { mode: 'required', status: 'missing', canCreate: false, canViewExport: true,
    deviceCode, license: null, checkedAt: '2026-10-27T00:00:00.000Z', message: '' };
  const copied: string[] = [];
  assert.equal(await copyLicenseInfo(createLicenseRequestInfo(state, '0.3.0'), { async writeText(value) { copied.push(value); } }, () => assert.fail('Clipboard unexpectedly unavailable.')), 'copied');
  assert.equal(copied.length, 1);
  assert.deepEqual(checkedIssueInput(copied[0], ''), { deviceCode });
  // A native single-line input removes line breaks from pasted pretty JSON.
  assert.deepEqual(checkedIssueInput(copied[0].replace(/[\r\n]/gu, ''), ''), { deviceCode });
  const upgraded = createLicenseRequestInfo(state, '0.3.1')!;
  assert.deepEqual(checkedIssueInput(upgraded, ''), { deviceCode });
});
