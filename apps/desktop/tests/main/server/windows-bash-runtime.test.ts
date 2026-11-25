import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { app } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: vi.fn(() => 'C:\\unused'), getPath: vi.fn(), getVersion: () => 'test' },
}));

import { resolveWindowsBashEnv } from '../../../src/main/server/windows-bash-runtime';

const root = 'C:\\Kimi Code\\resources\\windows-bash';
const bin = `${root}\\usr\\bin`;
const exists = () => true;
const standardTemp = win32.join(userInfo().homedir, 'AppData', 'Local', 'Temp');
const stagedRoot = fileURLToPath(new URL('../../../resources-stage/windows-bash/', import.meta.url));

describe('resolveWindowsBashEnv', () => {
  it('does nothing outside Windows', async () => {
    const env = {};
    expect(await resolveWindowsBashEnv({ platform: 'darwin', env, fileExists: () => false })).toBeUndefined();
    expect(env).toEqual({});
  });

  it.each(['KIMI_SHELL_PATH', 'kimi_shell_path'])('preserves an explicit %s and the existing PATH', async (key) => {
    const env = { [key]: 'D:\\Custom\\bash.exe', Path: 'D:\\Tools' };
    expect(await resolveWindowsBashEnv({ platform: 'win32', env, runtimeRoot: root, fileExists: () => false })).toBeUndefined();
    expect(env).toEqual({ [key]: 'D:\\Custom\\bash.exe', Path: 'D:\\Tools' });
  });

  it('uses the supplied Windows profile when HOME and the home drive are absent', async () => {
    const env = Object.freeze({ Path: 'C:\\Windows\\System32', TMP: standardTemp, USERPROFILE: 'D:\\User' });
    expect(await resolveWindowsBashEnv({ platform: 'win32', env, packaged: true, resourcesPath: 'C:\\Kimi Code\\resources', fileExists: exists }))
      .toEqual({ KIMI_SHELL_PATH: `${bin}\\bash.exe`, Path: `${bin};C:\\Windows\\System32`, HOME: 'D:\\User' });
  });

  it('preserves an explicit HOME ahead of Windows home settings', async () => {
    const env = { TMP: standardTemp, HOME: 'D:\\Custom', HOMEDRIVE: 'H:', HOMEPATH: '\\Home', USERPROFILE: 'D:\\User' };
    expect(await resolveWindowsBashEnv({ platform: 'win32', env, runtimeRoot: root, fileExists: exists })).not.toHaveProperty('HOME');
  });

  it('passes a redirected Windows home to Bash without losing Unicode', async () => {
    const env = { TMP: standardTemp, HOMEDRIVE: 'H:', HOMEPATH: '\\我的目录', USERPROFILE: 'D:\\User' };
    const runtime = await resolveWindowsBashEnv({ platform: 'win32', env, runtimeRoot: root, fileExists: exists });
    expect(runtime?.['HOME']).toBe('H:\\我的目录');
  });

  it('resolves the development runtime below resources-stage', async () => {
    const runtime = await resolveWindowsBashEnv({ platform: 'win32', env: {}, packaged: false, appPath: 'D:\\Code\\desktop', fileExists: exists });
    expect(runtime?.KIMI_SHELL_PATH).toBe('D:\\Code\\desktop\\resources-stage\\windows-bash\\usr\\bin\\bash.exe');
  });

  it('keeps one bundled entry first across repeated starts, ignoring case and trailing separators', async () => {
    const env = { PATH: `C:\\Tools;${bin}\\;${bin.toUpperCase()};D:\\Other` };
    const options = { platform: 'win32', env, runtimeRoot: root, fileExists: exists };
    const runtime = await resolveWindowsBashEnv(options);
    expect(runtime?.['PATH']).toBe(`${bin}\\;C:\\Tools;D:\\Other`);
    expect(await resolveWindowsBashEnv(options)).toEqual(runtime);
  });

  it('supports spaces and non-ASCII paths', async () => {
    const customRoot = 'D:\\用户目录\\Kimi Code Preview\\resources\\windows-bash';
    const runtime = await resolveWindowsBashEnv({ platform: 'win32', env: {}, runtimeRoot: customRoot, fileExists: exists });
    expect(runtime).toEqual({ KIMI_SHELL_PATH: `${customRoot}\\usr\\bin\\bash.exe`, PATH: `${customRoot}\\usr\\bin` });
  });

  it('fails clearly when a required runtime file is missing', async () => {
    await expect(resolveWindowsBashEnv({
      platform: 'win32',
      env: {},
      runtimeRoot: root,
      fileExists: (path) => !path.endsWith('cygpath.exe'),
    })).rejects.toThrow(`Windows Bash runtime is incomplete at ${root}: missing usr\\bin\\cygpath.exe`);
  });

  it.runIf(process.platform === 'win32' && existsSync(join(stagedRoot, 'usr', 'bin', 'bash.exe')))(
    'reads Unicode homes and keeps each live Bash on its own Windows temp directory',
    async () => {
      const scratch = await mkdtemp(join(tmpdir(), 'desktop bash mounts '));
      vi.mocked(app.getPath).mockReturnValue(join(scratch, 'user-data'));
      try {
        async function shell(name: string) {
          const home = join(scratch, '用户 ' + name);
          const temp = join(scratch, '临时 ' + name);
          await Promise.all([mkdir(home), mkdir(temp)]);
          await Promise.all([writeFile(join(home, 'marker'), name), writeFile(join(temp, 'marker'), name)]);
          const systemRoot = process.env['SystemRoot']!;
          const env = {
            HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2), USERPROFILE: scratch,
            TMP: temp, TEMP: temp, PATH: join(systemRoot, 'System32'), SystemRoot: systemRoot,
          };
          const runtime = await resolveWindowsBashEnv({ runtimeRoot: stagedRoot, env });
          return { exe: runtime!.KIMI_SHELL_PATH, options: { cwd: scratch, env: { ...env, ...runtime }, windowsHide: true } };
        }
        const [one, two] = await Promise.all([shell('one'), shell('two')]);
        const check = 'cat ~/marker /tmp/marker && t=$(mktemp) && test "$t" -ef "/tmp/${t##*/}" && rm "$t"';
        const first = spawn(one.exe, ['-c', `printf ready > ready; read -r; ${check}`], one.options);
        const output = text(first.stdout);
        const exited = new Promise<number | null>((done, reject) => first.once('error', reject).once('close', done));
        try {
          await expect.poll(() => existsSync(join(scratch, 'ready'))).toBe(true);
          const { stdout } = await promisify(execFile)(two.exe, ['-c', check], two.options);
          expect(stdout).toBe('twotwo');
        } finally {
          first.stdin.end('\n');
          await exited;
        }
        expect(await exited).toBe(0);
        expect(await output).toBe('oneone');
      } finally {
        await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
      }
    }, 90_000,
  );
});
