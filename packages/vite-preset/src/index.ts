import type { Plugin, UserConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { FileSystemIconLoader } from 'unplugin-icons/loaders';
import { execFileSync } from 'node:child_process';

const RAW_ICON_PREFIX = '\0kimi-raw-icon:';

function resolveCommitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function resolveBranch(): string {
  const fromEnv = process.env['GITHUB_REF_NAME'];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function rawIconPlugin(icons: Plugin): Plugin {
  return {
    name: 'kimi-raw-icons',
    enforce: 'pre',
    resolveId(id) {
      if (/^(?:\/?~icons\/|virtual[:/]icons\/).+[?&]raw(?:[=&]|$)/.test(id)) {
        return `${RAW_ICON_PREFIX}${encodeURIComponent(id)}`;
      }
      return null;
    },
    async load(id) {
      if (!id.startsWith(RAW_ICON_PREFIX) || typeof icons.load !== 'function') {
        return null;
      }
      return icons.load.call(this, decodeURIComponent(id.slice(RAW_ICON_PREFIX.length)));
    },
  };
}

export interface KimiRendererViteOptions {
  readonly root: string;
  readonly iconsDir: string;
  readonly defines?: Record<string, string>;
  readonly target?: string;
}

export function kimiRendererViteConfig(opts: KimiRendererViteOptions): UserConfig {
  const { root, iconsDir, defines, target = 'es2022' } = opts;
  const iconPlugins = [
    Icons({
      compiler: 'vue3',
      customCollections: {
        kimi: FileSystemIconLoader(iconsDir),
      },
    }),
  ].flat();
  const icons = iconPlugins.find(
    (plugin): plugin is Plugin => plugin.name === 'unplugin-icons' && typeof plugin.load === 'function',
  );
  if (!icons) throw new Error('unplugin-icons did not provide a load hook');
  return {
    root,
    plugins: [
      vue(),
      rawIconPlugin(icons),
      ...iconPlugins,
    ],
    define: {
      __KIMI_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __KIMI_COMMIT_SHA__: JSON.stringify(resolveCommitSha()),
      __KIMI_BRANCH__: JSON.stringify(resolveBranch()),
      ...defines,
    },
    assetsInclude: ['**/*.riv', '**/rive.wasm', '**/rive_fallback.wasm'],
    build: {
      target,
    },
    worker: {
      format: 'es',
    },
  };
}
