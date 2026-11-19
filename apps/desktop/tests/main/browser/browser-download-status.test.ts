import { describe, expect, it } from 'vitest';
import {
  downloadTimeLeftMs,
  downloadTimeLeftParts,
  formatDownloadBytes,
} from '../../../src/shared/browser-download-status';

describe('download time left', () => {
  it('divides the remaining bytes by the current speed', () => {
    expect(downloadTimeLeftMs(25, 125, 50)).toBe(2_000);
    expect(downloadTimeLeftMs(125, 125, 50)).toBe(0);
  });

  it('is unknown without a total size or a positive speed', () => {
    expect(downloadTimeLeftMs(25, 0, 50)).toBeUndefined();
    expect(downloadTimeLeftMs(25, 125, 0)).toBeUndefined();
    expect(downloadTimeLeftMs(25, 125, undefined)).toBeUndefined();
    expect(downloadTimeLeftMs(25, 125, Number.NaN)).toBeUndefined();
    expect(downloadTimeLeftMs(200, 125, 50)).toBeUndefined();
  });

  it('rounds to the largest whole unit the way Chrome words time left', () => {
    expect(downloadTimeLeftParts(400)).toEqual({ unit: 'seconds', count: 0 });
    expect(downloadTimeLeftParts(53_400)).toEqual({ unit: 'seconds', count: 53 });
    expect(downloadTimeLeftParts(59_600)).toEqual({ unit: 'minutes', count: 1 });
    expect(downloadTimeLeftParts(150_000)).toEqual({ unit: 'minutes', count: 3 });
    expect(downloadTimeLeftParts(59.6 * 60_000)).toEqual({ unit: 'hours', count: 1 });
    expect(downloadTimeLeftParts(5 * 3_600_000)).toEqual({ unit: 'hours', count: 5 });
    expect(downloadTimeLeftParts(23.6 * 3_600_000)).toEqual({ unit: 'days', count: 1 });
    expect(downloadTimeLeftParts(-5)).toEqual({ unit: 'seconds', count: 0 });
  });
});

describe('download sizes', () => {
  it('uses binary units up to TB with one decimal below 100 as Chrome does', () => {
    expect(formatDownloadBytes(0)).toBe('0 B');
    expect(formatDownloadBytes(1_023)).toBe('1023 B');
    expect(formatDownloadBytes(1_024)).toBe('1.0 KB');
    expect(formatDownloadBytes(150 * 1_024)).toBe('150 KB');
    expect(formatDownloadBytes(7_444_889)).toBe('7.1 MB');
    expect(formatDownloadBytes(181 * 1_048_576)).toBe('181 MB');
    expect(formatDownloadBytes(1_288_490_189)).toBe('1.2 GB');
    expect(formatDownloadBytes(2_147_483_648)).toBe('2.0 GB');
    expect(formatDownloadBytes(3 * 1_024 ** 4)).toBe('3.0 TB');
    expect(formatDownloadBytes(2_048 * 1_024 ** 4)).toBe('2048 TB');
    expect(formatDownloadBytes(-5)).toBe('0 B');
  });
});
