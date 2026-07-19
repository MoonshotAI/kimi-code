import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseManifest } from '#/app/plugin/manifest';

describe('plugin manifest parser', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-manifest-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads recursive command entries and valid hooks', async () => {
    await mkdir(join(dir, 'commands', 'frontend'), { recursive: true });
    await writeFile(join(dir, 'commands', 'frontend', 'component.md'), '# Component', 'utf8');
    await writeFile(join(dir, 'commands', 'deploy.md'), '# Deploy', 'utf8');
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'demo',
        commands: ['./commands'],
        hooks: [{ event: 'Stop', command: 'echo stop' }],
      }),
      'utf8',
    );

    const result = await parseManifest(dir);
    const root = await realpath(dir);

    expect(result.manifest?.commands).toEqual([
      { path: join(root, 'commands', 'deploy.md'), name: 'deploy' },
      { path: join(root, 'commands', 'frontend', 'component.md'), name: 'frontend/component' },
    ]);
    expect(result.manifest?.hooks).toEqual([{ event: 'Stop', command: 'echo stop' }]);
    expect(result.diagnostics).toEqual([]);
  });

  it('accepts hook fail_mode in either spelling and normalizes to failMode', async () => {
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'demo',
        hooks: [
          { event: 'PreToolUse', matcher: 'Bash', command: 'echo a', fail_mode: 'closed' },
          { event: 'PreToolUse', matcher: 'Write', command: 'echo b', failMode: 'closed' },
        ],
      }),
      'utf8',
    );

    const result = await parseManifest(dir);

    expect(result.diagnostics).toEqual([]);
    expect(result.manifest?.hooks).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', command: 'echo a', failMode: 'closed' },
      { event: 'PreToolUse', matcher: 'Write', command: 'echo b', failMode: 'closed' },
    ]);
  });

  it('warns on invalid hooks and command paths', async () => {
    await writeFile(
      join(dir, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'demo',
        commands: ['../outside.md'],
        hooks: [{ event: 'Nope', command: 'echo nope' }],
      }),
      'utf8',
    );

    const result = await parseManifest(dir);

    expect(result.manifest?.commands).toBeUndefined();
    expect(result.manifest?.hooks).toBeUndefined();
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      expect.stringContaining('Invalid hook at index 0'),
      '"commands" path must start with "./" (got "../outside.md")',
    ]);
  });
});
