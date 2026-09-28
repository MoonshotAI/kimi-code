import { describe, expect, it, vi } from 'vitest';

import type { WorkspaceTrustInfo } from '@moonshot-ai/kimi-code-sdk';

import { TrustPromptComponent } from '#/tui/components/dialogs/trust-prompt';

const ANSI_SGR = /\[[0-9;]*m/g;

function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function makeInfo(overrides: Partial<WorkspaceTrustInfo> = {}): WorkspaceTrustInfo {
  return {
    trusted: false,
    gatedMcpServers: [],
    gatedAdditionalDirs: [],
    instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [] },
    ...overrides,
  };
}

function renderLines(info: WorkspaceTrustInfo = makeInfo()): string[] {
  const prompt = new TrustPromptComponent({
    workDir: '/tmp/demo-workspace',
    info,
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

  it('explains what an unconfigured folder means when trusted', () => {
    const text = renderLines().join('\n');
    expect(text).toContain('No project-level config found here');
    expect(text).toContain('subject to your approvals');
    expect(text).toContain('applies automatically once this folder is trusted');
  });

  it('lists the gated project MCP servers with keys, origin, and caps', () => {
    const lines = renderLines(
      makeInfo({
        gatedMcpServers: [
          {
            name: 'nested-server',
            transport: 'stdio',
            command: 'nested-cmd',
            args: ['--safe'],
            cwd: '/tmp',
            envKeys: Array.from({ length: 25 }, (_, i) => `KEY_${i}`),
            origin: '/tmp/demo-workspace/.mcp.json',
          },
          {
            name: 'root-server',
            transport: 'http',
            url: 'https://example.test/mcp',
            headerKeys: ['Authorization'],
            bearerTokenEnvVar: 'MCP_TOKEN',
            origin: '/tmp/demo-workspace/.kimi-code/mcp.json',
          },
          {
            name: 'evil',
            transport: 'stdio',
            command: 'cmd\u001B[2J\u0007evil',
            envKeys: ['SAFE', 'BAD\u0007'],
            origin: '/tmp/demo-workspace/.mcp.json',
          },
          {
            name: 'multi\nline',
            transport: 'http',
            url: 'https://example.test/\u001B]8;;https://evil.test\u0007',
            origin: '/tmp/demo-workspace/.mcp.json',
          },
        ],
        instructionSources: {
          agentsMdPaths: [],
          skills: ['ski\u001B[2Jll', ...Array.from({ length: 12 }, (_, i) => `skill-${i}`)],
          agentProfiles: [],
        },
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('nested-server (stdio): command=nested-cmd');
    expect(text).toContain('args=["--safe"] cwd=/tmp');
    expect(text).toContain('env keys: KEY_0, KEY_1');
    expect(text).toContain('+15 more');
    expect(text).not.toContain('KEY_24');
    expect(text).toContain('from .mcp.json');
    expect(text).toContain('root-server (http): url=https://example.test/mcp');
    expect(text).toContain('header keys: Authorization · bearer token from env MCP_TOKEN');
    expect(text).toContain('from .kimi-code/mcp.json');
    expect(text).toContain('+5 more');
    // ESC and BEL are dropped, defusing the sequences into harmless literal text.
    expect(text).toContain('evil (stdio): command=cmd[2Jevil');
    expect(text).toContain('multiline (http): url=https://example.test/]8;;https://evil.test');
    expect(text).toContain('env keys: SAFE, BAD');
    expect(text).toContain('skills: ski[2Jll, skill-0');
    expect(text).not.toContain('\u001B]8;;https://evil.test');
  });

  it('renders the directory and instruction sections', () => {
    const lines = renderLines(
      makeInfo({
        gatedAdditionalDirs: ['/tmp/shared-assets', '/opt/toolchain', '/Users/alice/Documents'],
        instructionSources: {
          agentsMdPaths: ['/tmp/demo-workspace/AGENTS.md', '/Users/alice/shared/AGENTS.md'],
          skills: ['deploy-prod', 'lint-fix'],
          agentProfiles: ['release-manager'],
        },
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('/tmp/shared-assets');
    expect(text).toContain('/opt/toolchain');
    expect(text).toContain('/Users/alice/Documents');
    expect(text).toContain('AGENTS.md: AGENTS.md');
    expect(text).toContain('/Users/alice/shared/AGENTS.md');
    expect(text).toContain('skills: deploy-prod, lint-fix');
    expect(text).toContain('agent profiles available as subagents: release-manager');
  });

  it('caps overlong MCP target fields from untrusted config', () => {
    const lines = renderLines(
      makeInfo({
        gatedMcpServers: [
          {
            name: 'fat',
            transport: 'stdio',
            command: 'x'.repeat(200),
            args: ['--safe'],
            origin: '/tmp/demo-workspace/.mcp.json',
          },
        ],
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('…');
    expect(text).not.toContain('x'.repeat(200));
  });

  it('handles key input: default trust, cursor moves, and Esc', () => {
    const cases: { keys: string[]; expected: string }[] = [
      { keys: ['\r'], expected: 'trust' },
      { keys: ['\u001B[A', '\r'], expected: 'trust' },
      { keys: ['\u001B[B', '\r'], expected: 'distrust' },
      { keys: ['\u001B'], expected: 'distrust' },
    ];
    for (const { keys, expected } of cases) {
      const onSelect = vi.fn();
      const prompt = new TrustPromptComponent({
        workDir: '/tmp/demo-workspace',
        info: makeInfo(),
        onSelect,
      });
      for (const key of keys) prompt.handleInput(key);
      expect(onSelect).toHaveBeenCalledWith(expected);
    }
  });
});
