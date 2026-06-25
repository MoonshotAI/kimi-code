/**
 * Read media from the system clipboard with graceful platform fallbacks.
 *
 * kimi-core's LLM pipeline only accepts PNG/JPEG/GIF/WebP, and the
 * clipboard sources we query already emit those formats on supported
 * platforms — so we deliberately do not include a BMP→PNG converter.
 *
 * Lookup order:
 *   macOS file clipboard       -> osascript/AppKit file URLs
 *   macOS / Windows            -> native `@mariozechner/clipboard`
 *   Linux Wayland              -> wl-paste
 *   Linux X11                  -> xclip
 *   WSL (image not on Linux cb) -> PowerShell fallback via wslpath
 *
 * Returns `null` when no supported media is available, the format isn't
 * supported, or every fallback fails.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseImageMeta } from '#/utils/image/image-mime';

import {
  DEFAULT_LIST_TIMEOUT_MS,
  SUPPORTED_IMAGE_MIME_TYPES,
  baseMimeType,
  isFileLikeNativeFormat,
  isSupportedImageMimeType,
  isWaylandSession,
  isWSL,
  parseTargetList,
  runCommand as runCommandBase,
  safeAvailableFormats,
  type RunCommand,
  type RunCommandOptions,
} from './clipboard-common';
import { clipboard, type ClipboardModule } from './clipboard-native';

export interface ClipboardImage {
  kind: 'image';
  bytes: Uint8Array;
  mimeType: string;
}

export interface ClipboardVideo {
  kind: 'video';
  mimeType: string;
  filename: string;
  sourcePath: string;
}

export type ClipboardMedia = ClipboardImage | ClipboardVideo;

export class ClipboardMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClipboardMediaError';
  }
}

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const VIDEO_MIME_BY_SUFFIX: Readonly<Record<string, string>> = Object.freeze({
  '.mp4': 'video/mp4',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
});

const DEFAULT_READ_TIMEOUT_MS = 3000;
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;

const MACOS_FILE_PATH_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('Foundation');

const out = [];
const pb = $.NSPasteboard.generalPasteboard;
if (String(pb) !== '[id nil]') {
  try {
    const options = $.NSMutableDictionary.dictionary;
    options.setObjectForKey($.NSNumber.numberWithBool(true), $.NSPasteboardURLReadingFileURLsOnlyKey);
    const urls = pb.readObjectsForClassesOptions([$.NSURL], options);
    const count = urls ? urls.count : 0;
    for (let i = 0; i < count; i++) {
      const value = urls.objectAtIndex(i).path;
      const path = value ? ObjC.unwrap(value) : '';
      if (path) out.push(path);
    }
  } catch (error) {}

  if (out.length === 0) {
    try {
      const files = ObjC.deepUnwrap(pb.propertyListForType('NSFilenamesPboardType'));
      if (Array.isArray(files)) {
        for (const path of files) {
          if (path) out.push(String(path));
        }
      } else if (files) {
        out.push(String(files));
      }
    } catch (error) {}
  }
}
out.join('\n');
`.trim();

function selectPreferredImageMimeType(candidates: string[]): string | null {
  const normalized = candidates
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((raw) => ({ raw, base: baseMimeType(raw) }));

  for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
    const match = normalized.find((t) => t.base === preferred);
    if (match !== undefined) return match.raw;
  }
  const anyImage = normalized.find((t) => t.base.startsWith('image/'));
  return anyImage?.raw ?? null;
}

function videoMimeFromPath(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const suffix = path.slice(dot).toLowerCase();
  return VIDEO_MIME_BY_SUFFIX[suffix] ?? null;
}

function parseClipboardPaths(text: string): string[] {
  return splitClipboardPathLines(text)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      if (line.startsWith('file://')) {
        try {
          return fileURLToPath(line);
        } catch {
          return '';
        }
      }
      return line;
    })
    .filter((line) => line.length > 0 && isAbsolute(line));
}

function splitClipboardPathLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\r' || char === '\n' || text.codePointAt(i) === 0) {
      lines.push(text.slice(start, i));
      start = i + 1;
    }
  }
  lines.push(text.slice(start));
  return lines;
}

function readImagePath(path: string): ClipboardImage | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;

  const meta = parseImageMeta(bytes);
  if (meta === null) return null;
  return { kind: 'image', bytes: new Uint8Array(bytes), mimeType: meta.mime };
}

function readVideoPath(path: string): ClipboardVideo | null {
  const mimeType = videoMimeFromPath(path);
  if (mimeType === null) return null;
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_VIDEO_BYTES) {
    throw new ClipboardMediaError(
      `Video is ${(stat.size / 1024 / 1024).toFixed(1)} MB; maximum supported size is 100 MB.`,
    );
  }
  return {
    kind: 'video',
    mimeType,
    filename: basename(path),
    sourcePath: path,
  };
}

function readMediaPath(path: string): ClipboardMedia | null {
  // Video files are never opened as images.
  const video = readVideoPath(path);
  if (video !== null) return video;
  return readImagePath(path);
}

function readMediaFromPaths(paths: readonly string[]): ClipboardMedia | null {
  for (const path of paths) {
    const media = readMediaPath(path);
    if (media !== null) return media;
  }
  return null;
}

function readMediaFromText(text: string): ClipboardMedia | null {
  return readMediaFromPaths(parseClipboardPaths(text));
}

function runCommand(command: string, args: string[], options?: RunCommandOptions): { stdout: Buffer; ok: boolean } {
  return runCommandBase(command, args, {
    timeoutMs: options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    env: options?.env,
  });
}

function readClipboardFileMediaViaWlPaste(): ClipboardMedia | null {
  const list = runCommand('wl-paste', ['--list-types'], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });
  if (!list.ok) return null;

  const types = parseTargetList(list.stdout);
  const uriType = types.find((t) => baseMimeType(t) === 'text/uri-list');
  if (uriType === undefined) return null;

  const uris = runCommand('wl-paste', ['--type', uriType, '--no-newline']);
  return uris.ok ? readMediaFromText(uris.stdout.toString('utf-8')) : null;
}

function readClipboardImageViaWlPaste(): ClipboardImage | null {
  const list = runCommand('wl-paste', ['--list-types'], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });
  if (!list.ok) return null;

  const selected = selectPreferredImageMimeType(parseTargetList(list.stdout));
  if (selected === null) return null;

  const data = runCommand('wl-paste', ['--type', selected, '--no-newline']);
  if (!data.ok || data.stdout.length === 0) return null;
  return { kind: 'image', bytes: data.stdout, mimeType: baseMimeType(selected) };
}

function readClipboardFileMediaViaXclip(): ClipboardMedia | null {
  const targets = runCommand('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });
  if (!targets.ok) return null;

  const candidates = parseTargetList(targets.stdout);
  const uriType = candidates.find((t) => baseMimeType(t) === 'text/uri-list');
  if (uriType === undefined) return null;

  const uris = runCommand('xclip', ['-selection', 'clipboard', '-t', uriType, '-o']);
  return uris.ok ? readMediaFromText(uris.stdout.toString('utf-8')) : null;
}

function readClipboardImageViaXclip(): ClipboardImage | null {
  const targets = runCommand('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o'], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });

  const candidates = targets.ok ? parseTargetList(targets.stdout) : [];
  const preferred = candidates.length > 0 ? selectPreferredImageMimeType(candidates) : null;
  const tryTypes =
    preferred !== null
      ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES]
      : [...SUPPORTED_IMAGE_MIME_TYPES];

  for (const mime of tryTypes) {
    const data = runCommand('xclip', ['-selection', 'clipboard', '-t', mime, '-o']);
    if (data.ok && data.stdout.length > 0) {
      return { kind: 'image', bytes: data.stdout, mimeType: baseMimeType(mime) };
    }
  }
  return null;
}

/**
 * Windows clipboard images (Win+Shift+S) don't bridge into the WSL
 * Linux clipboard. PowerShell reaches the Windows clipboard directly;
 * we round-trip via a temp PNG because binary stdout is unreliable
 * across the WSL interop boundary.
 */
function readClipboardImageViaPowerShell(): ClipboardImage | null {
  const tmpFile = join(tmpdir(), `kimi-wsl-clip-${randomUUID()}.png`);
  try {
    const winPathResult = runCommand('wslpath', ['-w', tmpFile], {
      timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
    });
    if (!winPathResult.ok) return null;
    const winPath = winPathResult.stdout.toString('utf-8').trim();
    if (winPath.length === 0) return null;

    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$path = $env:KIMI_WSL_CLIPBOARD_IMAGE_PATH',
      '$img = [System.Windows.Forms.Clipboard]::GetImage()',
      "if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
    ].join('; ');

    const result = runCommand('powershell.exe', ['-NoProfile', '-Command', psScript], {
      timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
      env: { ...process.env, KIMI_WSL_CLIPBOARD_IMAGE_PATH: winPath },
    });
    if (!result.ok) return null;
    if (result.stdout.toString('utf-8').trim() !== 'ok') return null;

    const bytes = readFileSync(tmpFile);
    if (bytes.length === 0) return null;
    return { kind: 'image', bytes: new Uint8Array(bytes), mimeType: 'image/png' };
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

function readClipboardFilePathsViaMacOs(run: RunCommand): string[] {
  const result = run('osascript', ['-l', 'JavaScript', '-e', MACOS_FILE_PATH_SCRIPT], {
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
  });
  if (!result.ok || result.stdout.length === 0) return [];
  return parseClipboardPaths(result.stdout.toString('utf-8'));
}

async function readClipboardFileMediaViaNativeText(
  clip: ClipboardModule | null,
): Promise<{ media: ClipboardMedia | null; lookedFileLike: boolean }> {
  if (clip === null) return { media: null, lookedFileLike: false };

  const formats = safeAvailableFormats(clip);
  const lookedFileLike = formats.some(isFileLikeNativeFormat);
  if (!lookedFileLike || clip.getText === undefined) {
    return { media: null, lookedFileLike };
  }

  try {
    return { media: readMediaFromText(await clip.getText()), lookedFileLike };
  } catch (error) {
    if (error instanceof ClipboardMediaError) throw error;
    return { media: null, lookedFileLike };
  }
}

async function readClipboardImageViaNative(
  clip: ClipboardModule | null = clipboard,
): Promise<ClipboardImage | null> {
  if (clip === null) return null;

  let hasImage = false;
  try {
    hasImage = clip.hasImage();
  } catch {
    return null;
  }
  if (!hasImage) return null;

  try {
    const data = await clip.getImageBinary();
    if (data.length === 0) return null;
    return { kind: 'image', bytes: Uint8Array.from(data), mimeType: 'image/png' };
  } catch {
    return null;
  }
}

export async function readClipboardMedia(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  clipboard?: ClipboardModule | null;
  runCommand?: RunCommand;
}): Promise<ClipboardMedia | null> {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const clip = options?.clipboard ?? clipboard;
  const run = options?.runCommand ?? runCommand;

  // Termux on Android has no desktop clipboard; skip early rather than
  // churn through every fallback.
  if (env['TERMUX_VERSION'] !== undefined) return null;

  let image: ClipboardImage | null = null;
  if (platform === 'linux') {
    const wayland = isWaylandSession(env);
    const wsl = isWSL(env);

    if (wayland || wsl) {
      const fileMedia = readClipboardFileMediaViaWlPaste() ?? readClipboardFileMediaViaXclip();
      if (fileMedia !== null) return fileMedia;
      image = readClipboardImageViaWlPaste() ?? readClipboardImageViaXclip();
    }
    if (image === null && wsl) {
      image = readClipboardImageViaPowerShell();
    }
    if (image === null && !wayland) {
      const nativeFileMedia = await readClipboardFileMediaViaNativeText(clip);
      if (nativeFileMedia.media !== null) return nativeFileMedia.media;
      if (nativeFileMedia.lookedFileLike) return null;
      image = await readClipboardImageViaNative(clip);
    }
  } else {
    if (platform === 'darwin') {
      const fileMedia = readMediaFromPaths(readClipboardFilePathsViaMacOs(run));
      if (fileMedia !== null) return fileMedia;
    }

    const nativeFileMedia = await readClipboardFileMediaViaNativeText(clip);
    if (nativeFileMedia.media !== null) return nativeFileMedia.media;

    // Finder exposes file icons/thumbnails as image data. If the clipboard
    // looks file-like but we could not read a real file path, do not consume
    // that icon as an image attachment.
    if (platform === 'darwin' && nativeFileMedia.lookedFileLike) {
      return null;
    }

    image = await readClipboardImageViaNative(clip);
  }

  if (image === null) return null;
  if (!isSupportedImageMimeType(image.mimeType)) return null;
  return image;
}
