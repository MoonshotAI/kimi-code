import { describe, expect, it } from 'vitest';
import { catalogProviderModels } from '../src/catalog';
import { withCurrentMiniMaxModels } from '../src/minimax-catalog';

describe('public MiniMax catalog', () => {
  it.each(['https://api.minimax.io/anthropic', 'https://api.minimaxi.com/anthropic'])(
    'offers Flash first on %s without mutating legacy or media records', (api) => {
      const legacy = { id: 'MiniMax-M2.7', limit: { context: 204800 }, tool_call: true };
      const media = { id: 'speech-2.8-hd', modalities: { output: ['audio'] } };
      const original = { minimax: { id: 'minimax', api, npm: '@ai-sdk/anthropic', models: { legacy, media } } };
      const normalized = withCurrentMiniMaxModels(original);
      expect(Object.keys(normalized['minimax']!.models!)).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3', 'media']);
      expect(original.minimax.models).toEqual({ legacy, media });
      expect(normalized['minimax']!.models!['media']).toBe(media);
      const models = catalogProviderModels(normalized['minimax']!);
      expect(models.map((model) => model.id)).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3']);
      expect(models[0]).toMatchObject({
        maxOutputSize: 524288,
        alwaysThinking: true,
        defaultEffort: 'max',
        supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        capability: { max_context_tokens: 1000000, image_in: true, video_in: true },
      });
      expect(models[0]!.offEffort).toBeUndefined();
      expect(models[1]!.alwaysThinking).toBeUndefined();
    },
  );

  it('retains gateway IDs, limits and unrelated defaults without inventing a Flash route', () => {
    const model = (id: string) => ({ id, tool_call: true, limit: { context: 123456, output: 8192 } });
    const gateway = { id: 'openrouter', models: {
      other: model('unrelated-model'),
      old: model('minimax/minimax-m2.7'),
      m3: model('minimax/minimax-m3'),
      flash: model('minimax/minimax-m3.1-flash:free'),
      media: { ...model('MiniMax-M1-audio'), modalities: { output: ['audio'] } },
    } };
    const result = withCurrentMiniMaxModels({ gateway })['gateway']!;
    expect(Object.keys(result.models!)).toEqual(['other', 'flash', 'm3', 'media']);
    expect(result.models!['flash']).toBe(gateway.models.flash);
    expect(result.models!['other']).toBe(gateway.models.other);
    expect(result.models!['media']).toBe(gateway.models.media);
    const onlyM3 = withCurrentMiniMaxModels({ gateway: { ...gateway, models: { m3: gateway.models.m3 } } });
    expect(onlyM3['gateway']!.models).toEqual({ m3: gateway.models.m3 });
  });

  it('does not filter explicit catalog normalization used by custom registries', () => {
    const models = catalogProviderModels({ id: 'private', npm: '@ai-sdk/openai-compatible', models: {
      old: { id: 'MiniMax-M2.7', tool_call: true, limit: { context: 204800 } },
    } });
    expect(models[0]!.id).toBe('MiniMax-M2.7');
  });
});
