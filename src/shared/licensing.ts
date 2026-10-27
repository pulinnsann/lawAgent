/** Official distributions require an issuer-signed, single-device trial.
 * Development mode is selected by the trusted application host, never a token. */
export type LicenseMode = 'development' | 'required';
export type LicenseStatus = 'development' | 'missing' | 'active' | 'not_started' | 'expired'
  | 'invalid' | 'device_unavailable' | 'clock_rollback' | 'storage_error';

export interface LicensePayload {
  version: 1;
  product: 'law-agent';
  licenseId: string;
  seat: number;
  deviceCode: string;
  issuedAt: string;
  startsAt: string;
  expiresAt: string;
}
export interface LicenseSummary {
  licenseId: string; seat: number; issuedAt: string; startsAt: string; expiresAt: string;
}
export interface LicenseState {
  mode: LicenseMode;
  status: LicenseStatus;
  canCreate: boolean;
  canViewExport: true;
  deviceCode: string | null;
  license: LicenseSummary | null;
  checkedAt: string;
  message: string;
}
export const LICENSE_TRIAL_MILLISECONDS = 90 * 24 * 60 * 60 * 1000;
export const LICENSE_TOKEN_MAX_BYTES = 4096;
export const LICENSE_DEVICE_PATTERN = /^LAWDEV1-[a-f0-9]{64}$/u;
