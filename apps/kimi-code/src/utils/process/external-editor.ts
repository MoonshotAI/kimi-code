import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { quoteShellArg } from '#/utils/shell-quote';

export function resolveEditorCommand(configured?: string | null): string | undefined {
  const candidates = [configured, process.env['VISUAL'], process.env['EDITOR']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.trim();
    }
  }
  return undefined;
}

export async function editInExternalEditor(
  initialText: string,
  command: string,
): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-edit-'));
  const file = join(dir, 'prompt.md');
  await writeFile(file, initialText, 'utf-8');
  try {
    const shellCmd = `${command} ${quoteShellArg(file)}`;
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(shellCmd, {
        stdio: 'inherit',
        shell: true,
      });
      child.on('exit', (c) => { resolve(c ?? 0); });
      child.on('error', reject);
    });
    if (code !== 0) return undefined;
    return await readFile(file, 'utf-8');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

