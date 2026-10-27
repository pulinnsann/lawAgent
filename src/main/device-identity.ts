import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const MAX_OUTPUT_BYTES = 128 * 1024;
const DOMAIN = 'law-agent:device:v1\0';
const UUID = /^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/iu;

function normalizeIdentifier(raw: unknown): string | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 128) return null;
  let value = raw.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, '');
  if (value.startsWith('{') && value.endsWith('}')) value = value.slice(1, -1);
  if (!UUID.test(value)) return null;
  const hex = value.replaceAll('-', '').toLowerCase();
  if (/^(?:0{32}|f{32})$/u.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Same versioned domain, platform and canonical UUID bytes as the Tauri host.
 * Only the derived code leaves this module; raw command output is never logged. */
export function deviceCodeFromIdentifier(platform: NodeJS.Platform, raw: unknown): string | null {
  const normalized = normalizeIdentifier(raw);
  const domainPlatform = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : null;
  if (!normalized || !domainPlatform) return null;
  return `LAWDEV1-${createHash('sha256').update(DOMAIN).update(domainPlatform).update('\0').update(normalized).digest('hex')}`;
}

function validOutput(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= MAX_OUTPUT_BYTES;
}

export function parseMacOSDeviceCode(output: unknown): string | null {
  if (!validOutput(output)) return null;
  const matches = [...output.matchAll(/^[\t ]*"IOPlatformUUID"[\t ]*=[\t ]*"([^"\r\n]*)"[\t ]*\r?$/gmu)];
  return matches.length === 1 ? deviceCodeFromIdentifier('darwin', matches[0][1]) : null;
}

export function parseWindowsDeviceCode(output: unknown): string | null {
  if (!validOutput(output)) return null;
  const headings = [...output.matchAll(/^[\t ]*(HKEY_[^\r\n]*)[\t ]*\r?$/gimu)];
  if (headings.length !== 1 || headings[0][1].trim().toLowerCase() !== 'hkey_local_machine\\software\\microsoft\\cryptography') return null;
  const matches = [...output.matchAll(/^[\t ]*MachineGuid[\t ]+REG_SZ[\t ]+([^\r\n]+?)[\t ]*\r?$/gimu)];
  return matches.length === 1 ? deviceCodeFromIdentifier('win32', matches[0][1]) : null;
}

type ProbeOptions = { encoding: 'utf8'; timeout: number; maxBuffer: number; windowsHide: true; shell: false };
export type DeviceIdentityCommand = (file: string, args: readonly string[], options: ProbeOptions) => Promise<{ stdout: unknown }>;
type ProbeDependencies = { platform?: NodeJS.Platform; command?: DeviceIdentityCommand };

/** A bounded, one-shot compatibility probe for the Electron reference shell.
 * The native Tauri host uses IOKit/registry APIs directly. The optional command
 * dependency is for isolated tests; it is never exposed through renderer IPC. */
export async function readElectronDeviceCode(dependencies: ProbeDependencies = {}): Promise<string | null> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'win32') return null;
  const command: DeviceIdentityCommand = dependencies.command ?? ((file, args, options) => execute(file, [...args], options));
  const options: ProbeOptions = { encoding: 'utf8', timeout: 2000, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false };
  try {
    if (platform === 'darwin') {
      const result = await command('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], options);
      return parseMacOSDeviceCode(result.stdout);
    }
    // Avoid PATH/current-directory executable lookup on Windows. A missing or
    // nonstandard system installation simply leaves activation unavailable.
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    if (!win32.isAbsolute(systemRoot) || systemRoot.includes('\0')) return null;
    const result = await command(win32.join(systemRoot, 'System32', 'reg.exe'), ['QUERY', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], options);
    return parseWindowsDeviceCode(result.stdout);
  } catch {
    // execFile errors can contain raw stdout/stderr. Never forward or log them.
    return null;
  }
}
