import { createRequire } from 'node:module';

import { loadNativePackage } from '#/native/native-require';

declare const __KIMI_CODE_NATIVE_BUNDLE__: boolean | undefined;

export interface ClipboardModule {
  availableFormats?(): string[];
  hasText?(): boolean;
  getText?(): Promise<string>;
  setText?(text: string): Promise<void>;
  hasImage(): boolean;
  getImageBinary(): Promise<Array<number>>;
}

const nodeRequire = createRequire(import.meta.url);
const isNativeBundle =
  typeof __KIMI_CODE_NATIVE_BUNDLE__ === 'boolean' && __KIMI_CODE_NATIVE_BUNDLE__;

const hasDisplay =
  process.platform !== 'linux' || Boolean(process.env['DISPLAY'] ?? process.env['WAYLAND_DISPLAY']);

const clipboard: ClipboardModule | null = (() => {
  if (process.env['TERMUX_VERSION'] !== undefined || !hasDisplay) return null;
  try {
    const bundledClipboard = loadNativePackage<ClipboardModule>('@mariozechner/clipboard');
    if (bundledClipboard !== null) return bundledClipboard;
  } catch {
    return null;
  }
  if (isNativeBundle) return null;
  try {
    return nodeRequire('@mariozechner/clipboard') as ClipboardModule;
  } catch {
    return null;
  }
})();

export { clipboard };
