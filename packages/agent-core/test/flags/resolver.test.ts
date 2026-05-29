import { describe, expect, it } from 'vitest';

import {
  EXPERIMENTAL_PREFIX,
  FLAG_DEFINITIONS,
  MASTER_ENV,
  createFlagResolver,
  flagEnvKey,
  type FlagDefinitionInput,
  type FlagId,
} from '../../src/flags';

// Controlled fake definitions to assert the precedence matrix precisely (independent of the
// real registry contents).
const DEFS = [
  {
    id: 'a-on-default',
    env: 'KIMI_CODE_EXPERIMENTAL_A',
    default: true,
    surface: 'core',
  },
  {
    id: 'b-off-default',
    env: 'KIMI_CODE_EXPERIMENTAL_B',
    default: false,
    surface: 'tui',
  },
] as const satisfies readonly FlagDefinitionInput[];

type Env = Record<string, string | undefined>;

function make(env: Env) {
  const resolver = createFlagResolver(env, DEFS);
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

  it('L1 master switch beats an L2 per-feature off (D2)', () => {
    const enabled = make({ [MASTER_ENV]: '1', KIMI_CODE_EXPERIMENTAL_A: '0' });
    expect(enabled('a-on-default')).toBe(true);
  });

  it('master switch is inactive for lenient falsy values', () => {
    const enabled = make({ [MASTER_ENV]: '0' });
    expect(enabled('b-off-default')).toBe(false);
  });

  it('reads the env name declared in the registry (the declared name works, others do not)', () => {
    expect(make({ KIMI_CODE_EXPERIMENTAL_B: '1' })('b-off-default')).toBe(true);
    // The name mechanically derived from the id must not take effect (env is explicitly ..._B).
    expect(make({ KIMI_CODE_EXPERIMENTAL_B_OFF_DEFAULT: '1' })('b-off-default')).toBe(false);
  });

  it('unknown id resolves to false (defensive)', () => {
    expect(make({})('not-a-real-flag')).toBe(false);
  });

  it('flagEnvKey convention: kebab -> prefix + upper snake', () => {
    expect(flagEnvKey('my-feature')).toBe('KIMI_CODE_EXPERIMENTAL_MY_FEATURE');
  });
});

describe('FLAG_DEFINITIONS invariants', () => {
  it('every env satisfies: prefix / unique / not the master switch', () => {
    const seenEnv = new Set<string>();
    const seenId = new Set<string>();
    const defs: readonly FlagDefinitionInput[] = FLAG_DEFINITIONS;
    for (const def of defs) {
      expect(def.env.startsWith(EXPERIMENTAL_PREFIX)).toBe(true);
      expect(def.env).not.toBe(MASTER_ENV);
      expect(def.id).not.toBe('flag'); // reserved: would collide with the master switch
      expect(seenEnv.has(def.env)).toBe(false);
      expect(seenId.has(def.id)).toBe(false);
      seenEnv.add(def.env);
      seenId.add(def.id);
    }
  });
});
