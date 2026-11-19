import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const configPath = require.resolve('../../../electron-builder.config.cjs');

afterEach(() => {
  delete require.cache[configPath];
});

it('packages the app with file:// pages limited to what Chrome allows, and flips no other fuse', () => {
  const config = require(configPath) as { electronFuses?: Record<string, boolean> };
  expect(config.electronFuses).toEqual({ grantFileProtocolExtraPrivileges: false, resetAdHocDarwinSignature: true });
});
