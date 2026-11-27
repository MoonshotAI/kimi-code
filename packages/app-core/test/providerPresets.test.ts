import { describe, expect, it } from 'vitest';
import {
  catalogNameToProviderId,
  kimiCodingProviderFor,
  matchProviderPreset,
  matchProviderPresetByBaseUrl,
  presetCatalogId,
  presetDisplayName,
  presetProviderId,
  PROVIDER_PRESETS,
} from '../src/lib/providerPresets';

describe('PROVIDER_PRESETS', () => {
  it('keeps the curated brand order with regions as separate presets', () => {
    expect(PROVIDER_PRESETS.map((p) => p.key)).toEqual([
      'kimi-for-coding',
      'kimi-global',
      'zai-intl',
      'zai-cn',
      'deepseek',
      'minimax-intl',
      'minimax-cn',
      'alibaba-intl',
      'alibaba-cn',
    ]);
  });

  it('maps every preset to a unique models.dev catalog id', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.catalogId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.catalogId).not.toBe('');
    }
  });
});

describe('matchProviderPreset', () => {
  it('matches by catalog id', () => {
    expect(matchProviderPreset('kimi-for-coding')?.preset.key).toBe('kimi-for-coding');
    expect(matchProviderPreset('zai-coding-plan')?.preset.key).toBe('zai-intl');
    expect(matchProviderPreset('zhipuai-coding-plan')?.preset.key).toBe('zai-cn');
    expect(matchProviderPreset('minimax-coding-plan')?.preset.key).toBe('minimax-intl');
    expect(matchProviderPreset('minimax-cn-coding-plan')?.preset.key).toBe('minimax-cn');
    expect(matchProviderPreset('deepseek')?.preset.key).toBe('deepseek');
    expect(matchProviderPreset('alibaba-coding-plan')?.preset.key).toBe('alibaba-intl');
    expect(matchProviderPreset('alibaba-coding-plan-cn')?.preset.key).toBe('alibaba-cn');
  });

  it('matches by candidate catalog ids', () => {
    expect(matchProviderPreset('kimi-code-plan-cn')?.preset.key).toBe('kimi-for-coding');
  });

  it('matches by catalog display name when entries are provided', () => {
    const entries = [
      { id: 'zai-coding-plan', name: 'Z.AI Coding Plan' },
      { id: 'minimax-cn-coding-plan', name: 'MiniMax Token Plan (minimaxi.com)' },
    ];
    expect(matchProviderPreset('ZAI Coding Plan', entries)?.preset.key).toBe('zai-intl');
    expect(matchProviderPreset('MiniMax Token Plan', entries)?.preset.key).toBe('minimax-cn');
    expect(matchProviderPreset('ZAI Coding Plan')).toBeNull();
  });

  it('matches by candidate entry display name', () => {
    const entries = [{ id: 'kimi-code-plan-cn', name: 'Kimi For Coding (kimi.com)' }];
    expect(matchProviderPreset('Kimi For Coding', entries)?.preset.key).toBe('kimi-for-coding');
  });

  it('returns null for unknown providers', () => {
    expect(matchProviderPreset('my-gateway')).toBeNull();
  });
});

describe('matchProviderPresetByBaseUrl', () => {
  const entries = [
    { id: 'zai-coding-plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
    { id: 'zhipuai-coding-plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
    { id: 'deepseek', baseUrl: 'https://api.deepseek.com' },
    { id: 'minimax-coding-plan', baseUrl: 'https://api.minimax.io/anthropic' },
    { id: 'minimax-cn-coding-plan', baseUrl: 'https://api.minimaxi.com/anthropic' },
    { id: 'alibaba-coding-plan', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1' },
    { id: 'alibaba-coding-plan-cn', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1' },
  ];

  it('matches by endpoint host', () => {
    expect(matchProviderPresetByBaseUrl('https://api.z.ai/api/coding/paas/v4', entries)?.preset.key).toBe('zai-intl');
    expect(matchProviderPresetByBaseUrl('https://open.bigmodel.cn/api/coding/paas/v4', entries)?.preset.key).toBe('zai-cn');
    expect(matchProviderPresetByBaseUrl('https://api.deepseek.com', entries)?.preset.key).toBe('deepseek');
    expect(matchProviderPresetByBaseUrl('https://api.minimax.io/anthropic', entries)?.preset.key).toBe('minimax-intl');
    expect(matchProviderPresetByBaseUrl('https://api.minimaxi.com/anthropic', entries)?.preset.key).toBe('minimax-cn');
    expect(matchProviderPresetByBaseUrl('https://coding-intl.dashscope.aliyuncs.com/v1', entries)?.preset.key).toBe('alibaba-intl');
    expect(matchProviderPresetByBaseUrl('https://coding.dashscope.aliyuncs.com/v1', entries)?.preset.key).toBe('alibaba-cn');
  });

  it('matches kimi override endpoints regardless of catalog presence', () => {
    expect(matchProviderPresetByBaseUrl('https://api.kimi.com/coding/v1', entries)?.preset.key).toBe('kimi-for-coding');
    expect(matchProviderPresetByBaseUrl('https://api.kimi.com/coding', entries)?.preset.key).toBe('kimi-for-coding');
    expect(matchProviderPresetByBaseUrl('https://api.kimi.ai/coding/v1', entries)?.preset.key).toBe('kimi-global');
  });

  it('returns null for unknown hosts and missing urls', () => {
    expect(matchProviderPresetByBaseUrl('https://api.example.com/v1', entries)).toBeNull();
    expect(matchProviderPresetByBaseUrl(undefined, entries)).toBeNull();
    expect(matchProviderPresetByBaseUrl('', entries)).toBeNull();
    expect(matchProviderPresetByBaseUrl('not-a-url', entries)).toBeNull();
  });
});

describe('presetCatalogId', () => {
  const preset = PROVIDER_PRESETS[0]!;

  it('prefers newer candidate ids when present', () => {
    const entries = [{ id: 'kimi-code-plan-cn' }, { id: 'kimi-for-coding' }];
    expect(presetCatalogId(preset, entries)).toBe('kimi-code-plan-cn');
  });

  it('falls back to older ids when newer ones are absent', () => {
    expect(presetCatalogId(preset, [{ id: 'kimi-for-coding' }])).toBe('kimi-for-coding');
    expect(presetCatalogId(preset, [])).toBe('kimi-for-coding');
  });
});

describe('catalogNameToProviderId', () => {
  it('keeps clean names as-is', () => {
    expect(catalogNameToProviderId('Kimi For Coding', 'kimi-for-coding')).toBe('Kimi For Coding');
    expect(catalogNameToProviderId('DeepSeek', 'deepseek')).toBe('DeepSeek');
  });

  it('strips characters the id pattern rejects', () => {
    expect(catalogNameToProviderId('Z.AI Coding Plan', 'zai-coding-plan')).toBe('ZAI Coding Plan');
    expect(catalogNameToProviderId('MiniMax Token Plan (minimaxi.com)', 'minimax-cn-coding-plan')).toBe(
      'MiniMax Token Plan',
    );
  });

  it('falls back to the catalog id when nothing usable remains', () => {
    expect(catalogNameToProviderId('', 'deepseek')).toBe('deepseek');
    expect(catalogNameToProviderId('...', 'deepseek')).toBe('deepseek');
  });
});

describe('presetDisplayName', () => {
  it('uses domain suffixes for Alibaba regional presets', () => {
    const intl = PROVIDER_PRESETS.find((p) => p.key === 'alibaba-intl')!;
    const cn = PROVIDER_PRESETS.find((p) => p.key === 'alibaba-cn')!;
    expect(presetDisplayName(intl, { name: 'Alibaba Coding Plan' }, 'Alibaba Coding Plan (alibabacloud.com)')).toBe(
      'Alibaba Coding Plan (alibabacloud.com)',
    );
    expect(presetDisplayName(cn, { name: 'Alibaba Coding Plan (China)' }, 'Alibaba Coding Plan (aliyun.com)')).toBe(
      'Alibaba Coding Plan (aliyun.com)',
    );
  });

  it('uses catalog display names for other presets', () => {
    const preset = PROVIDER_PRESETS.find((p) => p.key === 'deepseek')!;
    expect(presetDisplayName(preset, { name: 'DeepSeek' }, 'fallback')).toBe('DeepSeek');
    expect(presetDisplayName(preset, undefined, 'fallback')).toBe('fallback');
  });
});

describe('presetProviderId', () => {
  it('keeps Alibaba regional provider ids distinct', () => {
    const intl = PROVIDER_PRESETS.find((p) => p.key === 'alibaba-intl')!;
    const cn = PROVIDER_PRESETS.find((p) => p.key === 'alibaba-cn')!;
    expect(presetProviderId(intl, { name: 'Alibaba Coding Plan' })).toBe('alibaba-coding-plan');
    expect(presetProviderId(cn, { name: 'Alibaba Coding Plan (China)' })).toBe('alibaba-coding-plan-cn');
  });

  it('keeps display-name-derived ids for other presets', () => {
    const preset = PROVIDER_PRESETS.find((p) => p.key === 'deepseek')!;
    expect(presetProviderId(preset, { name: 'DeepSeek' })).toBe('DeepSeek');
  });
});

describe('kimiCodingProviderFor', () => {
  it('maps kimi catalog ids to the kimi protocol with v1 endpoints', () => {
    expect(kimiCodingProviderFor('kimi-for-coding')).toEqual({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
    });
    expect(kimiCodingProviderFor('kimi-for-coding-global')).toEqual({
      type: 'kimi',
      baseUrl: 'https://api.kimi.ai/coding/v1',
    });
    expect(kimiCodingProviderFor('kimi-code-plan-cn')).toEqual({
      type: 'kimi',
      baseUrl: 'https://api.kimi.com/coding/v1',
    });
    expect(kimiCodingProviderFor('kimi-code-plan-global')).toEqual({
      type: 'kimi',
      baseUrl: 'https://api.kimi.ai/coding/v1',
    });
  });

  it('returns null for other catalog ids', () => {
    expect(kimiCodingProviderFor('deepseek')).toBeNull();
    expect(kimiCodingProviderFor('zai-coding-plan')).toBeNull();
  });
});
