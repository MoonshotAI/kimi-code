import { describe, expect, it } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { DEFAULT_STATUSLINE_CONFIG } from '#/tui/config';
import type { AppState } from '#/tui/types';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

const NODE = JSON.stringify(process.execPath);
function nodeCommand(script: string): string {
  return `${NODE} -e ${JSON.stringify(script)}`;
}

const ECHO_CONTEXT_SCRIPT = `let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>{const j=JSON.parse(d);process.stdout.write([j.session_id,j.model.id,j.workspace.current_dir,j.permission_mode,String(j.context.percent)].join('|'))})`;

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp/proj',
    additionalDirs: [],
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    statusLine: DEFAULT_STATUSLINE_CONFIG,
    availableModels: {},
    ...overrides,
  } as AppState;
}

function statusLineConfig(command: string): AppState['statusLine'] {
  return { command, intervalMs: 60_000, timeoutMs: 5_000 };
}

async function waitForLines(footer: FooterComponent, count: number): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  let lines = footer.render(120);
  while (lines.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    lines = footer.render(120);
  }
  return lines;
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('FooterComponent — statusline', () => {
  it('renders only two lines when no statusline command is configured', () => {
    const footer = new FooterComponent(baseState());
    try {
      expect(footer.render(120)).toHaveLength(2);
    } finally {
      footer.dispose();
    }
  });

  it('appends the command output as a third line with ANSI passed through', async () => {
    const footer = new FooterComponent(
      baseState({
        statusLine: statusLineConfig(
          nodeCommand(`process.stdout.write('\\u001B[31mred-status\\u001B[0m')`),
        ),
      }),
    );
    try {
      const lines = await waitForLines(footer, 3);

      expect(lines).toHaveLength(3);
      // Raw SGR from the script survives; the footer adds no colouring.
      expect(lines[2]).toContain('[31m');
      expect(strip(lines[2] ?? '')).toContain('red-status');
    } finally {
      footer.dispose();
    }
  });

  it('sends the session context as stdin JSON on every run', async () => {
    const footer = new FooterComponent(
      baseState({
        permissionMode: 'yolo',
        contextTokens: 50,
        maxContextTokens: 100,
        statusLine: statusLineConfig(nodeCommand(ECHO_CONTEXT_SCRIPT)),
      }),
    );
    try {
      const lines = await waitForLines(footer, 3);

      expect(strip(lines[2] ?? '')).toBe('sess_1|k2|/tmp/proj|yolo|50');
    } finally {
      footer.dispose();
    }
  });

  it('keeps two lines when the command never succeeds', async () => {
    const footer = new FooterComponent(
      baseState({ statusLine: statusLineConfig(nodeCommand(`process.exit(1)`)) }),
    );
    try {
      await settle(500);

      expect(footer.render(120)).toHaveLength(2);
    } finally {
      footer.dispose();
    }
  });

  it('starts the runner when setState introduces a statusline config', async () => {
    const footer = new FooterComponent(baseState());
    try {
      expect(footer.render(120)).toHaveLength(2);

      footer.setState(
        baseState({ statusLine: statusLineConfig(nodeCommand(`process.stdout.write('hot')`)) }),
      );

      const lines = await waitForLines(footer, 3);
      expect(strip(lines[2] ?? '')).toBe('hot');
    } finally {
      footer.dispose();
    }
  });
});
