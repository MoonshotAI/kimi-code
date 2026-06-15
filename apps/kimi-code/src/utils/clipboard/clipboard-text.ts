import { spawnSync } from 'node:child_process';

import { clipboard } from './clipboard-native';

function runClipboardCommand(command: string, args: readonly string[], input: string): void {
  const result = spawnSync(command, args, { encoding: 'utf8', input });
  if (result.error) throw result.error;
  if (result.status === 0) return;

  const detail = result.stderr.trim();
  throw new Error(
    detail.length > 0
      ? `${command} exited with code ${String(result.status)}: ${detail}`
      : `${command} exited with code ${String(result.status)}`,
  );
}

async function copyWithPlatformCommand(text: string): Promise<void> {
  const commands =
    process.platform === 'darwin'
      ? [{ command: 'pbcopy', args: [] as string[] }]
      : process.platform === 'win32'
        ? [{ command: 'clip.exe', args: [] as string[] }]
        : [
            { command: 'wl-copy', args: [] as string[] },
            { command: 'xclip', args: ['-selection', 'clipboard'] },
          ];

  let lastError: unknown;
  for (const candidate of commands) {
    try {
      runClipboardCommand(candidate.command, candidate.args, text);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error('No clipboard command is available.');
}

export async function copyTextToClipboard(text: string): Promise<void> {
  const clipboardModule = clipboard;
  if (clipboardModule?.setText !== undefined) {
    try {
      await clipboardModule.setText(text);
      return;
    } catch {
      // Fall back to platform clipboard commands below.
    }
  }

  await copyWithPlatformCommand(text);
}
