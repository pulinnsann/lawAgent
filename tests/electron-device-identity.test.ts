import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceCodeFromIdentifier, parseMacOSDeviceCode, parseWindowsDeviceCode, readElectronDeviceCode, type DeviceIdentityCommand } from '../src/main/device-identity';

const identifier = '12345678-9abc-4def-8123-456789abcdef';
const macCode = 'LAWDEV1-84766880ff982b087091e69019225e08f5cba050ea562d3276ab9672f939e0cb';
const windowsCode = 'LAWDEV1-df0eac0d3d79cd4cb0a1e9fe52f4244242d46aaa0949b7754e8a3e6464c681aa';
const macOutput = (uuid = identifier) => `+-o IOPlatformExpertDevice\n  {\n    "IOPlatformUUID" = "${uuid}"\n  }\n`;
const windowsOutput = (uuid = identifier) => `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${uuid}\r\n\r\n`;

test('Electron device codes match the native fixed vectors and normalize only documented UUID forms', () => {
  for (const value of [identifier, identifier.toUpperCase(), ` \t{${identifier.toUpperCase()}}\r\n`, identifier.replaceAll('-', '')]) {
    assert.equal(deviceCodeFromIdentifier('darwin', value), macCode);
    assert.equal(deviceCodeFromIdentifier('win32', value), windowsCode);
  }
  assert.notEqual(macCode, windowsCode);
  assert.match(macCode, /^LAWDEV1-[a-f\d]{64}$/u);
});

test('invalid, missing, placeholder and arbitrary identifiers produce no fallback device binding', () => {
  for (const value of [null, undefined, [], {}, 123, '', '\0', identifier + '\0', '0'.repeat(32), 'f'.repeat(32), '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff', `urn:uuid:${identifier}`, `{${identifier}`, '00:11:22:33:44:55', 'Synthetic computer name', '12345678-9abc-4deg-8123-456789abcdef', `\u00a0${identifier}`, `\v${identifier}`, 'a'.repeat(129)]) {
    assert.equal(deviceCodeFromIdentifier('darwin', value), null);
    assert.equal(deviceCodeFromIdentifier('win32', value), null);
  }
  assert.equal(deviceCodeFromIdentifier('linux', identifier), null);
});

test('ioreg parsing uses one exact property and rejects duplicate, escaped, malformed and oversized output', () => {
  assert.equal(parseMacOSDeviceCode(macOutput()), macCode);
  assert.equal(parseMacOSDeviceCode(macOutput(identifier.toUpperCase()).replaceAll('\n', '\r\n')), macCode);
  for (const value of [macOutput().replace('IOPlatformUUID', 'IOPlatformUUIDBackup'), macOutput() + macOutput(), macOutput(`\\"${identifier}`), macOutput(identifier + '\0'), macOutput('0'.repeat(32)), identifier, macOutput() + '\0', macOutput() + 'x'.repeat(128 * 1024), Buffer.from(macOutput()), null]) {
    assert.equal(parseMacOSDeviceCode(value), null);
  }
});

test('registry parsing requires the exact machine key, value name and REG_SZ type', () => {
  assert.equal(parseWindowsDeviceCode(windowsOutput()), windowsCode);
  assert.equal(parseWindowsDeviceCode(windowsOutput(identifier.toUpperCase()).toLowerCase()), windowsCode);
  for (const value of [windowsOutput().replace('MachineGuid', 'OtherGuid'), windowsOutput().replace('REG_SZ', 'REG_EXPAND_SZ'), windowsOutput().replace('HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER'), windowsOutput().replace('Cryptography', 'OtherKey'), windowsOutput() + windowsOutput(), windowsOutput('f'.repeat(32)), windowsOutput(identifier + '\0'), windowsOutput() + 'x'.repeat(128 * 1024), identifier, null]) {
    assert.equal(parseWindowsDeviceCode(value), null);
  }
});

test('the macOS probe is shell-free, bounded, one-shot and returns only the hashed result', async () => {
  let calls = 0;
  const command: DeviceIdentityCommand = async (file, args, options) => {
    calls++;
    assert.equal(file, '/usr/sbin/ioreg');
    assert.deepEqual(args, ['-rd1', '-c', 'IOPlatformExpertDevice']);
    assert.deepEqual(options, { encoding: 'utf8', timeout: 2000, maxBuffer: 128 * 1024, windowsHide: true, shell: false });
    return { stdout: macOutput() };
  };
  const result = await readElectronDeviceCode({ platform: 'darwin', command });
  assert.equal(result, macCode);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes(identifier));
});

test('the Windows probe reads only the 64-bit machine key using an absolute executable and no shell', async () => {
  let calls = 0;
  const command: DeviceIdentityCommand = async (file, args, options) => {
    calls++;
    assert.match(file, /^[a-z]:\\.*\\System32\\reg\.exe$/iu);
    assert.deepEqual(args, ['QUERY', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 2000);
    assert.equal(options.maxBuffer, 128 * 1024);
    return { stdout: windowsOutput() };
  };
  assert.equal(await readElectronDeviceCode({ platform: 'win32', command }), windowsCode);
  assert.equal(calls, 1);
});

test('failed or unsupported probes return null without propagating raw command data or starting replacements', async () => {
  let calls = 0;
  const command: DeviceIdentityCommand = async () => { calls++; throw new Error(macOutput()); };
  for (const platform of ['darwin', 'win32'] as const) assert.equal(await readElectronDeviceCode({ platform, command }), null);
  assert.equal(calls, 2);
  assert.equal(await readElectronDeviceCode({ platform: 'linux', command }), null);
  assert.equal(calls, 2);
  assert.equal(await readElectronDeviceCode({ platform: 'darwin', command: async () => ({ stdout: 'invalid output' }) }), null);
  assert.equal(await readElectronDeviceCode({ platform: 'win32', command: async () => ({ stdout: windowsOutput() + 'x'.repeat(128 * 1024) }) }), null);
});
