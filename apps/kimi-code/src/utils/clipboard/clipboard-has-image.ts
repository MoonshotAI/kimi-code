import {
  DEFAULT_LIST_TIMEOUT_MS,
  isFileLikeNativeFormat,
  isSupportedImageMimeType,
  isWaylandSession,
  isWSL,
  parseTargetList,
  runCommandAsync,
  safeAvailableFormats,
  type RunCommandAsync,
} from './clipboard-common';
import { clipboard, type ClipboardModule } from './clipboard-native';

const DEFAULT_POWERSHELL_TIMEOUT_MS = 2000;

async function hasImageViaWlPaste(run: RunCommandAsync): Promise<boolean> {
  const list = await run('wl-paste', ['--list-types'], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
  if (!list.ok) return false;
  return parseTargetList(list.stdout).some((t) => isSupportedImageMimeType(t));
}

async function hasImageViaXclip(run: RunCommandAsync): Promise<boolean> {
  const targets = await run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });
  if (!targets.ok) return false;
  return parseTargetList(targets.stdout).some((t) => isSupportedImageMimeType(t));
}

async function hasImageViaPowerShell(run: RunCommandAsync): Promise<boolean> {
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); ($img -ne $null)";
  const result = await run('powershell.exe', ['-NoProfile', '-Command', script], {
    timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
  });
  if (!result.ok) return false;
  const output = result.stdout.toString('utf-8').trim().toLowerCase();
  return output === 'true';
}

async function hasImageViaNative(clip: ClipboardModule | null): Promise<boolean> {
  if (clip === null) return false;

  // Finder exposes file icons/thumbnails as image data when a non-image file
  // is copied. Treat file-like clipboard contents as "not a pasteable image"
  // to match the read path in clipboard-image.ts.
  const formats = safeAvailableFormats(clip);
  if (formats.some(isFileLikeNativeFormat)) return false;

  try {
    return clip.hasImage();
  } catch {
    return false;
  }
}

export async function clipboardHasImage(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  clipboard?: ClipboardModule | null;
  runCommand?: RunCommandAsync;
}): Promise<boolean> {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const clip = options?.clipboard ?? clipboard;
  const run = options?.runCommand ?? runCommandAsync;

  if (env['TERMUX_VERSION'] !== undefined) return false;

  if (platform === 'linux') {
    const wayland = isWaylandSession(env);
    const wsl = isWSL(env);

    let xclipResult: Promise<boolean> | undefined;
    const xclipHasImage = (): Promise<boolean> => {
      xclipResult ??= hasImageViaXclip(run);
      return xclipResult;
    };

    if (wayland || wsl) {
      if (await hasImageViaWlPaste(run)) return true;
      if (await xclipHasImage()) return true;
    }
    if (wsl && (await hasImageViaPowerShell(run))) return true;
    if (!wayland) {
      if (await xclipHasImage()) return true;
      if (await hasImageViaNative(clip)) return true;
    }
    return false;
  }

  if (platform === 'darwin') {
    return hasImageViaNative(clip);
  }

  if (platform === 'win32') {
    return hasImageViaNative(clip);
  }

  return false;
}
