import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: vi.fn(() => 'C:\\unused') },
}));

import { configureWindowsBashRuntime } from '../../../src/main/server/windows-bash-runtime';

const root = 'C:\\Kimi Code\\resources\\windows-bash';
const exists = () => true;

describe('configureWindowsBashRuntime', () => {
  it('does nothing outside Windows', () => {
    const env: Record<string, string | undefined> = {};
    expect(configureWindowsBashRuntime({ platform: 'darwin', env, fileExists: () => false })).toBeUndefined();
    expect(env).toEqual({});
  });

  it('preserves an explicit shell override and the existing PATH', () => {
    const env = { KIMI_SHELL_PATH: 'D:\\Custom\\bash.exe', Path: 'D:\\Tools' };
    expect(configureWindowsBashRuntime({ platform: 'win32', env, runtimeRoot: root, fileExists: () => false })).toBeUndefined();
    expect(env).toEqual({ KIMI_SHELL_PATH: 'D:\\Custom\\bash.exe', Path: 'D:\\Tools' });
  });

  it('configures the packaged runtime and prepends its tools to the existing PATH key', () => {
    const env: Record<string, string | undefined> = { Path: 'C:\\Windows\\System32' };
    expect(configureWindowsBashRuntime({
      platform: 'win32',
      env,
      packaged: true,
      resourcesPath: 'C:\\Kimi Code\\resources',
      fileExists: exists,
    })).toBe(`${root}\\usr\\bin\\bash.exe`);
    expect(env['KIMI_SHELL_PATH']).toBe(`${root}\\usr\\bin\\bash.exe`);
    expect(env['Path']).toBe(`${root}\\usr\\bin;C:\\Windows\\System32`);
    expect(env).not.toHaveProperty('PATH');
  });

  it('resolves the development runtime below resources-stage', () => {
    const env: Record<string, string | undefined> = {};
    configureWindowsBashRuntime({
      platform: 'win32',
      env,
      packaged: false,
      appPath: 'D:\\Code\\desktop',
      fileExists: exists,
    });
    expect(env['KIMI_SHELL_PATH']).toBe('D:\\Code\\desktop\\resources-stage\\windows-bash\\usr\\bin\\bash.exe');
  });

  it('deduplicates PATH entries case-insensitively and is idempotent', () => {
    const env = { PATH: `${root}\\usr\\bin\\;C:\\Tools` };
    configureWindowsBashRuntime({ platform: 'win32', env, runtimeRoot: root, fileExists: exists });
    expect(env['PATH']).toBe(`${root}\\usr\\bin\\;C:\\Tools`);
    const before = { ...env };
    expect(configureWindowsBashRuntime({ platform: 'win32', env, runtimeRoot: root, fileExists: exists })).toBeUndefined();
    expect(env).toEqual(before);
  });

  it('supports spaces and non-ASCII paths', () => {
    const customRoot = 'D:\\用户目录\\Kimi Code Preview\\resources\\windows-bash';
    const env: Record<string, string | undefined> = {};
    expect(configureWindowsBashRuntime({ platform: 'win32', env, runtimeRoot: customRoot, fileExists: exists }))
      .toBe(`${customRoot}\\usr\\bin\\bash.exe`);
    expect(env['PATH']).toBe(`${customRoot}\\usr\\bin`);
  });

  it('fails clearly when a required runtime file is missing', () => {
    expect(() => configureWindowsBashRuntime({
      platform: 'win32',
      env: {},
      runtimeRoot: root,
      fileExists: (path) => !path.endsWith('cygpath.exe'),
    })).toThrow(`Windows Bash runtime is incomplete at ${root}: missing usr\\bin\\cygpath.exe`);
  });

});
