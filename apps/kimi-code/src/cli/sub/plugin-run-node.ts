import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED_EXTENSIONS = ['.js', '.mjs', '.cjs'];

export async function runPluginNodeEntry(entry: string, args: readonly string[]): Promise<void> {
  const pluginRoot = process.env['KIMI_PLUGIN_ROOT'];
  if (pluginRoot === undefined || pluginRoot.trim().length === 0) {
    throw new Error('KIMI_PLUGIN_ROOT is required to run a plugin node entry.');
  }

  const [rootReal, entryReal] = await Promise.all([
    realpath(pluginRoot),
    realpath(entry),
  ]);
  if (!isWithin(entryReal, rootReal)) {
    throw new Error(`Plugin node entry must be inside KIMI_PLUGIN_ROOT: ${entry}`);
  }

  const ext = path.extname(entryReal).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(`Plugin node entry must have a valid extension (${ALLOWED_EXTENSIONS.join(', ')}): ${entry}`);
  }

  process.argv = [process.argv[0] ?? process.execPath, entryReal, ...args];
  await import(pathToFileURL(entryReal).href);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  const isRelativeWithin = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (!isRelativeWithin) {
    return false;
  }
  const normalizedRoot = path.normalize(root + path.sep);
  return candidate.startsWith(normalizedRoot);
}
