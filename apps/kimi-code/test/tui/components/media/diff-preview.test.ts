import { describe, it, expect } from 'vitest';

import { renderDiffLinesClustered } from '#/tui/components/media/diff-preview';

function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');
}

describe('renderDiffLinesClustered tail mode', () => {
  it('keeps the tail when tail=true and exceeds maxLines', () => {
    const out = renderDiffLinesClustered(lines(40), lines(40, 'changed'), 'a.ts', {
      maxLines: 10,
      tail: true,
    });
    const joined = out.join('\n');
    expect(joined).toContain('earlier lines hidden');
    expect(joined).toContain('changed 40'); // tail change kept
    expect(joined).not.toContain('changed 1'); // head change dropped
  });

  it('keeps the head when tail=false', () => {
    const out = renderDiffLinesClustered(lines(40), lines(40, 'changed'), 'a.ts', {
      maxLines: 10,
      tail: false,
    });
    const joined = out.join('\n');
    expect(joined).toContain('more changes hidden');
    expect(joined).toContain('line 1'); // head delete line kept
    expect(joined).not.toContain('changed 40'); // tail add line dropped
  });
});
