import { visibleWidth } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import { buildStatusReportLines } from '#/tui/components/messages/status-panel';
import { i18n } from '#/tui/i18n';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('status panel report lines', () => {
  it('formats runtime status, context, and managed usage without account or AGENTS.md rows', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: 'k2',
      workDir: '/tmp/project',
      sessionId: 'ses-1',
      sessionTitle: 'Implement status',
      thinking: true,
      permissionMode: 'manual',
      planMode: false,
      contextUsage: 0.25,
      contextTokens: 2500,
      maxContextTokens: 10000,
      availableModels: {
        k2: {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 10000,
          displayName: 'Kimi K2',
        },
      },
      status: {
        model: 'k2',
        thinkingLevel: 'high',
        permission: 'auto',
        planMode: true,
        contextTokens: 3000,
        maxContextTokens: 12000,
        contextUsage: 0.25,
      },
      managedUsage: {
        summary: null,
        limits: [
          {
            label: '5h limit',
            used: 8,
            limit: 100,
            resetHint: 'resets in 1h',
          },
        ],
      },
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('>_ Kimi Code (v1.2.3)');
    expect(output).toContain('Model        Kimi K2 (thinking on)');
    expect(output).toContain('Directory    /tmp/project');
    expect(output).toContain('Permissions  auto');
    expect(output).toContain('Plan mode    on');
    expect(output).toContain('Session      ses-1');
    expect(output).toContain('Title        Implement status');
    expect(output).toContain('Context window');
    expect(output).toContain('25.0%');
    expect(output).toContain('(3.0k / 12.0k)');
    expect(output).toContain('Plan usage');
    expect(output).toContain('8% used');
    expect(output).not.toContain('Account');
    expect(output).not.toContain('AGENTS.md');
    expect(output).not.toContain('Runtime');
  });

  it('falls back to app state and shows status load errors as warnings', () => {
    const lines = buildStatusReportLines({
      version: '1.2.3',
      model: '',
      workDir: '/tmp/project',
      sessionId: '',
      sessionTitle: null,
      thinking: false,
      permissionMode: 'manual',
      planMode: false,
      contextUsage: 0,
      contextTokens: 0,
      maxContextTokens: 0,
      availableModels: {},
      statusError: 'No active session',
    }).map(strip);

    const output = lines.join('\n');
    expect(output).toContain('Model        not set');
    expect(output).toContain('Session      none');
    expect(output).toContain('Warning      No active session');
    expect(output).toContain('No context window data available.');
  });
});

describe('status panel — locale rendering', () => {
  afterEach(() => {
    i18n.setLocale('en');
  });

  const richOptions = {
    version: '1.2.3',
    model: 'k2',
    workDir: '/tmp/project',
    sessionId: 'ses-1',
    sessionTitle: 'Implement status',
    thinking: true,
    permissionMode: 'manual' as const,
    planMode: false,
    contextUsage: 0.25,
    contextTokens: 2500,
    maxContextTokens: 10000,
    availableModels: {
      k2: {
        provider: 'managed:kimi-code',
        model: 'kimi-k2',
        maxContextSize: 10000,
        displayName: 'Kimi K2',
      },
    },
  };

  it('renders status field labels and values in Simplified Chinese under zh-CN', () => {
    i18n.setLocale('zh-CN');

    const output = buildStatusReportLines(richOptions).map(strip).join('\n');

    expect(output).toContain('模型');
    expect(output).toContain('目录');
    expect(output).toContain('权限');
    expect(output).toContain('计划模式');
    expect(output).toContain('会话');
    expect(output).toContain('标题');
    expect(output).toContain('上下文窗口');
    // Plan mode off + thinking on render with translated on/off + label.
    expect(output).toContain('(思考 开)');
    expect(output).toContain('关');
    // Model display name stays untranslated.
    expect(output).toContain('Kimi K2');
    expect(output).not.toContain('Model');
    expect(output).not.toContain('Context window');
  });

  it('keeps status field labels in English on the default locale', () => {
    const output = buildStatusReportLines(richOptions).map(strip).join('\n');

    expect(output).toContain('Model');
    expect(output).toContain('Context window');
    expect(output).not.toContain('模型');
  });

  it('keeps the status panel aligned and within width under zh-CN', () => {
    i18n.setLocale('zh-CN');

    const lines = buildStatusReportLines(richOptions).map(strip);
    const width = 60;
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }

    // Field labels are padded to a common display width, so every value
    // column starts at the same visible offset (measured as the display
    // width of the "  <label><padding>" prefix before the value).
    const fieldLines = lines.filter((l) => /^ {2}\S/.test(l) && !l.includes('█'));
    const valueOffsets = fieldLines
      .map((l) => l.match(/^( {2}\S.*?\S {2,})\S/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => visibleWidth(m[1]!));
    expect(valueOffsets.length).toBeGreaterThan(1);
    expect(new Set(valueOffsets).size).toBe(1);
  });
});
