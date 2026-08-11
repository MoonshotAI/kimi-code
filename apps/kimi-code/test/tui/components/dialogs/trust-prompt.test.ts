import { describe, expect, it, vi } from 'vitest';

import { TrustPromptComponent } from '#/tui/components/dialogs/trust-prompt';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function renderLines(gatedMcpServers: readonly string[] = []): string[] {
  const prompt = new TrustPromptComponent({
    workDir: '/tmp/demo-workspace',
    gatedMcpServers,
    onSelect: vi.fn(),
  });
  return prompt.render(100).map(strip);
}

describe('TrustPromptComponent', () => {
  it('renders the header vocabulary and the workspace path', () => {
    const lines = renderLines();
    const titleIdx = lines.findIndex((l) => l.includes('Trust this folder?'));
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    const hint = lines[titleIdx + 1];
    expect(hint).toContain('↑↓ navigate');
    expect(hint).toContain('Enter select');
    expect(hint).toContain('Esc exit');
    expect(lines.some((l) => l.includes('/tmp/demo-workspace'))).toBe(true);
  });

  it('lists the gated project MCP servers when present', () => {
    const lines = renderLines(['nested-server', 'root-server']);
    expect(lines.some((l) => l.includes('This folder defines'))).toBe(true);
    expect(lines.some((l) => l.includes('nested-server'))).toBe(true);
    expect(lines.some((l) => l.includes('root-server'))).toBe(true);
    expect(renderLines().some((l) => l.includes('This folder defines'))).toBe(false);
  });

  it('selects trust on Enter with the default highlight', () => {
    const onSelect = vi.fn();
    const prompt = new TrustPromptComponent({
      workDir: '/tmp/demo-workspace',
      gatedMcpServers: [],
      onSelect,
    });
    prompt.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('trust');
  });

  it('selects distrust after moving the cursor down', () => {
    const onSelect = vi.fn();
    const prompt = new TrustPromptComponent({
      workDir: '/tmp/demo-workspace',
      gatedMcpServers: [],
      onSelect,
    });
    prompt.handleInput('\u001B[B');
    prompt.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('distrust');
  });

  it('treats Esc as distrust', () => {
    const onSelect = vi.fn();
    const prompt = new TrustPromptComponent({
      workDir: '/tmp/demo-workspace',
      gatedMcpServers: [],
      onSelect,
    });
    prompt.handleInput('\u001B');
    expect(onSelect).toHaveBeenCalledWith('distrust');
  });
});
