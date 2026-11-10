import { visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import { TruncatedOutputComponent } from '#/tui/components/messages/tool-renderers/truncated';
import { setRenderCacheEnabled } from '#/tui/utils/render-cache';


function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

describe('TruncatedOutputComponent', () => {
  it('indents content and the truncation hint by the configured amount', () => {
    const component = new TruncatedOutputComponent(['a', 'b', 'c', 'd', 'e'].join('\n'), {
      expanded: false,
      isError: false,
      maxLines: 2,
      indent: 6,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[0]?.startsWith('      a')).toBe(true);
    expect(lines[1]?.startsWith('      b')).toBe(true);
    expect(lines[2]).toBe('      … (3 more lines, ctrl+o to expand)');
  });

  it('defaults to a two-space indent for both content and hint', () => {
    const component = new TruncatedOutputComponent('x\ny\nz', {
      expanded: false,
      isError: false,
      maxLines: 1,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[0]?.startsWith('  x')).toBe(true);
    expect(lines[1]).toBe('  … (2 more lines, ctrl+o to expand)');
  });

  it('omits the ctrl+o promise when expandHint is false', () => {
    const component = new TruncatedOutputComponent('a\nb\nc\nd', {
      expanded: false,
      isError: false,
      maxLines: 2,
      indent: 4,
      expandHint: false,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[2]).toBe('    … (2 more lines)');
  });

  it('renders all lines without a hint when expanded', () => {
    const component = new TruncatedOutputComponent('a\nb\nc\nd', {
      expanded: true,
      isError: false,
      maxLines: 2,
      indent: 4,
    });

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('d');
    expect(out).not.toContain('more lines, ctrl+o');
  });

  it('shows a single overflow line instead of swapping it for a same-height hint', () => {
    const component = new TruncatedOutputComponent('a\nb\nc\nd', {
      expanded: false,
      isError: false,
      maxLines: 3,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain('d');
    expect(lines.some((line) => line.includes('more lines'))).toBe(false);
    expect(component.wasTruncated()).toBe(false);
  });

  it('collapses once folding saves at least one row', () => {
    const component = new TruncatedOutputComponent('a\nb\nc\nd\ne', {
      expanded: false,
      isError: false,
      maxLines: 3,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('  … (2 more lines, ctrl+o to expand)');
    expect(component.wasTruncated()).toBe(true);
  });

  it('keeps the truncation footer within the requested render width', () => {
    const output = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n');
    const component = new TruncatedOutputComponent(output, {
      expanded: false,
      isError: false,
      maxLines: 3,
      indent: 2,
    });

    for (const line of component.render(37)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });

  it('renders output verbatim, including literal <system> text in file content', () => {
    // Tool metadata no longer travels inside `output` (it rides the result's
    // `note` side channel), so the renderer must not eat user data that
    // merely contains the literal tag.
    const component = new TruncatedOutputComponent(
      '<system>literal text from a user file</system>\n<image path="/tmp/x.png">',
      { expanded: true, isError: false },
    );
    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('<system>literal text from a user file</system>');
    expect(out).toContain('<image path="/tmp/x.png">');
  });
});

describe('TruncatedOutputComponent render cache', () => {
  const output = ['a', 'b', 'c', 'd', 'e', 'f'].join('\n');
  const make = (tail = false) =>
    new TruncatedOutputComponent(output, { expanded: false, isError: false, maxLines: 2, tail });

  it('returns the same array when nothing changed between renders', () => {
    for (const tail of [false, true]) {
      const component = make(tail);
      const first = component.render(80);
      expect(component.render(80)).toBe(first);
    }
  });

  it('matches a fresh component after a width change and back', () => {
    const component = make();
    const wide = component.render(80);
    expect(component.render(5)).toEqual(make().render(5));
    expect(component.render(80)).toEqual(wide);
  });

  it('drops the cached lines on invalidate', () => {
    const component = make();
    const first = component.render(80);
    component.invalidate();
    const second = component.render(80);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  describe('with the render cache disabled', () => {
    afterEach(() => setRenderCacheEnabled(true));

    it('renders again with equal text', () => {
      setRenderCacheEnabled(false);
      for (const tail of [false, true]) {
        const component = make(tail);
        const first = component.render(80);
        const second = component.render(80);
        expect(second).not.toBe(first);
        expect(second).toEqual(first);
      }
    });
  });
});
