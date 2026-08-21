import { createRenderer, defineComponent, h, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import { useDetailPanel } from '../src/composables';
import type { DetailTarget } from '../src/composables';

describe('useDetailPanel agent transcript state', () => {
  it('updates loading state and roster metadata when the channel version changes', async () => {
    const channel = {
      loading: true,
      refreshError: false,
      loadingOlder: false,
      loadOlderError: false,
      agents: [] as Array<{ agentId: string; type?: 'sub'; label?: string }>,
      snapshot: {
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
        hasMoreOlder: false,
      },
      loadOlder: vi.fn(),
    };
    const entry = { channel, version: ref(0) };
    const client = {
      activeSessionId: ref('session-1'),
      findBashCommandForTask: () => undefined,
      activeAppTasks: ref([
        {
          id: 'agent-99',
          kind: 'subagent',
          description: 'Unrelated live agent',
        },
        {
          id: 'background-task-30',
          agentId: 'agent-30',
          kind: 'subagent',
          description: 'Inspect files',
          status: 'running',
          sessionId: 'session-1',
          createdAt: '2026-07-28T00:00:00.000Z',
          subagentType: 'explore',
        },
      ]),
      turns: ref([{
        id: 'turn-1',
        role: 'assistant',
        no: 1,
        text: '',
        tools: [{
          id: 'tool-1',
          name: 'Agent',
          arg: JSON.stringify({
            description: 'Inspect files',
            subagent_type: 'explore',
          }),
          status: 'ok',
          agentId: 'agent-30',
          output: ['saved result'],
        }],
      }]),
      sideChatVisible: ref(false),
      auxiliaryTranscripts: {
        getEntry: vi.fn(() => entry),
        activate: vi.fn(),
        deactivate: vi.fn(),
      },
    };
    let panel: ReturnType<typeof useDetailPanel> | undefined;
    const detailTarget = ref<DetailTarget | null>(null);
    const app = renderer.createApp(defineComponent(() => {
      panel = useDetailPanel({
        client: client as never,
        sideWidth: ref(280),
        detailTarget,
        closeFilePreview: vi.fn(),
      });
      return () => h('div');
    }));
    app.mount({ children: [] });

    panel!.openAgentPanel('agent-30');
    expect(client.auxiliaryTranscripts.activate).toHaveBeenCalledWith(
      'session-1',
      'agent-30',
    );
    expect(panel!.agentPanelLoading.value).toBe(true);
    expect(panel!.agentPanelMember.value).toMatchObject({
      id: 'agent-30',
      name: 'Inspect files',
      kind: 'subagent',
      subagentType: 'explore',
      phase: 'working',
    });

    client.activeAppTasks.value = [client.activeAppTasks.value[0]!];
    channel.loading = false;
    channel.agents = [{
      agentId: 'agent-30',
      type: 'sub',
      label: 'Inspect renderer',
    }];
    entry.version.value += 1;
    await nextTick();

    expect(panel!.agentPanelLoading.value).toBe(false);
    expect(panel!.agentPanelMember.value).toMatchObject({
      id: 'agent-30',
      name: 'Inspect renderer',
      kind: 'subagent',
      subagentType: 'explore',
      phase: 'completed',
      outputLines: ['saved result'],
    });

    client.turns.value[0]!.tools[0]!.status = 'error';
    await nextTick();
    expect(panel!.agentPanelMember.value).toMatchObject({
      phase: 'failed',
      status: 'failed',
      outputLines: ['saved result'],
    });

    detailTarget.value = 'file';
    await nextTick();
    expect(client.auxiliaryTranscripts.deactivate).toHaveBeenCalledWith(
      'session-1',
      'agent-30',
    );
    panel!.openAgentPanel('agent-30');
    expect(detailTarget.value).toBe('agent');
    expect(client.auxiliaryTranscripts.activate).toHaveBeenLastCalledWith(
      'session-1',
      'agent-30',
    );
    app.unmount();
  });

  it('discriminates subagent from bash by task kind when subagentType is absent', () => {
    const client = {
      activeSessionId: ref('session-1'),
      findBashCommandForTask: () => 'ls -la',
      activeAppTasks: ref([
        {
          id: 'agent-40',
          agentId: 'agent-40',
          kind: 'subagent',
          description: 'Explore the repo',
          status: 'completed',
          sessionId: 'session-1',
          createdAt: '2026-07-28T00:00:00.000Z',
          outputPreview: 'Done: found 3 entry points.',
          // No subagentType — REST/event rows may never report a profile.
        },
        {
          id: 'task-50',
          kind: 'bash',
          description: 'Bash: ls',
          status: 'completed',
          sessionId: 'session-1',
          createdAt: '2026-07-28T00:00:00.000Z',
          outputPreview: 'total 42',
        },
      ]),
      turns: ref([]),
      sideChatVisible: ref(false),
      auxiliaryTranscripts: {
        getEntry: vi.fn(() => undefined),
        activate: vi.fn(),
        deactivate: vi.fn(),
      },
    };
    let panel: ReturnType<typeof useDetailPanel> | undefined;
    const detailTarget = ref<DetailTarget | null>(null);
    const app = renderer.createApp(defineComponent(() => {
      panel = useDetailPanel({
        client: client as never,
        sideWidth: ref(280),
        detailTarget,
        closeFilePreview: vi.fn(),
      });
      return () => h('div');
    }));
    app.mount({ children: [] });

    // The subagent row keeps its subagent kind (and thus the prose fallback)
    // from the task store even though no profile was ever reported.
    panel!.openAgentPanel('agent-40');
    expect(panel!.agentPanelMember.value).toMatchObject({
      id: 'agent-40',
      kind: 'subagent',
      summary: 'Done: found 3 entry points.',
    });
    expect(panel!.agentPanelMember.value?.subagentType).toBeUndefined();

    // A bash task carries its kind too, so its command + output stay mono.
    panel!.openAgentPanel('task-50');
    expect(panel!.agentPanelMember.value).toMatchObject({
      id: 'task-50',
      kind: 'bash',
      prompt: 'ls -la',
    });
    app.unmount();
  });
});

interface HostNode {
  children: HostNode[];
  parent?: HostNode;
  text?: string;
}

const renderer = createRenderer<HostNode, HostNode>({
  patchProp: () => {},
  insert(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  },
  remove: () => {},
  createElement: () => ({ children: [] }),
  createText: (text) => ({ children: [], text }),
  createComment: (text) => ({ children: [], text }),
  setText(node, text) {
    node.text = text;
  },
  setElementText(node, text) {
    node.text = text;
  },
  parentNode: (node) => node.parent ?? null,
  nextSibling: () => null,
  querySelector: () => null,
  setScopeId: () => {},
  cloneNode: (node) => ({ ...node, children: [...node.children] }),
  insertStaticContent: () => {
    const node = { children: [] };
    return [node, node];
  },
});

describe('useDetailPanel provisional-id fold', () => {
  it('retires the provisional transcript entry when the task row folds to an agent id', async () => {
    const channel = {
      loading: false,
      refreshError: false,
      loadingOlder: false,
      loadOlderError: false,
      agents: [] as Array<{ agentId: string; type?: 'sub'; label?: string }>,
      snapshot: {
        items: [],
        tasks: [],
        interactions: [],
        attachments: [],
        todos: [],
        prompts: [],
        meta: {},
        hasMoreOlder: false,
      },
      loadOlder: vi.fn(),
    };
    const entry = { channel, version: ref(0) };
    const client = {
      activeSessionId: ref('session-1'),
      findBashCommandForTask: () => undefined,
      // The task store has not folded the row yet: the panel opens under the
      // provisional background-task id and (unknown target) activates its
      // transcript under that id.
      activeAppTasks: ref([] as unknown[]),
      turns: ref([]),
      sideChatVisible: ref(false),
      auxiliaryTranscripts: {
        getEntry: vi.fn(() => entry),
        activate: vi.fn(),
        deactivate: vi.fn(),
      },
    };
    let panel: ReturnType<typeof useDetailPanel> | undefined;
    const detailTarget = ref<DetailTarget | null>(null);
    const app = renderer.createApp(defineComponent(() => {
      panel = useDetailPanel({
        client: client as never,
        sideWidth: ref(280),
        detailTarget,
        closeFilePreview: vi.fn(),
      });
      return () => h('div');
    }));
    app.mount({ children: [] });

    panel!.openAgentPanel('task-30');
    expect(client.auxiliaryTranscripts.activate).toHaveBeenCalledWith('session-1', 'task-30');

    // The WS fold lands: the row now carries the stable agent id.
    client.activeAppTasks.value = [{
      id: 'agent-30',
      agentId: 'agent-30',
      backgroundTaskId: 'task-30',
      kind: 'subagent',
      description: 'Inspect files',
      status: 'running',
      sessionId: 'session-1',
      createdAt: '2026-07-28T00:00:00.000Z',
    }];
    await nextTick();

    // The provisional entry is retired before the folded one activates —
    // otherwise the close path only knows the folded id and 'task-30' leaks.
    expect(client.auxiliaryTranscripts.deactivate).toHaveBeenCalledWith('session-1', 'task-30');
    expect(client.auxiliaryTranscripts.activate).toHaveBeenCalledWith('session-1', 'agent-30');
    const deactivateOrder = client.auxiliaryTranscripts.deactivate.mock.invocationCallOrder[0]!;
    const activateCalls = client.auxiliaryTranscripts.activate.mock.invocationCallOrder;
    const foldedActivateOrder = activateCalls[activateCalls.length - 1]!;
    expect(deactivateOrder).toBeLessThan(foldedActivateOrder);
    app.unmount();
  });
});
