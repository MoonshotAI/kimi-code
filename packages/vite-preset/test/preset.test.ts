import { describe, expect, it } from 'vitest';
import { kimiRendererViteConfig } from '#/index';
describe('kimiRendererViteConfig', () => {
  it('emits worker.format es, es2022 target, and kimi icons collection, no alias', () => {
    const cfg = kimiRendererViteConfig({ root: '/x', iconsDir: '/x/icons/kimi', defines: { __KIMI_X__: '1' } });
    expect(cfg.worker).toEqual({ format: 'es' });
    expect(cfg.build?.target).toBe('es2022');
    expect(cfg.define).toMatchObject({ __KIMI_X__: '1' });
    expect((cfg.resolve?.alias ?? {})).toEqual({});
    const plugins = (cfg.plugins ?? []).flat().filter(Boolean).map((p: any) => p?.name).join('|');
    expect(plugins).toMatch(/unplugin-icons/);
  });
});
