import { createRequire } from 'node:module';
import fs from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const configPath = require.resolve('../../../electron-builder.config.cjs');
const zhStringsPath = require.resolve('../../../build/lproj/zh_CN.lproj/InfoPlist.strings');

afterEach(() => {
  delete require.cache[configPath];
});

function usageKeys(): string[] {
  const config = require(configPath) as { mac: { extendInfo: Record<string, string> } };
  return Object.keys(config.mac.extendInfo).filter((key) => key.endsWith('UsageDescription')).sort();
}

describe('macOS usage descriptions', () => {
  it('declares the macOS keys for browser camera, microphone and location access', () => {
    expect(usageKeys()).toEqual(expect.arrayContaining([
      'NSCameraUsageDescription',
      'NSLocationUsageDescription',
      'NSMicrophoneUsageDescription',
    ]));
    expect(usageKeys()).not.toContain('NSLocationWhenInUseUsageDescription');
  });

  it('localizes every usage description in Simplified Chinese', () => {
    const localized = Array.from(fs.readFileSync(zhStringsPath, 'utf8').matchAll(/^"(\w+)"\s*=/gm), (match) => match[1])
      .filter((key): key is string => key !== undefined)
      .sort();
    expect(localized).toEqual(usageKeys());
  });
});
