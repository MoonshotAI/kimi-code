type Translate = (key: string, params?: Record<string, unknown>) => string;

const INSTALL_FROM_PREFIX = 'Cannot install plugin from ';
const MISSING_MANIFEST_SUFFIX = ': No manifest at kimi.plugin.json or .kimi-plugin/plugin.json';

export function pluginErrorMessage(error: string | undefined, t: Translate): string | undefined {
  if (error === undefined) return undefined;
  if (!error.startsWith(INSTALL_FROM_PREFIX) || !error.endsWith(MISSING_MANIFEST_SUFFIX)) {
    return error;
  }
  const source = error.slice(INSTALL_FROM_PREFIX.length, -MISSING_MANIFEST_SUFFIX.length);
  if (source === '') return error;
  return t('settings.plugins.missingManifest', { source });
}
