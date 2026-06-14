import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import ConversationPane from '../src/components/ConversationPane.vue';
import type { ConversationStatus, TaskItem, TodoView, UIQuestion } from '../src/types';

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
        TabBar: true,
        ChatHeader: true,
        ChatPane: true,
        Composer: true,
        GoalStrip: true,
        TasksPane: true,
        TodoCard: true,
        Terminal: true,
        SwarmCard: true,
        FileTree: true,
        DiffView: true,
        ChangedTree: true,
        FilePreview: true,
      },
    },
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ConversationPane docked interrupt cards', () => {
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
  it('opens tasks and todos from the dock chips', async () => {
    const tasks: TaskItem[] = [{
      id: 'task_1',
      name: 'Build web',
      kind: 'task',
      state: 'run',
      timing: 'Running',
    }];
    const todos: TodoView[] = [{ title: 'Check mobile dock', status: 'in_progress' }];
    const wrapper = mountPane({ tasks, todos });

    expect(wrapper.find('.dock-work-panel').exists()).toBe(false);

    const chips = wrapper.findAll('.dock-work-chip');
    expect(chips).toHaveLength(2);

    await chips[0]!.trigger('click');
    expect(wrapper.find('.dock-work-panel').exists()).toBe(true);
    expect(wrapper.find('tasks-pane-stub').exists()).toBe(true);

    await chips[1]!.trigger('click');
    expect(wrapper.find('todo-card-stub').exists()).toBe(true);
  });
});
