import { describe, expect, it } from 'vitest';

import { previewPillLabel, type PrPreviewState } from '../../src/renderer/lib/prPreview';

describe('previewPillLabel', () => {
  it('is empty without a state and in passive phases', () => {
    expect(previewPillLabel(undefined)).toBe('');
    expect(previewPillLabel({ phase: 'idle' })).toBe('');
    expect(previewPillLabel({ phase: 'error', label: '#362' })).toBe('');
  });

  it('shows the target label while a preview builds', () => {
    for (const phase of ['fetching', 'installing', 'building'] as const) {
      expect(previewPillLabel({ phase, label: 'feat/branch' })).toBe('feat/branch');
    }
    expect(previewPillLabel({ phase: 'building' })).toBe('');
  });

  it('shows the serving label once active (falling back to the operation label)', () => {
    const active: PrPreviewState = { phase: 'active', label: 'main', servingLabel: 'main' };
    expect(previewPillLabel(active)).toBe('main');
    expect(previewPillLabel({ phase: 'active', label: '#362' })).toBe('#362');
    expect(previewPillLabel({ phase: 'active' })).toBe('');
  });
});
