import { spawnSync } from 'node:child_process';

import { clipboard } from './clipboard-native';
import { writeClipboardOSC52 } from './clipboard-osc52';

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

/** How the text was delivered: a verified local clipboard tool, or an
 *  unverified OSC 52 escape emitted to the terminal as a last resort. */
export type ClipboardCopyMethod = 'native' | 'osc52';

export async function copyTextToClipboard(text: string): Promise<ClipboardCopyMethod> {
  // OSC 52 travels over stdout to the local terminal emulator, so it reaches
  // the clipboard even over SSH or in containers with no native clipboard
  // tool. Emit it up front; every failure path below can fall back on it.
  const osc52Emitted = writeClipboardOSC52(text);

  const clipboardModule = clipboard;
  if (clipboardModule?.setText !== undefined) {
    try {
      await clipboardModule.setText(text);
      return 'native';
    } catch {
      // Fall back to platform clipboard commands below.
    }
  }

  try {
    await copyWithPlatformCommand(text);
    return 'native';
  } catch (error) {
    // The native clipboard is unreachable (headless server, SSH session,
    // missing wl-copy/xclip …) but the terminal may still have delivered the
    // text via OSC 52; without a terminal there is nothing left to try.
    if (osc52Emitted) return 'osc52';
    throw error;
  }
}
