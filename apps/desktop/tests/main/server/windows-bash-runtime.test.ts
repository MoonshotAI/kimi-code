import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: vi.fn(() => 'C:\\unused') },
}));

import { resolveWindowsBashEnv } from '../../../src/main/server/windows-bash-runtime';

const root = 'C:\\Kimi Code\\resources\\windows-bash';
const bin = `${root}\\usr\\bin`;
const exists = () => true;

describe('resolveWindowsBashEnv', () => {
  it('does nothing outside Windows', () => {
    const env = {};
    expect(resolveWindowsBashEnv({ platform: 'darwin', env, fileExists: () => false })).toBeUndefined();
    expect(env).toEqual({});
  });

  it.each(['KIMI_SHELL_PATH', 'kimi_shell_path'])('preserves an explicit %s and the existing PATH', (key) => {
    const env = { [key]: 'D:\\Custom\\bash.exe', Path: 'D:\\Tools' };
    expect(resolveWindowsBashEnv({ platform: 'win32', env, runtimeRoot: root, fileExists: () => false })).toBeUndefined();
    expect(env).toEqual({ [key]: 'D:\\Custom\\bash.exe', Path: 'D:\\Tools' });
  });

  it('returns only the private shell and search path, without modifying the parent environment', () => {
    const env = Object.freeze({ Path: 'C:\\Windows\\System32', USERPROFILE: 'D:\\User' });
    expect(resolveWindowsBashEnv({ platform: 'win32', env, packaged: true, resourcesPath: 'C:\\Kimi Code\\resources', fileExists: exists }))
      .toEqual({ KIMI_SHELL_PATH: `${bin}\\bash.exe`, Path: `${bin};C:\\Windows\\System32` });
  });

  it('resolves the development runtime below resources-stage', () => {
    const runtime = resolveWindowsBashEnv({ platform: 'win32', env: {}, packaged: false, appPath: 'D:\\Code\\desktop', fileExists: exists });
    expect(runtime?.KIMI_SHELL_PATH).toBe('D:\\Code\\desktop\\resources-stage\\windows-bash\\usr\\bin\\bash.exe');
  });

  it('keeps one bundled entry first across repeated starts, ignoring case and trailing separators', () => {
    const env = { PATH: `C:\\Tools;${bin}\\;${bin.toUpperCase()};D:\\Other` };
    const options = { platform: 'win32', env, runtimeRoot: root, fileExists: exists };
    const runtime = resolveWindowsBashEnv(options);
    expect(runtime?.['PATH']).toBe(`${bin}\\;C:\\Tools;D:\\Other`);
    expect(resolveWindowsBashEnv(options)).toEqual(runtime);
  });

  it('supports spaces and non-ASCII paths', () => {
    const customRoot = 'D:\\用户目录\\Kimi Code Preview\\resources\\windows-bash';
    const runtime = resolveWindowsBashEnv({ platform: 'win32', env: {}, runtimeRoot: customRoot, fileExists: exists });
    expect(runtime).toEqual({ KIMI_SHELL_PATH: `${customRoot}\\usr\\bin\\bash.exe`, PATH: `${customRoot}\\usr\\bin` });
  });

  it('fails clearly when a required runtime file is missing', () => {
    expect(() => resolveWindowsBashEnv({
      platform: 'win32',
      env: {},
      runtimeRoot: root,
      fileExists: (path) => !path.endsWith('cygpath.exe'),
    })).toThrow(`Windows Bash runtime is incomplete at ${root}: missing usr\\bin\\cygpath.exe`);
  });
});
