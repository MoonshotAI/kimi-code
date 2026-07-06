import { type ChatProvider, KimiChatProvider } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  applyKimiEnvSamplingParams,
  applyKimiEnvThinkingEffort,
  applyKimiEnvThinkingKeep,
} from '../../src/config/kimi-env-params';
import { KimiError } from '../../src/errors';

function kimi(): KimiChatProvider {
  return new KimiChatProvider({ model: 'kimi-k2', apiKey: 'k' });
}

interface KimiGenerationState {
  temperature?: number;
  top_p?: number;
  extra_body?: { thinking?: { type?: string; effort?: string; keep?: unknown } };
}

function genState(provider: ChatProvider): KimiGenerationState {
  return Reflect.get(provider as object, '_generationKwargs') as KimiGenerationState;
}

function expectConfigInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(KimiError);
    expect((error as KimiError).code).toBe('config.invalid');
    return;
  }
  throw new Error('expected function to throw');
}

describe('applyKimiEnvSamplingParams', () => {
  it('returns the same provider when no env vars are set', () => {
    const provider = kimi();
    expect(applyKimiEnvSamplingParams(provider, {})).toBe(provider);
  });

  it('injects temperature and top_p for a kimi provider', () => {
    const out = applyKimiEnvSamplingParams(kimi(), {
      KIMI_MODEL_TEMPERATURE: '0.3',
      KIMI_MODEL_TOP_P: '0.95',
    });
    const state = genState(out);
    expect(state.temperature).toBe(0.3);
    expect(state.top_p).toBe(0.95);
  });

  it('leaves non-kimi providers untouched', () => {
    const stub = { name: 'stub' } as unknown as ChatProvider;
    expect(applyKimiEnvSamplingParams(stub, { KIMI_MODEL_TEMPERATURE: '0.3' })).toBe(stub);
  });

  it('throws config.invalid for an invalid temperature', () => {
    expectConfigInvalid(() =>
      applyKimiEnvSamplingParams(kimi(), { KIMI_MODEL_TEMPERATURE: 'abc' }),
    );
  });
});

describe('applyKimiEnvThinkingKeep', () => {
  it('injects thinking.keep="all" by default when thinking is on', () => {
    const out = applyKimiEnvThinkingKeep(kimi(), 'high', {});
    expect(genState(out).extra_body?.thinking?.keep).toBe('all');
  });

  it('injects thinking.keep from env when thinking is on', () => {
    const out = applyKimiEnvThinkingKeep(kimi(), 'high', { KIMI_MODEL_THINKING_KEEP: 'all' });
    expect(genState(out).extra_body?.thinking?.keep).toBe('all');
  });

  it('injects thinking.keep from config when env is unset', () => {
    const out = applyKimiEnvThinkingKeep(kimi(), 'high', {}, 'all');
    expect(genState(out).extra_body?.thinking?.keep).toBe('all');
  });

  it('env takes precedence over config', () => {
    const out = applyKimiEnvThinkingKeep(kimi(), 'high', { KIMI_MODEL_THINKING_KEEP: 'all' }, 'off');
    expect(genState(out).extra_body?.thinking?.keep).toBe('all');
  });

  it.each(['off', 'false', '0', 'no', 'none', 'null', 'OFF', 'None'])(
    'env off-value %s disables keep even when config enables it',
    (off) => {
      const out = applyKimiEnvThinkingKeep(kimi(), 'high', { KIMI_MODEL_THINKING_KEEP: off }, 'all');
      expect(genState(out).extra_body).toBeUndefined();
    },
  );

  it.each(['off', 'none', 'null'])('config off-value %s disables keep by default', (off) => {
    const out = applyKimiEnvThinkingKeep(kimi(), 'high', {}, off);
    expect(genState(out).extra_body).toBeUndefined();
  });

  it('blank env falls through to config', () => {
    const out = applyKimiEnvThinkingKeep(kimi(), 'high', { KIMI_MODEL_THINKING_KEEP: '  ' }, 'off');
    expect(genState(out).extra_body).toBeUndefined();
  });

  it('does NOT inject thinking.keep when thinking is off', () => {
    const out = applyKimiEnvThinkingKeep(kimi(), 'off', { KIMI_MODEL_THINKING_KEEP: 'all' });
    expect(genState(out).extra_body).toBeUndefined();
  });

  it('leaves non-kimi providers untouched', () => {
    const stub = { name: 'stub' } as unknown as ChatProvider;
    expect(applyKimiEnvThinkingKeep(stub, 'high', { KIMI_MODEL_THINKING_KEEP: 'all' })).toBe(stub);
  });
});

describe('applyKimiEnvThinkingEffort', () => {
  it('injects thinking.effort when thinking is on', () => {
    const out = applyKimiEnvThinkingEffort(kimi(), 'high', {
      KIMI_MODEL_THINKING_EFFORT: 'max',
    });
    expect(genState(out).extra_body?.thinking?.effort).toBe('max');
  });

  it('forces the effort even when the model does not declare it', () => {
    // kimi() has no support_efforts, so withThinking('high') carries no effort;
    // the env var injects one anyway, bypassing the support_efforts gate.
    const provider = kimi().withThinking('high');
    const out = applyKimiEnvThinkingEffort(provider, 'high', {
      KIMI_MODEL_THINKING_EFFORT: 'max',
    });
    expect(genState(out).extra_body?.thinking).toEqual({ type: 'enabled', effort: 'max' });
  });

  it('does NOT inject thinking.effort when thinking is off', () => {
    const out = applyKimiEnvThinkingEffort(kimi(), 'off', {
      KIMI_MODEL_THINKING_EFFORT: 'max',
    });
    expect(genState(out).extra_body).toBeUndefined();
  });

  it('returns the same provider when the env var is unset or blank', () => {
    const provider = kimi();
    expect(applyKimiEnvThinkingEffort(provider, 'high', {})).toBe(provider);
    expect(
      applyKimiEnvThinkingEffort(provider, 'high', { KIMI_MODEL_THINKING_EFFORT: '  ' }),
    ).toBe(provider);
  });

  it('leaves non-kimi providers untouched', () => {
    const stub = { name: 'stub' } as unknown as ChatProvider;
    expect(
      applyKimiEnvThinkingEffort(stub, 'high', { KIMI_MODEL_THINKING_EFFORT: 'max' }),
    ).toBe(stub);
  });
});
