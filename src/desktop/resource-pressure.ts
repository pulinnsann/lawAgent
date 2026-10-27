import type { ResourcePressure } from '../shared/resources';

/** Native pressure is a scheduling hint. Missing readings are never zero RAM. */
export function normalizeNativePressure(value: unknown, now = Date.now()): ResourcePressure {
  const unknown: ResourcePressure = { level: 'unknown', source: 'unavailable', observedAt: new Date(now).toISOString(), availableBytes: null, totalBytes: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
  const input = value as Record<string, unknown>;
  if (typeof input.level !== 'string' || typeof input.source !== 'string') return unknown;
  if (!['normal', 'warning', 'critical', 'unknown'].includes(String(input.level)) || !['macos', 'windows', 'unavailable'].includes(String(input.source))) return unknown;
  const number = (item: unknown) => item === null || item === undefined ? null : typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 ? item : undefined;
  const availableBytes = number(input.availableBytes), totalBytes = number(input.totalBytes);
  if (availableBytes === undefined || totalBytes === undefined || availableBytes !== null && totalBytes !== null && availableBytes > totalBytes) return unknown;
  return { level: input.level as ResourcePressure['level'], source: input.source as ResourcePressure['source'], observedAt: unknown.observedAt, availableBytes, totalBytes };
}
