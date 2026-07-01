/**
 * External-editor helper — spawn $VISUAL / $EDITOR (or a configured
 * command) on a temp file seeded with the current editor buffer, then
 * read the edited contents back.
 *
 * Resolution priority:
 *   configured (from Core/SDK defaults or `/editor`) >
 *   $VISUAL > $EDITOR > undefined (caller handles "no editor" toast).
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { quoteShellArg } from '#/utils/shell-quote';

export interface ExternalEditorOptions {
  readonly signal?: AbortSignal;
}

export function resolveEditorCommand(configured?: string | null): string | undefined {
  const candidates = [configured, process.env['VISUAL'], process.env['EDITOR']];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) {
      return c.trim();
    }
  }
  return undefined;
}

/**
 * Launch `command` (tokenised via a shell) against a temp file seeded
 * with `initialText`. Returns the edited contents on success, or
 * `undefined` if the editor exited non-zero / the file disappeared.
 *
 * The command is passed to the system shell (`shell: true`) so users can
 * supply argv-style strings like `code --wait` or `nvim +"set ft=markdown"`.
 */
export async function editInExternalEditor(
  initialText: string,
  command: string,
  options: ExternalEditorOptions = {},
): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-edit-'));
  const file = join(dir, 'prompt.md');
  await writeFile(file, initialText, 'utf-8');
  try {
    if (options.signal?.aborted === true) return undefined;
    const shellCmd = `${command} ${quoteShellArg(file)}`;
    const result = await new Promise<number | 'aborted'>((resolve, reject) => {
      const child = spawn(shellCmd, {
        stdio: 'inherit',
        shell: true,
        signal: options.signal,
      });
      const onAbort = (): void => {
        child.kill();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('exit', (c) => {
        options.signal?.removeEventListener('abort', onAbort);
        resolve(options.signal?.aborted === true ? 'aborted' : c ?? 0);
      });
      child.on('error', (error: unknown) => {
        options.signal?.removeEventListener('abort', onAbort);
        if (options.signal?.aborted === true) {
          resolve('aborted');
          return;
        }
        reject(error);
      });
    });
    if (result === 'aborted' || result !== 0) return undefined;
    return await readFile(file, 'utf-8');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    });
  }
}
