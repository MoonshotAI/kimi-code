import { type ChatProvider, KimiChatProvider } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { applyKimiEnvSamplingParams, applyKimiEnvThinkingKeep } from '../../src/agent/kimi-env-params';
import { KimiError } from '../../src/errors';

function kimi(): KimiChatProvider {
  return new KimiChatProvider({ model: 'kimi-k2', apiKey: 'k' });
}

interface KimiGenerationState {
  temperature?: number;
  top_p?: number;
  extra_body?: { thinking?: { keep?: unknown } };
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
  it('injects thinking.keep when thinking is on', () => {
    const out = applyKimiEnvThinkingKeep(kimi(), 'high', { KIMI_MODEL_THINKING_KEEP: 'all' });
    expect(genState(out).extra_body?.thinking?.keep).toBe('all');
  });

  it('does NOT inject thinking.keep when thinking is off', () => {
    const out = applyKimiEnvThinkingKeep(kimi(), 'off', { KIMI_MODEL_THINKING_KEEP: 'all' });
    expect(genState(out).extra_body).toBeUndefined();
  });

  it('returns the same provider when keep is unset', () => {
    const provider = kimi();
    expect(applyKimiEnvThinkingKeep(provider, 'high', {})).toBe(provider);
  });

  it('leaves non-kimi providers untouched', () => {
    const stub = { name: 'stub' } as unknown as ChatProvider;
    expect(applyKimiEnvThinkingKeep(stub, 'high', { KIMI_MODEL_THINKING_KEEP: 'all' })).toBe(stub);
  });
});
