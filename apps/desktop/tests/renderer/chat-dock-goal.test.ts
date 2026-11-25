// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import ChatDock from '../../src/renderer/components/chat/ChatDock.vue';

const state = vi.hoisted(() => ({
  goal: null as null | { value: { objective: string; status: 'active' | 'paused' | 'blocked'; turnsUsed: number; tokensUsed: number; wallClockMs: number } | null },
  goalModeAvailable: null as null | { value: boolean },
  controlGoal: null as null | ReturnType<typeof vi.fn>,
  confirm: null as null | ReturnType<typeof vi.fn>,
}));

vi.mock('@moonshot-ai/app-client/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/client')>();
  const vue = await import('vue');
  state.goal = vue.ref(null);
  state.goalModeAvailable = vue.ref(true);
  state.controlGoal = vi.fn();
  state.confirm = vi.fn(async () => true);
  return {
    ...actual,
    useKimiWebClient: () => ({
      goal: state.goal!,
      goalModeAvailable: state.goalModeAvailable!,
      status: vue.ref({ cwd: '/workspace' }),
      planMode: vue.ref(false),
      planArmed: vue.ref(false),
      controlGoal: state.controlGoal!,
      togglePlanMode: vi.fn(),
      cancelTask: vi.fn(),
      dismissQuestion: vi.fn(),
    }),
  };
});

vi.mock('@moonshot-ai/app-client/composables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-client/composables')>();
  const vue = await import('vue');
  return {
    ...actual,
    useConfirmDialog: () => ({ confirm: state.confirm!, isConfirmOpen: vue.ref(false) }),
    useAppDialogs: () => ({ anyOverlayOpen: vue.ref(false) }),
  };
});

vi.mock('@moonshot-ai/app-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-core')>();
  const vue = await import('vue');
  return { ...actual, useAppearance: () => ({ fontScale: vue.ref('medium') }) };
});

vi.mock('@moonshot-ai/app-components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/app-components')>();
  return { ...actual, Composer: { render: () => null } };
});

vi.mock('@moonshot-ai/app-markdown', () => ({ Markdown: { render: () => null } }));

let app: App | null = null;
let host: HTMLDivElement;

function actionButton(label: string): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

beforeEach(() => {
  state.goalModeAvailable!.value = true;
  state.controlGoal!.mockReset();
  state.confirm!.mockReset().mockResolvedValue(true);
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

async function mountGoalDock(status: 'active' | 'paused' | 'blocked'): Promise<void> {
  state.goal!.value = { objective: 'Ship the feature', status, turnsUsed: 1, tokensUsed: 100, wallClockMs: 1000 };
  app = createApp({
    setup: () => () => h(ChatDock, {
      dockPanel: 'goal',
      bashTasks: [],
      subagentTasks: [],
      bashRunning: 0,
      subagentRunning: 0,
      todoDoneCount: 0,
      hasDockWork: true,
      todos: [],
    }),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, name => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.provide(panelApiKey, undefined);
  app.mount(host);
  await nextTick();
}

describe('ChatDock goal controls', () => {
  it.each(['paused', 'blocked'] as const)('disables Resume for a %s goal when UpdateGoal is unavailable while keeping Cancel enabled', async (status) => {
    await mountGoalDock(status);
    const resume = actionButton('Resume');
    expect(resume.disabled).toBe(false);

    state.goalModeAvailable!.value = false;
    await nextTick();
    expect(resume.disabled).toBe(true);
    resume.click();
    expect(state.controlGoal).not.toHaveBeenCalled();

    const cancel = actionButton('Cancel');
    expect(cancel.disabled).toBe(false);
    cancel.click();
    await nextTick();
    expect(state.controlGoal).toHaveBeenCalledWith('cancel');
  });

  it('resumes a paused goal when UpdateGoal is available and keeps Pause enabled for an active goal when disabled', async () => {
    await mountGoalDock('paused');
    actionButton('Resume').click();
    expect(state.controlGoal).toHaveBeenCalledWith('resume');

    state.controlGoal!.mockReset();
    state.goalModeAvailable!.value = false;
    state.goal!.value = { objective: 'Ship the feature', status: 'active', turnsUsed: 1, tokensUsed: 100, wallClockMs: 1000 };
    await nextTick();
    const pause = actionButton('Pause');
    expect(pause.disabled).toBe(false);
    pause.click();
    expect(state.controlGoal).toHaveBeenCalledWith('pause');
  });
});
