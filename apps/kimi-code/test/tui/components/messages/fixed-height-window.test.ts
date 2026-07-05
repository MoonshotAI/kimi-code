import { describe, it, expect } from 'vitest';

import { FixedHeightWindow } from '#/tui/components/messages/fixed-height-window';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('FixedHeightWindow', () => {
  it('pads short content to the fixed height', () => {
    const win = new FixedHeightWindow({ height: 4, lines: ['a', 'b'] });
    const out = win.render(80).map(strip);
    expect(out).toHaveLength(4);
    expect(out[0]).toContain('a');
    expect(out[1]).toContain('b');
  });

  it('keeps the tail when content exceeds height and tail=true', () => {
    const win = new FixedHeightWindow({
      height: 3,
      tail: true,
      lines: ['l1', 'l2', 'l3', 'l4', 'l5'],
    });
    const out = win.render(80).map(strip);
    expect(out).toHaveLength(3);
    expect(out.join('\n')).toContain('l5');
    expect(out.join('\n')).not.toContain('l1');
  });

  it('keeps the head when tail=false', () => {
    const win = new FixedHeightWindow({
      height: 3,
      tail: false,
      lines: ['l1', 'l2', 'l3', 'l4', 'l5'],
    });
    const out = win.render(80).map(strip);
    expect(out).toHaveLength(3);
    expect(out.join('\n')).toContain('l1');
    expect(out.join('\n')).not.toContain('l5');
  });

  it('returns identical line count across different content lengths', () => {
    const win = new FixedHeightWindow({ height: 5, lines: ['x'] });
    const short = win.render(80).length;
    win.setLines(['1', '2', '3', '4', '5', '6', '7', '8']);
    const long = win.render(80).length;
    expect(short).toBe(5);
    expect(long).toBe(5);
  });
});
