import { createRenderer, defineComponent, h, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import { useDetailPanel } from '../../src/renderer/composables/useDetailPanel';
import type { DetailTarget } from '../../src/renderer/composables/useFilePreview';

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
