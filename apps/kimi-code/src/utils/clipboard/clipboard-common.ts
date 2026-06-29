import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

import type { ClipboardModule } from './clipboard-native';

export type RunCommandOptions = { timeoutMs?: number; env?: NodeJS.ProcessEnv };
export type RunCommand = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => { stdout: Buffer; ok: boolean };
export type RunCommandAsync = (
  command: string,
  args: string[],
  options?: RunCommandOptions,
) => Promise<{ stdout: Buffer; ok: boolean }>;

export const SUPPORTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export const DEFAULT_LIST_TIMEOUT_MS = 1000;
export const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export function baseMimeType(raw: string): string {
  return raw.split(';')[0]?.trim().toLowerCase() ?? raw.toLowerCase();
}

export function isSupportedImageMimeType(mime: string): boolean {
  const base = baseMimeType(mime);
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(base);
}

export function parseTargetList(output: Buffer): string[] {
  return output
    .toString('utf-8')
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function runCommand(
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

/**
 * Non-blocking counterpart of `runCommand`. Used by the clipboard image probe
 * on the startup path so a slow or wedged helper (notably `powershell.exe` on
 * WSL, or a stuck `wl-paste`/`xclip`) cannot freeze the event loop. The child
 * is killed and the promise resolves with `ok: false` once `timeoutMs` elapses
 * or the captured stdout exceeds `DEFAULT_MAX_BUFFER_BYTES`.
 */
export function runCommandAsync(
  command: string,
  args: string[],
  options?: RunCommandOptions,
): Promise<{ stdout: Buffer; ok: boolean }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        env: options?.env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve({ ok: false, stdout: Buffer.alloc(0) });
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    // Marks the promise as settled and clears the timeout. Returns true only for
    // the first caller, so each event handler below resolves at most once.
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };

    timer = setTimeout(() => {
      child.kill();
      if (claim()) resolve({ ok: false, stdout: Buffer.alloc(0) });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > DEFAULT_MAX_BUFFER_BYTES) {
        child.kill();
        if (claim()) resolve({ ok: false, stdout: Buffer.alloc(0) });
        return;
      }
      chunks.push(chunk);
    });

    child.on('error', () => {
      if (claim()) resolve({ ok: false, stdout: Buffer.alloc(0) });
    });

    child.on('close', (code) => {
      if (code !== 0) {
        if (claim()) resolve({ ok: false, stdout: Buffer.alloc(0) });
        return;
      }
      if (claim()) resolve({ ok: true, stdout: Buffer.concat(chunks) });
    });
  });
}

export function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['WAYLAND_DISPLAY']) || env['XDG_SESSION_TYPE'] === 'wayland';
}

export function isWSL(env: NodeJS.ProcessEnv): boolean {
  if (env['WSL_DISTRO_NAME'] !== undefined || env['WSLENV'] !== undefined) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf-8'));
  } catch {
    return false;
  }
}

export function isFileLikeNativeFormat(format: string): boolean {
  const f = format.toLowerCase();
  const base = baseMimeType(format);
  return (
    f.includes('file-url') ||
    f.includes('file url') ||
    f.includes('nsfilenames') ||
    f.includes('com.apple.finder') ||
    base === 'text/uri-list' ||
    base === 'public.url'
  );
}

export function safeAvailableFormats(clip: ClipboardModule | null): string[] {
  if (clip?.availableFormats === undefined) return [];
  try {
    return clip.availableFormats();
  } catch {
    return [];
  }
}
