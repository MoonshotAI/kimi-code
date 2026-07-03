import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { visibleWidth } from '@moonshot-ai/pi-tui';

import { BannerComponent } from '#/tui/components/chrome/banner';
import { currentTheme } from '#/tui/theme';
import type { BannerState } from '#/tui/types';

function makeBannerState(overrides: Partial<BannerState> = {}): BannerState {
  return {
    key: 'component-banner',
    tag: null,
    mainText: '',
    subText: null,
    display: 'always',
    ...overrides,
  };
}

const banner: BannerState = makeBannerState({
  tag: "What's new:",
  mainText: 'This is the main banner message for testing purposes.',
  subText: 'This is a short subtext line.',
});

describe('BannerComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
  });

  it('renders star tag, main text, and subtext', () => {
    const lines = new BannerComponent(banner).render(80);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('✦');
    expect(lines[0]).toContain("What's new:");
    expect(lines[0]).toContain('This is the main banner message');
    expect(lines[1]).toContain('This is a short subtext');
    expect(lines[2]).toBe('');
  });

  it('does not add an extra colon to the tag', () => {
    const lines = new BannerComponent(banner).render(80);
    expect(lines[0]).not.toContain("What's new::");
  });

  it('renders without a tag when tag is empty', () => {
    const lines = new BannerComponent(makeBannerState({ mainText: 'Hello' })).render(80);
    expect(lines.length).toBe(2);
    expect(lines[0]).not.toContain('✦');
    expect(lines[0]).toContain('Hello');
    expect(lines[1]).toBe('');
  });

  it('wraps long main text to fit available width', () => {
    const width = 30;
    const lines = new BannerComponent(banner).render(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(lines.some((line) => line.includes('…'))).toBe(false);
    const mainContentLines = lines.filter((line) =>
      /main|banner|message|testing|purposes/.test(line),
    );
    expect(mainContentLines.length).toBeGreaterThan(1);
  });

  it('wraps long subtext to fit available width', () => {
    const width = 30;
    const state = makeBannerState({
      mainText: 'Short',
      subText: 'Short subtext line one plus subtext line two for wrapping tests.',
    });
    const lines = new BannerComponent(state).render(width);
    expect(lines[0]).toContain('Short');
    const subContentLines = lines.filter((line) =>
      /Short subtext|line one|plus|subtext|line two|for|wrapping|tests/.test(line),
    );
    expect(subContentLines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('keeps every line within terminal width on very narrow terminals', () => {
    for (const width of [0, 1, 2, 3, 5, 10]) {
      const lines = new BannerComponent(banner).render(width);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(0, width));
      }
    }
  });

  it('shows tag only on the first wrapped line', () => {
    const width = 40;
    const state = makeBannerState({
      tag: 'New:',
      mainText: 'This is a very long main text line that should wrap automatically.',
    });
    const lines = new BannerComponent(state).render(width);
    const mainRows = lines.slice(0, -1);
    let tagCount = 0;
    for (const line of mainRows) {
      if (line.includes('✦ New:')) tagCount += 1;
    }
    expect(tagCount).toBe(1);
    expect(mainRows.length).toBeGreaterThan(1);
    const firstIndex = lines.findIndex((line) => line.includes('✦ New:'));
    expect(firstIndex).toBe(0);
  });

  it('continues main text under the tag column and keeps subtext aligned with the tag text', () => {
    const width = 80;
    const lines = new BannerComponent(banner).render(width);
    const firstLine = lines[0]!;
    const mainStartIndex = firstLine.indexOf('This is the main banner message');
    const tagPrefixVisibleWidth = visibleWidth(firstLine.slice(0, mainStartIndex));
    const subLine = lines[1]!;
    const subStartIndex = subLine.indexOf('This is a short subtext');
    const subIndentVisibleWidth = visibleWidth(subLine.slice(0, subStartIndex));
    // The subtext starts two columns after the left edge ("✦ "), which aligns
    // with the tag text itself rather than the main-text column.
    expect(subIndentVisibleWidth).toBe(visibleWidth('✦ '));
    expect(tagPrefixVisibleWidth).toBeGreaterThan(visibleWidth('✦ '));
  });

  it('drops the tag when it does not fit', () => {
    const width = 5;
    const lines = new BannerComponent(banner).render(width);
    expect(lines[0]).not.toContain('✦');
    expect(lines[0]).not.toContain("What's new");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('still renders the tag when it fits', () => {
    const width = 40;
    const lines = new BannerComponent(banner).render(width);
    expect(lines[0]).toContain('✦');
    expect(lines[0]).toContain("What's new");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('does not render subtext when empty', () => {
    const lines = new BannerComponent(makeBannerState({ tag: 'Tip', mainText: 'Use /help' })).render(80);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('Use /help');
    expect(lines[1]).toBe('');
  });

  it('supports explicit newlines in main text', () => {
    const lines = new BannerComponent(makeBannerState({ mainText: 'Line 1\nLine 2' })).render(80);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('Line 1');
    expect(lines[1]).toContain('Line 2');
    expect(lines[2]).toBe('');
  });

  it('styles tag, main text, and subtext with theme colors', () => {
    const lines = new BannerComponent(banner).render(80);
    expect(lines[0]).toContain(currentTheme.boldFg('primary', "✦ What's new:"));
    expect(lines[0]).toContain(
      currentTheme.boldFg('textStrong', 'This is the main banner message for testing purposes.'),
    );
    expect(lines[1]).toContain(currentTheme.fg('textDim', 'This is a short subtext line.'));
  });

  it('does not stack the dim modifier on top of the textDim color', () => {
    const lines = new BannerComponent(banner).render(80);
    expect(lines[1]).toContain('This is a short subtext');
    expect(lines[1]).not.toContain('[2m');
    expect(lines[2]).toBe('');
  });

  it('keeps subsequent main lines indented to the main-text column and subtext aligned with the tag text', () => {
    const width = 20;
    const lines = new BannerComponent(
      makeBannerState({
        tag: 'New:',
        mainText: 'Line 1 with a lot of content',
        subText: 'Sub text',
      }),
    ).render(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(lines[0]).toContain('✦ New:');
    const firstLine = lines[0]!;
    const mainTextStart = visibleWidth(firstLine.slice(0, firstLine.indexOf('Line 1')));
    const continuationLine = lines.find((line) => line.includes('lot of'))!;
    expect(visibleWidth(continuationLine.slice(0, continuationLine.indexOf('lot of')))).toBe(mainTextStart);
    const subLine = lines.find((line) => line.includes('Sub text'))!;
    expect(visibleWidth(subLine.slice(0, subLine.indexOf('Sub text')))).toBe(visibleWidth('✦ '));
  });
});
