import type { UserConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { FileSystemIconLoader } from 'unplugin-icons/loaders';

export interface KimiRendererViteOptions {
  readonly root: string;
  readonly iconsDir: string;
  readonly defines?: Record<string, string>;
  readonly target?: string;
}

export function kimiRendererViteConfig(opts: KimiRendererViteOptions): UserConfig {
  const { root, iconsDir, defines, target = 'es2022' } = opts;
  return {
    root,
    plugins: [
      vue(),
      Icons({
        compiler: 'vue3',
        customCollections: {
          kimi: FileSystemIconLoader(iconsDir),
        },
      }),
    ],
    define: { ...defines },
    build: {
      target,
    },
    worker: {
      format: 'es',
    },
  };
}
