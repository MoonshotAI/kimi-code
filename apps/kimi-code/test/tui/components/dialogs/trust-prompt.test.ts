import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceTrustMcpServerInfo } from '@moonshot-ai/kimi-code-sdk';

import { TrustPromptComponent } from '#/tui/components/dialogs/trust-prompt';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function renderLines(gatedMcpServers: readonly WorkspaceTrustMcpServerInfo[] = []): string[] {
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
    const lines = renderLines([
      { name: 'nested-server', transport: 'stdio', command: 'nested-cmd', args: ['--safe'], cwd: '/tmp' },
      { name: 'root-server', transport: 'http', url: 'https://example.test/mcp' },
    ]);
    expect(lines.some((l) => l.includes('Project MCP targets'))).toBe(true);
    expect(lines.some((l) => l.includes('nested-server (stdio): command=nested-cmd'))).toBe(true);
    expect(lines.some((l) => l.includes('args=["--safe"] cwd=/tmp'))).toBe(true);
    expect(lines.some((l) => l.includes('root-server (http): url=https://example.test/mcp'))).toBe(true);
    expect(renderLines().some((l) => l.includes('This folder defines'))).toBe(false);
  });

  it('strips terminal control characters from workspace-supplied MCP targets', () => {
    const lines = renderLines([
      { name: 'evil', transport: 'stdio', command: 'cmd\u001B[2J\u0007evil' },
      { name: 'multi\nline', transport: 'http', url: 'https://example.test/\u001B]8;;https://evil.test\u0007' },
    ]);
    const text = lines.join('\n');
    // ESC and BEL are dropped, defusing the sequences into harmless literal text.
    expect(text).toContain('evil (stdio): command=cmd[2Jevil');
    expect(text).toContain('multiline (http): url=https://example.test/]8;;https://evil.test');
    expect(text).not.toContain('\u001B]8;;https://evil.test');
  });

  it("defaults to Don't trust", () => {
    const onSelect = vi.fn();
    const prompt = new TrustPromptComponent({
      workDir: '/tmp/demo-workspace',
      gatedMcpServers: [],
      onSelect,
    });
    prompt.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('distrust');
  });

  it('selects trust only after moving to it explicitly', () => {
    const onSelect = vi.fn();
    const prompt = new TrustPromptComponent({
      workDir: '/tmp/demo-workspace',
      gatedMcpServers: [],
      onSelect,
    });
    prompt.handleInput('\u001B[A');
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
