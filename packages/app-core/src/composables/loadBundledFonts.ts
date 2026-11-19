const LOADERS = new Map<string, () => Promise<unknown>>([
  ['Schibsted Grotesk Variable', () =>
    Promise.all([
      import('@fontsource-variable/schibsted-grotesk/wght.css'),
      import('@fontsource-variable/schibsted-grotesk/wght-italic.css'),
    ])],
  ['Noto Sans SC Variable', () => import('@fontsource-variable/noto-sans-sc/wght.css')],
  ['JetBrains Mono Variable', () =>
    Promise.all([
      import('@fontsource-variable/jetbrains-mono/wght.css'),
      import('@fontsource-variable/jetbrains-mono/wght-italic.css'),
    ])],
]);

const loading = new Map<string, Promise<void>>();

export function loadBundledFont(family: string): Promise<void> {
  const load = LOADERS.get(family);
  if (load === undefined) return Promise.resolve();
  const existing = loading.get(family);
  if (existing !== undefined) return existing;
  const pending = load().then(
    () => globalThis.document?.fonts?.load(`1em "${family}"`).then(
      () => undefined,
      () => undefined,
    ),
    () => {
      loading.delete(family);
    },
  );
  loading.set(family, pending);
  return pending;
}

export function loadBundledFonts(families: readonly string[]): void {
  for (const family of families) void loadBundledFont(family);
}
