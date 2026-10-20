import { describe, expect, it } from 'vitest';
import { modelsDevProviderModels } from '#/app/kosongConfig/modelsDev';
import { withCurrentMiniMaxModels } from '#/app/kosongConfig/modelsDevMiniMax';

describe('MiniMax public directory', () => {
  it.each(['https://api.minimax.io/anthropic', 'https://api.minimaxi.com/anthropic'])(
    'offers Flash first at %s and retains original records', (api) => {
      const legacy = { id: 'MiniMax-M2.7', limit: { context: 204800 } };
      const media = { id: 'speech-2.8-hd', modalities: { output: ['audio'] } };
      const original = { minimax: { id: 'minimax', api, models: { legacy, media } } };
      const catalog = withCurrentMiniMaxModels(original);
      const models = modelsDevProviderModels(catalog['minimax']!);
      expect(models.map((model) => model.id)).toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3']);
      expect(models[0]).toMatchObject({
        alwaysThinking: true, defaultEffort: 'max', maxOutputSize: 524288,
        supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        capability: { max_context_tokens: 1000000, image_in: true, video_in: true },
      });
      expect(models[1]!.alwaysThinking).toBeUndefined();
      expect(original.minimax.models).toEqual({ legacy, media });
      expect(catalog['minimax']!.models!['media']).toBe(media);
    },
  );
  it('retains gateway metadata and unrelated defaults while leaving custom normalization alone', () => {
    const model = (id: string) => ({ id, limit: { context: 123456, output: 8192 } });
    const gateway = { id: 'openrouter', models: {
      other: model('unrelated-model'), old: model('minimax/minimax-m2.7'),
      m3: model('minimax/minimax-m3'), flash: model('minimax/minimax-m3.1-flash:free'),
    } };
    const normalized = withCurrentMiniMaxModels({ gateway })['gateway']!;
    expect(Object.keys(normalized.models!)).toEqual(['other', 'flash', 'm3']);
    expect(normalized.models!['flash']).toBe(gateway.models.flash);
    expect(modelsDevProviderModels(gateway).map((entry) => entry.id)).toContain('minimax/minimax-m2.7');
  });
});
