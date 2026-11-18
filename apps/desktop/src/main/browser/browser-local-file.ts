import { stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BROWSER_STATE_URL_MAX } from '../../shared/browser';

const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const STAT_TIMEOUT_MS = 10_000;

export class BrowserLocalFileError extends Error {
  constructor(message: string) {
    super(`browser-open-local-file: ${message}`);
    this.name = 'BrowserLocalFileError';
  }
}

function localTarget(target: string): { path: string; suffix: string } {
  if (!/^file:/i.test(target)) return { path: target, suffix: '' };
  try {
    const url = new URL(target);
    return { path: fileURLToPath(url), suffix: `${url.search}${url.hash}` };
  } catch {
    throw new BrowserLocalFileError('invalid file URL');
  }
}

async function statIsFile(path: string): Promise<boolean> {
  const settled = await Promise.race([
    stat(path).then(
      (result) => ({ timedOut: false as const, isFile: result.isFile() }),
      () => ({ timedOut: false as const, isFile: null }),
    ),
    new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), STAT_TIMEOUT_MS)),
  ]);
  if (settled.timedOut) throw new BrowserLocalFileError('file validation timed out');
  if (settled.isFile === null) throw new BrowserLocalFileError('file not found');
  if (!settled.isFile) throw new BrowserLocalFileError('not a file');
  return true;
}

export async function resolveLocalHtmlFileUrl(target: string, urlSuffix = ''): Promise<string> {
  if (urlSuffix !== '' && !urlSuffix.startsWith('?') && !urlSuffix.startsWith('#')) throw new BrowserLocalFileError('invalid URL suffix');
  const { path: raw, suffix } = localTarget(target.trim());
  if (raw.includes('\0') || !isAbsolute(raw)) throw new BrowserLocalFileError('path must be absolute');
  const path = resolve(raw);
  if (!HTML_EXTENSIONS.has(extname(path).toLowerCase())) throw new BrowserLocalFileError('not an HTML file');
  if (!(await statIsFile(path))) throw new BrowserLocalFileError('file not found');
  const url = `${pathToFileURL(path).href}${suffix}${urlSuffix}`;
  if (url.length > BROWSER_STATE_URL_MAX) throw new BrowserLocalFileError('path is too long');
  return url;
}

export function localFileAddressUrl(address: string, platform: NodeJS.Platform = process.platform): string | null {
  const input = address.trim();
  if (/^file:/i.test(input)) {
    try {
      return new URL(input).href;
    } catch {
      return null;
    }
  }
  if (input.includes('\0')) return null;
  const windows = platform === 'win32';
  const absolute = windows ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/.test(input) && win32.isAbsolute(input) : input.startsWith('/');
  return absolute ? pathToFileURL(input, { windows }).href : null;
}
