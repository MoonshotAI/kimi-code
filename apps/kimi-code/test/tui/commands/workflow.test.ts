import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleWorkflowCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { closeWorkflowsBrowser } from '#/tui/controllers/workflows-browser';
import { currentTheme } from '#/tui/theme';

const ENTER = '\r';
const ESCAPE = '';
const DOWN = '[B';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const WORKFLOW = {
  name: 'demo-flow',
  description: 'Demo workflow.',
  whenToUse: undefined,
  phases: [{ title: 'One', detail: 'first' }, { title: 'Two' }],
  path: '/tmp/demo-flow.js',
  source: 'project' as const,
};

const WORKFLOW_DETAIL = { ...WORKFLOW, script: 'export const meta = {};\nreturn 1;\n' };

const RUN = {
  runId: 'wfrun-abc123',
  workflowName: 'demo-flow',
  description: 'Demo workflow.',
  phases: WORKFLOW.phases,
  status: 'running' as const,
  phase: 'One',
  phaseIndex: 0,
  agentCalls: 2,
  logs: ['[phase] One'],
  startedAt: Date.now(),
  taskId: 'workflow-xyz',
  args: '',
  source: 'project' as const,
  scriptPath: '/tmp/demo-flow.js',
};

function makeSession() {
  return {
    listWorkflows: vi.fn(async () => ({ workflows: [WORKFLOW], skipped: [] as { path: string; reason: string }[] })),
    getWorkflow: vi.fn(async (name: string) => ({ workflow: name === 'demo-flow' ? WORKFLOW_DETAIL : null })),
    reloadWorkflows: vi.fn(async () => ({ workflows: [WORKFLOW], skipped: [{ path: '/tmp/bad.js', reason: 'no meta' }] })),
    runWorkflow: vi.fn(async () => ({ runId: 'wfrun-abc123', taskId: 'workflow-xyz', workflowName: 'demo-flow' })),
    listWorkflowRuns: vi.fn(async () => ({ runs: [RUN] })),
    getWorkflowRun: vi.fn(async () => ({ run: { ...RUN, script: WORKFLOW_DETAIL.script } })),
    cancelWorkflowRun: vi.fn(async () => ({ cancelled: true })),
    saveWorkflow: vi.fn(async () => ({ path: '/tmp/.kimi-code/workflows/demo-flow.js', name: 'demo-flow' })),
  };
}

function makeHost(options: { hasSession?: boolean } = {}) {
  const session = makeSession();
  const children: unknown[] = ['layout'];
  const host = {
    state: {
      appState: {},
      theme: currentTheme,
      ui: {
        children,
        clear: vi.fn(() => children.splice(0, children.length)),
        addChild: vi.fn((child: unknown) => children.push(child)),
        setFocus: vi.fn(),
        requestRender: vi.fn(),
      },
      terminal: { rows: 24 },
      editor: {},
      transcriptContainer: { addChild: vi.fn() },
    },
    session: (options.hasSession ?? true) ? session : undefined,
    requireSession: () => session,
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

interface TestComponent {
  handleInput(data: string): void;
  render(width: number): string[];
}

function mountedPrompt(host: SlashCommandHost): TestComponent {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  const component = mock.mock.calls.at(-1)?.[0] as TestComponent | undefined;
  if (component === undefined) throw new Error('expected a mounted prompt');
  return component;
}

afterEach(() => {
  closeWorkflowsBrowser();
});

describe('handleWorkflowCommand', () => {
  it('requires an active session', async () => {
    const { host } = makeHost({ hasSession: false });
    await handleWorkflowCommand(host, 'list');
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('session'));
  });

  it('lists discovered workflows', async () => {
    const { host } = makeHost();
    await handleWorkflowCommand(host, 'list');
    expect(host.showNotice).toHaveBeenCalledWith(
      'Workflows (1)',
      expect.stringContaining('demo-flow'),
    );
  });

  it('opens the runs browser when invoked without arguments', async () => {
    const { host } = makeHost();
    await handleWorkflowCommand(host, '');
    const ui = host.state.ui as unknown as { children: unknown[] };
    const browser = ui.children.at(-1) as TestComponent;
    const rendered = stripAnsi(browser.render(100).join('\n'));
    expect(rendered).toContain('Workflow runs');
    browser.handleInput(ESCAPE); // close
  });

  it('executes the workflow immediately when called with run', async () => {
    const { host, session } = makeHost();
    await handleWorkflowCommand(host, 'run demo-flow some args');
    expect(session.runWorkflow).toHaveBeenCalledWith({ name: 'demo-flow', args: 'some args' });
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('wfrun-abc123'));
  });

  it('executes without args when none are provided', async () => {
    const { host, session } = makeHost();
    await handleWorkflowCommand(host, 'run demo-flow');
    expect(session.runWorkflow).toHaveBeenCalledWith({ name: 'demo-flow', args: '' });
  });

  it('errors when the workflow does not exist', async () => {
    const { host, session } = makeHost();
    session.runWorkflow = vi.fn(async () => { throw new Error('workflow not found: missing-flow'); });
    await handleWorkflowCommand(host, 'run missing-flow');
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('missing-flow'));
  });

  it('cancels a run by unique prefix', async () => {
    const { host, session } = makeHost();
    await handleWorkflowCommand(host, 'cancel wfrun-abc');
    expect(session.cancelWorkflowRun).toHaveBeenCalledWith('wfrun-abc123');
  });

  it('rejects an unknown run prefix', async () => {
    const { host, session } = makeHost();
    await handleWorkflowCommand(host, 'cancel nope');
    expect(session.cancelWorkflowRun).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('nope'));
  });

  it('saves a run to the project scope by default and to user scope with --user', async () => {
    const { host, session } = makeHost();
    await handleWorkflowCommand(host, 'save wfrun-abc');
    expect(session.saveWorkflow).toHaveBeenCalledWith({
      script: WORKFLOW_DETAIL.script,
      scope: 'project',
    });
    await handleWorkflowCommand(host, 'save wfrun-abc --user');
    expect(session.saveWorkflow).toHaveBeenCalledWith({
      script: WORKFLOW_DETAIL.script,
      scope: 'user',
    });
  });

  it('reloads workflows and reports skipped files', async () => {
    const { host } = makeHost();
    await handleWorkflowCommand(host, 'reload');
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('1 discovered (1 invalid skipped)'));
  });

  it('opens the runs browser with /workflow runs', async () => {
    const { host } = makeHost();
    await handleWorkflowCommand(host, 'runs');
    const ui = host.state.ui as unknown as { children: unknown[] };
    const browser = ui.children.at(-1) as TestComponent;
    const rendered = stripAnsi(browser.render(100).join('\n'));
    expect(rendered).toContain('Workflow runs');
    expect(rendered).toContain('demo-flow');
    browser.handleInput(ESCAPE); // close
  });
});
