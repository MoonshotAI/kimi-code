// @moonshot-ai/app-ui icon resolver contract.
//
// <Icon> renders a consumer-registered line icon by name. The actual icon
// registry (which maps a name to a Vue component) is owned by the consumer —
// it depends on the consumer's bundler icon collections (`~icons/*`), which
// must not enter this package. The consumer bridges its registry in once at
// app setup via `app.provide(IconResolverKey, name => componentOrUndefined)`.
//
// SIZE_PX / IconSize are pure, package-owned constants (the design-system
// §02 size scale), so they travel with <Icon>.

import type { Component, InjectionKey } from 'vue';

/** Injection key for the consumer-provided name → component resolver. */
export const IconResolverKey: InjectionKey<(name: string) => Component | undefined> =
  Symbol('IconResolver');

/** Pixel size for each <Icon> size token (design-system §02). */
export const SIZE_PX = { sm: 14, md: 16, lg: 20 } as const;

export type IconSize = keyof typeof SIZE_PX;
