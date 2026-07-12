import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { t } from '#/i18n';

export async function runPluginNodeEntry(entry: string, args: readonly string[]): Promise<void> {
  const pluginRoot = process.env['KIMI_PLUGIN_ROOT'];
  if (pluginRoot === undefined || pluginRoot.trim().length === 0) {
    throw new Error(t('tui.statusMessages.pluginRootRequired'));
  }

  const [rootReal, entryReal] = await Promise.all([
    realpath(pluginRoot),
    realpath(entry),
  ]);
  if (!isWithin(entryReal, rootReal)) {
    throw new Error(t("tui.statusMessages.pluginEntryOutsideRoot", { entry }));
  }

  process.argv = [process.argv[0] ?? process.execPath, entryReal, ...args];
  await import(pathToFileURL(entryReal).href);
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
