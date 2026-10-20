import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import type { ShallowRef } from '@moonshot-ai/agent-core/kernel/index';

import {
  createConfig,
  isPlainObject,
  planConfigWriteback,
  useConfig,
  useConfigOverlay,
  useConfigSection,
  type ConfigChangedEvent,
  type ConfigOverlayContribution,
  type ConfigPersist,
  type ConfigSectionContribution,
  type ConfigStore,
  type DomainUpdate,
} from '#/features/config/index';
import { createHarness, memoryHarnessSpace, type Harness } from '#/runtime/index';

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
  deprecations: [{ key: 'api_token', replacement: 'api_key' }],
};

const probeOverlay: ConfigOverlayContribution = {
  name: 'probe-overlay',
  apply(effective, getEnv, validate) {
    if (getEnv('PROBE_OVERLAY') === undefined) return;
    effective['ghost'] = { injected: true };
    const limits = isPlainObject(effective['limits']) ? effective['limits'] : {};
    effective['limits'] = validate('limits', { ...limits, timeout: 999 });
  },
  strip(name, value, rawSnake) {
    if (name === 'ghost') return undefined;
    if (name === 'limits' && isPlainObject(value) && value['timeout'] === 999) {
      const raw = isPlainObject(rawSnake['limits']) ? rawSnake['limits'] : undefined;
      const out = { ...value };
      if (typeof raw?.['timeout'] === 'number') {
        out['timeout'] = raw['timeout'];
      } else {
        delete out['timeout'];
      }
      return out;
    }
    return value;
  },
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function configProbe(
  capture: { config?: Readonly<ShallowRef<ConfigStore | undefined>> },
  sections: readonly ConfigSectionContribution<any>[],
  overlays: readonly ConfigOverlayContribution[],
) {
  return createFeature('config-probe', {
    app() {
      for (const section of sections) useConfigSection(section);
      for (const overlay of overlays) useConfigOverlay(overlay);
      capture.config = useConfig();
    },
  });
}

async function mountConfigApp(options: {
  persist?: ConfigPersist;
  env?: Record<string, string | undefined>;
  sections?: readonly ConfigSectionContribution<any>[];
  overlays?: readonly ConfigOverlayContribution[];
}): Promise<{ harness: Harness; config: ConfigStore }> {
  const capture: { config?: Readonly<ShallowRef<ConfigStore | undefined>> } = {};
  const probe = configProbe(capture, options.sections ?? [limitsSection, accountSection], options.overlays ?? []);
  const harness = createHarness({ space: memoryHarnessSpace() });
  harness.app.features.add(probe);
  harness.app.features.add(createConfig({ persist: options.persist, env: options.env }));
  await tick();
  const store = capture.config?.value;
  if (store === undefined) throw new Error('config store was not exposed');
  await store.reload();
  return { harness, config: store };
}

describe('config feature', () => {
  it('resolves sections through default, file, env, and memory layers', async () => {
    const file = fakePersist('[limits]\ntimeout = 5\n');
    const { harness, config } = await mountConfigApp({
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
    await harness.close();
  });

  it('loads v2 snake_case files and converts first-level keys to camelCase in memory', async () => {
    const file = fakePersist('[limits]\nmax_retries = 6\ntimeout = 5\n\n[account]\napi_key = "sk-file"\n');
    const { harness, config } = await mountConfigApp({ persist: file.persist });
    expect(config.get('limits')).toEqual({ maxRetries: 6, timeout: 5 });
    expect(config.get('account')).toEqual({ apiKey: 'sk-file' });
    await harness.close();
  });

  it('falls back to deprecated env names and reports a diagnostic', async () => {
    const { harness, config } = await mountConfigApp({
      env: { OLD_PROBE_API_KEY: 'sk-old' },
    });
    expect(config.get('account')).toEqual({ apiKey: 'sk-old' });
    expect(
      config.diagnostics().some((entry) => entry.message.includes('OLD_PROBE_API_KEY is deprecated')),
    ).toBe(true);
    await harness.close();
    const preferred = await mountConfigApp({
      env: { OLD_PROBE_API_KEY: 'sk-old', PROBE_API_KEY: 'sk-new' },
    });
    expect(preferred.config.get('account')).toEqual({ apiKey: 'sk-new' });
    expect(
      preferred.config.diagnostics().some((entry) => entry.message.includes('is deprecated')),
    ).toBe(false);
    await preferred.harness.close();
  });

  it('persists user-target writes as snake_case while preserving comments, and keeps memory writes in memory', async () => {
    const file = fakePersist(
      '# top comment\n\n[limits]\n# keep me\ntimeout = 5\n\n[account]\napi_key = "sk-file"\nplan = "free"\n',
    );
    const { harness, config } = await mountConfigApp({
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
    expect(written).toContain('max_retries = 7');
    expect(written).not.toContain('maxRetries');
    await config.set('account', { apiKey: 'sk-written', plan: 'pro' }, 'user');
    const stripped = file.saved.at(-1)!;
    expect(stripped).not.toContain('sk-written');
    expect(stripped).not.toContain('sk-env');
    expect(stripped).toContain('api_key = "sk-file"');
    expect(stripped).toContain('plan = "pro"');
    expect(config.get('account')).toEqual({ apiKey: 'sk-env', plan: 'pro' });
    await config.replace({ limits: { timeout: 1 } }, 'user');
    const replaced = file.saved.at(-1)!;
    expect(replaced).toContain('timeout = 1');
    expect(replaced).toContain('max_retries = 7');
    await harness.close();
  });

  it('reloads from disk and updates section refs', async () => {
    const file = fakePersist('[limits]\ntimeout = 5\n');
    const { harness, config } = await mountConfigApp({ persist: file.persist });
    expect(config.get('limits')).toEqual({ timeout: 5 });
    file.setText('[limits]\ntimeout = 9\nmax_retries = 1\n');
    await config.reload();
    expect(config.get('limits')).toEqual({ maxRetries: 1, timeout: 9 });
    expect(config.section('limits').value).toEqual({ maxRetries: 1, timeout: 9 });
    await harness.close();
  });

  it('reports validation and deprecation diagnostics from the snake_case disk keys', async () => {
    const file = fakePersist('[limits]\ntimeout = "soon"\n\n[account]\napi_token = "abc"\n');
    const { harness, config } = await mountConfigApp({ persist: file.persist });
    const diagnostics = config.diagnostics();
    expect(
      diagnostics.some(
        (entry) =>
          entry.section === 'limits' && entry.message.includes('Ignored invalid config section'),
      ),
    ).toBe(true);
    expect(
      diagnostics.some(
        (entry) =>
          entry.section === 'account' &&
          entry.message.includes("[account] 'api_token' is deprecated") &&
          entry.message.includes("'api_key'"),
      ),
    ).toBe(true);
    expect(config.get('limits')).toEqual({ maxRetries: 3 });
    await harness.close();
  });

  it('passes unregistered sections through with first-level case conversion on get and set', async () => {
    const file = fakePersist('[custom_domain]\nfoo_bar = 1\n\n[other]\nkey = 1\n');
    const { harness, config } = await mountConfigApp({ persist: file.persist });
    expect(config.get('customDomain')).toEqual({ fooBar: 1 });
    expect(config.get('missingDomain')).toBeUndefined();
    await config.set('customDomain', { bazQux: 2 }, 'user');
    const written = file.saved.at(-1)!;
    expect(written).toContain('baz_qux = 2');
    expect(written).toContain('foo_bar = 1');
    expect(written).toContain('[other]');
    expect(config.get('customDomain')).toEqual({ fooBar: 1, bazQux: 2 });
    await config.replace({ customDomain: { onlyLeft: true } }, 'user');
    expect(config.get('customDomain')).toEqual({ onlyLeft: true });
    expect(file.saved.at(-1)).toContain('only_left = true');
    await harness.close();
  });

  it('merges unregistered memory writes with deepMerge and leaves registered strictness intact', async () => {
    const { harness, config } = await mountConfigApp({});
    await config.set('scratch', { a: 1, nested: { x: 1 } }, 'memory');
    await config.set('scratch', { nested: { y: 2 } }, 'memory');
    expect(config.get('scratch')).toEqual({ a: 1, nested: { x: 1, y: 2 } });
    expect(config.section('scratch').value).toEqual({ a: 1, nested: { x: 1, y: 2 } });
    await config.replace({ scratch: null }, 'memory');
    expect(config.get('scratch')).toBeUndefined();
    await harness.close();
  });

  it('gates readiness on the initial load', async () => {
    let release: (text: string | undefined) => void = () => {};
    const gate = new Promise<string | undefined>((resolve) => {
      release = resolve;
    });
    const persist: ConfigPersist = {
      load: () => gate,
      save: () => Promise.resolve(),
    };
    const capture: { config?: Readonly<ShallowRef<ConfigStore | undefined>> } = {};
    const probe = configProbe(capture, [limitsSection], []);
    const spec = createConfig({ persist });
    const harness = createHarness({ space: memoryHarnessSpace() });
    harness.app.features.add(probe);
    harness.app.features.add(spec);
    let loaded = false;
    const onLoaded = harness.app
      .wait(spec, 'config.changed', {
        match: (event) => (event.value as LimitsConfig).timeout === 4,
      })
      .then(() => {
        loaded = true;
      });
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loaded).toBe(false);
    const config = capture.config?.value;
    if (config === undefined) throw new Error('config store was not exposed');
    expect(config.get('limits')).toEqual({ maxRetries: 3 });
    release('[limits]\ntimeout = 4\n');
    await onLoaded;
    await config.reload();
    expect(loaded).toBe(true);
    expect(config.get('limits')).toEqual({ timeout: 4 });
    await harness.close();
  });

  it('runs memory-only when no persist is configured', async () => {
    const { harness, config } = await mountConfigApp({});
    expect(config.get('limits')).toEqual({ maxRetries: 3 });
    await config.set('limits', { timeout: 2 }, 'memory');
    expect(config.get('limits')).toEqual({ timeout: 2 });
    await expect(config.set('limits', { timeout: 3 }, 'user')).rejects.toThrow('persist');
    await harness.close();
  });

  it('exposes the configured env source through the facade', async () => {
    const { harness, config } = await mountConfigApp({ env: { PROBE_KEY: 'from-config' } });
    expect(config.env('PROBE_KEY')).toBe('from-config');
    expect(config.env('PROBE_MISSING')).toBeUndefined();
    await harness.close();
  });

  it('applies contributed overlays over delivered values and keeps them out of persisted content', async () => {
    const file = fakePersist('[limits]\ntimeout = 5\n');
    const { harness, config } = await mountConfigApp({
      persist: file.persist,
      env: { PROBE_OVERLAY: '1' },
      overlays: [probeOverlay],
    });
    expect(config.get('limits')).toEqual({ timeout: 999 });
    expect(config.section('limits').value).toEqual({ timeout: 999 });
    expect(config.get('ghost')).toEqual({ injected: true });

    file.setText('[limits]\ntimeout = 8\n');
    await config.reload();
    expect(config.get('limits')).toEqual({ timeout: 999 });

    await config.set('limits', { timeout: 100 }, 'memory');
    expect(config.get('limits')).toEqual({ timeout: 100 });
    await config.replace({ limits: undefined }, 'memory');
    expect(config.get('limits')).toEqual({ timeout: 999 });

    await config.replace({ limits: { timeout: 999, maxRetries: 3 }, ghost: { injected: true } }, 'user');
    const written = file.saved.at(-1)!;
    expect(written).toContain('timeout = 8');
    expect(written).toContain('max_retries = 3');
    expect(written).not.toContain('999');
    expect(written).not.toContain('ghost');
    expect(written).not.toContain('injected');
    expect(config.get('limits')).toEqual({ maxRetries: 3, timeout: 999 });
    await harness.close();

    const plain = await mountConfigApp({
      persist: fakePersist('[limits]\ntimeout = 5\n').persist,
      overlays: [probeOverlay],
    });
    expect(plain.config.get('limits')).toEqual({ timeout: 5 });
    expect(plain.config.get('ghost')).toBeUndefined();
    await plain.harness.close();
  });

  it('emits config.changed with the section name and new value', async () => {
    const spec = createConfig({});
    const capture: { config?: Readonly<ShallowRef<ConfigStore | undefined>> } = {};
    const probe = configProbe(capture, [limitsSection], []);
    const harness = createHarness({ space: memoryHarnessSpace() });
    const events: ConfigChangedEvent[] = [];
    harness.app.on(spec, 'config.changed', (event) => {
      events.push(event);
    });
    harness.app.features.add(probe);
    harness.app.features.add(spec);
    await tick();
    const config = capture.config?.value;
    if (config === undefined) throw new Error('config store was not exposed');
    await config.set('limits', { maxRetries: 8 }, 'memory');
    expect(
      events.some(
        (event) =>
          event.section === 'limits' &&
          event.source === 'set' &&
          (event.value as LimitsConfig).maxRetries === 8,
      ),
    ).toBe(true);
    await harness.close();
  });
});

describe('planConfigWriteback', () => {
  function edit(
    text: string,
    snakeKey: string,
    previousValue: unknown,
    nextValue: unknown,
    expected: Record<string, unknown>,
  ): string | undefined {
    const update: DomainUpdate = { snakeKey, previousValue, nextValue };
    return planConfigWriteback(text, [update], expected);
  }

  it('rewrites only the changed statement and keeps adjacent comments and key formatting', () => {
    const text = ['[image]', '# keep me', 'max_edge_px   =   1500', 'quality = "high"', ''].join('\n');
    const result = edit(
      text,
      'image',
      { max_edge_px: 1500, quality: 'high' },
      { max_edge_px: 2000, quality: 'high' },
      { image: { max_edge_px: 2000, quality: 'high' } },
    );
    expect(result).toBe('[image]\n# keep me\nmax_edge_px   =   2000\nquality = "high"\n');
  });

  it('edits a scalar top-level domain in place and keeps the trailing comment', () => {
    const text = 'default_model = "kimi-k2"   # pick one\n';
    const result = edit(text, 'default_model', 'kimi-k2', 'kimi-k3', { default_model: 'kimi-k3' });
    expect(result).toBe('default_model = "kimi-k3"   # pick one\n');
  });

  it('appends a new key after the last statement of its block, before trailing trivia', () => {
    const text = ['[image]', 'max_edge_px = 1500', '# tail note', ''].join('\n');
    const result = edit(
      text,
      'image',
      { max_edge_px: 1500 },
      { max_edge_px: 1500, read_byte_budget: 5000 },
      { image: { max_edge_px: 1500, read_byte_budget: 5000 } },
    );
    expect(result).toBe('[image]\nmax_edge_px = 1500\nread_byte_budget = 5000\n# tail note\n');
  });

  it('deletes only the removed key line and keeps surrounding comments', () => {
    const text = ['[image]', '# about edge', 'max_edge_px = 1500', 'quality = "high"', ''].join('\n');
    const result = edit(
      text,
      'image',
      { max_edge_px: 1500, quality: 'high' },
      { quality: 'high' },
      { image: { quality: 'high' } },
    );
    expect(result).toBe('[image]\n# about edge\nquality = "high"\n');
  });

  it('edits one provider in place, drops a removed provider block and appends a new one', () => {
    const text = [
      '[providers]',
      '',
      '# acme provider',
      '[providers.acme]',
      'base_url = "https://acme.example.com"',
      'api_key = "acme-key"',
      '',
      '[providers.beta]',
      'base_url = "https://beta.example.com"',
      'api_key = "beta-key"',
      '',
    ].join('\n');
    const gamma = { base_url: 'https://gamma.example.com', api_key: 'gamma-key' };
    const result = edit(
      text,
      'providers',
      {
        acme: { base_url: 'https://acme.example.com', api_key: 'acme-key' },
        beta: { base_url: 'https://beta.example.com', api_key: 'beta-key' },
      },
      {
        acme: { base_url: 'https://acme.example.com', api_key: 'acme-key-2' },
        gamma,
      },
      {
        providers: {
          acme: { base_url: 'https://acme.example.com', api_key: 'acme-key-2' },
          gamma,
        },
      },
    );
    expect(result).toBe(
      [
        '[providers]',
        '',
        '# acme provider',
        '[providers.acme]',
        'base_url = "https://acme.example.com"',
        'api_key = "acme-key-2"',
        '',
        '[providers.gamma]',
        'base_url = "https://gamma.example.com"',
        'api_key = "gamma-key"',
        '',
      ].join('\n'),
    );
  });

  it('falls back to re-serializing a dotted-key domain while preserving other domains', () => {
    const text = 'a.b = 1\n\n[cool]\nx = 1\n';
    const result = edit(text, 'a', { b: 1 }, { b: 2 }, { a: { b: 2 }, cool: { x: 1 } });
    expect(result).toBe('[a]\nb = 2\n\n[cool]\nx = 1\n');
  });

  it('does not treat multiline string bodies or bracketed array items as table headers', () => {
    const text = [
      '[custom]',
      'notes = """',
      '[fake]',
      '"""',
      'list = [ "]", "[" ]',
      '',
      '[image]',
      'max_edge_px = 1500',
      '',
    ].join('\n');
    const result = edit(text, 'image', { max_edge_px: 1500 }, { max_edge_px: 2000 }, {
      custom: { notes: '[fake]\n', list: [']', '['] },
      image: { max_edge_px: 2000 },
    });
    expect(result).toBe(
      [
        '[custom]',
        'notes = """',
        '[fake]',
        '"""',
        'list = [ "]", "[" ]',
        '',
        '[image]',
        'max_edge_px = 2000',
        '',
      ].join('\n'),
    );
  });

  it('preserves CRLF everywhere and writes the edited statement with CRLF', () => {
    const text = '# note\r\n[image]\r\nmax_edge_px = 1500\r\n';
    const result = edit(text, 'image', { max_edge_px: 1500 }, { max_edge_px: 2000 }, {
      image: { max_edge_px: 2000 },
    });
    expect(result).toBe('# note\r\n[image]\r\nmax_edge_px = 2000\r\n');
  });

  it('appends a new domain to a file without a trailing newline', () => {
    const text = '[image]\nmax_edge_px = 1500';
    const result = edit(text, 'thinking', undefined, { effort: 'high' }, {
      image: { max_edge_px: 1500 },
      thinking: { effort: 'high' },
    });
    expect(result).toBe('[image]\nmax_edge_px = 1500\n[thinking]\neffort = "high"\n');
  });

  it('removes a deleted domain region and keeps neighboring trivia', () => {
    const text = ['# head', '[image]', 'max_edge_px = 1500', '', '# tail', '[tail]', 'x = 1', ''].join('\n');
    const result = edit(text, 'image', { max_edge_px: 1500 }, undefined, { tail: { x: 1 } });
    expect(result).toBe('# head\n\n# tail\n[tail]\nx = 1\n');
  });

  it('declines to plan when the file contains constructs it cannot map', () => {
    const text = '"weird key" = 1\n';
    expect(edit(text, 'weird_key', 1, 2, { weird_key: 2 })).toBeUndefined();
  });

  it('declines to plan when the data and the text disagree about a domain', () => {
    const text = '[image]\nmax_edge_px = 1500\n';
    expect(edit(text, 'image', undefined, { max_edge_px: 2000 }, { image: { max_edge_px: 2000 } })).toBeUndefined();
  });

  it('edits inside a quoted sub-table region at key level', () => {
    const text = '[models."acme/m1"]\n# keep\nname = "m1"\nmax_context_size = 1000\n';
    const result = edit(
      text,
      'models',
      { 'acme/m1': { name: 'm1', max_context_size: 1000 } },
      { 'acme/m1': { name: 'm1x', max_context_size: 1000 } },
      { models: { 'acme/m1': { name: 'm1x', max_context_size: 1000 } } },
    );
    expect(result).toBe('[models."acme/m1"]\n# keep\nname = "m1x"\nmax_context_size = 1000\n');
  });

  it('removes one quoted model entry and appends another with a quoted header', () => {
    const text = '[models."acme/m1"]\nname = "m1"\n';
    const result = edit(text, 'models', { 'acme/m1': { name: 'm1' } }, { 'beta/m2': { name: 'm2' } }, {
      models: { 'beta/m2': { name: 'm2' } },
    });
    expect(result).toBe('[models."beta/m2"]\nname = "m2"\n');
  });
});
