<script setup lang="ts">
import { computed } from 'vue';
import { MANAGED_KIMI_CODE_PROVIDER_ID } from '@moonshot-ai/app-core/api';
import { matchProviderPreset, matchProviderPresetByBaseUrl } from '@moonshot-ai/app-core/lib';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import kimiSvg from '@lobehub/icons-static-svg/icons/kimi.svg?raw';
import zaiSvg from '@lobehub/icons-static-svg/icons/zai.svg?raw';
import zhipuSvg from '@lobehub/icons-static-svg/icons/zhipu.svg?raw';
import deepseekSvg from '@lobehub/icons-static-svg/icons/deepseek.svg?raw';
import minimaxSvg from '@lobehub/icons-static-svg/icons/minimax.svg?raw';
import qwenSvg from '@lobehub/icons-static-svg/icons/qwen.svg?raw';

type Brand = 'kimi' | 'zai' | 'zhipu' | 'deepseek' | 'minimax' | 'qwen';

const BRAND_SVGS: Record<Brand, string> = {
  kimi: kimiSvg,
  zai: zaiSvg,
  zhipu: zhipuSvg,
  deepseek: deepseekSvg,
  minimax: minimaxSvg,
  qwen: qwenSvg,
};

const props = withDefaults(
  defineProps<{
    id: string;
    size?: 'xs' | 'sm' | 'md' | 'lg';
  }>(),
  { size: 'md' },
);

const client = useKimiWebClient();

const provider = computed(() => client.providers.value.find((p) => p.id === props.id));

const brand = computed<Brand | null>(() => {
  if (props.id === MANAGED_KIMI_CODE_PROVIDER_ID) return 'kimi';
  return (
    matchProviderPreset(props.id, client.presetCatalogProviders.value)?.preset.icon ??
    matchProviderPresetByBaseUrl(provider.value?.baseUrl, client.presetCatalogProviders.value)
      ?.preset.icon ??
    null
  );
});

const svg = computed(() => (brand.value === null ? null : BRAND_SVGS[brand.value]));

const letter = computed(() => props.id.trim().charAt(0).toUpperCase() || '?');
</script>

<template>
  <span class="pbi" :class="[`pbi-${size}`, brand !== null ? `pbi-${brand}` : 'pbi-fallback']" aria-hidden="true">
    <!-- eslint-disable-next-line vue/no-v-html -->
    <span v-if="svg !== null" class="pbi-glyph" v-html="svg" />
    <span v-else class="pbi-letter">{{ letter }}</span>
  </span>
</template>

<style scoped>
.pbi {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.pbi-glyph {
  display: inline-flex;
  color: #fff;
}
.pbi-glyph :deep(svg) {
  display: block;
}
.pbi-xs { width: 16px; height: 16px; border-radius: 5px; font-size: 10px; }
.pbi-sm { width: 28px; height: 28px; border-radius: 8px; font-size: 16px; }
.pbi-md { width: 36px; height: 36px; border-radius: 10px; font-size: 20px; }
.pbi-lg { width: 44px; height: 44px; border-radius: 12px; font-size: 26px; }

.pbi-kimi { background: #0b0b0e; }
.pbi-zai { background: #111111; }
.pbi-zhipu { background: #3859ff; }
.pbi-deepseek { background: #4d6bfe; }
.pbi-minimax { background: linear-gradient(135deg, #e2167e, #fe603c); }
.pbi-qwen { background: linear-gradient(135deg, #6336e7, #6f69f7); }
.pbi-fallback { background: var(--color-fill-2); }
.pbi-letter {
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
.pbi-xs .pbi-letter { font-size: 10px; }
.pbi-sm .pbi-letter { font-size: var(--text-xs); }
.pbi-md .pbi-letter { font-size: var(--text-sm); }
.pbi-lg .pbi-letter { font-size: var(--text-base); }
</style>
