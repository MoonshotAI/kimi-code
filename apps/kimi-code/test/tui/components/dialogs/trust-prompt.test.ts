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
    disabledUserMcpServers: [],
    instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [] },
    disclosureComplete: true,
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

  it('renders the empty state, and admits incomplete discovery instead', () => {
    const text = renderLines().join('\n');
    expect(text).toContain('No project-level config found here');
    expect(text).toContain('subject to your approvals');
    expect(text).toContain('applies automatically once this folder is trusted');

    const partial = renderLines(makeInfo({ disclosureComplete: false })).join('\n');
    expect(partial).toContain('disclosure may be incomplete');
    expect(partial).not.toContain('No project-level config found here');
  });

  it('lists the gated project MCP servers with keys and origin', () => {
    const lines = renderLines(
      makeInfo({
        gatedMcpServers: [
          {
            name: 'nested-server',
            transport: 'stdio',
            command: 'nested-cmd',
            args: ['--safe'],
            cwd: '/tmp',
            envKeys: ['API_KEY'],
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
        ],
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('Run 2 project MCP servers');
    expect(text).toContain('nested-server (stdio): command=nested-cmd');
    expect(text).toContain('args=["--safe"] cwd=/tmp');
    expect(text).toContain('env keys: API_KEY');
    expect(text).toContain('from .mcp.json');
    expect(text).toContain('root-server (http): url=https://example.test/mcp');
    expect(text).toContain('header keys: Authorization · bearer token from env MCP_TOKEN');
    expect(text).toContain('from .kimi-code/mcp.json');
  });

  it('renders the directory, instruction, and disabled-server sections', () => {
    const lines = renderLines(
      makeInfo({
        gatedAdditionalDirs: [
          { path: '/tmp/shared-assets', realPath: '/tmp/shared-assets' },
          { path: '/opt/toolchain', realPath: '/opt/toolchain' },
          { path: '/tmp/demo-workspace/linked-dir', realPath: '/Users/alice/Documents' },
        ],
        disabledUserMcpServers: ['github', 'ci-runner'],
        instructionSources: {
          agentsMdPaths: ['/tmp/demo-workspace/AGENTS.md'],
          skills: ['deploy-prod', 'lint-fix'],
          agentProfiles: ['release-manager'],
        },
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('Grant access to 3 directories outside this project');
    expect(text).toContain('/tmp/shared-assets');
    expect(text).toContain('/opt/toolchain');
    // A symlinked entry renders its real target so the grant is not disguised.
    expect(text).toContain('/tmp/demo-workspace/linked-dir → /Users/alice/Documents');
    expect(text).toContain('Turn off 2 user-level MCP servers (disabled by project config)');
    expect(text).toContain('github');
    expect(text).toContain('ci-runner');
    expect(text).toContain('Feed instructions to the agent');
    expect(text).toContain('AGENTS.md: AGENTS.md');
    expect(text).toContain('skills: deploy-prod, lint-fix');
    expect(text).toContain('agent profiles: release-manager');
  });

  it('strips terminal control characters from workspace-supplied text', () => {
    const lines = renderLines(
      makeInfo({
        gatedMcpServers: [
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
          skills: ['ski\u001B[2Jll'],
          agentProfiles: [],
        },
      }),
    );
    const text = lines.join('\n');
    // ESC and BEL are dropped, defusing the sequences into harmless literal text.
    expect(text).toContain('evil (stdio): command=cmd[2Jevil');
    expect(text).toContain('multiline (http): url=https://example.test/]8;;https://evil.test');
    expect(text).toContain('env keys: SAFE, BAD');
    expect(text).toContain('skills: ski[2Jll');
    expect(text).not.toContain('\u001B]8;;https://evil.test');
  });

  it('caps long lists and untrusted MCP key lists with a "+N more" suffix', () => {
    const lines = renderLines(
      makeInfo({
        gatedMcpServers: [
          {
            name: 'fat',
            transport: 'stdio',
            command: 'cmd',
            envKeys: Array.from({ length: 25 }, (_, i) => `KEY_${i}`),
            origin: '/tmp/demo-workspace/.mcp.json',
          },
        ],
        instructionSources: {
          agentsMdPaths: [],
          skills: Array.from({ length: 12 }, (_, i) => `skill-${i}`),
          agentProfiles: [],
        },
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('env keys: KEY_0, KEY_1');
    expect(text).toContain('+15 more');
    expect(text).not.toContain('KEY_24');
    expect(text).toContain('+4 more');
  });

  it('defaults to Trust this folder', () => {
    const onSelect = vi.fn();
    const prompt = new TrustPromptComponent({
      workDir: '/tmp/demo-workspace',
      info: makeInfo(),
      onSelect,
    });
    prompt.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('trust');
  });

  it('stays on trust when moving up past the top', () => {
    const onSelect = vi.fn();
    const prompt = new TrustPromptComponent({
      workDir: '/tmp/demo-workspace',
      info: makeInfo(),
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
      info: makeInfo(),
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
      info: makeInfo(),
      onSelect,
    });
    prompt.handleInput('\u001B');
    expect(onSelect).toHaveBeenCalledWith('distrust');
  });
});
