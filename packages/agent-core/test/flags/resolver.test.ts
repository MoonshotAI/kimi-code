import { describe, expect, it } from 'vitest';

import {
  FLAG_DEFINITIONS,
  MASTER_ENV,
  FlagResolver,
  type FlagDefinitionInput,
  type FlagId,
} from '../../src/flags';

// Controlled fake definitions to assert the precedence matrix precisely (independent of the
// real registry contents).
const DEFS = [
  {
    id: 'a-on-default',
    title: 'A on default',
    description: 'Fake flag A.',
    env: 'KIMI_CODE_EXPERIMENTAL_A',
    default: true,
    surface: 'core',
  },
  {
    id: 'b-off-default',
    title: 'B off default',
    description: 'Fake flag B.',
    env: 'KIMI_CODE_EXPERIMENTAL_B',
    default: false,
    surface: 'tui',
  },
] as const satisfies readonly FlagDefinitionInput[];

type Env = Record<string, string | undefined>;

function make(env: Env) {
  const resolver = new FlagResolver(env, DEFS);
  // The fake ids are not part of the real FlagId union, so cast to FlagId when calling.
  return (id: string) => resolver.enabled(id as FlagId);
}

describe('FlagResolver', () => {
  it('L3 default: returns the registry default when env is empty', () => {
    const enabled = make({});
    expect(enabled('a-on-default')).toBe(true);
    expect(enabled('b-off-default')).toBe(false);
  });

  it('L2 per-feature on (lenient truthy values)', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(make({ KIMI_CODE_EXPERIMENTAL_B: v })('b-off-default')).toBe(true);
    }
  });

  it('L2 per-feature off (lenient falsy values) overrides default=true', () => {
    for (const v of ['0', 'false', 'no', 'off']) {
      expect(make({ KIMI_CODE_EXPERIMENTAL_A: v })('a-on-default')).toBe(false);
    }
  });

  it('L2 unparseable value falls back to default', () => {
    expect(make({ KIMI_CODE_EXPERIMENTAL_B: 'maybe' })('b-off-default')).toBe(false);
    expect(make({ KIMI_CODE_EXPERIMENTAL_A: 'maybe' })('a-on-default')).toBe(true);
  });

  it('L1 master switch: every flag is on when enabled (including default=false)', () => {
    const enabled = make({ [MASTER_ENV]: '1' });
    expect(enabled('a-on-default')).toBe(true);
    expect(enabled('b-off-default')).toBe(true);
  });

  it('L1 master switch beats an L2 per-feature off', () => {
    const enabled = make({ [MASTER_ENV]: '1', KIMI_CODE_EXPERIMENTAL_A: '0' });
    expect(enabled('a-on-default')).toBe(true);
  });

  it('master switch is inactive for lenient falsy values', () => {
    const enabled = make({ [MASTER_ENV]: '0' });
    expect(enabled('b-off-default')).toBe(false);
  });

  it('returns a full snapshot and enabled ids in registry order', () => {
    const resolver = new FlagResolver({ KIMI_CODE_EXPERIMENTAL_B: '1' }, DEFS);
    expect(resolver.snapshot()).toEqual({
      'a-on-default': true,
      'b-off-default': true,
    });
    expect(resolver.enabledIds()).toEqual(['a-on-default', 'b-off-default']);
  });

  it('reads the env name declared in the registry (the declared name works, others do not)', () => {
    expect(make({ KIMI_CODE_EXPERIMENTAL_B: '1' })('b-off-default')).toBe(true);
    // The name mechanically derived from the id must not take effect (env is explicitly ..._B).
    expect(make({ KIMI_CODE_EXPERIMENTAL_B_OFF_DEFAULT: '1' })('b-off-default')).toBe(false);
  });

  it('unknown id resolves to false (defensive)', () => {
    expect(make({})('not-a-real-flag')).toBe(false);
  });

  it('uses config overrides between env and registry defaults', () => {
    const resolver = new FlagResolver({}, DEFS, {
      'a-on-default': false,
      'b-off-default': true,
    } as never);

    expect(resolver.enabled('a-on-default' as FlagId)).toBe(false);
    expect(resolver.enabled('b-off-default' as FlagId)).toBe(true);
  });

  it('keeps env precedence above config overrides', () => {
    const resolver = new FlagResolver(
      {
        KIMI_CODE_EXPERIMENTAL_A: '1',
        KIMI_CODE_EXPERIMENTAL_B: '0',
      },
      DEFS,
      {
        'a-on-default': false,
        'b-off-default': true,
      } as never,
    );

    expect(resolver.enabled('a-on-default' as FlagId)).toBe(true);
    expect(resolver.enabled('b-off-default' as FlagId)).toBe(false);
  });

  it('updates config overrides without leaking into another resolver', () => {
    const first = new FlagResolver({}, DEFS, { 'b-off-default': true } as never);
    const second = new FlagResolver({}, DEFS);

    expect(first.enabled('b-off-default' as FlagId)).toBe(true);
    expect(second.enabled('b-off-default' as FlagId)).toBe(false);

    first.setConfigOverrides({ 'b-off-default': false } as never);

    expect(first.enabled('b-off-default' as FlagId)).toBe(false);
    expect(second.enabled('b-off-default' as FlagId)).toBe(false);
  });

  it('explains the source of the effective value', () => {
    const defaulted = new FlagResolver({}, DEFS);
    expect(defaulted.explain('b-off-default' as FlagId)).toMatchObject({
      id: 'b-off-default',
      enabled: false,
      source: 'default',
      configValue: undefined,
    });

    const configured = new FlagResolver({}, DEFS, { 'b-off-default': true } as never);
    expect(configured.explain('b-off-default' as FlagId)).toMatchObject({
      enabled: true,
      source: 'config',
      configValue: true,
    });

    const fromEnv = new FlagResolver(
      { KIMI_CODE_EXPERIMENTAL_B: '0' },
      DEFS,
      { 'b-off-default': true } as never,
    );
    expect(fromEnv.explain('b-off-default' as FlagId)).toMatchObject({
      enabled: false,
      source: 'env',
      configValue: true,
    });
  });
});

describe('FLAG_DEFINITIONS invariants', () => {
  it('every env satisfies: prefix / unique / not the master switch', () => {
    const seenEnv = new Set<string>();
    const seenId = new Set<string>();
    const defs: readonly FlagDefinitionInput[] = FLAG_DEFINITIONS;
    for (const def of defs) {
      expect(def.env.startsWith('KIMI_CODE_EXPERIMENTAL_')).toBe(true);
      expect(def.env).not.toBe(MASTER_ENV);
      expect(def.id).not.toBe('flag'); // reserved: would collide with the master switch
      expect(def.title.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(seenEnv.has(def.env)).toBe(false);
      expect(seenId.has(def.id)).toBe(false);
      seenEnv.add(def.env);
      seenId.add(def.id);
    }
  });
});
