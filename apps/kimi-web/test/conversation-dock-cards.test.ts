import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import ConversationPane from '../src/components/ConversationPane.vue';
import type { SwarmGroup } from '../src/composables/swarmGroups';
import type { ConversationStatus, QueuedPromptView, TaskItem, TodoView, UIQuestion } from '../src/types';

const status: ConversationStatus = {
  model: 'kimi-test',
  modelId: 'kimi-test',
  ctxUsed: 0,
  ctxMax: 0,
  permission: 'manual',
  branch: 'main',
  cwd: '/repo',
  isGitRepo: true,
};

const turns = [{ id: 't1', role: 'user' as const, no: 1, text: 'hi' }];

function question(id: string, text: string): UIQuestion {
  return {
    questionId: id,
    sessionId: 'sess_1',
    questions: [
      {
        id: `${id}_item`,
        question: text,
        options: [{ id: 'opt_1', label: 'Option 1' }],
      },
    ],
  };
}

function mountPane(extraProps: Record<string, unknown>) {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: {} },
    missingWarn: false,
    fallbackWarn: false,
  });
  return mount(ConversationPane, {
    attachTo: document.body,
    props: {
      mobile: true,
      turns,
      tasks: [],
      status,
      ...extraProps,
    },
    global: {
      plugins: [i18n],
      stubs: {
        ChatHeader: true,
        ChatPane: true,
        Composer: true,
        GoalStrip: true,
        TasksPane: true,
        TodoCard: true,
        QueuePane: true,
        Terminal: true,
        SwarmCard: true,
      },
    },
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('ConversationPane docked composer', () => {
  it('renders the docked composer inside the chat layout', async () => {
    const wrapper = mountPane({});

    expect(wrapper.find('composer-stub').exists()).toBe(true);
    expect(wrapper.find('.chat-layout > .chat-dock').exists()).toBe(true);
    expect(wrapper.find('.chat-scroll > .chat-dock').exists()).toBe(false);
  });

  it('passes the chat scroller gutter to the dock for composer alignment', async () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    const wrapper = mountPane({});
    await nextTick();
    await nextTick();

    const pane = wrapper.find('.chat-scroll').element as HTMLElement;
    Object.defineProperty(pane, 'offsetWidth', {
      configurable: true,
      get: () => 800,
    });
    Object.defineProperty(pane, 'clientWidth', {
      configurable: true,
      get: () => 785,
    });

    for (const callback of resizeCallbacks) {
      callback([], {} as ResizeObserver);
    }
    await nextTick();

    const dock = wrapper.find('.chat-dock').element as HTMLElement;
    expect(dock.style.getPropertyValue('--panes-scrollbar-width')).toBe('15px');
  });

  it('remounts the question card when the pending question changes', async () => {
    const wrapper = mountPane({ questions: [question('q1', 'First?')] });

    await wrapper.find('.qmin').trigger('click');
    expect(wrapper.find('.qbody').exists()).toBe(false);

    await wrapper.setProps({ questions: [question('q2', 'Second?')] });
    await nextTick();

    expect(wrapper.find('.qbody').exists()).toBe(true);
    expect(wrapper.text()).toContain('Second?');
  });

  it('remounts the approval card when the pending approval changes', async () => {
    const wrapper = mountPane({
      approvals: [{ approvalId: 'a1', block: { kind: 'generic', summary: 'first action' } }],
    });

    await wrapper.find('.amin').trigger('click');
    expect(wrapper.find('.body-generic').exists()).toBe(false);

    await wrapper.setProps({
      approvals: [{ approvalId: 'a2', block: { kind: 'generic', summary: 'second action' } }],
    });
    await nextTick();

    expect(wrapper.find('.body-generic').exists()).toBe(true);
    expect(wrapper.text()).toContain('second action');
  });
});

describe('ConversationPane dock work panel', () => {
  it('opens bash, subagent, todos, and queue from the dock chips', async () => {
    const tasks: TaskItem[] = [
      {
        id: 'task_1',
        name: 'Build web',
        kind: 'bash',
        state: 'run',
        timing: 'Running',
      },
      {
        id: 'task_2',
        name: 'Review code',
        kind: 'subagent',
        state: 'run',
        timing: 'Running',
      },
    ];
    const todos: TodoView[] = [{ title: 'Check mobile dock', status: 'in_progress' }];
    const queued: QueuedPromptView[] = [{ text: 'Queued thought', attachmentCount: 0 }];
    const wrapper = mountPane({ tasks, todos, queued });

    expect(wrapper.find('.dock-work-panel').exists()).toBe(false);

    const chips = wrapper.findAll('.dock-work-chip');
    expect(chips).toHaveLength(4);
    for (const chip of chips) {
      expect(chip.find('svg').exists()).toBe(true);
      expect(chip.find('.dw-count').exists()).toBe(true);
    }
    expect(chips[2]!.find('.dw-count').text()).toBe('(0/1)');
    expect(chips[3]!.find('.dw-count').text()).toBe('(1)');

    await chips[0]!.trigger('click');
    expect(wrapper.find('.dock-work-panel').exists()).toBe(true);
    const bashPane = wrapper.findComponent({ name: 'TasksPane' });
    expect(bashPane.exists()).toBe(true);
    expect(bashPane.props('tasks')).toHaveLength(1);
    expect(bashPane.props('tasks')[0].id).toBe('task_1');

    await chips[1]!.trigger('click');
    const subagentPane = wrapper.findAllComponents({ name: 'TasksPane' }).at(-1);
    expect(subagentPane).toBeTruthy();
    expect(subagentPane!.props('tasks')).toHaveLength(1);
    expect(subagentPane!.props('tasks')[0].id).toBe('task_2');

    await chips[2]!.trigger('click');
    expect(wrapper.find('todo-card-stub').exists()).toBe(true);

    await chips[3]!.trigger('click');
    expect(wrapper.find('queue-pane-stub').exists()).toBe(true);
    expect(wrapper.findComponent({ name: 'QueuePane' }).props('queued')).toHaveLength(1);
  });

  it('closes the dock work panel when the user clicks outside it', async () => {
    const tasks: TaskItem[] = [
      {
        id: 'task_1',
        name: 'Review code',
        kind: 'subagent',
        state: 'run',
        timing: 'Running',
      },
    ];
    const wrapper = mountPane({ tasks });

    await wrapper.find('.dock-work-chip').trigger('click');
    expect(wrapper.find('.dock-work-panel').exists()).toBe(true);
    expect(wrapper.find('.dock-work-close').exists()).toBe(false);

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextTick();

    expect(wrapper.find('.dock-work-panel').exists()).toBe(false);
  });
});

function swarmGroup(members: { phase: SwarmGroup['members'][number]['phase']; id?: string }[]): SwarmGroup {
  const ms = members.map((m, i) => ({
    id: m.id ?? `agent_${i + 1}`,
    name: `Agent ${i + 1}`,
    phase: m.phase,
    swarmIndex: i + 1,
  }));
  const counts: SwarmGroup['counts'] = { queued: 0, working: 0, suspended: 0, completed: 0, failed: 0 };
  for (const m of ms) counts[m.phase]++;
  return { id: 'swarm_1', members: ms, counts };
}

describe('ConversationPane swarm stack', () => {
  it('shows the swarm stack while at least one member is active', () => {
    const wrapper = mountPane({
      swarms: [swarmGroup([{ phase: 'working' }, { phase: 'completed' }])],
    });
    expect(wrapper.find('.swarm-stack').exists()).toBe(true);
  });

  it('hides the swarm stack once all members are completed or failed', () => {
    const wrapper = mountPane({
      swarms: [swarmGroup([{ phase: 'completed' }, { phase: 'failed' }])],
    });
    expect(wrapper.find('.swarm-stack').exists()).toBe(false);
  });
});
