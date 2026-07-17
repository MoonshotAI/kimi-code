// Usage-panel positioning scenarios: side selection and viewport height limits.
// Uses the real pure helper with no mocked collaborators.
// Run with: pnpm --filter @moonshot-ai/kimi-web test -- usagePanelPosition.test.ts
import { describe, expect, it } from 'vitest';

import { calculateUsagePanelPosition } from './usagePanelPosition';

describe('usage panel viewport placement', () => {
  it('opens above with a top gutter when the larger space is above the trigger', () => {
    expect(
      calculateUsagePanelPosition(
        { top: 280, right: 300, bottom: 300 },
        { width: 320, height: 320 },
      ),
    ).toEqual({
      right: 20,
      bottom: 48,
      maxHeight: 264,
    });
  });

  it('opens below with a bottom gutter when the larger space is below the trigger', () => {
    expect(
      calculateUsagePanelPosition(
        { top: 100, right: 300, bottom: 120 },
        { width: 320, height: 800 },
      ),
    ).toEqual({
      right: 20,
      top: 128,
      maxHeight: 664,
    });
  });
});
