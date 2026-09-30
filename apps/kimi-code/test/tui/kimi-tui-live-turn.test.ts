import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAssistantMessage,
  createUserMessage,
  type AgentLlmRequester,
  type LlmModelSpec,
  type LlmOutcome,
} from '@moonshot-ai/agent-core';
import { McpRef } from '@moonshot-ai/harness-core';
import { createKimiHarness, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { dispatchInput } from '#/tui/commands/dispatch';
import { handleReloadCommand } from '#/tui/commands/reload';
import { TrustPromptComponent } from '#/tui/components/dialogs/trust-prompt';
import { KimiTUI } from '#/tui/kimi-tui';
import { DEFAULT_TUI_CONFIG } from '#/tui/config';
import type { CLIOptions } from '#/cli/options';

const model: LlmModelSpec = { provider: 'test', name: 'test-model' };

function createScriptedRequester(text: string): AgentLlmRequester {
  const self: AgentLlmRequester = {
    with: () => self,
    request: () => {
      throw new Error('unused');
    },
    generate: async (_rest, control) => {
      control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text } });
      const usage = { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 };
      control.onEvent?.({ type: 'llm.streaming.usage', usage });
      const outcome: LlmOutcome = {
        type: 'done',
        message: createAssistantMessage([{ type: 'text', text }]),
        usage,
      };
      control.onEvent?.({ type: 'llm.ended', outcome });
      return outcome;
    },
  };
  return self;
}

const CLI_OPTIONS: CLIOptions = {
  session: undefined,
  continue: false,
  yolo: false,
  auto: false,
  plan: false,
  model: undefined,
  outputFormat: undefined,
  prompt: undefined,
  skillsDirs: [],
  agent: undefined,
  agentFiles: [],
};

describe('KimiTUI live turn (v3 harness)', () => {
  let root: string | undefined;
  let harness: KimiHarness | undefined;

  afterEach(async () => {
    const currentRoot = root;
    root = undefined;
    harness = undefined;
    if (currentRoot !== undefined) {
      await rm(currentRoot, { recursive: true, force: true });
    }
  });

  it('lazy-creates a session, streams a turn, and returns to idle', async () => {
    root = await mkdtemp(join(tmpdir(), 'kimi-tui-live-turn-'));
    const workDir = join(root, 'work');
    harness = await createKimiHarness({
      homeDir: join(root, 'home'),
      workDir,
    });
    await harness.config.set('defaultModel', 'test/test-model', 'user');

    const tui = new KimiTUI(harness, {
      cliOptions: CLI_OPTIONS,
      tuiConfig: DEFAULT_TUI_CONFIG,
      version: '0.0.0-test',
      workDir,
    });
    tui.hydrateLazyConfigDefaults();
    expect(tui.state.appState.model).toBe('test/test-model');

    await tui.sendNormalUserInput('hello');
    const session = tui.session;
    expect(session).toBeDefined();
    session!.main.setModel({ spec: model });
    session!.main.setRequester(createScriptedRequester('hi there'));

    const done = await session!.main.wait('turn.done', { timeoutMs: 10_000 });
    expect(done.outcome.type).toBe('done');

    // Let the turn.done handler (which waits for the journal write chain) land.
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    const assistantText = tui.state.transcriptEntries
      .filter((entry) => entry.kind === 'assistant')
      .map((entry) => entry.content)
      .join('');
    expect(assistantText).toContain('hi there');
    const userEntries = tui.state.transcriptEntries.filter((entry) => entry.kind === 'user');
    expect(userEntries.map((entry) => entry.content)).toContain('hello');
    expect(tui.state.appState.streamingPhase).toBe('idle');
    expect(tui.state.appState.sessionId).toBe(session!.id);

    await tui.stop();
  }, 20_000);

  it('registers dynamic skill commands and dispatches an activation', async () => {
    root = await mkdtemp(join(tmpdir(), 'kimi-tui-skill-dispatch-'));
    const workDir = join(root, 'work');
    harness = await createKimiHarness({
      homeDir: join(root, 'home'),
      workDir,
    });
    await harness.config.set('defaultModel', 'test/test-model', 'user');

    const tui = new KimiTUI(harness, {
      cliOptions: CLI_OPTIONS,
      tuiConfig: DEFAULT_TUI_CONFIG,
      version: '0.0.0-test',
      workDir,
    });

    await tui.refreshDynamicCommands();
    expect(tui.skillCommandMap.get('write-goal')).toBe('write-goal');
    expect(tui.skillCommandMap.get('update-config')).toBe('update-config');

    const session = await tui.ensureSession();
    expect(session).toBeDefined();
    session!.main.setModel({ spec: model });
    session!.main.setRequester(createScriptedRequester('skill ran'));
    tui.sessionEventHandler.startSubscription();

    dispatchInput(tui, '/write-goal ship the feature');
    const done = await session!.main.wait('turn.done', { timeoutMs: 10_000 });
    expect(done.outcome.type).toBe('done');
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    const activations = tui.state.transcriptEntries.filter(
      (entry) => entry.kind === 'skill_activation',
    );
    expect(activations.length).toBe(1);
    expect(activations[0]?.skillName).toBe('write-goal');
    expect(activations[0]?.skillArgs).toBe('ship the feature');

    await tui.stop();
  }, 20_000);

  it('expands plugin commands into a prompt on dispatch', async () => {
    root = await mkdtemp(join(tmpdir(), 'kimi-tui-plugin-cmd-'));
    const workDir = join(root, 'work');
    harness = await createKimiHarness({
      homeDir: join(root, 'home'),
      workDir,
    });

    const tui = new KimiTUI(harness, {
      cliOptions: CLI_OPTIONS,
      tuiConfig: DEFAULT_TUI_CONFIG,
      version: '0.0.0-test',
      workDir,
    });
    tui.pluginCommandMap.set('demo:deploy', 'Deploy $ARGUMENTS now.');
    const sent: string[] = [];
    tui.sendNormalUserInput = async (text: string) => {
      sent.push(text);
    };

    dispatchInput(tui, '/demo:deploy prod');

    expect(sent).toEqual(['Deploy prod now.']);
    await tui.stop();
  }, 20_000);

  it('reloads every mounted facade through /reload', async () => {
    root = await mkdtemp(join(tmpdir(), 'kimi-tui-reload-'));
    const workDir = join(root, 'work');
    const previousHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = join(root, 'home');
    try {
      harness = await createKimiHarness({
        homeDir: join(root, 'home'),
        workDir,
      });

      const tui = new KimiTUI(harness, {
        cliOptions: CLI_OPTIONS,
        tuiConfig: DEFAULT_TUI_CONFIG,
        version: '0.0.0-test',
        workDir,
      });
      const statuses: string[] = [];
      const showStatus = tui.showStatus.bind(tui);
      tui.showStatus = (msg: string, color?: Parameters<typeof showStatus>[1]) => {
        statuses.push(msg);
        showStatus(msg, color);
      };

      await handleReloadCommand(tui);

      expect(statuses).toContain('Reloaded: config, skills, profiles, plugins, mcp.');
      expect(tui.skillCommandMap.get('write-goal')).toBe('write-goal');
      await tui.stop();
    } finally {
      if (previousHome === undefined) {
        delete process.env['KIMI_CODE_HOME'];
      } else {
        process.env['KIMI_CODE_HOME'] = previousHome;
      }
    }
  }, 20_000);

  it('binds an --agent-file profile system prompt at session creation', async () => {
    root = await mkdtemp(join(tmpdir(), 'kimi-tui-agent-file-'));
    const workDir = join(root, 'work');
    const profilePath = join(root, 'test-agent.md');
    await writeFile(
      profilePath,
      [
        '---',
        'name: test-agent',
        'description: test profile',
        '---',
        '',
        'You are the test agent. MARKER-AGENT-FILE-XYZ.',
        '',
      ].join('\n'),
      'utf-8',
    );
    harness = await createKimiHarness({
      homeDir: join(root, 'home'),
      workDir,
    });
    await harness.config.set('defaultModel', 'test/test-model', 'user');

    const tui = new KimiTUI(harness, {
      cliOptions: { ...CLI_OPTIONS, agentFiles: [profilePath] },
      tuiConfig: DEFAULT_TUI_CONFIG,
      version: '0.0.0-test',
      workDir,
    });

    let systemText = '';
    const session = await tui.ensureSession();
    expect(session).toBeDefined();
    session!.main.setModel({ spec: model });
    const systemPromptRequester: AgentLlmRequester = {
      with: () => systemPromptRequester,
      request: () => {
        throw new Error('unused');
      },
      generate: async (rest, control) => {
        systemText = rest.profile?.systemPrompt ?? '';
        control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'ok' } });
        const usage = { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 };
        control.onEvent?.({ type: 'llm.streaming.usage', usage });
        const outcome: LlmOutcome = {
          type: 'done',
          message: createAssistantMessage([{ type: 'text', text: 'ok' }]),
          usage,
        };
        control.onEvent?.({ type: 'llm.ended', outcome });
        return outcome;
      },
    };
    session!.main.setRequester(systemPromptRequester);

    const done = await session!.main.run(createUserMessage('hi'), { timeoutMs: 10_000 });
    expect(done.outcome.type).toBe('done');
    expect(systemText).toContain('MARKER-AGENT-FILE-XYZ');

    await tui.stop();
  }, 20_000);

  it('recreates the harness with trusted MCP after a startup trust grant', async () => {
    root = await mkdtemp(join(tmpdir(), 'kimi-tui-trust-'));
    const workDir = join(root, 'work');
    await mkdir(join(workDir, '.kimi-code'), { recursive: true });
    await writeFile(
      join(workDir, '.kimi-code', 'mcp.json'),
      JSON.stringify({ mcpServers: { 'proj-server': { url: 'https://example.test/mcp' } } }),
      'utf-8',
    );
    const homeDir = join(root, 'home');
    harness = await createKimiHarness({ homeDir, workDir });
    const original = harness;
    let closed = false;
    const originalClose = original.close.bind(original);
    original.close = async () => {
      closed = true;
      await originalClose();
    };
    let factoryCalls = 0;
    const factory = (): Promise<KimiHarness> => {
      factoryCalls += 1;
      return createKimiHarness({ homeDir, workDir });
    };

    const tui = new KimiTUI(original, {
      cliOptions: CLI_OPTIONS,
      tuiConfig: DEFAULT_TUI_CONFIG,
      version: '0.0.0-test',
      workDir,
      harnessFactory: factory,
    });

    expect(original.trust.isTrusted(workDir)).toBe(false);
    const promptPromise = (
      tui as unknown as { maybeRunWorkspaceTrustPrompt(): Promise<boolean> }
    ).maybeRunWorkspaceTrustPrompt();
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    const prompt = tui.state.editorContainer.children.find(
      (child) => child instanceof TrustPromptComponent,
    );
    expect(prompt).toBeDefined();
    (prompt as TrustPromptComponent).handleInput('\r');
    const startedLoop = await promptPromise;

    expect(startedLoop).toBe(true);
    expect(factoryCalls).toBe(1);
    expect(closed).toBe(true);
    expect(tui.harness).not.toBe(original);
    expect(tui.harness.trust.isTrusted(workDir)).toBe(true);

    let projectServerVisible = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (tui.harness.app.resolve(McpRef)?.list().some((entry) => entry.name === 'proj-server') === true) {
        projectServerVisible = true;
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    expect(projectServerVisible).toBe(true);

    await tui.stop();
  }, 30_000);
});
