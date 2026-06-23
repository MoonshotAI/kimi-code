import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { clipboard, type ClipboardModule } from './clipboard-native';

type RunCommandOptions = { timeoutMs?: number; env?: NodeJS.ProcessEnv };
type RunCommand = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => { stdout: Buffer; ok: boolean };

const SUPPORTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 2000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

function baseMimeType(raw: string): string {
  return raw.split(';')[0]?.trim().toLowerCase() ?? raw.toLowerCase();
}

function isSupportedImageMimeType(mime: string): boolean {
  const base = baseMimeType(mime);
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(base);
}

function parseTargetList(output: Buffer): string[] {
  return output
    .toString('utf-8')
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function runCommand(
  command: string,
  args: string[],
  options?: RunCommandOptions,
): { stdout: Buffer; ok: boolean } {
  const result = spawnSync(command, args, {
    timeout: options?.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
    env: options?.env,
  });
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, stdout: Buffer.alloc(0) };
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
  return { ok: true, stdout };
}

function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['WAYLAND_DISPLAY']) || env['XDG_SESSION_TYPE'] === 'wayland';
}

function isWSL(env: NodeJS.ProcessEnv): boolean {
  if (env['WSL_DISTRO_NAME'] !== undefined || env['WSLENV'] !== undefined) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf-8'));
  } catch {
    return false;
  }
}

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

async function hasImageViaMacOs(clip: ClipboardModule | null, run: RunCommand): Promise<boolean> {
  if (clip !== null) {
    try {
      if (clip.hasImage()) return true;
    } catch {
      // fall through to osascript
    }
  }
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

    if (wayland || wsl) {
      if (hasImageViaWlPaste(run) || hasImageViaXclip(run)) return true;
    }
    if (wsl && hasImageViaPowerShell(run)) return true;
    if (!wayland) {
      if (hasImageViaXclip(run)) return true;
      try {
        if (await hasImageViaMacOs(clip, run)) return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  if (platform === 'darwin') {
    return hasImageViaMacOs(clip, run);
  }

  if (platform === 'win32') {
    return hasImageViaPowerShell(run);
  }

  return false;
}
