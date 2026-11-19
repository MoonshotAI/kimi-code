import type { Component, InjectionKey } from 'vue';

export type FontPreviewChrome = 'macos' | 'windows' | 'linux' | 'plain';

export interface FontPreviewPlatform {
  isMacosDesktop: boolean;
  isWindowsDesktop: boolean;
  isLinuxDesktop: boolean;
  hasCustomTitleBar: boolean;
}

export function fontPreviewChrome(platform: FontPreviewPlatform): FontPreviewChrome {
  if (platform.isMacosDesktop) return 'macos';
  if (platform.isWindowsDesktop) return 'windows';
  if (platform.isLinuxDesktop && platform.hasCustomTitleBar) return 'linux';
  return 'plain';
}

export const FontPreviewBrandKey: InjectionKey<Component> = Symbol('FontPreviewBrand');
