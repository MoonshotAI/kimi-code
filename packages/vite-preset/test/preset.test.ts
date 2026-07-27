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

  it('loads raw icon imports through an internal virtual id', async () => {
    const cfg = kimiRendererViteConfig({ root: '/x', iconsDir: '/x/icons/kimi' });
    const plugins = (cfg.plugins ?? []).flat().filter(Boolean) as any[];
    const rawIcons = plugins.find((plugin) => plugin.name === 'kimi-raw-icons');
    const resolved = rawIcons.resolveId('~icons/ri/add-line?raw');

    expect(resolved).toBe('\0kimi-raw-icon:~icons%2Fri%2Fadd-line%3Fraw');
    await expect(rawIcons.load.call({}, resolved)).resolves.toMatchObject({
      code: expect.stringContaining('export default "<svg'),
    });
  });
});
