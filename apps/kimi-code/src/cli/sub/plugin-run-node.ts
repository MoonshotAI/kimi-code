import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

  process.argv = [process.argv[0] ?? process.execPath, entryReal, ...args];
  await import(pathToFileURL(entryReal).href);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
