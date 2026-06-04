import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  completeAddDirectoryArgument,
  completeRemoveDirectoryArgument,
} from '#/tui/commands/directory-completions';

describe('directory slash command completions', () => {
  it('completes child directories for /add-dir', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-dir-complete-'));
    await mkdir(join(workDir, 'packages'));
    await mkdir(join(workDir, 'src'));

    const result = completeAddDirectoryArgument('pa', workDir);

    expect(result).not.toBeNull();
    expect(result!.map((item) => item.label)).toContain('packages/');
    expect(result!.map((item) => item.description)).toContain(resolve(workDir, 'packages'));
  });

  it('completes existing extra directories for /remove-dir', () => {
    const extra = resolve('/workspace/shared-lib');

    const result = completeRemoveDirectoryArgument('shared', [extra]);

    expect(result).toEqual([
      {
        value: extra,
        label: basename(extra),
        description: extra,
      },
    ]);
  });
});
