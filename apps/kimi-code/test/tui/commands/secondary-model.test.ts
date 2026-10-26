/**
 * Scenario: /secondary-model command behavior in the interactive TUI.
 * Responsibilities: model and effort selection, persistence, subagent binding,
 * preservation of pool descriptions, cancellation, and error paths.
 * Wiring: real command and selectors, real SDK config and subagent integration,
 * plus a small host rig for focused error cases.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/secondary-model.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKimiHarness, type Event, type KimiConfig, type ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { handleSecondaryModelCommand } from '#/tui/commands/config';
import { EffortSelectorComponent } from '#/tui/components/dialogs/effort-selector';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';

const ESC = String.fromCodePoint(27);
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;

interface PickerOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly title?: string;
  readonly thinkingControl?: boolean;
  readonly onSelect: (selection: { alias: string }) => void;
}

function model(name: string): ModelAlias {
  return {
    provider: 'test',
    model: name,
    maxContextSize: 200_000,
    displayName: name,
  } as unknown as ModelAlias;
}

function makeHost(options?: {
  readonly secondaryModel?: KimiConfig['secondaryModel'];
}) {
  const appState = {
    availableModels: {
      k2: model('k2'),
      cheap: model('cheap'),
      // The v1 derived entry must never be selectable.
      '__secondary__': model('cheap'),
      // The pool's reserved symbolic choice must never be selectable either.
      'primary': model('primary'),
    } as Record<string, ModelAlias>,
    availableProviders: {},
    transcriptEntries: [],
  };
  const host = {
    state: {
      appState,
      transcriptEntries: [],
    },
    authFlow: {
      refreshOAuthProviderModels: vi.fn(async () => undefined),
    },
    harness: {
      getConfig: vi.fn(async () => ({
        providers: {},
        secondaryModel: options?.secondaryModel,
      })),
      setConfig: vi.fn(async () => ({})),
    },
    setAppState: vi.fn((patch) => Object.assign(appState, patch)),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      getConfig: ReturnType<typeof vi.fn>;
      setConfig: ReturnType<typeof vi.fn>;
    };
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showNotice: ReturnType<typeof vi.fn>;
  };
  return { host };
}

function mountedPicker(host: { mountEditorReplacement: ReturnType<typeof vi.fn> }): PickerOptions {
  expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  const component = host.mountEditorReplacement.mock.calls[0]![0];
  expect(component).toBeInstanceOf(TabbedModelSelectorComponent);
  return (component as unknown as { opts: PickerOptions }).opts;
}

function mountedEffortPicker(host: { mountEditorReplacement: ReturnType<typeof vi.fn> }): EffortSelectorComponent {
  const component = host.mountEditorReplacement.mock.calls.at(-1)![0];
  expect(component).toBeInstanceOf(EffortSelectorComponent);
  return component as EffortSelectorComponent;
}

async function withRealConfig(
  secondaryModel: KimiConfig['secondaryModel'],
  run: (host: ReturnType<typeof makeHost>['host'], harness: ReturnType<typeof createKimiHarness>) => Promise<void>,
): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-secondary-effort-'));
  const harness = createKimiHarness({
    homeDir,
    identity: { productName: 'test', version: '0.0.0-test', platform: 'test' },
  });
  const { host } = makeHost();
  try {
    const reasoner: ModelAlias = {
      ...model('reasoner'),
      capabilities: ['thinking', 'always_thinking'],
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    };
    await harness.setConfig({
      providers: { test: { type: 'openai', apiKey: 'YOUR_API_KEY' } },
      models: { reasoner },
      secondaryModel,
    });
    Object.assign(host, { harness });
    host.state.appState.availableModels = { reasoner };
    await run(host, harness);
  } finally {
    await harness.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe('handleSecondaryModelCommand', () => {
  it('lets the user choose and persist subagent effort with the real config service', async () => {
    await withRealConfig({ defaultModel: 'reasoner' }, async (host, harness) => {
      await handleSecondaryModelCommand(host, '');
      const modelPicker = host.mountEditorReplacement.mock.calls.at(-1)![0] as TabbedModelSelectorComponent;
      modelPicker.handleInput('\r');
      const effortPicker = mountedEffortPicker(host);
      expect(effortPicker.render(100).join('\n')).toContain('Select subagent thinking effort');
      effortPicker.handleInput(RIGHT);
      effortPicker.handleInput(RIGHT);
      effortPicker.handleInput('\r');

      await vi.waitFor(async () => {
        expect((await harness.getConfig({ reload: true })).secondaryModel).toEqual({
          defaultModel: 'reasoner',
          defaultEffort: 'high',
        });
      });
    });
  });

  it('removes the pool effort override when the user selects Default', async () => {
    await withRealConfig({
      defaultModel: 'reasoner',
      defaultEffort: 'max',
      models: { reasoner: 'complex tasks' },
    }, async (host, harness) => {
      await handleSecondaryModelCommand(host, '');
      mountedPicker(host).onSelect({ alias: 'reasoner' });
      const effortPicker = mountedEffortPicker(host);
      for (let i = 0; i < 3; i++) effortPicker.handleInput(LEFT);
      effortPicker.handleInput('\r');
      await vi.waitFor(async () => {
        expect((await harness.getConfig({ reload: true })).secondaryModel).toEqual({
          defaultModel: 'reasoner',
          models: { reasoner: 'complex tasks' },
        });
      });
      const restarted = createKimiHarness({
        homeDir: harness.homeDir,
        identity: { productName: 'test', version: '0.0.0-test', platform: 'test' },
      });
      try {
        expect((await restarted.getConfig()).secondaryModel).toEqual({
          defaultModel: 'reasoner',
          models: { reasoner: 'complex tasks' },
        });
      } finally {
        await restarted.close();
      }
    });
  });

  it('rejects a level if the pool changes to an incompatible model while the picker is open', async () => {
    await withRealConfig({ defaultModel: 'reasoner' }, async (host, harness) => {
      await handleSecondaryModelCommand(host, '');
      mountedPicker(host).onSelect({ alias: 'reasoner' });
      const effortPicker = mountedEffortPicker(host);
      for (let i = 0; i < 3; i++) effortPicker.handleInput(RIGHT);
      await harness.setConfig({
        models: {
          fast: {
            ...model('fast'),
            capabilities: ['thinking'],
            supportEfforts: ['low', 'high'],
          },
        },
        secondaryModel: { models: { reasoner: 'deep tasks', fast: 'quick tasks' } },
      });
      effortPicker.handleInput('\r');
      await vi.waitFor(() => {
        expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('max'));
      });
      expect((await harness.getConfig({ reload: true })).secondaryModel?.defaultEffort).toBeUndefined();
    });
  });

  it('uses the chosen effort on a new subagent without changing the main agent', async () => {
    await withRealConfig({ defaultModel: 'reasoner' }, async (host, harness) => {
      await harness.setConfig({
        providers: { test: { baseUrl: 'https://model.example.test/v1' } },
        models: {
          main: {
            ...host.state.appState.availableModels['reasoner']!,
            model: 'main',
          },
        },
        defaultModel: 'main',
        thinking: { enabled: true, effort: 'max' },
        autoSessionTitle: false,
      });
      await handleSecondaryModelCommand(host, '');
      mountedPicker(host).onSelect({ alias: 'reasoner' });
      const effortPicker = mountedEffortPicker(host);
      effortPicker.handleInput(RIGHT);
      effortPicker.handleInput(RIGHT);
      effortPicker.handleInput('\r');
      await vi.waitFor(() => {
        expect(host.showStatus).toHaveBeenCalled();
      });

      const requests: Array<{ model: string; reasoning_effort?: string }> = [];
      const fetchStub = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== 'https://model.example.test/v1/chat/completions') {
          throw new Error(`Unexpected fetch: ${url}`);
        }
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        const request = JSON.parse(init.body) as (typeof requests)[number];
        const delegate = request.model === 'main' && requests.length === 0;
        requests.push(request);
        const delta = delegate
          ? { tool_calls: [{ index: 0, id: 'delegate', type: 'function', function: {
            name: 'Agent', arguments: JSON.stringify({ prompt: 'Say hello.', description: 'Say hello', subagent_type: 'coder' }),
          } }] }
          : { content: 'hello' };
        const chunk = { id: 'test', object: 'chat.completion.chunk', created: 0, model: request.model };
        return new Response([
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: delegate ? 'tool_calls' : 'stop' }] })}`,
          'data: [DONE]',
        ].join('\n\n') + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      });
      try {
        const session = await harness.createSession({ workDir: harness.homeDir, permission: 'yolo' });
        let ended: Event | undefined;
        const unsubscribe = session.onEvent((event) => {
          if (event.type === 'turn.ended' && event.agentId === 'main') ended = event;
        });
        await session.prompt('Use a coder subagent to say hello.');
        await vi.waitFor(() => {
          expect(ended).toMatchObject({ reason: 'completed' });
        }, { timeout: 5_000 });
        unsubscribe();
        expect(requests.filter((request) => request.model === 'reasoner')).toEqual([
          expect.objectContaining({ reasoning_effort: 'high' }),
        ]);
        expect(requests.filter((request) => request.model === 'main')).toEqual([
          expect.objectContaining({ reasoning_effort: 'max' }),
          expect.objectContaining({ reasoning_effort: 'max' }),
        ]);
      } finally {
        fetchStub.mockRestore();
      }
    });
  }, 15_000);

  it('keeps an existing On override selected for an effort-capable model', async () => {
    await withRealConfig({ defaultModel: 'reasoner', defaultEffort: 'on' }, async (host, harness) => {
      await handleSecondaryModelCommand(host, '');
      mountedPicker(host).onSelect({ alias: 'reasoner' });
      const effortPicker = mountedEffortPicker(host);
      expect(effortPicker.render(100).join('\n')).toContain('[ On ]');
      effortPicker.handleInput('\r');
      await vi.waitFor(() => {
        expect(host.showStatus).toHaveBeenCalled();
      });
      expect((await harness.getConfig({ reload: true })).secondaryModel?.defaultEffort).toBe('on');
    });
  });

  it('preserves a valid pool effort when the selected custom model has no effort list', async () => {
    await withRealConfig({ defaultModel: 'reasoner' }, async (host, harness) => {
      const custom: ModelAlias = { ...model('custom'), capabilities: ['thinking'] };
      const secondaryModel = {
        defaultModel: 'custom',
        defaultEffort: 'xhigh',
        models: { custom: 'custom thinking model', reasoner: 'declared efforts' },
      };
      await harness.setConfig({
        models: {
          reasoner: { supportEfforts: ['low', 'high', 'xhigh'] },
          custom,
        },
        secondaryModel,
      });
      host.state.appState.availableModels = (await harness.getConfig()).models ?? {};
      await handleSecondaryModelCommand(host, '');
      const picker = host.mountEditorReplacement.mock.calls.at(-1)![0] as TabbedModelSelectorComponent;
      picker.handleInput('\r');
      const effortPicker = mountedEffortPicker(host);
      expect(effortPicker.render(100).join('\n')).toContain('[ Xhigh ]');
      effortPicker.handleInput('\r');
      await vi.waitFor(() => {
        expect(host.showStatus).toHaveBeenCalled();
      });
      expect(host.showError).not.toHaveBeenCalled();
      expect((await harness.getConfig({ reload: true })).secondaryModel).toEqual(secondaryModel);
    });
  });

  it.each([
    { label: 'omitted', supportEfforts: undefined },
    { label: 'empty', supportEfforts: [] },
  ])('offers pool efforts when the selected model effort list is $label', async ({ supportEfforts }) => {
    await withRealConfig({ defaultModel: 'reasoner' }, async (host, harness) => {
      await harness.setConfig({
        models: { custom: { ...model('custom'), capabilities: ['thinking'], supportEfforts } },
        secondaryModel: { models: { reasoner: 'declared efforts', custom: 'custom thinking model' } },
      });
      host.state.appState.availableModels = (await harness.getConfig()).models ?? {};
      await handleSecondaryModelCommand(host, 'custom');
      const picker = host.mountEditorReplacement.mock.calls.at(-1)![0] as TabbedModelSelectorComponent;
      picker.handleInput('\r');
      const effortPicker = mountedEffortPicker(host);
      for (let i = 0; i < 4; i++) effortPicker.handleInput(RIGHT);
      expect(effortPicker.render(100).join('\n')).toContain('[ Max ]');
      effortPicker.handleInput('\r');
      await vi.waitFor(() => {
        expect(host.showStatus).toHaveBeenCalled();
      });
      expect(host.showError).not.toHaveBeenCalled();
      expect((await harness.getConfig({ reload: true })).secondaryModel).toEqual({
        defaultModel: 'custom',
        defaultEffort: 'max',
        models: { reasoner: 'declared efforts', custom: 'custom thinking model' },
      });
    });
  });

  it('preserves an existing effort when the only model overrides its effort list to empty', async () => {
    await withRealConfig({ defaultModel: 'reasoner' }, async (host, harness) => {
      await harness.setConfig({
        models: { reasoner: { overrides: { supportEfforts: [] } } },
        secondaryModel: { defaultEffort: 'xhigh' },
      });
      host.state.appState.availableModels = (await harness.getConfig()).models ?? {};
      await handleSecondaryModelCommand(host, '');
      const picker = host.mountEditorReplacement.mock.calls.at(-1)![0] as TabbedModelSelectorComponent;
      picker.handleInput('\r');
      const effortPicker = mountedEffortPicker(host);
      expect(effortPicker.render(100).join('\n')).toContain('[ Xhigh ]');
      effortPicker.handleInput('\r');
      await vi.waitFor(() => {
        expect(host.showStatus).toHaveBeenCalled();
      });
      expect(host.showError).not.toHaveBeenCalled();
      expect((await harness.getConfig({ reload: true })).secondaryModel).toEqual({
        defaultModel: 'reasoner', defaultEffort: 'xhigh',
      });
    });
  });

  it('saves an effort inferred from the selected model provider', async () => {
    await withRealConfig({ defaultModel: 'reasoner' }, async (host, harness) => {
      const claude = { ...model('claude-latest') };
      await harness.setConfig({
        providers: { test: { type: 'anthropic' } },
        models: { claude },
        secondaryModel: { defaultModel: 'claude' },
      });
      host.state.appState.availableModels = { claude };
      host.state.appState.availableProviders = { test: { type: 'anthropic' } };
      await handleSecondaryModelCommand(host, '');
      mountedPicker(host).onSelect({ alias: 'claude' });
      const effortPicker = mountedEffortPicker(host);
      for (let i = 0; i < 4; i++) effortPicker.handleInput(RIGHT);
      expect(effortPicker.render(100).join('\n')).toContain('[ High ]');
      effortPicker.handleInput('\r');
      await vi.waitFor(() => {
        expect(host.showStatus).toHaveBeenCalled();
      });
      expect((await harness.getConfig({ reload: true })).secondaryModel).toEqual({
        defaultModel: 'claude', defaultEffort: 'high',
      });
      expect(host.showError).not.toHaveBeenCalled();
    });
  });

  it('offers only levels shared by every effective model in the pool', async () => {
    const { host } = makeHost({
      secondaryModel: { defaultModel: 'reasoner', models: { reasoner: 'deep tasks', fast: 'quick tasks' } },
    });
    host.state.appState.availableModels = {
      reasoner: { ...model('reasoner'), capabilities: ['always_thinking'], supportEfforts: ['low', 'high', 'max'] },
      fast: { ...model('fast'), capabilities: ['thinking'], supportEfforts: ['low', 'high', 'max'], overrides: { supportEfforts: ['high'] } },
    };
    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'reasoner' });
    const rendered = mountedEffortPicker(host).render(100).join('\n');
    expect(rendered).toContain('Default');
    expect(rendered).toContain('High');
    expect(rendered).not.toContain('Low');
    expect(rendered).not.toContain('Max');
    expect(rendered).not.toContain('Off');
    expect(rendered).toContain('entire subagent model pool');
  });

  it('leaves the model and effort unchanged when the effort step is cancelled', async () => {
    await withRealConfig({ defaultModel: 'reasoner', defaultEffort: 'max' }, async (host, harness) => {
      await handleSecondaryModelCommand(host, '');
      mountedPicker(host).onSelect({ alias: 'reasoner' });
      const effortPicker = mountedEffortPicker(host);
      effortPicker.handleInput(LEFT);
      effortPicker.handleInput(ESC);
      expect((await harness.getConfig({ reload: true })).secondaryModel).toEqual({
        defaultModel: 'reasoner', defaultEffort: 'max',
      });
      expect(host.showStatus).not.toHaveBeenCalled();
    });
  });

  it('opens the picker filtered to user models, with the configured default as current', async () => {
    const { host } = makeHost({ secondaryModel: { defaultModel: 'cheap' } });

    await handleSecondaryModelCommand(host, '');

    const opts = mountedPicker(host);
    expect(Object.keys(opts.models)).toEqual(['k2', 'cheap']);
    expect(opts.currentValue).toBe('cheap');
    expect(opts.title).toContain('secondary model');
    // The following step selects effort and explains its pool-wide scope.
    expect(opts.thinkingControl).toBe(false);
  });

  it('persists only default_model when no pool exists (implicit single-entry pool)', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });
    mountedEffortPicker(host).handleInput('\r');

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      secondaryModel: { defaultModel: 'k2' },
    });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('adds the picked alias to an existing pool with an empty description', async () => {
    const { host } = makeHost({
      secondaryModel: {
        defaultModel: 'cheap',
        models: { cheap: 'fast and cheap' },
      },
    });

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });
    mountedEffortPicker(host).handleInput('\r');

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      secondaryModel: {
        defaultModel: 'k2',
        models: { cheap: 'fast and cheap', k2: '' },
      },
    });
  });

  it('keeps existing pool descriptions and other pool entries on save', async () => {
    const { host } = makeHost({
      secondaryModel: {
        defaultModel: 'cheap',
        models: { cheap: 'fast and cheap', k2: 'hard tasks' },
      },
    });

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });
    mountedEffortPicker(host).handleInput('\r');

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      secondaryModel: {
        defaultModel: 'k2',
        models: { cheap: 'fast and cheap', k2: 'hard tasks' },
      },
    });
  });

  it('pre-selects a valid alias argument instead of erroring', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, 'cheap');

    const opts = mountedPicker(host);
    expect(opts.selectedValue).toBe('cheap');
  });

  it('rejects an unknown alias argument without opening the picker', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, 'nope');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: nope');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('rejects the synthesized derived alias as an argument', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, '__secondary__');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: __secondary__');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('rejects the reserved primary alias as an argument', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, 'primary');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('reserved'));
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('reports the reserved error for primary even when it is the only configured model', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = { primary: model('primary') };

    await handleSecondaryModelCommand(host, 'primary');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('reserved'));
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('shows a notice when no models are configured', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = {};

    await handleSecondaryModelCommand(host, '');

    expect(host.showNotice).toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('reports a persistence failure without a status message', async () => {
    const { host } = makeHost();
    host.harness.setConfig.mockRejectedValueOnce(new Error('disk full'));

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });
    mountedEffortPicker(host).handleInput('\r');

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalled();
    });
    expect(host.showError.mock.calls[0]![0]).toContain('disk full');
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});
