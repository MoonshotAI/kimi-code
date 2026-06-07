import type { ContextBreakdown } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { buildContextReportLines } from '#/tui/components/messages/context-panel';
import { darkColors } from '#/tui/theme/colors';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

const BREAKDOWN: ContextBreakdown = {
  model: 'Kimi-K2.6',
  maxContextTokens: 262_000,
  totalTokens: 26_147,
  categories: [
    { key: 'systemPrompt', label: 'System prompt', tokens: 3_600 },
    { key: 'systemTools', label: 'System tools', tokens: 18_600 },
    { key: 'mcpTools', label: 'MCP tools', tokens: 0 },
    { key: 'customAgents', label: 'Custom agents', tokens: 627 },
    { key: 'memoryFiles', label: 'Memory files', tokens: 112 },
    { key: 'skills', label: 'Skills', tokens: 3_200 },
    { key: 'messages', label: 'Messages', tokens: 8 },
    { key: 'freeSpace', label: 'Free space', tokens: 235_853 },
  ],
};

describe('buildContextReportLines', () => {
  it('renders the model, total usage, and a row per non-empty category', () => {
    const lines = buildContextReportLines({ colors: darkColors, breakdown: BREAKDOWN }).map(strip);
    const joined = lines.join('\n');

    expect(lines).toContain('Context window');
    expect(joined).toContain('Kimi-K2.6');
    expect(joined).toContain('10.0%'); // 26.1k / 262k
    for (const label of [
      'System prompt',
      'System tools',
      'Custom agents',
      'Memory files',
      'Skills',
      'Messages',
      'Free space',
    ]) {
      expect(joined).toContain(label);
    }
  });

  it('hides empty categories but always shows free space', () => {
    const joined = buildContextReportLines({ colors: darkColors, breakdown: BREAKDOWN })
      .map(strip)
      .join('\n');

    expect(joined).not.toContain('MCP tools');
    expect(joined).toContain('Free space');
  });

  it('omits percentages when the context window is unknown', () => {
    const breakdown: ContextBreakdown = {
      ...BREAKDOWN,
      maxContextTokens: 0,
      categories: BREAKDOWN.categories.map((cat) =>
        cat.key === 'freeSpace' ? { ...cat, tokens: 0 } : cat,
      ),
    };

    const joined = buildContextReportLines({ colors: darkColors, breakdown }).map(strip).join('\n');
    expect(joined).toContain('context window unknown');
    expect(joined).not.toContain('%');
  });
});
