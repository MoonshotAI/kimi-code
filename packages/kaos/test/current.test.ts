import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  execWithEnv,
  getCurrentKaos,
  LocalKaos,
  normpath,
  pathClass,
  readLines,
  readText,
  writeText,
} from '#/index';

describe('getCurrentKaos', () => {
  it('returns the LocalKaos bound by the test setup', () => {
    const kaos = getCurrentKaos();
    expect(kaos).toBeInstanceOf(LocalKaos);
    expect(kaos.name).toBe('local');
  });
});

describe('module-level proxy functions', () => {
  it('normpath delegates to the current kaos instance', () => {
    // LocalKaos on posix normalizes '/foo/../bar' to '/bar'
    const result = normpath('/foo/../bar');
    expect(typeof result).toBe('string');
    expect(result.endsWith('bar')).toBe(true);
  });

  it('pathClass returns posix or win32 from the current kaos', () => {
    const result = pathClass();
    expect(result === 'posix' || result === 'win32').toBe(true);
  });

  it('readLines proxies to the current kaos and yields lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kaos-readlines-'));
    try {
      const filePath = join(dir, 'lines.txt');
      await writeText(filePath, 'alpha\nbravo\ncharlie');
      const collected: string[] = [];
      for await (const line of readLines(filePath)) {
        collected.push(line);
      }
      // readLines preserves newline terminators on each line.
      expect(collected).toEqual(['alpha\n', 'bravo\n', 'charlie']);
      expect(collected.join('')).toBe('alpha\nbravo\ncharlie');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writeText accepts an encoding option through the module-level proxy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kaos-writetext-enc-'));
    try {
      const filePath = join(dir, 'enc.txt');
      // Pass a non-default encoding to prove the option flows through the
      // proxy signature without a TypeScript error.
      await writeText(filePath, 'hello-latin1', { encoding: 'latin1' });
      const contents = await readText(filePath, { encoding: 'latin1' });
      expect(contents).toBe('hello-latin1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('execWithEnv proxies to the current kaos', async () => {
    // Use the real LocalKaos to run `env | grep CUSTOM_VAR`
    const proc = await execWithEnv(['sh', '-c', 'echo "$CUSTOM_VAR"'], {
      CUSTOM_VAR: 'proxy_test_value',
      // Preserve PATH so sh can be found
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    });

    const chunks: Buffer[] = [];
    for await (const chunk of proc.stdout) {
      chunks.push(chunk as Buffer);
    }
    const stdout = Buffer.concat(chunks).toString('utf-8').trim();
    await proc.wait();

    expect(stdout).toBe('proxy_test_value');
  });
});
