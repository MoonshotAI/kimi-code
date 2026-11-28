import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLOCK_FILE_ENV, HostClockService } from '#/os/backends/node-local/hostClockService';

describe('HostClockService', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function clockFile(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'host-clock-'));
    dirs.push(dir);
    const file = join(dir, 'clock.txt');
    await writeFile(file, content);
    return file;
  }

  it('reads the real time when no clock file is set', () => {
    vi.stubEnv(CLOCK_FILE_ENV, '');
    const before = Date.now();
    const now = new HostClockService().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('reads the time in the clock file on every call, so a test can move it', async () => {
    const file = await clockFile('2030-01-01T12:00:00Z\n');
    vi.stubEnv(CLOCK_FILE_ENV, file);
    const clock = new HostClockService();
    expect(clock.now().toISOString()).toBe('2030-01-01T12:00:00.000Z');
    await writeFile(file, '2030-01-02T12:00:00Z');
    expect(clock.now().toISOString()).toBe('2030-01-02T12:00:00.000Z');
  });

  it('refuses a clock file that does not hold a time instead of falling back to the real time', async () => {
    const file = await clockFile('tomorrow');
    vi.stubEnv(CLOCK_FILE_ENV, file);
    expect(() => new HostClockService().now()).toThrow(`${CLOCK_FILE_ENV} points at ${file}, which does not hold an ISO-8601 time: "tomorrow"`);
  });
});
