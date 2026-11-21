import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import type { WorkspaceTrustInfo } from '@moonshot-ai/kimi-code-sdk';
import { TrustPromptComponent } from '#/tui/components/dialogs/trust-prompt';

const projectRoot = '/tmp/example-project';
function info(overrides: Partial<WorkspaceTrustInfo> = {}): WorkspaceTrustInfo {
  return {
    trusted: false,
    projectRoot,
    gatedMcpServers: [],
    gatedAdditionalDirs: [],
    additionalDirSources: [],
    instructionSources: { agentsMdPaths: [], skills: [], agentProfiles: [], paths: [] },
    warnings: [],
    ...overrides,
  };
}
function render(prompt: TrustPromptComponent, width = 80): string[] {
  return prompt.render(width).map((line) => line.replaceAll(/\u001B\[[0-9;]*m/g, ''));
}
function mouse(type: 'move' | 'press' | 'release' | 'click', y: number): TuiMouseEvent {
  return {
    type,
    button: type === 'move' ? 'none' : 'left',
    x: 4,
    y,
    screenX: 4,
    screenY: y,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function mixedInfo(): WorkspaceTrustInfo {
  return info({
    gatedMcpServers: [
      {
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['--private-argument'],
        origin: `${projectRoot}/.mcp.json`,
      },
      {
        name: 'docs',
        transport: 'http',
        url: 'https://example.test/private',
        origin: `${projectRoot}/.kimi-code/mcp.json`,
      },
    ],
    gatedAdditionalDirs: ['/tmp/shared-assets', '/Users/example/Documents'],
    additionalDirSources: [`${projectRoot}/.kimi-code/local.toml`],
    instructionSources: {
      agentsMdPaths: [`${projectRoot}/AGENTS.md`],
      skills: ['lint-fix', 'deploy'],
      agentProfiles: ['reviewer'],
      paths: [
        `${projectRoot}/AGENTS.md`,
        `${projectRoot}/.kimi-code/skills/`,
        `${projectRoot}/.kimi-code/agents/`,
      ],
    },
  });
}

describe('TrustPromptComponent', () => {
  it('asks to trust the project and shows its primary directory', () => {
    const prompt = new TrustPromptComponent({
      info: info({ projectRoot: '/work/app' }),
      getAvailableRows: () => 23,
      onSelect: vi.fn(),
    });
    const lines = render(prompt);
    const text = lines.join('\n');
    expect(lines[1]).toBe(' Trust this project?');
    expect(lines.slice(4, 5)).toEqual([' /work/app']);
    expect(text).toContain('Trust is remembered for this project, including future project config changes.');
    expect(text).not.toContain('folder');
  });
  it('shows sources inside the project root relative to it and other sources in full', () => {
    const prompt = new TrustPromptComponent({
      info: info({
        projectRoot: '/work/app',
        gatedMcpServers: [
          { name: 'checkout', transport: 'stdio', origin: '/work/app-fix/.kimi-code/mcp.json' },
          { name: 'root', transport: 'stdio', origin: '/work/app/.mcp.json' },
        ],
      }),
      getAvailableRows: () => 23,
      onSelect: vi.fn(),
    });
    expect(render(prompt).join('\n')).toContain('Config: /work/app-fix/.kimi-code/mcp.json, .mcp.json');
  });
  it('fits typical consequences and actual source paths on an 80x24 terminal', () => {
    const prompt = new TrustPromptComponent({
      info: mixedInfo(),
      getAvailableRows: () => 23,
      onSelect: vi.fn(),
    });
    const lines = render(prompt);
    const text = lines.join('\n');
    expect(lines.length).toBeLessThanOrEqual(23);
    for (const label of [
      'Start 2 MCP servers automatically',
      'Config: .mcp.json, .kimi-code/mcp.json',
      'Access 2 folders outside this project',
      'Config: .kimi-code/local.toml',
      'AGENTS.md',
      '.kimi-code/skills',
      '.kimi-code/agents/',
      'Check:',
      'future project config changes',
      'Trust and continue',
    ])
      expect(text).toContain(label);
    for (const hidden of [
      'page',
      '--private-argument',
      'PRIVATE_KEY',
      'https://example.test/private',
      'subagents',
    ])
      expect(text).not.toContain(hidden);
  });
  it('distinguishes empty activation from unreadable configuration', () => {
    const empty = new TrustPromptComponent({ info: info(), onSelect: vi.fn() });
    expect(render(empty).join('\n')).toContain(
      'No project integrations or instructions to activate.',
    );
    const failed = new TrustPromptComponent({
      info: info({ warnings: ['Could not inspect MCP configuration.'] }),
      onSelect: vi.fn(),
    });
    const text = render(failed).join('\n');
    expect(text).toContain('Could not inspect MCP configuration.');
    expect(text).not.toContain('No project integrations');
    expect(text).not.toContain('No project-level config');
    expect(text).toContain('future project config changes');
  });
  it('pages through MCP sources with fixed choices and persistent trust copy', () => {
    const paths = Array.from({ length: 8 }, (_, i) => `/outside/directory-${i}`);
    const origins = Array.from({ length: 12 }, (_, i) => `/outside/source-${i}/mcp.json`);
    let rows = 23;
    const prompt = new TrustPromptComponent({
      info: info({
        gatedMcpServers: origins.map((origin, i) => ({
          name: `server-${i}`,
          transport: 'stdio',
          origin,
        })),
        gatedAdditionalDirs: paths,
        additionalDirSources: [`${projectRoot}/.kimi-code/local.toml`],
      }),
      getAvailableRows: () => rows,
      onSelect: vi.fn(),
    });
    const pages: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const lines = render(prompt, 60);
      const text = lines.join('\n');
      if (pages.includes(text)) break;
      expect(lines.length).toBeLessThanOrEqual(rows);
      expect(text).toContain('Trust and continue');
      expect(text).toContain('Exit');
      expect(text.replaceAll(/\s+/g, ' ')).toContain('future project config');
      pages.push(text);
      prompt.handleInput('\u001B[C');
    }
    expect(pages.length).toBeGreaterThan(1);
    for (const path of origins) expect(pages.join('\n')).toContain(path);
    expect(pages.join('\n')).not.toContain('/outside/directory-');
    expect(pages.join('\n')).not.toContain('more');
    prompt.handleInput('\u001B[D');
    expect(render(prompt, 60).join('\n')).toBe(pages.at(-2));
    prompt.handleInput('\u001B[6~');
    expect(render(prompt, 60).join('\n')).toBe(pages.at(-1));
    rows = 60;
    expect(render(prompt, 60).join('\n')).not.toContain('page');
  });
  it('cleans control characters and retains full long source paths across wrapping', () => {
    const longPath = `/outside/${'x'.repeat(100)}/mcp.json`;
    const prompt = new TrustPromptComponent({
      info: info({
        projectRoot: '/tmp/\u001B[2Jproject',
        gatedMcpServers: [{ name: 'ignored', transport: 'http', origin: longPath }],
        gatedAdditionalDirs: ['/outside/\u001B[2Jdirectory\u0007'],
        additionalDirSources: ['/outside/\u001B[2Jconfig\u0007'],
      }),
      onSelect: vi.fn(),
    });
    const text = render(prompt).join('\n');
    expect(text).not.toContain('\u001B');
    expect(text).not.toContain('\u0007');
    expect(text).toContain('/outside/[2Jconfig');
    expect(text.replaceAll(/\s/g, '')).toContain(longPath);
  });
  it('pauses confirmation in a tiny terminal and restores it after resizing', () => {
    let rows = 4;
    const onSelect = vi.fn();
    const prompt = new TrustPromptComponent({
      info: mixedInfo(),
      getAvailableRows: () => rows,
      onSelect,
    });
    expect(render(prompt).join('\n')).toContain('Enlarge terminal');
    prompt.handleInput('\r');
    expect(onSelect).not.toHaveBeenCalled();
    prompt.handleInput('\u001B');
    expect(onSelect).toHaveBeenCalledWith('distrust');
    onSelect.mockClear();
    rows = 23;
    render(prompt);
    prompt.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('trust');
  });
  it('moves selection with the pointer and activates the same choice on click', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const onSelect = vi.fn();
    const prompt = new TrustPromptComponent({ info: info(), onSelect });
    prompt.focused = true;
    const row = render(prompt).findIndex((line) => line.includes('Exit'));

    expect(prompt.handleMouse(mouse('move', row))).toEqual({ handled: true, render: true });
    expect(render(prompt)[row]).toContain('❯ Exit');
    expect(onSelect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    for (const type of ['press', 'release', 'click'] as const) prompt.handleMouse(mouse(type, row));
    expect(onSelect).toHaveBeenCalledWith('distrust');
  });

  it('preserves default trust, selection, and escape behavior', () => {
    for (const { keys, expected } of [
      { keys: ['\r'], expected: 'trust' },
      { keys: ['\u001B[A', '\r'], expected: 'trust' },
      { keys: ['\u001B[B', '\r'], expected: 'distrust' },
      { keys: ['\u001B'], expected: 'distrust' },
    ]) {
      const onSelect = vi.fn();
      const prompt = new TrustPromptComponent({ info: info(), onSelect });
      render(prompt);
      for (const key of keys) prompt.handleInput(key);
      expect(onSelect).toHaveBeenCalledWith(expected);
    }
  });
});
