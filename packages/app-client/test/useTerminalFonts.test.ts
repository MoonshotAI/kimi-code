import { afterEach, describe, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({ mounted: [] as (() => void)[], unmounted: [] as (() => void)[] }));
vi.mock('vue', () => ({
  onMounted: (fn: () => void) => lifecycle.mounted.push(fn),
  onUnmounted: (fn: () => void) => lifecycle.unmounted.push(fn),
}));
vi.mock('@moonshot-ai/app-core', () => ({ useFontPrefs: vi.fn() }));
import { useTerminalFonts } from '../src/composables/useTerminalFonts';

afterEach(() => {
  lifecycle.unmounted.forEach((fn) => fn());
  lifecycle.mounted.length = 0;
  lifecycle.unmounted.length = 0;
  vi.unstubAllGlobals();
});

describe('useTerminalFonts', () => {
  it('updates live terminals, ignores unrelated mutations, and releases observers', () => {
    const tokens: Record<string, string> = {
      '--font-terminal': '"JetBrains Mono", monospace',
    };
    let size = '13px';
    let mutation = () => {};
    const disconnect = vi.fn();
    const fonts = new EventTarget();
    const root = {};
    vi.stubGlobal('document', {
      documentElement: root,
      body: { appendChild: vi.fn() },
      createElement: () => ({ style: {}, remove: vi.fn() }),
      fonts,
    });
    vi.stubGlobal('getComputedStyle', (el: unknown) => el === root
      ? { getPropertyValue: (key: string) => tokens[key] }
      : { fontSize: size });
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: () => void) { mutation = callback; }
      observe = vi.fn();
      disconnect = disconnect;
    });
    const apply = vi.fn();
    const { readOptions } = useTerminalFonts(apply);
    expect(readOptions()).toEqual({ fontFamily: '"JetBrains Mono", monospace', fontSize: 13 });
    lifecycle.mounted.forEach((fn) => fn());
    mutation();
    expect(apply).toHaveBeenCalledTimes(1);
    tokens['--font-terminal'] = '"Menlo", "JetBrains Mono", monospace';
    size = '18px';
    mutation();
    expect(apply).toHaveBeenLastCalledWith({ fontFamily: tokens['--font-terminal'], fontSize: 18 });
    fonts.dispatchEvent(new Event('loadingdone'));
    expect(apply).toHaveBeenCalledTimes(3);
    lifecycle.unmounted.forEach((fn) => fn());
    lifecycle.unmounted.length = 0;
    fonts.dispatchEvent(new Event('loadingdone'));
    expect(apply).toHaveBeenCalledTimes(3);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
