import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { windowsPowerShellPath } from '#/app/capability/entries/kimiCu';
import { windowsCuProcessScript } from '#/app/capability/entries/windowsCuProcesses';

it.skipIf(process.platform !== 'win32')('releases a locked plugin directory without stopping unrelated processes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cu-process-test-'));
  const children: ChildProcess[] = [];
  try {
    const locked = path.join(root, 'plugin');
    const other = path.join(root, 'other');
    await mkdir(locked);
    await mkdir(other);
    const executable = path.join(root, 'kimi-cu.exe');
    const unrelatedExecutable = path.join(other, 'kimi-cu.exe');
    await copyFile(process.execPath, executable);
    await copyFile(process.execPath, unrelatedExecutable);
    const body = "process.stdout.write('ready'); setInterval(() => {}, 1000);";
    await writeFile(path.join(locked, 'agent'), body);
    await writeFile(path.join(other, 'agent'), body);
    await writeFile(path.join(other, 'doctor'), body);
    const start = async (exe: string, mode: string, cwd: string): Promise<ChildProcess> => {
      const child = spawn(exe, [mode], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      await once(child.stdout, 'data');
      return child;
    };
    const agent = await start(executable, 'agent', locked);
    const doctor = await start(executable, 'doctor', other);
    const unrelated = await start(unrelatedExecutable, 'agent', other);
    const env = {
      ...process.env,
      KIMI_CU_WINDOWS_EXE: executable,
      KIMI_CU_WINDOWS_HOME: root,
      LOCALAPPDATA: root,
      ProgramFiles: root,
    };
    const manage = async (stop: boolean): Promise<string> => {
      const result = await promisify(execFile)(windowsPowerShellPath(), [
        '-NoProfile', '-NonInteractive', '-Command', windowsCuProcessScript(stop),
      ], { env, windowsHide: true, timeout: 20_000 });
      return result.stdout.trim();
    };
    expect(await manage(false)).toBe('1');
    expect(agent.exitCode).toBeNull();
    await expect(rename(locked, `${locked}-moved`)).rejects.toMatchObject({ code: 'EBUSY' });
    const stopped = once(agent, 'exit');
    expect(await manage(true)).toBe('1');
    await stopped;
    await rename(locked, `${locked}-moved`);
    expect(doctor.exitCode).toBeNull();
    expect(unrelated.exitCode).toBeNull();
    expect(await manage(false)).toBe('0');
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
