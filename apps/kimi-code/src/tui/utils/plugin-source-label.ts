import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk';

type PluginSourceSummary = Partial<PluginSummary> &
  Pick<PluginSummary, 'source' | 'originalSource' | 'github'>;

export const OFFICIAL_BADGE = 'official';
export const CURATED_BADGE = 'curated';
export const THIRD_PARTY_BADGE = 'third-party';

export type PluginTrustLabel = 'official' | 'curated' | 'third-party';

const CODE_CDN_HOSTS = new Set(['code.kimi.com', 'code.kimi.ai']);
const CONTENT_CDN_HOSTS = new Set(['cdn.kimi.com', 'cdn.kimi.ai']);

export function formatPluginSourceLabel(plugin: PluginSourceSummary): string {
  if (plugin.source === 'github' && plugin.github !== undefined) {
    return `github ${plugin.github.owner}/${plugin.github.repo}@${plugin.github.ref.value}`;
  }
  if (plugin.source === 'zip-url' && plugin.originalSource !== undefined) {
    const host = hostFromUrl(plugin.originalSource);
    if (host !== undefined) return `via ${host}`;
  }
  return plugin.source;
}

export function pluginTrustLabel(plugin: PluginSourceSummary): PluginTrustLabel {
  if (plugin.source !== 'zip-url' || plugin.originalSource === undefined) {
    return 'third-party';
  }
  try {
    const url = new URL(plugin.originalSource);
    if (isOfficialPluginUrl(url)) {
      return 'official';
    }
    if (
      url.protocol === 'https:' &&
      CODE_CDN_HOSTS.has(url.hostname) &&
      url.pathname.startsWith('/kimi-code/plugins/curated/')
    ) {
      return 'curated';
    }
    return 'third-party';
  } catch {
    return 'third-party';
  }
}

export function isOfficialPluginSource(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed.startsWith('https://')) return false;
  try {
    return isOfficialPluginUrl(new URL(trimmed));
  } catch {
    return false;
  }
}

export function isOfficialPluginInstall(plugin: PluginSourceSummary): boolean {
  return (
    plugin.source === 'zip-url' &&
    plugin.originalSource !== undefined &&
    isOfficialPluginSource(plugin.originalSource)
  );
}

function isOfficialPluginUrl(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  return (
    (CODE_CDN_HOSTS.has(url.hostname) &&
      url.pathname.startsWith('/kimi-code/plugins/official/')) ||
    (CONTENT_CDN_HOSTS.has(url.hostname) &&
      (url.pathname.startsWith('/kimi-computer-use/') ||
        url.pathname.startsWith('/kimi-computer-use-windows/')))
  );
}

function hostFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.port.length > 0) return `${url.hostname}:${url.port}`;
    return url.hostname;
  } catch {
    return undefined;
  }
}
