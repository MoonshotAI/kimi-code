import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { mountApp, type AppHandle } from '#/app/index';
import {
  ConfigRef,
  createConfig,
  useConfigSection,
  type ConfigChangedEvent,
  type ConfigPersist,
  type ConfigSectionContribution,
  type ConfigStore,
} from '#/builtin/config/index';
import { createFeature } from '#/feature/index';

interface LimitsConfig {
  readonly maxRetries?: number;
  readonly timeout?: number;
}

interface AccountConfig {
  readonly apiKey?: string;
  readonly plan?: string;
}

const limitsSection: ConfigSectionContribution<LimitsConfig> = {
  name: 'limits',
  schema: z.object({
    maxRetries: z.number().int().optional(),
    timeout: z.number().int().optional(),
  }),
  defaultValue: { maxRetries: 3 },
};

const accountSection: ConfigSectionContribution<AccountConfig> = {
  name: 'account',
  schema: z.object({
    apiKey: z.string().optional(),
    plan: z.string().optional(),
  }),
  envBindings: {
    apiKey: { env: 'PROBE_API_KEY', deprecatedEnv: 'OLD_PROBE_API_KEY' },
  },
  stripEnv: (value) => {
    const out = { ...value };
    delete out.apiKey;
    return out;
  },
  deprecations: [{ key: 'token', replacement: 'apiKey' }],
};

function fakePersist(initial?: string): {
  saved: string[];
  setText(text: string | undefined): void;
  persist: ConfigPersist;
} {
  const saved: string[] = [];
  let text = initial;
  return {
    saved,
    setText: (value) => {
      text = value;
    },
    persist: {
      load: () => Promise.resolve(text),
      save: (value) => {
        saved.push(value);
        text = value;
        return Promise.resolve();
      },
    },
  };
}

async function mountConfigApp(options: {
  persist?: ConfigPersist;
  env?: Record<string, string | undefined>;
  sections?: readonly ConfigSectionContribution[];
}): Promise<{ app: AppHandle; config: ConfigStore }> {
  const sections = options.sections ?? [limitsSection, accountSection];
  const probe = createFeature('config-probe', {
    app() {
      for (const section of sections) useConfigSection(section);
    },
  });
  const app = mountApp({
    features: [probe, createConfig({ persist: options.persist, env: options.env })],
  });
  await app.ready();
  return { app, config: app.resolve(ConfigRef) };
}

describe('config feature', () => {
  it('resolves sections through default, file, env, and memory layers', async () => {
    const file = fakePersist('[limits]\ntimeout = 5\n');
    const { app, config } = await mountConfigApp({
      persist: file.persist,
      env: { PROBE_API_KEY: 'sk-env' },
    });
    expect(config.get('limits')).toEqual({ timeout: 5 });
    expect(config.get('account')).toEqual({ apiKey: 'sk-env' });
    expect(config.section('limits').value).toEqual({ timeout: 5 });
    file.setText('[other]\nkey = 1\n');
    await config.reload();
    expect(config.get('limits')).toEqual({ maxRetries: 3 });
    await config.set('limits', { maxRetries: 9 }, 'memory');
    expect(config.get('limits')).toEqual({ maxRetries: 9 });
    await config.replace({ limits: undefined }, 'memory');
    expect(config.get('limits')).toEqual({ maxRetries: 3 });
    await app.disposeAsync();
  });

  it('falls back to deprecated env names and reports a diagnostic', async () => {
    const { app, config } = await mountConfigApp({
      env: { OLD_PROBE_API_KEY: 'sk-old' },
    });
    expect(config.get('account')).toEqual({ apiKey: 'sk-old' });
    expect(
      config.diagnostics().some((entry) => entry.message.includes('OLD_PROBE_API_KEY is deprecated')),
    ).toBe(true);
    await app.disposeAsync();
    const preferred = await mountConfigApp({
      env: { OLD_PROBE_API_KEY: 'sk-old', PROBE_API_KEY: 'sk-new' },
    });
    expect(preferred.config.get('account')).toEqual({ apiKey: 'sk-new' });
    expect(
      preferred.config.diagnostics().some((entry) => entry.message.includes('is deprecated')),
    ).toBe(false);
    await preferred.app.disposeAsync();
  });

  it('persists user-target writes while preserving comments, and keeps memory writes in memory', async () => {
    const file = fakePersist(
      '# top comment\n\n[limits]\n# keep me\ntimeout = 5\n\n[account]\napiKey = "sk-file"\nplan = "free"\n',
    );
    const { app, config } = await mountConfigApp({
      persist: file.persist,
      env: { PROBE_API_KEY: 'sk-env' },
    });
    await config.set('limits', { maxRetries: 7, timeout: 5 }, 'memory');
    expect(file.saved).toHaveLength(0);
    await config.set('limits', { maxRetries: 7, timeout: 5 }, 'user');
    expect(file.saved).toHaveLength(1);
    const written = file.saved[0]!;
    expect(written).toContain('# top comment');
    expect(written).toContain('# keep me');
    expect(written).toContain('timeout = 5');
    expect(written).toContain('maxRetries = 7');
    await config.set('account', { apiKey: 'sk-written', plan: 'pro' }, 'user');
    const stripped = file.saved.at(-1)!;
    expect(stripped).not.toContain('apiKey');
    expect(stripped).toContain('plan = "pro"');
    expect(config.get('account')).toEqual({ apiKey: 'sk-env', plan: 'pro' });
    await config.replace({ limits: { timeout: 1 } }, 'user');
    const replaced = file.saved.at(-1)!;
    expect(replaced).toContain('timeout = 1');
    expect(replaced).not.toContain('maxRetries');
    await app.disposeAsync();
  });

  it('reloads from disk and updates section refs', async () => {
    const file = fakePersist('[limits]\ntimeout = 5\n');
    const { app, config } = await mountConfigApp({ persist: file.persist });
    expect(config.get('limits')).toEqual({ timeout: 5 });
    file.setText('[limits]\ntimeout = 9\nmaxRetries = 1\n');
    await config.reload();
    expect(config.get('limits')).toEqual({ maxRetries: 1, timeout: 9 });
    expect(config.section('limits').value).toEqual({ maxRetries: 1, timeout: 9 });
    await app.disposeAsync();
  });

  it('reports validation and deprecation diagnostics', async () => {
    const file = fakePersist('[limits]\ntimeout = "soon"\n\n[account]\ntoken = "abc"\n');
    const { app, config } = await mountConfigApp({ persist: file.persist });
    const diagnostics = config.diagnostics();
    expect(
      diagnostics.some(
        (entry) =>
          entry.section === 'limits' && entry.message.includes('Ignored invalid config section'),
      ),
    ).toBe(true);
    expect(
      diagnostics.some(
        (entry) => entry.section === 'account' && entry.message.includes("'token' is deprecated"),
      ),
    ).toBe(true);
    expect(config.get('limits')).toEqual({ maxRetries: 3 });
    await app.disposeAsync();
  });

  it('gates app readiness on the initial load', async () => {
    let release: (text: string | undefined) => void = () => {};
    const gate = new Promise<string | undefined>((resolve) => {
      release = resolve;
    });
    const persist: ConfigPersist = {
      load: () => gate,
      save: () => Promise.resolve(),
    };
    const probe = createFeature('config-probe', {
      app() {
        useConfigSection(limitsSection);
      },
    });
    const app = mountApp({ features: [probe, createConfig({ persist })] });
    let ready = false;
    void app.ready().then(() => {
      ready = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ready).toBe(false);
    release('[limits]\ntimeout = 4\n');
    await app.ready();
    expect(ready).toBe(true);
    expect(app.resolve(ConfigRef).get('limits')).toEqual({ timeout: 4 });
    await app.disposeAsync();
  });

  it('runs memory-only when no persist is configured', async () => {
    const { app, config } = await mountConfigApp({});
    expect(config.get('limits')).toEqual({ maxRetries: 3 });
    await config.set('limits', { timeout: 2 }, 'memory');
    expect(config.get('limits')).toEqual({ timeout: 2 });
    await expect(config.set('limits', { timeout: 3 }, 'user')).rejects.toThrow('persist');
    await app.disposeAsync();
  });

  it('exposes the configured env source through the facade', async () => {
    const { app, config } = await mountConfigApp({ env: { PROBE_KEY: 'from-config' } });
    expect(config.env('PROBE_KEY')).toBe('from-config');
    expect(config.env('PROBE_MISSING')).toBeUndefined();
    await app.disposeAsync();
  });

  it('emits config.changed with the section name and new value', async () => {
    const spec = createConfig({});
    const probe = createFeature('config-probe', {
      app() {
        useConfigSection(limitsSection);
      },
    });
    const app = mountApp({ features: [probe, spec] });
    const events: ConfigChangedEvent[] = [];
    app.on(spec, 'config.changed', (event) => {
      events.push(event);
    });
    await app.ready();
    const config = app.resolve(ConfigRef);
    await config.set('limits', { maxRetries: 8 }, 'memory');
    expect(
      events.some(
        (event) =>
          event.section === 'limits' &&
          event.source === 'set' &&
          (event.value as LimitsConfig).maxRetries === 8,
      ),
    ).toBe(true);
    await app.disposeAsync();
  });
});
