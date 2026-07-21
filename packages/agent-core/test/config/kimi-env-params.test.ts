import { type ChatProvider, KimiChatProvider } from '@moonshot-ai/kosong';
import { AnthropicChatProvider } from '@moonshot-ai/kosong/providers/anthropic';
import { describe, expect, it } from 'vitest';

import {
  applyAnthropicThinkingKeep,
  applyKimiEnvSamplingParams,
  applyKimiEnvThinkingKeep,
  resolveKimiEnvThinkingEffort,
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

describe('resolveKimiEnvThinkingEffort', () => {
  it('returns the trimmed force override for an enabled Kimi model', () => {
    expect(
      resolveKimiEnvThinkingEffort('high', true, {
        KIMI_MODEL_THINKING_EFFORT: ' max ',
      }),
    ).toBe('max');
  });

  it('lowercases the force override', () => {
    expect(
      resolveKimiEnvThinkingEffort('high', true, {
        KIMI_MODEL_THINKING_EFFORT: ' MAX ',
      }),
    ).toBe('max');
  });

  it('does not override an explicit off effort', () => {
    expect(
      resolveKimiEnvThinkingEffort('off', true, {
        KIMI_MODEL_THINKING_EFFORT: 'max',
      }),
    ).toBeUndefined();
  });

  it('ignores an unset or blank force override', () => {
    expect(resolveKimiEnvThinkingEffort('high', true, {})).toBeUndefined();
    expect(
      resolveKimiEnvThinkingEffort('high', true, {
        KIMI_MODEL_THINKING_EFFORT: '  ',
      }),
    ).toBeUndefined();
  });

  it('does not apply the Kimi force override to another provider', () => {
    expect(
      resolveKimiEnvThinkingEffort('high', false, {
        KIMI_MODEL_THINKING_EFFORT: 'max',
      }),
    ).toBeUndefined();
  });
});

function anthropic(): AnthropicChatProvider {
  return new AnthropicChatProvider({ model: 'claude-sonnet-4-6', apiKey: 'k' });
}

interface AnthropicKeepState {
  contextManagement?: { edits: Array<{ type: string; keep?: string }> };
  betaFeatures?: string[];
}

function anthropicState(provider: ChatProvider): AnthropicKeepState {
  return Reflect.get(provider as object, '_generationKwargs') as AnthropicKeepState;
}

describe('applyAnthropicThinkingKeep', () => {
  it('injects context_management keep="all" by default when thinking is on', () => {
    const out = applyAnthropicThinkingKeep(anthropic(), 'high', {});
    expect(anthropicState(out).contextManagement).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
    expect(anthropicState(out).betaFeatures).toContain('context-management-2025-06-27');
  });

  it('injects keep from env when thinking is on', () => {
    const out = applyAnthropicThinkingKeep(anthropic(), 'high', { KIMI_MODEL_THINKING_KEEP: 'all' });
    expect(anthropicState(out).contextManagement?.edits[0]?.keep).toBe('all');
  });

  it('injects keep from config when env is unset', () => {
    const out = applyAnthropicThinkingKeep(anthropic(), 'high', {}, 'all');
    expect(anthropicState(out).contextManagement?.edits[0]?.keep).toBe('all');
  });

  it('env takes precedence over config', () => {
    const out = applyAnthropicThinkingKeep(
      anthropic(),
      'high',
      { KIMI_MODEL_THINKING_KEEP: 'all' },
      'off',
    );
    expect(anthropicState(out).contextManagement?.edits[0]?.keep).toBe('all');
  });

  it.each(['off', 'false', '0', 'no', 'none', 'null', 'OFF', 'None'])(
    'env off-value %s disables keep even when config enables it',
    (off) => {
      const out = applyAnthropicThinkingKeep(
        anthropic(),
        'high',
        { KIMI_MODEL_THINKING_KEEP: off },
        'all',
      );
      expect(anthropicState(out).contextManagement).toBeUndefined();
    },
  );

  it.each(['off', 'none', 'null'])('config off-value %s disables keep by default', (off) => {
    const out = applyAnthropicThinkingKeep(anthropic(), 'high', {}, off);
    expect(anthropicState(out).contextManagement).toBeUndefined();
  });

  it('blank env falls through to config', () => {
    const out = applyAnthropicThinkingKeep(
      anthropic(),
      'high',
      { KIMI_MODEL_THINKING_KEEP: '  ' },
      'off',
    );
    expect(anthropicState(out).contextManagement).toBeUndefined();
  });

  it('does NOT inject context_management when thinking is off', () => {
    const out = applyAnthropicThinkingKeep(anthropic(), 'off', { KIMI_MODEL_THINKING_KEEP: 'all' });
    expect(anthropicState(out).contextManagement).toBeUndefined();
  });

  it('does not duplicate the context-management beta on repeated calls', () => {
    const out = applyAnthropicThinkingKeep(
      applyAnthropicThinkingKeep(anthropic(), 'high', {}),
      'high',
      {},
    );
    const betas = anthropicState(out).betaFeatures ?? [];
    expect(betas.filter((b) => b === 'context-management-2025-06-27')).toHaveLength(1);
  });

  it('leaves non-anthropic providers untouched', () => {
    const stub = { name: 'stub' } as unknown as ChatProvider;
    expect(applyAnthropicThinkingKeep(stub, 'high', { KIMI_MODEL_THINKING_KEEP: 'all' })).toBe(stub);
  });
});
