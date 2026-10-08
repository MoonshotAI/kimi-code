export interface ProviderImagePolicy {
  readonly acceptedMimes: ReadonlySet<string>;
  readonly inlineByteBudget: number;
}

export const DEFAULT_INLINE_IMAGE_BYTE_BUDGET = 3.75 * 1024 * 1024;

const BASELINE_IMAGE_POLICY: ProviderImagePolicy = {
  acceptedMimes: new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  inlineByteBudget: DEFAULT_INLINE_IMAGE_BYTE_BUDGET,
};

const KIMI_IMAGE_POLICY: ProviderImagePolicy = {
  acceptedMimes: new Set([
    ...BASELINE_IMAGE_POLICY.acceptedMimes,
    'image/bmp',
    'image/heic',
    'image/heif',
  ]),
  inlineByteBudget: 5 * 1024 * 1024,
};

export function providerImagePolicy(provider?: string): ProviderImagePolicy {
  return provider === 'kimi' ? KIMI_IMAGE_POLICY : BASELINE_IMAGE_POLICY;
}
