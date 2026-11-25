// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { AppToolsConfig } from '@moonshot-ai/app-core/api';

const fakes = vi.hoisted(() => ({
  listToolCatalog: vi.fn(),
  loadConfig: vi.fn(),
  updateConfig: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
  back: vi.fn(),
  open: vi.fn(),
  config: null as null | { value: { tools?: AppToolsConfig } | null },
  hosts: null as null | { value: readonly { id: string }[] },
}));

vi.mock('@moonshot-ai/app-client/client', () => ({
  getKimiWebApi: () => ({ listToolCatalog: fakes.listToolCatalog }),
  toast: fakes.toast,
  t: (key: string) => key,
}));

vi.mock('@moonshot-ai/app-client/stores', async () => {
  const vue = await import('vue');
  fakes.config = vue.ref<{ tools?: AppToolsConfig } | null>(null);
  fakes.hosts = vue.ref<readonly { id: string }[]>([]);
  return {
    configStore: () => ({
      config: fakes.config!.value,
      updateConfig: fakes.updateConfig,
      loadConfig: fakes.loadConfig,
    }),
    hostsStore: () => ({ hosts: fakes.hosts!.value }),
  };
});

vi.mock('@moonshot-ai/app-client/composables', () => ({
  useConfirmDialog: () => ({ confirm: fakes.confirm }),
}));

import DefaultToolsPanel from '../src/settings/DefaultToolsPanel.vue';
import DefaultToolsRow from '../src/settings/DefaultToolsRow.vue';
import DefaultToolsSetting from '../src/settings/DefaultToolsSetting.vue';
import { defaultToolLabelKey, groupDefaultTools } from '../src/settings/defaultToolsCatalog';

let app: App | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  fakes.config!.value = {
    tools: { enabled: ['Read'], disabled: ['Bash', 'mcp__example__*'] },
  };
  fakes.hosts!.value = [];
  fakes.listToolCatalog.mockReset().mockResolvedValue([
    { name: 'Bash', source: 'builtin' },
    { name: 'Read', source: 'builtin' },
  ]);
  fakes.loadConfig.mockReset().mockResolvedValue('committed');
  fakes.updateConfig.mockReset().mockResolvedValue(true);
  fakes.confirm.mockReset().mockResolvedValue(true);
  fakes.toast.mockReset();
  fakes.back.mockReset();
  fakes.open.mockReset();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host?.remove();
  host = null;
});

async function flush(): Promise<void> {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountPanel(): Promise<{ confirmDiscard: () => Promise<boolean> }> {
  host = document.createElement('div');
  host.className = 'settings-dialog';
  document.body.append(host);
  let panel!: { confirmDiscard: () => Promise<boolean> };
  app = createApp({
    setup: () => () => h(DefaultToolsPanel, {
      ref: (value) => { panel = value as { confirmDiscard: () => Promise<boolean> }; },
      onBack: fakes.back,
    }),
  });
  app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  await flush();
  return panel;
}

function switches(): HTMLButtonElement[] {
  return [...(host?.querySelectorAll<HTMLButtonElement>('[role="switch"]') ?? [])];
}

function switchNamed(label: string): HTMLButtonElement {
  const item = switches().find((candidate) => candidate.getAttribute('aria-label') === label);
  if (!item) throw new Error(`Missing switch ${label}`);
  return item;
}

function button(text: string): HTMLButtonElement | undefined {
  return [...(host?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((candidate) => candidate.textContent?.trim() === text);
}

describe('DefaultToolsPanel', () => {
  it('loads a grouped catalog without search, bulk actions, or enabled counts', async () => {
    await mountPanel();

    expect(fakes.listToolCatalog).toHaveBeenCalledOnce();
    expect(switches().map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(host?.querySelector('input[type="search"]')).toBeNull();
    expect(host?.textContent).not.toContain('Enable all');
    expect(host?.textContent).not.toContain('Disable all');
    expect(host?.textContent).not.toContain('2 enabled');
    expect(host?.textContent).toContain('Enable or disable the tools available to the agent. Disabled tools become unavailable.');
    expect(button('Save')?.disabled).toBe(true);
  });

  it('edits a draft and only writes config when Save is clicked', async () => {
    await mountPanel();
    switchNamed('Run terminal commands').click();
    await flush();

    expect(fakes.updateConfig).not.toHaveBeenCalled();
    expect(host?.textContent).toContain('Unsaved changes');
    expect(button('Save')?.disabled).toBe(false);
    button('Save')?.click();
    await flush();

    expect(fakes.updateConfig).toHaveBeenCalledWith({
      tools: { enabled: ['Bash', 'Read'], disabled: ['mcp__example__*'] },
    });
    expect(fakes.toast).toHaveBeenCalledWith({ layout: 'bar', mode: 'replace', variant: 'success', title: 'Tool settings saved' });
    expect(host?.textContent).not.toContain('Unsaved changes');
    expect(button('Save')?.disabled).toBe(true);
  });

  it('keeps the draft and shows feedback when saving fails', async () => {
    fakes.updateConfig.mockResolvedValue(false);
    await mountPanel();
    switchNamed('Run terminal commands').click();
    await flush();
    button('Save')?.click();
    await flush();

    expect(host?.textContent).toContain('Couldn\'t save. Try again');
    expect(host?.textContent).toContain('Unsaved changes');
    expect(switchNamed('Run terminal commands').getAttribute('aria-checked')).toBe('true');
    expect(button('Save')?.disabled).toBe(false);
  });

  it('confirms before discarding changes on back', async () => {
    await mountPanel();
    switchNamed('Run terminal commands').click();
    await flush();
    host?.querySelector<HTMLButtonElement>('.settings-subpage-back')?.click();
    await flush();

    expect(fakes.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Discard unsaved changes',
      message: 'Your changes won’t be saved',
      confirmLabel: 'Discard changes',
    }));
    expect(fakes.back).toHaveBeenCalledOnce();
  });

  it('stays on the page when discarding is cancelled', async () => {
    fakes.confirm.mockResolvedValue(false);
    await mountPanel();
    switchNamed('Run terminal commands').click();
    await flush();
    host?.querySelector<HTMLButtonElement>('.settings-subpage-back')?.click();
    await flush();

    expect(fakes.back).not.toHaveBeenCalled();
    expect(host?.textContent).toContain('Unsaved changes');
    expect(switchNamed('Run terminal commands').getAttribute('aria-checked')).toBe('true');
  });

  it('retries a failed catalog load', async () => {
    fakes.listToolCatalog
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([{ name: 'Read', source: 'builtin' }]);
    await mountPanel();
    expect(host?.textContent).toContain('Could not load the tool list');

    button('Retry')?.click();
    await flush();
    expect(fakes.listToolCatalog).toHaveBeenCalledTimes(2);
    expect(switches()).toHaveLength(1);
  });

  it('blocks editing while config is unavailable and preserves existing denials after retry', async () => {
    fakes.config!.value = null;
    fakes.loadConfig
      .mockResolvedValueOnce('failed')
      .mockImplementationOnce(async () => {
        fakes.config!.value = { tools: { disabled: ['Bash'] } };
        return 'committed';
      });
    await mountPanel();

    expect(fakes.loadConfig).toHaveBeenCalledOnce();
    expect(switches()).toHaveLength(0);
    expect(host?.textContent).toContain('Could not load the tool list');
    expect(button('Save')?.disabled).toBe(true);

    button('Retry')?.click();
    await flush();
    expect(fakes.loadConfig).toHaveBeenCalledTimes(2);
    expect(switchNamed('Run terminal commands').getAttribute('aria-checked')).toBe('false');

    switchNamed('Read files').click();
    await flush();
    button('Save')?.click();
    await flush();
    expect(fakes.updateConfig).toHaveBeenCalledWith({
      tools: { enabled: undefined, disabled: ['Bash', 'Read'] },
    });
  });

  it('initializes the draft when a config without a tools section loads after mount', async () => {
    fakes.config!.value = null;
    fakes.loadConfig.mockImplementationOnce(async () => {
      fakes.config!.value = {};
      return 'committed';
    });
    await mountPanel();

    expect(switches()).toHaveLength(2);
    expect(switchNamed('Run terminal commands').getAttribute('aria-checked')).toBe('true');
  });

  it('labels Agent as subagent in settings while keeping the chat tool label as task', async () => {
    fakes.listToolCatalog.mockResolvedValue([{ name: 'Agent', source: 'builtin' }]);
    host = document.createElement('div');
    document.body.append(host);
    const i18n = createKimiI18n({ locale: 'zh' });
    app = createApp({ setup: () => () => h(DefaultToolsPanel) });
    app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.use(i18n);
    app.mount(host);
    await flush();

    expect(host.textContent).toContain('子智能体');
    const { toolLabel: chatToolLabel } = await import('@moonshot-ai/app-core/lib');
    const translate = (key: string) => i18n.global.t(key);
    expect(chatToolLabel(translate, 'Agent')).toBe('任务');
  });

  it('rebases unsaved draft toggles onto concurrent updates from another client before saving', async () => {
    fakes.config!.value = { tools: { disabled: [] } };
    fakes.listToolCatalog.mockResolvedValue([
      { name: 'Bash', source: 'builtin' },
      { name: 'Write', source: 'builtin' },
    ]);
    await mountPanel();
    switchNamed('Write files').click();
    await flush();
    expect(host?.textContent).toContain('Unsaved changes');

    fakes.config!.value = { tools: { disabled: ['Bash'] } };
    await flush();

    expect(switchNamed('Run terminal commands').getAttribute('aria-checked')).toBe('false');
    expect(switchNamed('Write files').getAttribute('aria-checked')).toBe('false');
    expect(host?.textContent).toContain('Unsaved changes');

    button('Save')?.click();
    await flush();
    expect(fakes.updateConfig).toHaveBeenCalledWith({
      tools: { enabled: undefined, disabled: ['Bash', 'Write'] },
    });
  });

  it('adopts in-flight config updates from another client instead of overwriting them on the next save', async () => {
    fakes.config!.value = { tools: { disabled: [] } };
    fakes.listToolCatalog.mockResolvedValue([
      { name: 'Bash', source: 'builtin' },
      { name: 'Write', source: 'builtin' },
      { name: 'Read', source: 'builtin' },
    ]);
    let resolveSave!: (saved: boolean) => void;
    fakes.updateConfig.mockReturnValueOnce(new Promise<boolean>((resolve) => {
      resolveSave = resolve;
    }));
    await mountPanel();
    switchNamed('Write files').click();
    await flush();
    button('Save')?.click();
    await flush();

    fakes.config!.value = { tools: { disabled: ['Bash'] } };
    await flush();
    resolveSave(true);
    await flush();

    expect(switchNamed('Run terminal commands').getAttribute('aria-checked')).toBe('false');
    expect(switchNamed('Write files').getAttribute('aria-checked')).toBe('true');

    switchNamed('Read files').click();
    await flush();
    button('Save')?.click();
    await flush();
    expect(fakes.updateConfig).toHaveBeenLastCalledWith({
      tools: { enabled: undefined, disabled: ['Bash', 'Read'] },
    });
  });

  it('rebases unsaved draft toggles onto config updates that arrive during a failed save', async () => {
    fakes.config!.value = { tools: { disabled: [] } };
    fakes.listToolCatalog.mockResolvedValue([
      { name: 'Bash', source: 'builtin' },
      { name: 'Write', source: 'builtin' },
    ]);
    let resolveSave!: (saved: boolean) => void;
    fakes.updateConfig
      .mockReturnValueOnce(new Promise<boolean>((resolve) => {
        resolveSave = resolve;
      }))
      .mockResolvedValueOnce(true);
    await mountPanel();
    switchNamed('Write files').click();
    await flush();
    button('Save')?.click();
    await flush();

    fakes.config!.value = { tools: { disabled: ['Bash'] } };
    await flush();
    resolveSave(false);
    await flush();

    expect(host?.textContent).toContain('Couldn\'t save. Try again');
    expect(host?.textContent).toContain('Unsaved changes');
    expect(switchNamed('Run terminal commands').getAttribute('aria-checked')).toBe('false');
    expect(switchNamed('Write files').getAttribute('aria-checked')).toBe('false');

    button('Save')?.click();
    await flush();
    expect(fakes.updateConfig).toHaveBeenLastCalledWith({
      tools: { enabled: undefined, disabled: ['Bash', 'Write'] },
    });
  });

  it('refuses to discard while a save is in flight', async () => {
    let resolveSave!: (saved: boolean) => void;
    fakes.updateConfig.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveSave = resolve;
    }));
    const panel = await mountPanel();
    switchNamed('Run terminal commands').click();
    await flush();
    button('Save')?.click();
    await flush();

    await expect(panel.confirmDiscard()).resolves.toBe(false);
    host?.querySelector<HTMLButtonElement>('.settings-subpage-back')?.click();
    await flush();
    expect(fakes.confirm).not.toHaveBeenCalled();
    expect(fakes.back).not.toHaveBeenCalled();

    resolveSave(true);
    await flush();
    await expect(panel.confirmDiscard()).resolves.toBe(true);
  });
});

describe('DefaultToolsRow', () => {
  it('opens the tools subpage without an entry icon or enabled count', async () => {
    host = document.createElement('div');
    document.body.append(host);
    app = createApp({ setup: () => () => h(DefaultToolsRow, { onOpen: fakes.open }) });
    app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await flush();

    const entry = host.querySelector<HTMLButtonElement>('.dt-entry')!;
    expect(entry.textContent).toContain('Built-in tools');
    expect(entry.textContent).toContain('Enable or disable the tools available to the agent');
    expect(entry.querySelectorAll('svg')).toHaveLength(1);
    expect(entry.querySelector('svg')?.getAttribute('data-icon')).toBe('chevron-right');
    entry.click();
    expect(fakes.open).toHaveBeenCalledWith(entry);
  });

  it('makes the local-only scope explicit when SSH hosts are configured', async () => {
    fakes.hosts!.value = [{ id: 'ssh-1' }];
    host = document.createElement('div');
    document.body.append(host);
    app = createApp({ setup: () => () => h('div', [h(DefaultToolsRow), h(DefaultToolsPanel)]) });
    app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await flush();

    expect(host.querySelector('.dt-entry-hint')?.textContent).toContain('仅对本机项目生效');
    expect(host.querySelector('.settings-subpage-desc')?.textContent).toContain('仅对本机项目生效');
  });
});


describe('DefaultToolsSetting', () => {
  it('opens the subpage with an inline back button like GlobalAgentsMdSetting and confirms discard once', async () => {
    host = document.createElement('div');
    document.body.append(host);
    const openChanges: boolean[] = [];
    let setting!: { confirmDiscard: () => Promise<boolean>; reset: () => void };
    app = createApp({
      setup: () => () => h(DefaultToolsSetting, {
        ref: (value) => { setting = value as typeof setting; },
        onOpenChange: (open: boolean) => openChanges.push(open),
      }),
    });
    app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await flush();

    expect(openChanges).toEqual([false]);
    host.querySelector<HTMLButtonElement>('.dt-entry')!.click();
    await flush();
    expect(openChanges).toEqual([false, true]);

    const back = host.querySelector<HTMLButtonElement>('.settings-subpage-back')!;
    expect(host.querySelector('.settings-subpage')?.contains(back)).toBe(true);

    switchNamed('Run terminal commands').click();
    await flush();
    back.click();
    await flush();
    expect(fakes.confirm).toHaveBeenCalledOnce();
    expect(openChanges).toEqual([false, true, false]);
    expect(host.querySelector('.dt-entry')).not.toBeNull();

    host.querySelector<HTMLButtonElement>('.dt-entry')!.click();
    await flush();
    switchNamed('Run terminal commands').click();
    await flush();
    fakes.confirm.mockResolvedValueOnce(false);
    await expect(setting.confirmDiscard()).resolves.toBe(false);
    expect(openChanges).toEqual([false, true, false, true]);

    setting.reset();
    await flush();
    expect(openChanges).toEqual([false, true, false, true, false]);
  });
});


describe('defaultToolsCatalog', () => {
  const ALL_CONFIGURABLE_TOOLS = [
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'Bash', 'TaskList', 'TaskOutput', 'TaskStop', 'WaitFor',
    'WebSearch', 'FetchURL',
    'TodoList', 'ExitPlanMode', 'Agent', 'AgentSwarm', 'AskUserQuestion', 'Skill', 'NotifyUser',
    'CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal',
    'CronCreate', 'CronList', 'CronDelete',
    'TowerInit', 'TowerPlan', 'TowerSpawn', 'TowerMerge', 'TowerRebase', 'TowerTeardown',
    'TowerComplete', 'TowerSend', 'TowerInbox', 'TowerFinding', 'TowerReview', 'TowerMission', 'TowerStatus',
  ];

  it('groups all 39 configurable built-in tools into dedicated groups without an orphan catch-all', () => {
    const entries = ALL_CONFIGURABLE_TOOLS.map((name) => ({ name, source: 'builtin' as const }));
    const groups = groupDefaultTools(entries);

    expect(groups.map((group) => group.id)).toEqual(['file', 'shell', 'web', 'agent', 'goal', 'cron', 'tower']);
    expect(groups.flatMap((group) => group.tools.map((tool) => tool.name)).toSorted()).toEqual(
      [...ALL_CONFIGURABLE_TOOLS].toSorted(),
    );
    expect(groups.find((group) => group.id === 'file')?.tools.map((tool) => tool.name)).toEqual([
      'Read', 'Write', 'Edit', 'Glob', 'Grep',
    ]);
    expect(groups.find((group) => group.id === 'shell')?.tools.map((tool) => tool.name)).toEqual([
      'Bash', 'TaskList', 'TaskOutput', 'TaskStop', 'WaitFor',
    ]);
    expect(groups.find((group) => group.id === 'cron')?.tools.map((tool) => tool.name)).toEqual([
      'CronCreate', 'CronList', 'CronDelete',
    ]);
  });

  it('uses settings-specific noun labels instead of chat streaming verbs', () => {
    const { t } = createKimiI18n({ locale: 'zh' }).global;
    const labelOf = (name: string) => {
      const key = defaultToolLabelKey(name);
      expect(key).toBeDefined();
      return t(key!);
    };

    expect(t('settings.defaultToolsGroupShell')).toBe('终端与后台任务');
    expect(labelOf('Bash')).toBe('执行终端命令');
    expect(labelOf('WebSearch')).toBe('网页搜索');
    expect(labelOf('Grep')).toBe('搜索文件内容');
    expect(labelOf('Agent')).toBe('子智能体');
    expect(labelOf('NotifyUser')).toBe('发送进展通知');
    expect(labelOf('ExitPlanMode')).toBe('审批计划');
    expect(labelOf('TowerSpawn')).toBe('启动工作与评审智能体');
  });

  it('places unknown future tools into the fallback group', () => {
    const groups = groupDefaultTools([{ name: 'FutureTool', source: 'builtin' }]);
    expect(groups).toEqual([
      { id: 'other', labelKey: 'settings.defaultToolsGroupOther', tools: [{ name: 'FutureTool', source: 'builtin' }] },
    ]);
  });
});
