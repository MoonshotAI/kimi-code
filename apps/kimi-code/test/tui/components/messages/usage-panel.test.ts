import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import { buildUsageReportLines, UsagePanelComponent } from '#/tui/components/messages/usage-panel';
import { i18n } from '#/tui/i18n';
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
      } as never,
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

  it('wraps preformatted usage lines in a bordered panel', () => {
    const component = new UsagePanelComponent(() => ['Session usage'], 'primary');
    const output = component.render(80).map(strip);

    expect(output[0]).toContain(' Usage ');
    expect(output[1]).toContain('Session usage');
  });

  it('titles the default panel from the active locale', () => {
    i18n.setLocale('zh-CN');
    try {
      const component = new UsagePanelComponent(() => ['会话用量'], 'primary');
      const output = component.render(80).map(strip);

      expect(output[0]).toContain('用量');
      expect(output[0]).not.toContain('Usage');
    } finally {
      i18n.setLocale('en');
    }
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

  it('renders the usage-panel labels in Simplified Chinese when the locale is zh-CN', () => {
    i18n.setLocale('zh-CN');
    try {
      const report = {
        sessionUsage: {
          byModel: {
            kimi: { inputOther: 1000, inputCacheRead: 500, inputCacheCreation: 500, output: 250 },
            'kimi-2': { inputOther: 10, inputCacheRead: 0, inputCacheCreation: 0, output: 5 },
          },
        } as never,
        contextUsage: 0.25,
        contextTokens: 2500,
        maxContextTokens: 10000,
        managedUsage: {
          summary: { label: 'daily', used: 20, limit: 100, resetHint: 'resets tomorrow' },
          limits: [],
        },
      };
      const output = buildUsageReportLines(report).map(strip).join('\n');

      expect(output).toContain('会话用量');
      expect(output).toContain('输入');
      expect(output).toContain('输出');
      expect(output).toContain('合计');
      expect(output).toContain('上下文窗口');
      expect(output).toContain('套餐用量');
      expect(output).toContain('已用');
      // Model names and SDK-provided values stay untranslated.
      expect(output).toContain('kimi');
      expect(output).not.toContain('Session usage');
      expect(output).not.toContain('Context window');
      expect(output).not.toContain('Plan usage');
    } finally {
      i18n.setLocale('en');
    }
  });

  it('keeps the usage-panel labels in English on the default locale', () => {
    const output = buildUsageReportLines({
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
    }).map(strip).join('\n');

    expect(output).toContain('Session usage');
    expect(output).not.toContain('会话用量');
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
