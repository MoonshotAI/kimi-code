import {
  DEFAULT_LIST_TIMEOUT_MS,
  isSupportedImageMimeType,
  isWaylandSession,
  isWSL,
  parseTargetList,
  runCommand,
  type RunCommand,
} from './clipboard-common';
import { clipboard, type ClipboardModule } from './clipboard-native';

const DEFAULT_POWERSHELL_TIMEOUT_MS = 2000;

function hasImageViaWlPaste(run: RunCommand): boolean {
  const list = run('wl-paste', ['--list-types'], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
  if (!list.ok) return false;
  return parseTargetList(list.stdout).some((t) => isSupportedImageMimeType(t));
}

function hasImageViaXclip(run: RunCommand): boolean {
  const targets = run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });
  if (!targets.ok) return false;
  return parseTargetList(targets.stdout).some((t) => isSupportedImageMimeType(t));
}

function hasImageViaPowerShell(run: RunCommand): boolean {
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); ($img -ne $null)";
  const result = run('powershell.exe', ['-NoProfile', '-Command', script], {
    timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
  });
  if (!result.ok) return false;
  const output = result.stdout.toString('utf-8').trim().toLowerCase();
  return output === 'true';
}

async function hasImageViaNative(clip: ClipboardModule | null): Promise<boolean> {
  if (clip === null) return false;
  try {
    return clip.hasImage();
  } catch {
    return false;
  }
}

function hasImageViaMacOsOsascript(run: RunCommand): boolean {
  const result = run('osascript', ['-e', 'the clipboard as «class PNGf»'], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });
  return result.ok;
}

export async function clipboardHasImage(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  clipboard?: ClipboardModule | null;
  runCommand?: RunCommand;
}): Promise<boolean> {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const clip = options?.clipboard ?? clipboard;
  const run = options?.runCommand ?? runCommand;

  if (env['TERMUX_VERSION'] !== undefined) return false;

  if (platform === 'linux') {
    const wayland = isWaylandSession(env);
    const wsl = isWSL(env);
    const xclipHasImage = !wayland && hasImageViaXclip(run);

    if (wayland || wsl) {
      if (hasImageViaWlPaste(run) || xclipHasImage) return true;
    }
    if (wsl && hasImageViaPowerShell(run)) return true;
    if (!wayland) {
      if (xclipHasImage) return true;
      if (await hasImageViaNative(clip)) return true;
    }
    return false;
  }

  if (platform === 'darwin') {
    if (await hasImageViaNative(clip)) return true;
    return hasImageViaMacOsOsascript(run);
  }

  if (platform === 'win32') {
    if (await hasImageViaNative(clip)) return true;
    return hasImageViaPowerShell(run);
  }

  return false;
}
