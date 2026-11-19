
import type { Component, InjectionKey } from 'vue';

export const IconResolverKey: InjectionKey<(name: string) => Component | undefined> =
  Symbol('IconResolver');

export const SIZE_PX = { sm: 14, md: 16, lg: 20 } as const;

export type IconSize = keyof typeof SIZE_PX;
