import { visibleWidth } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import { buildUsageReportLines, UsagePanelComponent } from '#/tui/components/messages/usage-panel';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';

afterEach(() => {
  currentTheme.setPalette(darkColors);
});

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('UsagePanelComponent', () => {
  it('formats session, context, and managed usage sections', () => {
    const lines = buildUsageReportLines({
      sessionUsage: {
        byModel: {
          kimi: {
            inputOther: 1000,
            inputCacheRead: 500,
            inputCacheCreation: 500,
            output: 250,
          },
        },
      },
      contextUsage: 0.25,
      contextTokens: 2500,
      maxContextTokens: 10000,
      managedUsage: {
        summary: {
          label: 'daily',
          used: 20,
          limit: 100,
          resetHint: 'resets tomorrow',
        },
        limits: [],
      },
    }).map(strip);

    expect(lines).toContain('Session usage');
    expect(lines).toContain('  kimi  input 2.0k  output 250  total 2.3k');
    expect(lines).toContain('Context window');
    expect(lines.join('\n')).toContain('25.0%');
    expect(lines).toContain('Plan usage');
    expect(lines.join('\n')).toContain('20% used');
    expect(lines.join('\n')).toContain('resets tomorrow');
  });

  it('formats extra usage with a monthly limit', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      managedUsage: {
        summary: null,
        limits: [],
        extraUsage: {
          balanceCents: 10000,
          totalCents: 20000,
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimitCents: 20000,
          monthlyUsedCents: 5000,
          currency: 'USD',
        },
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(lines).toContain('Extra Usage');
    expect(output).toContain('Balance');
    expect(output).toContain('100.00');
    expect(output).toContain('Used this month');
    expect(output).toContain('50.00');
    expect(output).toContain('Monthly limit');
    expect(output).toContain('200.00');
    // bar row contains block glyphs but no percentage text
    expect(output).toContain('░');
  });

  it('formats extra usage without a monthly limit and omits the progress bar', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      managedUsage: {
        summary: null,
        limits: [],
        extraUsage: {
          balanceCents: 18208,
          totalCents: 40000,
          monthlyChargeLimitEnabled: false,
          monthlyChargeLimitCents: 0,
          monthlyUsedCents: 21792,
          currency: 'CNY',
        },
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(lines).toContain('Extra Usage');
    expect(output).toContain('Balance');
    expect(output).toContain('¥182.08');
    expect(output).toContain('Used this month');
    expect(output).toContain('¥217.92');
    expect(output).toContain('Monthly limit');
    expect(output).toContain('Unlimited');
    expect(output).not.toContain('░');
    expect(output).not.toContain('█');
  });

  it('omits the extra usage section when extraUsage is omitted or null', () => {
    for (const extraUsage of [undefined, null]) {
      const lines = buildUsageReportLines({
        sessionUsage: { byModel: {} },
        contextUsage: 0,
        contextTokens: 0,
        maxContextTokens: 0,
        managedUsage: { summary: null, limits: [], extraUsage },
      }).map(strip);

      expect(lines).not.toContain('Extra Usage');
    }
  });

  it('formats extra usage with CNY currency', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      managedUsage: {
        summary: null,
        limits: [],
        extraUsage: {
          balanceCents: 10000,
          totalCents: 20000,
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimitCents: 20000,
          monthlyUsedCents: 5000,
          currency: 'CNY',
        },
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Balance');
    expect(output).toContain('100.00');
    expect(output).toContain('Used this month');
    expect(output).toContain('50.00');
    expect(output).toContain('Monthly limit');
    expect(output).toContain('200.00');
  });

  it('aligns the currency symbol and decimal point across extra usage rows', () => {
    const lines = buildUsageReportLines({
      sessionUsage: { byModel: {} },
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      managedUsage: {
        summary: null,
        limits: [],
        extraUsage: {
          balanceCents: 15901,
          totalCents: 300000,
          monthlyChargeLimitEnabled: true,
          monthlyChargeLimitCents: 300000,
          monthlyUsedCents: 24099,
          currency: 'CNY',
        },
      },
    }).map(strip);

    const extraRows = lines.filter((line) => line.includes('¥'));
    expect(extraRows).toHaveLength(3);
    // The currency symbol stays in one column...
    expect(new Set(extraRows.map((line) => line.indexOf('¥'))).size).toBe(1);
    // ...and the right-aligned numeric parts end in the same column, so the
    // decimal points line up across rows.
    expect(new Set(extraRows.map((line) => line.length)).size).toBe(1);
  });

  it('wraps preformatted usage lines in a bordered panel', () => {
    const component = new UsagePanelComponent(() => ['Session usage'], 'primary');
    const output = component.render(80).map(strip);

    expect(output[0]).toContain(' Usage ');
    expect(output[1]).toContain('Session usage');
  });

  it('truncates lines wider than the terminal so the panel never overflows', () => {
    const longLine = 'error: ' + 'x'.repeat(200);
    const component = new UsagePanelComponent(() => [longLine], 'primary');
    const width = 60;

    const output = component.render(width);

    for (const line of output) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('keeps the bordered panel within narrow terminal widths', () => {
    const component = new UsagePanelComponent(() => ['Session usage', '  kimi  input 2.0k'], 'primary');

    for (const width of [39, 24, 20, 10, 4, 1]) {
      for (const line of component.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('rebuilds its body from the active palette on invalidate', () => {
    // Emit the resolved palette value as visible text so the assertion holds
    // regardless of chalk's colour level in the test environment.
    const component = new UsagePanelComponent(() => [`text=${currentTheme.color('text')}`], 'primary');
    const bodyOf = (): string => {
      const line = component.render(80).map(strip).find((l) => l.includes('text='));
      if (line === undefined) throw new Error('body line not found');
      return line;
    };

    expect(bodyOf()).toContain(darkColors.text);
    currentTheme.setPalette(lightColors);
    component.invalidate();
    expect(bodyOf()).toContain(lightColors.text);
  });
});
