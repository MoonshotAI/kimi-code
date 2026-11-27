import { afterEach, describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';
import { formatDuration } from '@moonshot-ai/app-core/lib';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import { clientLocale, resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';

afterEach(() => {
  resetKimiClientDeps();
});

describe('clientLocale', () => {
  it('defaults to en when no locale getter is injected', () => {
    setKimiClientDeps({ api: () => ({}) as unknown as KimiWebApi, t: (key) => key });
    expect(clientLocale()).toBe('en');
  });

  it('tracks the host reactive locale inside computed duration projections', () => {
    const locale = ref<'en' | 'zh'>('en');
    setKimiClientDeps({
      api: () => ({}) as unknown as KimiWebApi,
      t: (key) => key,
      locale: () => locale.value,
    });
    const label = computed(() => formatDuration(2_877_480_000, clientLocale()));
    expect(label.value).toBe('33d 7h');
    locale.value = 'zh';
    expect(label.value).toBe('33 天 7 小时');
  });
});
