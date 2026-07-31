import { resetCapabilitiesCache, setCapabilities, visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import { TruncatedOutputComponent } from '#/tui/components/messages/tool-renderers/truncated';


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
    expect(lines[2]).toBe('      ... (3 more lines, ctrl+o to expand)');
  });

  it('defaults to a two-space indent for both content and hint', () => {
    const component = new TruncatedOutputComponent('x\ny\nz', {
      expanded: false,
      isError: false,
      maxLines: 1,
    });

    const lines = strip(component.render(80).join('\n')).split('\n');
    expect(lines[0]?.startsWith('  x')).toBe(true);
    expect(lines[1]).toBe('  ... (2 more lines, ctrl+o to expand)');
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
    expect(lines[2]).toBe('    ... (2 more lines)');
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

describe('TruncatedOutputComponent URL linkification', () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  it('linkifies bare URLs in output on hyperlink-capable terminals', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const component = new TruncatedOutputComponent('pr: https://example.com/pull/1', {
      expanded: false,
      isError: false,
    });

    const out = component.render(80).join('\n');
    expect(out).toContain("\u001B]8;;https://example.com/pull/1\u0007");
  });

  it('leaves URLs as plain text when hyperlinks are unsupported', () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const component = new TruncatedOutputComponent('pr: https://example.com/pull/1', {
      expanded: false,
      isError: false,
    });

    const out = component.render(80).join('\n');
    expect(out).not.toContain("\u001B]8;");
    expect(strip(out)).toContain('pr: https://example.com/pull/1');
  });
});
