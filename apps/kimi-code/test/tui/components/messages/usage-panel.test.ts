import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';

import { buildUsageReportLines, UsagePanelComponent } from '#/tui/components/messages/usage-panel';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('UsagePanelComponent', () => {
  it('shows cache hit ratio bar and read/other breakdown below each model line', () => {
    const lines = buildUsageReportLines({
      colors: darkColors,
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
    }).map(strip);

    // Model line unchanged
    expect(lines).toContain('  kimi  input 2.0k  output 250  total 2.3k');
    // Cache subline: indent=model prefix width, bar=5/20 filled, 25% hit, 500 read, 1.0k other
    const cacheLine = lines.find((l) => l.includes('cache') && l.includes('hit'));
    expect(cacheLine).toBeDefined();
    expect(cacheLine).toContain('25% hit');
    expect(cacheLine).toContain('500 read');
    expect(cacheLine).toContain('1.0k other');
    // Bar: 5 filled out of 20
    expect(cacheLine).toContain('█████░░░░░░░░░░░░░░░');
  });

  it('shows zero cache hit ratio when no cache reads occurred', () => {
    const lines = buildUsageReportLines({
      colors: darkColors,
      sessionUsage: {
        byModel: {
          kimi: {
            inputOther: 3000,
            inputCacheRead: 0,
            inputCacheCreation: 0,
            output: 1000,
          },
        },
      } as never,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
    }).map(strip);

    const cacheLine = lines.find((l) => l.includes('cache') && l.includes('hit'));
    expect(cacheLine).toBeDefined();
    expect(cacheLine).toContain('0% hit');
    expect(cacheLine).toContain('0 read');
    expect(cacheLine).toContain('3.0k other');
  });

  it('formats session, context, and managed usage sections', () => {
    const lines = buildUsageReportLines({
      colors: darkColors,
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
    expect(lines).toContain('Context window');
    expect(lines.join('\n')).toContain('25.0%');
    expect(lines).toContain('Plan usage');
    expect(lines.join('\n')).toContain('20% used');
    expect(lines.join('\n')).toContain('resets tomorrow');
  });

  it('shows separate cache lines for each model in multi-model sessions', () => {
    const lines = buildUsageReportLines({
      colors: darkColors,
      sessionUsage: {
        byModel: {
          'kimi-k2.5': {
            inputOther: 4000,
            inputCacheRead: 6000,
            inputCacheCreation: 200,
            output: 500,
          },
          'deepseek-v4': {
            inputOther: 2000,
            inputCacheRead: 0,
            inputCacheCreation: 0,
            output: 1000,
          },
        },
      } as never,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
    }).map(strip);

    // Both model lines present (model padded to max width for alignment)
    const modelLines = lines.filter(
      (l) => l.startsWith('  ') && (l.includes('kimi-k2.5') || l.includes('deepseek-v4'))
        && l.includes('input') && l.includes('output') && l.includes('total')
        && !l.includes('cache'),
    );
    expect(modelLines).toHaveLength(2);
    expect(modelLines[0]).toContain('kimi-k2.5');
    expect(modelLines[0]).toContain('10.2k');
    expect(modelLines[0]).toContain('500');
    expect(modelLines[0]).toContain('10.7k');
    expect(modelLines[1]).toContain('deepseek-v4');
    expect(modelLines[1]).toContain('2.0k');
    expect(modelLines[1]).toContain('1.0k');
    expect(modelLines[1]).toContain('3.0k');
    // Both have cache sublines
    const cacheLines = lines.filter((l) => l.includes('cache') && l.includes('hit'));
    expect(cacheLines).toHaveLength(2);
    // kimi-k2.5: 6000/10200 ≈ 58.8% hit
    expect(cacheLines[0]).toContain('58.8% hit');
    expect(cacheLines[0]).toContain('6.0k read');
    // deepseek-v4: 0% hit
    expect(cacheLines[1]).toContain('0% hit');
    expect(cacheLines[1]).toContain('2.0k other');
    // Total line itself contains no cache info
    const totalLine = lines.find((l) => l.startsWith('  total'));
    expect(totalLine).toBeDefined();
    expect(totalLine!).not.toContain('cache');
  });

  it('wraps preformatted usage lines in a bordered panel', () => {
    const component = new UsagePanelComponent(['Session usage'], darkColors.primary);
    const output = component.render(80).map(strip);

    expect(output[0]).toContain(' Usage ');
    expect(output[1]).toContain('Session usage');
  });

  it('truncates lines wider than the terminal so the panel never overflows', () => {
    const longLine = 'error: ' + 'x'.repeat(200);
    const component = new UsagePanelComponent([longLine], darkColors.primary);
    const width = 60;

    const output = component.render(width);

    for (const line of output) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
