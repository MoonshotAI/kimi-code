import { mkdtemp, rm, stat as fsStat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Kaos } from '#/kaos';
import { LocalKaos } from '#/local';
import type { KaosProcess } from '#/process';

/**
 * Helper to run a cmd.exe command and collect stdout/stderr/exitCode.
 * Prepends `chcp 65001>nul &` to ensure UTF-8 output.
 */
async function runCmd(
  kaos: Kaos,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc: KaosProcess = await kaos.exec('cmd.exe', '/c', `chcp 65001>nul & ${command}`);

  proc.stdin.end();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const stdoutDone = new Promise<void>((resolve) => {
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    proc.stdout.on('end', () => {
      resolve();
    });
  });

  const stderrDone = new Promise<void>((resolve) => {
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    proc.stderr.on('end', () => {
      resolve();
    });
  });

  const exitCode = await proc.wait();
  await stdoutDone;
  await stderrDone;

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
    stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    exitCode,
  };
}

describe.skipIf(process.platform !== 'win32')('LocalKaos cmd.exe', () => {
  let kaos: Kaos;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'kaos-cmd-'));
    kaos = await LocalKaos.create();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should run a simple command', async () => {
    const { exitCode, stdout, stderr } = await runCmd(kaos, 'echo Hello Windows');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('Hello Windows');
    expect(stderr).toBe('');
  });

  it('should handle command with error exit', async () => {
    // `exit /b 1` must produce neither stdout nor stderr — pinning that
    // keeps us honest if cmd.exe or the chcp prefix ever leaks output.
    const { exitCode, stdout, stderr } = await runCmd(kaos, 'exit /b 1');
    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it('should support command chaining', async () => {
    const { exitCode, stdout, stderr } = await runCmd(kaos, 'echo First&& echo Second');
    expect(exitCode).toBe(0);
    expect(stdout.replaceAll('\r\n', '\n')).toBe('First\nSecond\n');
    expect(stderr).toBe('');
  });

  it('should perform file operations', async () => {
    // Write via kaos (avoids cmd.exe redirect quoting quirks on Windows where
    // Node's auto-escaping of the redirected path breaks the command), then
    // read back via `type` and pin the exact stdout byte-for-byte.
    const filePath = join(tmpDir, 'test_file.txt').replaceAll('/', '\\');

    await kaos.writeText(filePath, 'Test content\r\n');

    const statInfo = await fsStat(filePath);
    expect(statInfo.isFile()).toBe(true);

    // The path contains no spaces (tmpDir is under the 8.3 short-name temp
    // dir), so pass it unquoted: wrapping it in `"…"` would make Node's
    // Windows arg-quoting escape the inner quotes to `\"`, which cmd.exe
    // does not unescape — leaving `type` looking for a literal `\"…\"`.
    const read = await runCmd(kaos, `type ${filePath}`);
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe('Test content\r\n');
    expect(read.stderr).toBe('');
  });
});
