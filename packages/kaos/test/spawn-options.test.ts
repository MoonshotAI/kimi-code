import { describe, expect, it } from 'vitest';

import { buildLocalSpawnOptions } from '#/local';

// Regression coverage for the "every command pops an empty console window on
// Windows" bug. `child_process.spawn` defaults `windowsHide` to `false`; on
// Windows that makes Node allocate a *visible* console for each child process
// the agent spawns through `BashTool` → `LocalKaos.exec`/`execWithEnv`. The
// fix is to pass `windowsHide: true`. The flag is only observable on Windows,
// so we assert the spawn options builder directly.

describe('buildLocalSpawnOptions (Windows console-window regression)', () => {
  it('sets windowsHide:true on Windows so commands do not flash a console', () => {
    const options = buildLocalSpawnOptions(true, 'C:\\repo', undefined);
    expect(options.windowsHide).toBe(true);
  });

  it('sets windowsHide:true on POSIX too (it is ignored there, kept unconditional)', () => {
    const options = buildLocalSpawnOptions(false, '/repo', undefined);
    expect(options.windowsHide).toBe(true);
  });

  it('keeps detached platform-conditional (POSIX tree-kill vs Windows taskkill /T)', () => {
    expect(buildLocalSpawnOptions(true, 'C:\\repo', undefined).detached).toBe(false);
    expect(buildLocalSpawnOptions(false, '/repo', undefined).detached).toBe(true);
  });

  it('pipes stdin/stdout/stderr and forwards cwd + env', () => {
    const env = { FOO: 'bar' };
    const options = buildLocalSpawnOptions(false, '/repo', env);
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(options.cwd).toBe('/repo');
    expect(options.env).toBe(env);
  });
});
