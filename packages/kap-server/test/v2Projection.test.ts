import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseServerMessage, type ServerMessage, type SessionInfo, type WorkspaceInfo } from '../src/protocol/v2/messages/index';
import type {
  InteractionPendingRecord,
  InteractionResolvedRecord,
  ProjectionEvent,
} from '../src/services/v2Projection/agentProjector';
import { registerHistoryRoutes, historyResponseSchema } from '../src/routes/history';
import { liveSessionSourceFor, SessionV2Binder, type SessionV2Binding, type V2SessionSource } from '../src/services/v2Projection/binder';
import { GlobalV2Fanout, type GlobalV2Event } from '../src/services/v2Projection/globalFanout';
import { ConnectionRegistry } from '../src/transport/ws/connectionRegistry';
import { WsConnectionV2 } from '../src/transport/ws/v2/wsConnectionV2';
import { AgentV2Projector } from '../src/services/v2Projection/agentProjector';
import { buildColdHistory } from '../src/services/v2Projection/coldHistory';
import { SessionV2Projector } from '../src/services/v2Projection/sessionProjector';
import type { SessionFactsPatch } from '../src/services/v2Projection/sessionStateComposer';

interface FixtureTab {
  id: string;
  sections: { label: string; items: { note?: string; json: string }[] }[];
}

const FIXTURES = JSON.parse(
  readFileSync(new URL('./fixtures/v2-examples.json', import.meta.url), 'utf8'),
) as { tabs: FixtureTab[] };

interface ScriptStep {
  event?: ProjectionEvent;
  facts?: SessionFactsPatch & { time: number };
  interaction?: ({ phase: 'pending' } & InteractionPendingRecord) | ({ phase: 'resolved' } & InteractionResolvedRecord);
}

function fixtureStream(tabId: string, sectionLabel: string): unknown[] {
  const tab = FIXTURES.tabs.find((t) => t.id === tabId);
  if (!tab) throw new Error(`tab ${tabId} not found`);
  const section = tab.sections.find((s) => s.label === sectionLabel);
  if (!section) throw new Error(`section ${sectionLabel} not found in ${tabId}`);
  return section.items.map((it) => JSON.parse(it.json));
}

function runScript(sessionId: string, steps: ScriptStep[]): ServerMessage[] {
  const projector = new SessionV2Projector(sessionId);
  const out: ServerMessage[] = [];
  for (const step of steps) {
    if (step.event) out.push(...projector.applyAgentEvent(step.event.agentId ?? 'main', step.event));
    if (step.facts) {
      const { time, ...patch } = step.facts;
      out.push(...projector.applyFacts(patch, time));
    }
    if (step.interaction) {
      const i = step.interaction;
      if (i.phase === 'pending') {
        out.push(...projector.applyInteractionPending('main', { id: i.id, kind: i.kind, toolCallId: i.toolCallId, request: i.request, time: i.time }));
      } else {
        out.push(...projector.applyInteractionResolved('main', { id: i.id, state: i.state, response: i.response, time: i.time }));
      }
    }
  }
  return out;
}

function expectStream(tabId: string, sectionLabel: string, steps: ScriptStep[]): void {
  expectStreams(tabId, [sectionLabel], steps);
}

function expectStreams(tabId: string, sectionLabels: string[], steps: ScriptStep[]): void {
  const expected = sectionLabels
    .flatMap((label) => fixtureStream(tabId, label))
    .filter((m) => (m as { type?: string }).type !== 'subscribe' && (m as { type?: string }).type !== 'ack') as {
    session_id?: string;
  }[];
  const sessionId = expected.find((m) => typeof m.session_id === 'string')?.session_id ?? 's_01';
  const actual = runScript(sessionId, steps);
  for (const msg of actual) parseServerMessage(msg);
  expect(actual).toEqual(expected);
}

function expectScenarios(tabId: string, scenarios: { sectionLabel: string; steps: ScriptStep[] }[]): void {
  for (const { sectionLabel, steps } of scenarios) expectStream(tabId, sectionLabel, steps);
}

const T = Date.parse('2026-09-03T10:00:00.000Z');

describe('v2Projection × 实例对拍', () => {
  it('basic 直播流', () => {
    expectStream('basic', '流式（WS）', [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '你好' }],
          createdAt: '2026-09-03T10:00:00.000Z',
          time: T + 10,
        },
      },
      {
        event: {
          type: 'turn.started',
          turnId: 0,
          promptId: 'p_01',
          origin: { kind: 'user' },
          time: T + 15,
        },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: T + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: T + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: T + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '用户在打招呼，', time: T + 420 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '简短回应即可。', time: T + 580 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '你好！', time: T + 1050 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '有什么可以帮你的？', time: T + 1200 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 1820, output: 24, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: T + 1400,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 1483, time: T + 1500 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 1868,
            usage: { total: { inputOther: 1820, output: 24, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          time: T + 1520,
        },
      },
    ]);
  });

  it('tool 直播流', () => {
    const B = Date.parse('2026-09-03T11:00:00.000Z');
    expectStream('tool', '流式（WS）', [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '执行一下 ls' }],
          createdAt: '2026-09-03T11:00:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 2000,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '用户想看当前目录内容，用 Bash 执行 ls。', time: B + 420 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '好的，执行 `ls`：', time: B + 800 } },
      { event: { type: 'tool.call.delta', turnId: 0, toolCallId: 'call_01', name: 'Bash', argumentsPart: '{"command": "ls', time: B + 1000 } },
      { event: { type: 'tool.call.delta', turnId: 0, toolCallId: 'call_01', argumentsPart: '"}', time: B + 1100 } },
      { event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_01', name: 'Bash', args: { command: 'ls' }, time: B + 1150 } },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_01',
          output: { stdout: 'apps\ndocs\npackages\npnpm-workspace.yaml\n', exit_code: 0 },
          time: B + 1600,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2100, output: 96, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 1700,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 1900 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '当前目录下有 4 个条目：', time: B + 2250 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '`apps`、`docs`、`packages` 和 `pnpm-workspace.yaml`。', time: B + 2400 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 2240, output: 58, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 2600,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 2683, time: B + 2700 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 4494,
            usage: { total: { inputOther: 4340, output: 154, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          time: B + 2720,
        },
      },
    ]);
  });

  it('multi-tool 直播流', () => {
    const B = Date.parse('2026-09-03T12:00:00.000Z');
    expectStream('multi-tool', '流式（WS）', [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '写一个 hello.py 打印当前时间，加个 shebang，然后跑一下' }],
          createdAt: '2026-09-03T12:00:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 2000,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 18,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '先 Write 创建脚本，再 Edit 加 shebang，最后 Bash 运行。', time: B + 420 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '我来创建 `hello.py`：', time: B + 750 } },
      {
        event: {
          type: 'tool.call.delta',
          turnId: 0,
          toolCallId: 'call_01',
          name: 'Write',
          argumentsPart: '{"path": "hello.py", "content": "from datetime import datetime\\nprint(datetime.now())\\n"}',
          time: B + 1000,
        },
      },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_01',
          name: 'Write',
          args: { path: 'hello.py', content: 'from datetime import datetime\nprint(datetime.now())\n' },
          time: B + 1100,
        },
      },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_01', output: { bytes_written: 52 }, time: B + 1400 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2400, output: 130, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 1500,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 1700 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '补上 shebang：', time: B + 1950 } },
      {
        event: {
          type: 'tool.call.delta',
          turnId: 0,
          toolCallId: 'call_02',
          name: 'Edit',
          argumentsPart: '{"path": "hello.py", "old": "from datetime import datetime", "new": "#!/usr/bin/env python3\\nfrom datetime import datetime"}',
          time: B + 2100,
        },
      },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_02',
          name: 'Edit',
          args: { path: 'hello.py', old: 'from datetime import datetime', new: '#!/usr/bin/env python3\nfrom datetime import datetime' },
          time: B + 2200,
        },
      },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_02', output: { applied: true }, time: B + 2400 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 2580, output: 74, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 2500,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 3, time: B + 2700 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '跑一下验证：', time: B + 2850 } },
      {
        event: {
          type: 'tool.call.delta',
          turnId: 0,
          toolCallId: 'call_03',
          name: 'Bash',
          argumentsPart: '{"command": "python3 hello.py"}',
          time: B + 3000,
        },
      },
      {
        event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_03', name: 'Bash', args: { command: 'python3 hello.py' }, time: B + 3100 },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_03',
          output: { stdout: '2026-09-03 12:00:03.587201\n', exit_code: 0 },
          time: B + 3600,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 3,
          usage: { inputOther: 2720, output: 66, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 3700,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 4, time: B + 3900 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '完成。`hello.py` 已创建并加上 shebang，', time: B + 4100 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '运行输出当前时间，一切正常。', time: B + 4150 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 4,
          usage: { inputOther: 2830, output: 62, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 4300,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 4383, time: B + 4400 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 10862,
            usage: { total: { inputOther: 10530, output: 332, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          time: B + 4420,
        },
      },
    ]);
  });

  it('todo 直播流', () => {
    const B = Date.parse('2026-09-03T12:00:00.000Z');
    const todos1 = [
      { title: '查看登录页代码，定位白屏原因', status: 'in_progress' },
      { title: '修复崩溃', status: 'pending' },
      { title: '跑测试验证', status: 'pending' },
    ];
    const todos2 = [
      { title: '查看登录页代码，定位白屏原因', status: 'done' },
      { title: '修复崩溃', status: 'in_progress' },
      { title: '跑测试验证', status: 'pending' },
    ];
    const todos3 = [
      { title: '查看登录页代码，定位白屏原因', status: 'done' },
      { title: '修复崩溃', status: 'done' },
      { title: '跑测试验证', status: 'in_progress' },
    ];
    const todos4 = [
      { title: '查看登录页代码，定位白屏原因', status: 'done' },
      { title: '修复崩溃', status: 'done' },
      { title: '跑测试验证', status: 'done' },
    ];
    expectStream('todo', '流式（WS）', [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '登录页点登录直接白屏，修一下' }],
          createdAt: '2026-09-03T12:00:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '白屏一般是运行时错误。分三步：', time: B + 450 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '定位、修复、验证。', time: B + 580 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '我分三步处理：', time: B + 1050 } },
      { event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_01', name: 'TodoWrite', args: { items: todos1 }, time: B + 1300 } },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_01', output: { updated: true }, time: B + 1350 } },
      { event: { type: 'tools.update_store', key: 'todo', value: todos1, time: B + 1360 } },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_02',
          name: 'Read',
          args: { path: 'apps/web/src/views/LoginView.vue' },
          time: B + 1500,
        },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_02',
          output: { content: '<template>…（文件内容）…</template>', lines: 214 },
          time: B + 2200,
        },
      },
      { event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_03', name: 'TodoWrite', args: { items: todos2 }, time: B + 2300 } },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_03', output: { updated: true }, time: B + 2350 } },
      { event: { type: 'tools.update_store', key: 'todo', value: todos2, time: B + 2360 } },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_04',
          name: 'Edit',
          args: { path: 'apps/web/src/views/LoginView.vue', old: 'const token = user.token;', new: 'const token = user?.token;' },
          time: B + 2500,
        },
      },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_04', output: { applied: true }, time: B + 3000 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2900, output: 78, inputCacheRead: 10000, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 3100,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 3150 } },
      { event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_05', name: 'TodoWrite', args: { items: todos3 }, time: B + 3300 } },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_05', output: { updated: true }, time: B + 3350 } },
      { event: { type: 'tools.update_store', key: 'todo', value: todos3, time: B + 3360 } },
      {
        event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_06', name: 'Bash', args: { command: 'pnpm test -- login' }, time: B + 3500 },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_06',
          output: { stdout: 'Test Files  1 passed (1)\n     Tests  6 passed (6)\n', exit_code: 0 },
          time: B + 5500,
        },
      },
      { event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_07', name: 'TodoWrite', args: { items: todos4 }, time: B + 5600 } },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_07', output: { updated: true }, time: B + 5650 } },
      { event: { type: 'tools.update_store', key: 'todo', value: todos4, time: B + 5660 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '修好了：`handleLogin` 在 `user` 为空时直接读 `token` 导致白屏，', time: B + 6000 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '已加可选链判空；登录相关 6 个测试全部通过。', time: B + 6300 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 2600, output: 84, inputCacheRead: 9500, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 6600,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 6683, time: B + 6700 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 5700,
            usage: { total: { inputOther: 5500, output: 162, inputCacheRead: 19500, inputCacheCreation: 0 } },
          },
          time: B + 6720,
        },
      },
    ]);
  });

  it('queue-abort 直播流', () => {
    const B = Date.parse('2026-09-03T11:00:00.000Z');
    expectStreams('queue-abort', ['排队与接棒（WS）', '中断（WS）'], [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '跑一下测试套件' }],
          createdAt: '2026-09-03T11:00:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '测试命令免审批，直接跑。', time: B + 450 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '我来跑测试：', time: B + 1050 } },
      {
        event: {
          type: 'tool.call.delta',
          turnId: 0,
          toolCallId: 'call_01',
          name: 'Bash',
          argumentsPart: '{"command": "pnpm test"}',
          time: B + 1300,
        },
      },
      {
        event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_01', name: 'Bash', args: { command: 'pnpm test' }, time: B + 1500 },
      },
      {
        event: {
          type: 'tool.progress',
          turnId: 0,
          toolCallId: 'call_01',
          update: { kind: 'stdout', text: '… 12 passed …' },
          time: B + 3000,
        },
      },
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_02',
          status: 'queued',
          content: [{ type: 'text', text: '把失败的用例列出来' }],
          createdAt: '2026-09-03T11:00:04.000Z',
          time: B + 4010,
        },
      },
      {
        event: {
          type: 'tool.progress',
          turnId: 0,
          toolCallId: 'call_01',
          update: { kind: 'stdout', text: '… 2 failed …' },
          time: B + 5500,
        },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_01',
          output: { stdout: 'Test Files  1 failed | 3 passed (4)\n     Tests  2 failed | 18 passed (20)\n', exit_code: 1 },
          time: B + 6000,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2600, output: 60, inputCacheRead: 9000, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 6100,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 6150 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '测试跑完了：18 通过、2 失败。', time: B + 6500 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 2800, output: 40, inputCacheRead: 11000, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 6800,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 6883, time: B + 6900 } },
      { event: { type: 'prompt.started', promptId: 'p_02', time: B + 6920 } },
      { event: { type: 'turn.started', turnId: 1, promptId: 'p_02', origin: { kind: 'user' }, time: B + 6930 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 1, step: 0, phase: 'running', since: B + 6930 } },
          status: {
            contextTokens: 4400,
            usage: { total: { inputOther: 5400, output: 100, inputCacheRead: 20000, inputCacheCreation: 0 } },
          },
          time: B + 6940,
        },
      },
      { event: { type: 'turn.step.started', turnId: 1, step: 1, time: B + 6950 } },
      { event: { type: 'thinking.delta', turnId: 1, delta: '从刚才的输出里挑失败用例即可，', time: B + 7250 } },
      { event: { type: 'thinking.delta', turnId: 1, delta: '不用重跑。', time: B + 7400 } },
      { event: { type: 'assistant.delta', turnId: 1, delta: '失败的两个用例都在 `auth` 目录下：', time: B + 7900 } },
      { event: { type: 'assistant.delta', turnId: 1, delta: '`login.spec.ts` 的「过期 token 应跳转登录页」、', time: B + 8100 } },
      {
        event: {
          type: 'turn.step.interrupted',
          turnId: 1,
          step: 1,
          reason: 'aborted by user',
          time: B + 8610,
        },
      },
      { event: { type: 'turn.ended', turnId: 1, reason: 'cancelled', time: B + 8620 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 6500,
            usage: { total: { inputOther: 7600, output: 135, inputCacheRead: 26000, inputCacheCreation: 0 } },
          },
          time: B + 8640,
        },
      },
      { event: { type: 'prompt.aborted', promptId: 'p_02', abortedAt: '2026-09-03T11:00:08.650Z', time: B + 8650 } },
    ]);
  });

  it('tool-error 直播流', () => {
    const B = Date.parse('2026-09-03T15:00:00.000Z');
    expectStream('tool-error', '流式（WS）', [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '把配置里的超时时间改成 30 秒' }],
          createdAt: '2026-09-03T15:00:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '超时配置在 config/server.toml，直接 Edit。', time: B + 450 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '我来改超时配置：', time: B + 1050 } },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_01',
          name: 'Edit',
          args: { path: 'config/server.toml', old: 'timeout = 10', new: 'timeout = 30' },
          time: B + 1500,
        },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_01',
          output: 'old_string 在文件中未找到',
          isError: true,
          time: B + 1900,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2300, output: 46, inputCacheRead: 7200, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 2000,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 2050 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '没匹配上，我先看下文件实际内容：', time: B + 2400 } },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_02',
          name: 'Read',
          args: { path: 'config/server.toml' },
          time: B + 2800,
        },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_02',
          output: { content: '[server]\nrequest_timeout = 10\n…', lines: 18 },
          time: B + 3200,
        },
      },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_03',
          name: 'Edit',
          args: { path: 'config/server.toml', old: 'request_timeout = 10', new: 'request_timeout = 30' },
          time: B + 3400,
        },
      },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_03', output: { applied: true }, time: B + 3800 } },
      {
        event: {
          type: 'assistant.delta',
          turnId: 0,
          delta: '改好了：超时配置项是 `request_timeout`（不是 `timeout`），已从 10 改为 30。',
          time: B + 4200,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 2800, output: 82, inputCacheRead: 10400, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 4500,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 4583, time: B + 4600 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 5000,
            usage: { total: { inputOther: 5100, output: 128, inputCacheRead: 17600, inputCacheCreation: 0 } },
          },
          time: B + 4620,
        },
      },
    ]);
  });

  it('llm-retry 直播流', () => {
    const B = Date.parse('2026-09-03T15:30:00.000Z');
    expectStream('llm-retry', '流式（WS）', [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '总结一下这个项目的目录结构' }],
          createdAt: '2026-09-03T15:30:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '', time: B + 300 } },
      {
        event: {
          type: 'turn.step.retrying',
          turnId: 0,
          step: 1,
          failedAttempt: 1,
          nextAttempt: 2,
          maxAttempts: 3,
          delayMs: 2000,
          errorName: 'RateLimitError',
          errorMessage: '429 too many requests',
          statusCode: 429,
          time: B + 500,
        },
      },
      { event: { type: 'thinking.delta', turnId: 0, delta: '先列顶层目录，', time: B + 2950 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '再按功能分组说明。', time: B + 3100 } },
      {
        event: {
          type: 'assistant.delta',
          turnId: 0,
          delta: '项目分四块：`apps/` 三个端（desktop、web、auth-login）、',
          time: B + 3700,
        },
      },
      {
        event: {
          type: 'assistant.delta',
          turnId: 0,
          delta: '`packages/` 八个共享包、`scripts/` 构建发布脚本、`docs/` 设计文档。',
          time: B + 3900,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2400, output: 62, inputCacheRead: 8600, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 4200,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 4283, time: B + 4300 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 4300,
            usage: { total: { inputOther: 2400, output: 62, inputCacheRead: 8600, inputCacheCreation: 0 } },
          },
          time: B + 4320,
        },
      },
    ]);
  });

  it('approval 起跑与批准', () => {
    const B = Date.parse('2026-09-03T10:00:00.000Z');
    expectStreams('approval', ['起跑与审批请求（WS）', 'A · 批准（WS）'], [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '把登录页崩溃的复现脚本跑一下' }],
          createdAt: '2026-09-03T10:00:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '复现脚本在 `scripts/` 下，', time: B + 450 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: 'node 执行需要审批。', time: B + 580 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '我来跑一下复现脚本：', time: B + 1050 } },
      {
        event: {
          type: 'tool.call.delta',
          turnId: 0,
          toolCallId: 'call_01',
          name: 'Bash',
          argumentsPart: '{"command": "node scripts/repro-login-crash.mjs',
          time: B + 1300,
        },
      },
      { event: { type: 'tool.call.delta', turnId: 0, toolCallId: 'call_01', argumentsPart: '"}', time: B + 1400 } },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_01',
          name: 'Bash',
          args: { command: 'node scripts/repro-login-crash.mjs' },
          time: B + 1500,
        },
      },
      {
        event: {
          type: 'permission.approval.requested',
          id: 'ap_01',
          turnId: 0,
          toolCallId: 'call_01',
          toolName: 'Bash',
          action: '运行脚本需要执行权限',
          toolInput: { command: 'node scripts/repro-login-crash.mjs' },
          time: B + 1510,
        },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'approval' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 1510 } },
          status: {
            contextTokens: 4280,
            usage: {
              currentTurn: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
              total: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
            },
          },
          time: B + 1520,
        },
      },
      {
        event: {
          type: 'permission.approval.resolved',
          id: 'ap_01',
          turnId: 0,
          toolCallId: 'call_01',
          toolName: 'Bash',
          action: '运行脚本需要执行权限',
          toolInput: { command: 'node scripts/repro-login-crash.mjs' },
          decision: 'approved',
          time: B + 5100,
        },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            contextTokens: 4280,
            usage: {
              currentTurn: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
              total: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
            },
          },
          time: B + 5110,
        },
      },
      {
        event: {
          type: 'tool.progress',
          turnId: 0,
          toolCallId: 'call_01',
          update: { kind: 'stdout', text: "TypeError: Cannot read properties of undefined (reading 'token')" },
          time: B + 5900,
        },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_01',
          output: { stdout: "TypeError: Cannot read properties of undefined (reading 'token')\n    at handleLogin (LoginView.vue:87)\n", exit_code: 1 },
          time: B + 6200,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 6300,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 6350 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '复现成功，报错和浏览器里看到的一致：', time: B + 6700 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '`handleLogin` 读取了 undefined 的 `token` 字段（`LoginView.vue:87`）。', time: B + 6900 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 3100, output: 88, inputCacheRead: 12800, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 7200,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 7283, time: B + 7300 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 5700,
            usage: { total: { inputOther: 5500, output: 140, inputCacheRead: 20800, inputCacheCreation: 0 } },
          },
          time: B + 7320,
        },
      },
    ]);
  });

  it('approval 起跑与拒绝', () => {
    const B = Date.parse('2026-09-03T10:00:00.000Z');
    expectStreams('approval', ['起跑与审批请求（WS）', 'B · 拒绝（WS）'], [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '把登录页崩溃的复现脚本跑一下' }],
          createdAt: '2026-09-03T10:00:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '复现脚本在 `scripts/` 下，', time: B + 450 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: 'node 执行需要审批。', time: B + 580 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '我来跑一下复现脚本：', time: B + 1050 } },
      {
        event: {
          type: 'tool.call.delta',
          turnId: 0,
          toolCallId: 'call_01',
          name: 'Bash',
          argumentsPart: '{"command": "node scripts/repro-login-crash.mjs',
          time: B + 1300,
        },
      },
      { event: { type: 'tool.call.delta', turnId: 0, toolCallId: 'call_01', argumentsPart: '"}', time: B + 1400 } },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_01',
          name: 'Bash',
          args: { command: 'node scripts/repro-login-crash.mjs' },
          time: B + 1500,
        },
      },
      {
        event: {
          type: 'permission.approval.requested',
          id: 'ap_01',
          turnId: 0,
          toolCallId: 'call_01',
          toolName: 'Bash',
          action: '运行脚本需要执行权限',
          toolInput: { command: 'node scripts/repro-login-crash.mjs' },
          time: B + 1510,
        },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'approval' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 1510 } },
          status: {
            contextTokens: 4280,
            usage: {
              currentTurn: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
              total: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
            },
          },
          time: B + 1520,
        },
      },
      {
        event: {
          type: 'permission.approval.resolved',
          id: 'ap_01',
          turnId: 0,
          toolCallId: 'call_01',
          toolName: 'Bash',
          action: '运行脚本需要执行权限',
          toolInput: { command: 'node scripts/repro-login-crash.mjs' },
          decision: 'rejected',
          time: B + 5100,
        },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            contextTokens: 4280,
            usage: {
              currentTurn: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
              total: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
            },
          },
          time: B + 5110,
        },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_01',
          output: 'rejected by user',
          isError: true,
          time: B + 5200,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 5300,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 5350 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '好，那不跑了。', time: B + 5700 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '需要我换个方式排查吗——比如直接读 `handleLogin` 的实现？', time: B + 5900 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 2900, output: 76, inputCacheRead: 12100, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 6200,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 6283, time: B + 6300 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 5500,
            usage: { total: { inputOther: 5300, output: 128, inputCacheRead: 20100, inputCacheCreation: 0 } },
          },
          time: B + 6320,
        },
      },
    ]);
  });

  it('question 直播流', () => {
    const B = Date.parse('2026-09-03T14:00:00.000Z');
    expectStreams('question', ['起跑与提问（WS）', '回答与继续（WS）'], [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '把 README 的安装命令更新成 pnpm' }],
          createdAt: '2026-09-03T14:00:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '安装命令在快速开始和开发者文档各有一处。', time: B + 450 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '范围不明，先问用户。', time: B + 580 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: 'README 里有两处安装命令，先确认范围：', time: B + 1050 } },
      {
        interaction: {
          phase: 'pending',
          id: 'q_01',
          kind: 'question',
          request: {
            questions: [
              { id: 'q1', question: 'README 里有两处安装命令（快速开始、开发者文档），要都更新吗？', options: ['两处都改', '只改快速开始'] },
            ],
          },
          time: B + 1500,
        },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'question' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 1500 } },
          status: {
            contextTokens: 4150,
            usage: {
              currentTurn: { inputOther: 2300, output: 48, inputCacheRead: 7600, inputCacheCreation: 0 },
              total: { inputOther: 2300, output: 48, inputCacheRead: 7600, inputCacheCreation: 0 },
            },
          },
          time: B + 1520,
        },
      },
      {
        interaction: {
          phase: 'resolved',
          id: 'q_01',
          state: 'answered',
          response: { answers: { q1: '两处都改' } },
          time: B + 5100,
        },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            contextTokens: 4150,
            usage: {
              currentTurn: { inputOther: 2300, output: 48, inputCacheRead: 7600, inputCacheCreation: 0 },
              total: { inputOther: 2300, output: 48, inputCacheRead: 7600, inputCacheCreation: 0 },
            },
          },
          time: B + 5110,
        },
      },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_01',
          name: 'Edit',
          args: { path: 'README.md', old: 'npm install && npm run dev', new: 'pnpm install && pnpm dev' },
          time: B + 5300,
        },
      },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_01', output: { applied: true }, time: B + 5800 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2300, output: 48, inputCacheRead: 7600, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 5900,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 5950 } },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_02',
          name: 'Edit',
          args: { path: 'README.md', old: 'npm run build && npm start', new: 'pnpm build && pnpm start' },
          time: B + 6100,
        },
      },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_02', output: { applied: true }, time: B + 6500 } },
      {
        event: {
          type: 'assistant.delta',
          turnId: 0,
          delta: '两处都改好了：快速开始和开发者文档的安装命令已更新为 `pnpm` 版。',
          time: B + 6900,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 2500, output: 62, inputCacheRead: 8800, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 7200,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 7283, time: B + 7300 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 4900,
            usage: { total: { inputOther: 4800, output: 110, inputCacheRead: 16400, inputCacheCreation: 0 } },
          },
          time: B + 7320,
        },
      },
    ]);
  });

  it('background-task 直播流', () => {
    const B = Date.parse('2026-09-03T16:00:00.000Z');
    expectStreams('background-task', ['转后台（WS）', '任务完成与新 turn（WS）'], [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '跑一下完整构建' }],
          createdAt: '2026-09-03T16:00:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '完整构建要几分钟，先跑起来，太久就转后台。', time: B + 450 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '我来跑完整构建：', time: B + 1050 } },
      {
        event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_01', name: 'Bash', args: { command: 'pnpm build' }, time: B + 1500 },
      },
      {
        event: {
          type: 'tool.progress',
          turnId: 0,
          toolCallId: 'call_01',
          update: { kind: 'stdout', text: '… compiling packages (3/8) …' },
          time: B + 3000,
        },
      },
      {
        event: {
          type: 'task.started',
          info: {
            taskId: 'task_01',
            kind: 'shell',
            status: 'running',
            description: 'pnpm build',
            detached: true,
            outputTail: '… compiling packages (3/8) …',
          },
          time: B + 4000,
        },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_01',
          output: { detached: true, task_id: 'task_01' },
          time: B + 4010,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2500, output: 58, inputCacheRead: 9200, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 4100,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 4150 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '构建量比较大，已转后台跑（task_01），完成后我告诉你。', time: B + 4500 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 2700, output: 66, inputCacheRead: 10100, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 4800,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 4883, time: B + 4900 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 5300,
            usage: { total: { inputOther: 5200, output: 124, inputCacheRead: 19300, inputCacheCreation: 0 } },
          },
          time: B + 4920,
        },
      },
      {
        event: {
          type: 'shell.output',
          taskId: 'task_01',
          update: { kind: 'stdout', text: '… packages (8/8) done, writing dist …' },
          time: B + 450000,
        },
      },
      {
        event: {
          type: 'task.terminated',
          info: { taskId: 'task_01', kind: 'shell', status: 'completed', description: 'pnpm build', resultSummary: '构建成功：8 个包全部编译通过' },
          outputTail: '… build finished successfully in 7m 56s …',
          time: B + 478500,
        },
      },
      {
        event: {
          type: 'task.notified',
          title: '后台构建完成',
          body: '构建成功：8 个包全部编译通过',
          severity: 'info',
          notificationType: 'task.completed',
          sourceKind: 'background_task',
          sourceId: 'task_01',
          time: B + 478510,
        },
      },
      { event: { type: 'turn.started', turnId: 1, origin: { kind: 'task', taskId: 'task_01' }, time: B + 478600 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 1, step: 0, phase: 'running', since: B + 478600 } },
          status: {
            contextTokens: 5300,
            usage: { total: { inputOther: 5200, output: 124, inputCacheRead: 19300, inputCacheCreation: 0 } },
          },
          time: B + 478610,
        },
      },
      { event: { type: 'turn.step.started', turnId: 1, step: 1, time: B + 478620 } },
      { event: { type: 'assistant.delta', turnId: 1, delta: '构建完成了：8 个包全部编译通过，产物在各自的 `dist/`。', time: B + 479000 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 1,
          step: 1,
          usage: { inputOther: 2900, output: 44, inputCacheRead: 12000, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 479300,
        },
      },
      { event: { type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 797, time: B + 479400 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 5600,
            usage: { total: { inputOther: 8100, output: 168, inputCacheRead: 31300, inputCacheCreation: 0 } },
          },
          time: B + 479410,
        },
      },
    ]);
  });

  it('compaction 直播流', () => {
    const B = Date.parse('2026-09-03T16:30:00.000Z');
    expectStream('compaction', '流式（WS）', [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          turnId: 8,
          content: [{ type: 'text', text: '接着上面的讨论，把新页面的路由也加上' }],
          createdAt: '2026-09-03T16:30:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 8, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 8, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 241000,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 20337, output: 4398, inputCacheRead: 128912, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      {
        event: {
          type: 'compaction.completed',
          result: { summary: '前 8 轮讨论摘要', compactedCount: 42, tokensBefore: 241000, tokensAfter: 62000 },
          time: B + 100,
        },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 8, step: 0, phase: 'running', since: B + 15 } },
          status: { contextTokens: 62000 },
          time: B + 110,
        },
      },
      { event: { type: 'turn.step.started', turnId: 8, step: 1, time: B + 120 } },
      { event: { type: 'thinking.delta', turnId: 8, delta: '路由集中在 router 配置文件，加一条即可。', time: B + 550 } },
      { event: { type: 'assistant.delta', turnId: 8, delta: '我来加路由：', time: B + 1150 } },
      {
        event: {
          type: 'tool.call.started',
          turnId: 8,
          toolCallId: 'call_01',
          name: 'Edit',
          args: {
            path: 'apps/web/src/router.ts',
            old: "  { path: '/login', component: LoginView },",
            new: "  { path: '/login', component: LoginView },\n  { path: '/new-page', component: NewPageView },",
          },
          time: B + 1500,
        },
      },
      { event: { type: 'tool.result', turnId: 8, toolCallId: 'call_01', output: { applied: true }, time: B + 1900 } },
      { event: { type: 'assistant.delta', turnId: 8, delta: '加好了：`/new-page` 路由已注册到 `router.ts`。', time: B + 2300 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 8,
          step: 1,
          usage: { inputOther: 3100, output: 72, inputCacheRead: 9600, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 2600,
        },
      },
      { event: { type: 'turn.ended', turnId: 8, reason: 'completed', durationMs: 2683, time: B + 2700 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 65200,
            usage: { total: { inputOther: 20600, output: 4460, inputCacheRead: 129500, inputCacheCreation: 0 } },
          },
          time: B + 2720,
        },
      },
    ]);
  });

  it('undo 直播流', () => {
    const B = Date.parse('2026-09-03T18:10:00.000Z');
    expectStream('undo', 'undo（WS）', [
      { event: { type: 'context.undone', turns: 1, fromTurnId: 0, time: B + 5000 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 5000,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 5100, output: 128, inputCacheRead: 17600, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 5010,
        },
      },
    ]);
  });

  it('big-output 直播流', () => {
    const B = Date.parse('2026-09-03T18:30:00.000Z');
    expectStream('big-output', '流式（WS）', [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '跑一下全量测试' }],
          createdAt: '2026-09-03T18:30:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '全量测试输出会很大，截断内联即可。', time: B + 450 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '我来跑全量测试：', time: B + 1050 } },
      {
        event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_01', name: 'Bash', args: { command: 'pnpm test --all' }, time: B + 1500 },
      },
      {
        event: {
          type: 'tool.progress',
          turnId: 0,
          toolCallId: 'call_01',
          update: { kind: 'stdout', text: '… running 43 test files …' },
          time: B + 20000,
        },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_01',
          output: {
            stdout: '…\n ✓ packages/app-core/src/lib/wire.test.ts (42 tests)\n ✗ packages/app-client/src/stores/chat.test.ts (2 failed)\nTest Files  2 failed | 41 passed (43)\n     Tests  2 failed | 386 passed (388)\n',
            exit_code: 1,
            truncated: true,
            total_lines: 4821,
          },
          time: B + 45200,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2800, output: 72, inputCacheRead: 11000, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 45300,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 45350 } },
      {
        event: {
          type: 'assistant.delta',
          turnId: 0,
          delta: '全量 43 个测试文件：41 通过、2 失败（都在 `app-client` 的 chat store）。',
          time: B + 45700,
        },
      },
      { event: { type: 'assistant.delta', turnId: 0, delta: '完整日志 4821 行，需要我拉出来定位吗？', time: B + 45800 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 3000, output: 80, inputCacheRead: 12100, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 46000,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 46083, time: B + 46100 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 5900,
            usage: { total: { inputOther: 5800, output: 152, inputCacheRead: 23100, inputCacheCreation: 0 } },
          },
          time: B + 46120,
        },
      },
    ]);
  });

  it('plan 直播流', () => {
    const B = Date.parse('2026-09-03T17:50:00.000Z');
    expectStream('plan', '流式（WS）', [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '把登录页改造成支持 SSO' }],
          createdAt: '2026-09-03T17:50:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '改造涉及多个文件，先进入 plan 模式出方案。', time: B + 450 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '这个改造涉及多个文件，我先出方案再动手：', time: B + 1050 } },
      { event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_01', name: 'EnterPlanMode', time: B + 1500 } },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_01', output: { entered: true }, time: B + 1600 } },
      { event: { type: 'agent.status.updated', planMode: true, time: B + 1610 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            contextTokens: 4100,
            usage: { total: { inputOther: 2200, output: 58, inputCacheRead: 8000, inputCacheCreation: 0 } },
          },
          modes: { plan: { version: 0 } },
          time: B + 1620,
        },
      },
      { event: { type: 'assistant.delta', turnId: 0, delta: 'SSO 改造分四步：1. 接入 OAuth 客户端（`auth/oauth.ts', time: B + 2000 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '`）；2. 登录页加 SSO 按钮；3. 新增 `/callback` 路由处理回跳；4. 本地会话与 SSO 会话合并。', time: B + 2300 } },
      {
        event: {
          type: 'plan.revision',
          id: 'rev_01',
          version: 1,
          key: 'plans/sso.md',
          sha256: 'deadbeef',
          bytes: 512,
          summary: 'SSO 改造四步',
          time: B + 2700,
        },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            contextTokens: 4300,
            usage: { total: { inputOther: 2400, output: 96, inputCacheRead: 8600, inputCacheCreation: 0 } },
          },
          modes: { plan: { version: 1, review_path: 'plans/sso.md' } },
          time: B + 2710,
        },
      },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_02',
          name: 'ExitPlanMode',
          args: { plan_key: 'plans/sso.md' },
          display: { kind: 'plan_review', plan: '## 目标\n\n接入 SSO 登录，改造涉及多个文件。', path: 'plans/sso.md' },
          time: B + 2900,
        },
      },
      {
        event: {
          type: 'permission.approval.requested',
          id: 'ap_01',
          turnId: 0,
          toolCallId: 'call_02',
          toolName: 'ExitPlanMode',
          action: '请审查并批准实施方案',
          toolInput: { plan_key: 'plans/sso.md' },
          display: { kind: 'plan_review', plan: '## 目标\n\n接入 SSO 登录，改造涉及多个文件。', path: 'plans/sso.md' },
          time: B + 2910,
        },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'approval' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 2910 } },
          status: {
            contextTokens: 4300,
            usage: {
              currentTurn: { inputOther: 2400, output: 96, inputCacheRead: 8600, inputCacheCreation: 0 },
              total: { inputOther: 2400, output: 96, inputCacheRead: 8600, inputCacheCreation: 0 },
            },
          },
          time: B + 2920,
        },
      },
      {
        event: {
          type: 'permission.approval.resolved',
          id: 'ap_01',
          turnId: 0,
          toolCallId: 'call_02',
          toolName: 'ExitPlanMode',
          action: '请审查并批准实施方案',
          toolInput: { plan_key: 'plans/sso.md' },
          decision: 'approved',
          time: B + 5000,
        },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            contextTokens: 4300,
            usage: {
              currentTurn: { inputOther: 2400, output: 96, inputCacheRead: 8600, inputCacheCreation: 0 },
              total: { inputOther: 2400, output: 96, inputCacheRead: 8600, inputCacheCreation: 0 },
            },
          },
          time: B + 5010,
        },
      },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_02', output: { approved: true }, time: B + 5020 } },
      { event: { type: 'agent.status.updated', planMode: false, time: B + 5030 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            contextTokens: 4300,
            usage: { total: { inputOther: 2400, output: 96, inputCacheRead: 8600, inputCacheCreation: 0 } },
          },
          time: B + 5040,
        },
      },
      { event: { type: 'assistant.delta', turnId: 0, delta: '开始实施，先接 OAuth 客户端：', time: B + 5400 } },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_03',
          name: 'Write',
          args: { path: 'apps/web/src/auth/oauth.ts', content: '…（OAuth 客户端封装）…' },
          time: B + 5800,
        },
      },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_03', output: { bytes_written: 612 }, time: B + 6300 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2400, output: 96, inputCacheRead: 8600, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 6400,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 6450 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '第 1 步完成。继续第 2 步（登录页 SSO 按钮）？', time: B + 6800 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 2900, output: 74, inputCacheRead: 11200, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 7100,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 7183, time: B + 7200 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 5600,
            usage: { total: { inputOther: 5300, output: 170, inputCacheRead: 19800, inputCacheCreation: 0 } },
          },
          time: B + 7220,
        },
      },
    ]);
  });

  it('goal 直播流', () => {
    const B = Date.parse('2026-09-03T18:00:00.000Z');
    expectStream('goal', '流式（WS）', [
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          goal: {
            objective: '修复登录页白屏并让登录测试全绿',
            status: 'active',
            completionCriterion: 'pnpm test -- login 全部通过',
            budgetUsed: 0,
            budgetLimit: 50,
          },
          time: B,
        },
      },
      {
        event: {
          type: 'turn.started',
          turnId: 0,
          promptId: 'p_01',
          origin: { kind: 'system_trigger', name: 'goal_continuation' },
          time: B + 15,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '先复现定位，再修，最后跑测试验证达标条件。', time: B + 450 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '先修复崩溃点：', time: B + 1050 } },
      {
        event: {
          type: 'tool.call.started',
          turnId: 0,
          toolCallId: 'call_01',
          name: 'Edit',
          args: { path: 'apps/web/src/views/LoginView.vue', old: 'const token = user.token;', new: 'const token = user?.token;' },
          time: B + 1500,
        },
      },
      { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_01', output: { applied: true }, time: B + 2000 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2600, output: 64, inputCacheRead: 9800, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 2100,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 2150 } },
      {
        event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_02', name: 'Bash', args: { command: 'pnpm test -- login' }, time: B + 2300 },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_02',
          output: { stdout: 'Test Files  1 passed (1)\n     Tests  6 passed (6)\n', exit_code: 0 },
          time: B + 4300,
        },
      },
      { event: { type: 'assistant.delta', turnId: 0, delta: '目标达成：白屏已修复，登录相关 6 个测试全部通过。', time: B + 4700 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 1, phase: 'running', since: B + 15 } },
          status: {
            contextTokens: 5400,
            usage: { total: { inputOther: 5300, output: 140, inputCacheRead: 18600, inputCacheCreation: 0 } },
          },
          goal: {
            objective: '修复登录页白屏并让登录测试全绿',
            status: 'complete',
            completionCriterion: 'pnpm test -- login 全部通过',
            budgetUsed: 3,
            budgetLimit: 50,
          },
          time: B + 4950,
        },
      },
      {
        event: {
          type: 'goal.updated',
          snapshot: {
            objective: '修复登录页白屏并让登录测试全绿',
            status: 'complete',
            completionCriterion: 'pnpm test -- login 全部通过',
            budgetUsed: 3,
            budgetLimit: 50,
          },
          time: B + 4960,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 2700, output: 76, inputCacheRead: 10200, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 5000,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 5083, time: B + 5100 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 5400,
            usage: { total: { inputOther: 5300, output: 140, inputCacheRead: 18600, inputCacheCreation: 0 } },
          },
          goal: null,
          time: B + 5110,
        },
      },
    ]);
  });

  it('sidechat 直播流', () => {
    const B = Date.parse('2026-09-03T17:40:00.000Z');
    expectStream('sidechat', '流式（WS）', [
      {
        event: {
          type: 'prompt.submitted',
          agentId: 'side_01',
          promptId: 'p_01',
          status: 'running',
          turnId: 1,
          content: [{ type: 'text', text: '`user?.token` 是啥语法？' }],
          createdAt: '2026-09-03T17:40:00.000Z',
          time: B + 10,
        },
      },
      {
        event: { type: 'turn.started', agentId: 'side_01', turnId: 1, promptId: 'p_01', origin: { kind: 'side' }, time: B + 15 },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 1, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 5700,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 5500, output: 162, inputCacheRead: 19500, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', agentId: 'side_01', turnId: 1, step: 1, time: B + 22 } },
      {
        event: {
          type: 'assistant.delta',
          agentId: 'side_01',
          turnId: 1,
          delta: '`user?.token` 是可选链：`user` 为 null / undefined 时整个表达式短路为 undefined，',
          time: B + 500,
        },
      },
      {
        event: { type: 'assistant.delta', agentId: 'side_01', turnId: 1, delta: '不会再抛 TypeError。昨天的白屏正是缺了它。', time: B + 700 },
      },
      {
        event: {
          type: 'turn.step.completed',
          agentId: 'side_01',
          turnId: 1,
          step: 1,
          usage: { inputOther: 2100, output: 48, inputCacheRead: 6000, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 1000,
        },
      },
      { event: { type: 'turn.ended', agentId: 'side_01', turnId: 1, reason: 'completed', durationMs: 1083, time: B + 1100 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 5900,
            usage: { total: { inputOther: 7600, output: 210, inputCacheRead: 25500, inputCacheCreation: 0 } },
          },
          time: B + 1120,
        },
      },
    ]);
  });

  it('attachment 直播流', () => {
    const B = Date.parse('2026-09-03T18:20:00.000Z');
    expectStream('attachment', '流式（WS）', [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '看下这个报错截图' }],
          attachmentIds: ['att_01'],
          createdAt: '2026-09-03T18:20:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '截图里是 TypeError，位置在 handleLogin:87。', time: B + 450 } },
      {
        event: {
          type: 'assistant.delta',
          turnId: 0,
          delta: '截图显示 `TypeError: Cannot read properties of undefined (reading \'token\')`，',
          time: B + 1050,
        },
      },
      {
        event: {
          type: 'assistant.delta',
          turnId: 0,
          delta: '发生在 `LoginView.vue:87` 的 `handleLogin`——`user` 为空时直接读了 `token`。',
          time: B + 1250,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2600, output: 66, inputCacheRead: 9000, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 1600,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 1683, time: B + 1700 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 4500,
            usage: { total: { inputOther: 2600, output: 66, inputCacheRead: 9000, inputCacheCreation: 0 } },
          },
          time: B + 1720,
        },
      },
    ]);
  });

  it('cron 直播流', () => {
    const B = Date.parse('2026-09-03T18:40:00.000Z');
    expectStream('cron', '流式（WS）', [
      {
        event: {
          type: 'cron.fired',
          promptId: 'p_01',
          origin: { kind: 'cron_job', jobId: 'cron_01', cron: '0 9 * * 1-5', recurring: true, coalescedCount: 0, stale: false },
          prompt: '跑一遍登录相关测试并汇报结果',
          time: B,
        },
      },
      {
        event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'cron_job', jobId: 'cron_01' }, time: B + 15 },
      },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '定时任务：跑登录测试并汇报。', time: B + 450 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '开始执行定时任务：', time: B + 1050 } },
      {
        event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_01', name: 'Bash', args: { command: 'pnpm test -- login' }, time: B + 1500 },
      },
      {
        event: {
          type: 'tool.result',
          turnId: 0,
          toolCallId: 'call_01',
          output: { stdout: 'Test Files  1 passed (1)\n     Tests  6 passed (6)\n', exit_code: 0 },
          time: B + 3500,
        },
      },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
          usage: { inputOther: 2400, output: 58, inputCacheRead: 9000, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 3600,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 3650 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '定时报告：登录相关 6 个测试全部通过，无异常。', time: B + 4000 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 2,
          usage: { inputOther: 2600, output: 62, inputCacheRead: 9800, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: B + 4300,
        },
      },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 4383, time: B + 4400 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 4800,
            usage: { total: { inputOther: 5000, output: 120, inputCacheRead: 18800, inputCacheCreation: 0 } },
          },
          time: B + 4410,
        },
      },
    ]);
  });

  it('injection 三场景', () => {
    const S = Date.parse('2026-09-03T18:50:00.000Z');
    const C = Date.parse('2026-09-04T08:59:50.000Z');
    const K = Date.parse('2026-09-04T10:30:00.000Z');
    expectScenarios('injection', [
      {
        sectionLabel: 'steer（WS）',
        steps: [
          {
            event: {
              type: 'prompt.submitted',
              promptId: 'p_01',
              status: 'running',
              content: [{ type: 'text', text: '把登录页白屏修一下' }],
              createdAt: '2026-09-03T18:50:00.000Z',
              time: S + 10,
            },
          },
          { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: S + 15 } },
          {
            facts: {
              activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
              agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: S + 15 } },
              status: {
                model: 'kimi-k3-highspeed',
                contextTokens: 1820,
                maxContextTokens: 262144,
                usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
              },
              permission: 'manual',
              time: S + 20,
            },
          },
          { event: { type: 'turn.step.started', turnId: 0, step: 1, time: S + 22 } },
          { event: { type: 'thinking.delta', turnId: 0, delta: '白屏是 user 为空读 token 导致，加可选链。', time: S + 450 } },
          { event: { type: 'assistant.delta', turnId: 0, delta: '先修复崩溃点：', time: S + 1050 } },
          {
            event: {
              type: 'tool.call.started',
              turnId: 0,
              toolCallId: 'call_01',
              name: 'Edit',
              args: { path: 'apps/web/src/views/LoginView.vue', old: 'const token = user.token;', new: 'const token = user?.token;' },
              time: S + 1500,
            },
          },
          { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_01', output: { applied: true }, time: S + 2000 } },
          {
            event: {
              type: 'turn.step.completed',
              turnId: 0,
              step: 1,
              usage: { inputOther: 2600, output: 64, inputCacheRead: 9800, inputCacheCreation: 0 },
              finishReason: 'tool_use',
              time: S + 2100,
            },
          },
          { event: { type: 'turn.step.started', turnId: 0, step: 2, time: S + 2150 } },
          {
            event: { type: 'tool.call.started', turnId: 0, toolCallId: 'call_02', name: 'Bash', args: { command: 'pnpm test -- login' }, time: S + 2300 },
          },
          {
            event: {
              type: 'prompt.submitted',
              promptId: 'p_02',
              status: 'queued',
              steer: true,
              content: [{ type: 'text', text: '顺便把超时时间也改成 30' }],
              createdAt: '2026-09-03T18:50:03.000Z',
              time: S + 3000,
            },
          },
          {
            event: {
              type: 'prompt.steered',
              activePromptId: 'p_01',
              promptIds: ['p_02'],
              content: [{ type: 'text', text: '顺便把超时时间也改成 30' }],
              steeredAt: '2026-09-03T18:50:03.000Z',
              time: S + 3010,
            },
          },
          {
            event: {
              type: 'tool.result',
              turnId: 0,
              toolCallId: 'call_02',
              output: { stdout: 'Test Files  1 passed (1)\n     Tests  6 passed (6)\n', exit_code: 0 },
              time: S + 4500,
            },
          },
          { event: { type: 'assistant.delta', turnId: 0, delta: '测试通过，白屏修好了。接着把超时改成 30：', time: S + 4900 } },
          {
            event: {
              type: 'tool.call.started',
              turnId: 0,
              toolCallId: 'call_03',
              name: 'Edit',
              args: { path: 'config/server.toml', old: 'request_timeout = 10', new: 'request_timeout = 30' },
              time: S + 5300,
            },
          },
          { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_03', output: { applied: true }, time: S + 5700 } },
          {
            event: {
              type: 'assistant.delta',
              turnId: 0,
              delta: '都完成了：白屏已修复（测试全绿），超时已改为 30 秒。',
              time: S + 6100,
            },
          },
          {
            event: {
              type: 'turn.step.completed',
              turnId: 0,
              step: 2,
              usage: { inputOther: 3200, output: 118, inputCacheRead: 13600, inputCacheCreation: 0 },
              finishReason: 'end_turn',
              time: S + 6400,
            },
          },
          { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 6483, time: S + 6500 } },
          {
            facts: {
              activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
              agentActivity: { lifecycle: 'ready' },
              status: {
                contextTokens: 6100,
                usage: { total: { inputOther: 5800, output: 182, inputCacheRead: 23400, inputCacheCreation: 0 } },
              },
              time: S + 6530,
            },
          },
        ],
      },
      {
        sectionLabel: 'cron · 忙时（WS）',
        steps: [
          {
            event: {
              type: 'prompt.submitted',
              promptId: 'p_01',
              status: 'running',
              turnId: 1,
              content: [{ type: 'text', text: '重构 auth 模块' }],
              createdAt: '2026-09-04T08:59:50.000Z',
              time: C + 10,
            },
          },
          { event: { type: 'turn.started', turnId: 1, promptId: 'p_01', origin: { kind: 'user' }, time: C + 15 } },
          {
            facts: {
              activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
              agentActivity: { lifecycle: 'ready', turn: { turnId: 1, step: 0, phase: 'running', since: C + 15 } },
              status: {
                model: 'kimi-k3-highspeed',
                contextTokens: 6100,
                maxContextTokens: 262144,
                usage: { total: { inputOther: 5800, output: 182, inputCacheRead: 23400, inputCacheCreation: 0 } },
              },
              permission: 'manual',
              time: C + 20,
            },
          },
          { event: { type: 'turn.step.started', turnId: 1, step: 1, time: C + 22 } },
          { event: { type: 'thinking.delta', turnId: 1, delta: '先拆 session 签发逻辑。', time: C + 450 } },
          { event: { type: 'assistant.delta', turnId: 1, delta: '先拆 session 签发：', time: C + 1050 } },
          {
            event: {
              type: 'tool.call.started',
              turnId: 1,
              toolCallId: 'call_01',
              name: 'Edit',
              args: { path: 'apps/web/src/auth/session.ts', old: '…（旧签发逻辑）…', new: '…（拆分后）…' },
              time: C + 1500,
            },
          },
          {
            event: {
              type: 'cron.fired',
              promptId: 'cron_01_p',
              origin: { kind: 'cron_job', jobId: 'cron_01', cron: '0 9 * * 1-5', recurring: true, coalescedCount: 0, stale: false },
              prompt: '跑一遍登录相关测试并汇报结果',
              time: C + 10000,
            },
          },
          { event: { type: 'tool.result', turnId: 1, toolCallId: 'call_01', output: { applied: true }, time: C + 10500 } },
          {
            event: {
              type: 'turn.step.completed',
              turnId: 1,
              step: 1,
              usage: { inputOther: 3400, output: 96, inputCacheRead: 15000, inputCacheCreation: 0 },
              finishReason: 'tool_use',
              time: C + 10600,
            },
          },
          { event: { type: 'turn.step.started', turnId: 1, step: 2, time: C + 10650 } },
          { event: { type: 'assistant.delta', turnId: 1, delta: '定时任务到点了。先把重构收尾：', time: C + 11000 } },
          {
            event: {
              type: 'tool.call.started',
              turnId: 1,
              toolCallId: 'call_02',
              name: 'Edit',
              args: { path: 'apps/web/src/auth/index.ts', old: "export * from './session';", new: "export * from './session';\nexport * from './token';" },
              time: C + 11400,
            },
          },
          { event: { type: 'tool.result', turnId: 1, toolCallId: 'call_02', output: { applied: true }, time: C + 11800 } },
          { event: { type: 'assistant.delta', turnId: 1, delta: '重构完成。现在执行定时任务——跑登录测试：', time: C + 12200 } },
          {
            event: { type: 'tool.call.started', turnId: 1, toolCallId: 'call_03', name: 'Bash', args: { command: 'pnpm test -- login' }, time: C + 12600 },
          },
          {
            event: {
              type: 'tool.result',
              turnId: 1,
              toolCallId: 'call_03',
              output: { stdout: 'Test Files  1 passed (1)\n     Tests  6 passed (6)\n', exit_code: 0 },
              time: C + 14600,
            },
          },
          {
            event: {
              type: 'assistant.delta',
              turnId: 1,
              delta: '都完成了：auth 重构收尾；定时任务已执行——登录测试 6/6 通过。',
              time: C + 15000,
            },
          },
          {
            event: {
              type: 'turn.step.completed',
              turnId: 1,
              step: 2,
              usage: { inputOther: 3600, output: 142, inputCacheRead: 16200, inputCacheCreation: 0 },
              finishReason: 'end_turn',
              time: C + 15300,
            },
          },
          { event: { type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 15383, time: C + 15400 } },
          {
            facts: {
              activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
              agentActivity: { lifecycle: 'ready' },
              status: {
                contextTokens: 10400,
                usage: { total: { inputOther: 12800, output: 420, inputCacheRead: 38400, inputCacheCreation: 0 } },
              },
              time: C + 15420,
            },
          },
        ],
      },
      {
        sectionLabel: 'task 完成 · 忙时（WS）',
        steps: [
          {
            event: {
              type: 'prompt.submitted',
              promptId: 'p_01',
              status: 'running',
              turnId: 2,
              content: [{ type: 'text', text: '把登录页按钮改成品牌色' }],
              createdAt: '2026-09-04T10:30:00.000Z',
              time: K + 10,
            },
          },
          { event: { type: 'turn.started', turnId: 2, promptId: 'p_01', origin: { kind: 'user' }, time: K + 15 } },
          {
            facts: {
              activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
              agentActivity: { lifecycle: 'ready', turn: { turnId: 2, step: 0, phase: 'running', since: K + 15 } },
              status: {
                model: 'kimi-k3-highspeed',
                contextTokens: 10400,
                maxContextTokens: 262144,
                usage: { total: { inputOther: 12800, output: 420, inputCacheRead: 38400, inputCacheCreation: 0 } },
              },
              permission: 'manual',
              time: K + 20,
            },
          },
          { event: { type: 'turn.step.started', turnId: 2, step: 1, time: K + 22 } },
          { event: { type: 'thinking.delta', turnId: 2, delta: '改按钮样式，一处 CSS 变量即可。', time: K + 450 } },
          { event: { type: 'assistant.delta', turnId: 2, delta: '我来改按钮颜色：', time: K + 1050 } },
          {
            event: {
              type: 'tool.call.started',
              turnId: 2,
              toolCallId: 'call_01',
              name: 'Edit',
              args: { path: 'apps/web/src/styles/theme.css', old: '--btn-primary: #6b7280;', new: '--btn-primary: #4f46e5;' },
              time: K + 1500,
            },
          },
          {
            event: {
              type: 'task.terminated',
              info: {
                taskId: 'task_01',
                kind: 'shell',
                status: 'completed',
                description: 'pnpm build',
                detached: true,
                startedAt: '2026-09-04T10:30:02.000Z',
                resultSummary: '构建成功：8 个包全部编译通过',
              },
              outputTail: '… build finished successfully …',
              time: K + 2000,
            },
          },
          {
            event: {
              type: 'task.notified',
              title: '后台任务完成',
              body: '构建成功：8 个包全部编译通过',
              severity: 'info',
              notificationType: 'task.completed',
              sourceKind: 'background_task',
              sourceId: 'task_01',
              time: K + 2010,
            },
          },
          { event: { type: 'tool.result', turnId: 2, toolCallId: 'call_01', output: { applied: true }, time: K + 2500 } },
          {
            event: {
              type: 'assistant.delta',
              turnId: 2,
              delta: '按钮颜色改好了。顺便说，后台构建也完成了：8 个包全部编译通过。',
              time: K + 2900,
            },
          },
          {
            event: {
              type: 'turn.step.completed',
              turnId: 2,
              step: 1,
              usage: { inputOther: 3100, output: 92, inputCacheRead: 12800, inputCacheCreation: 0 },
              finishReason: 'end_turn',
              time: K + 3200,
            },
          },
          { event: { type: 'turn.ended', turnId: 2, reason: 'completed', durationMs: 3283, time: K + 3300 } },
          {
            facts: {
              activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
              agentActivity: { lifecycle: 'ready' },
              status: {
                contextTokens: 11800,
                usage: { total: { inputOther: 15900, output: 512, inputCacheRead: 51200, inputCacheCreation: 0 } },
              },
              time: K + 3320,
            },
          },
        ],
      },
    ]);
  });

  it('steer race：提交即收官，按新 turn 单实体补 emit', () => {
    const S = Date.parse('2026-09-03T19:10:00.000Z');
    const actual = runScript('s_race', [
      { event: { type: 'prompt.submitted', promptId: 'p_01', status: 'running', content: [{ type: 'text', text: '主任务' }], createdAt: '2026-09-03T19:10:00.000Z', time: S } },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: S + 10 } },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: S + 20 } },
      { event: { type: 'prompt.submitted', promptId: 'p_02', status: 'queued', steer: true, content: [{ type: 'text', text: '插一句' }], createdAt: '2026-09-03T19:10:01.000Z', time: S + 1000 } },
      { event: { type: 'turn.step.completed', turnId: 0, step: 1, time: S + 2000 } },
      { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 2000, time: S + 2010 } },
      { event: { type: 'prompt.completed', promptId: 'p_01', finishedAt: '2026-09-03T19:10:02.010Z', time: S + 2010 } },
      { event: { type: 'turn.started', turnId: 1, promptId: 'p_02', origin: { kind: 'user' }, time: S + 2020 } },
      { event: { type: 'prompt.started', promptId: 'p_02', time: S + 2021 } },
      { event: { type: 'turn.step.started', turnId: 1, step: 1, time: S + 2022 } },
      { event: { type: 'turn.step.completed', turnId: 1, step: 1, time: S + 3000 } },
      { event: { type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 1000, time: S + 3010 } },
      { event: { type: 'prompt.completed', promptId: 'p_02', finishedAt: '2026-09-03T19:10:03.010Z', time: S + 3010 } },
    ]);
    for (const msg of actual) parseServerMessage(msg);
    const steerFrames = actual.filter(
      (m) => m.type === 'user' && (m as { text?: string }).text === '插一句',
    ) as { message_id: string; status: string }[];
    expect(steerFrames.length).toBeGreaterThan(0);
    for (const frame of steerFrames) expect(frame.message_id).toBe('t2.u0');
    expect(steerFrames[steerFrames.length - 1]?.status).toBe('completed');
    const firstSteerIdx = actual.indexOf(steerFrames[0] as (typeof actual)[number]);
    const turnT2Idx = actual.findIndex((m) => m.type === 'turn' && (m as { turn_id?: string }).turn_id === 't2');
    expect(firstSteerIdx).toBeGreaterThan(turnT2Idx);
    const t1Users = actual.filter(
      (m) => m.type === 'user' && (m as { message_id?: string }).message_id?.startsWith('t1.'),
    ) as { text?: string }[];
    for (const frame of t1Users) expect(frame.text).not.toBe('插一句');
  });

  it('subagent 四场景', () => {
    const B = Date.parse('2026-09-03T17:30:00.000Z');
    const spawnArgs = { description: '审查 LoginView 的白屏修复', agent_type: 'reviewer' };
    const reviewRefs = [{ agent_id: 'review_01', role: 'child' as const }];
    const startSteps = (thinkA: string, thinkB: string, say: string): ScriptStep[] => [
      {
        event: {
          type: 'prompt.submitted',
          promptId: 'p_01',
          status: 'running',
          content: [{ type: 'text', text: '白屏修好了，帮我审查一下改动' }],
          createdAt: '2026-09-03T17:30:00.000Z',
          time: B + 10,
        },
      },
      { event: { type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 0, step: 0, phase: 'running', since: B + 15 } },
          status: {
            model: 'kimi-k3-highspeed',
            contextTokens: 1820,
            maxContextTokens: 262144,
            usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
          },
          permission: 'manual',
          time: B + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: thinkA, time: B + 450 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: thinkB, time: B + 580 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: say, time: B + 1050 } },
    ];
    const collectSteps = (at: number): ScriptStep[] => [
      {
        event: {
          type: 'task.terminated',
          info: { taskId: 'task_01', kind: 'agent', status: 'completed', description: '审查 LoginView 的白屏修复', resultSummary: '审查通过，无回归风险' },
          outputTail: '审查通过：可选链修复正确，无回归风险。',
          time: at,
        },
      },
      { event: { type: 'turn.started', turnId: 1, origin: { kind: 'task', taskId: 'task_01' }, time: at + 10 } },
      {
        facts: {
          activity: { busy: true, mainTurnActive: true, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready', turn: { turnId: 1, step: 0, phase: 'running', since: at + 10 } },
          status: {
            contextTokens: 4500,
            usage: { total: { inputOther: 2600, output: 64, inputCacheRead: 9800, inputCacheCreation: 0 } },
          },
          time: at + 20,
        },
      },
      { event: { type: 'turn.step.started', turnId: 1, step: 1, time: at + 30 } },
      { event: { type: 'assistant.delta', turnId: 1, delta: '后台审查完成了：修复正确，无回归风险，可以放心提交。', time: at + 400 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 1,
          step: 1,
          usage: { inputOther: 2800, output: 58, inputCacheRead: 10600, inputCacheCreation: 0 },
          finishReason: 'end_turn',
          time: at + 700,
        },
      },
      { event: { type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 787, time: at + 800 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 4800,
            usage: { total: { inputOther: 5400, output: 122, inputCacheRead: 20400, inputCacheCreation: 0 } },
          },
          time: at + 810,
        },
      },
    ];
    expectScenarios('subagent', [
      {
        sectionLabel: 'A · 前台（主通道）',
        steps: [
          ...startSteps('起个 reviewer 子代理独立审查，', '前台等它出结果。', '我起一个审查子代理，前台等它：'),
          {
            event: {
              type: 'tool.call.started',
              turnId: 0,
              toolCallId: 'call_01',
              name: 'Agent',
              args: spawnArgs,
              agentRefs: reviewRefs,
              time: B + 1500,
            },
          },
          {
            event: {
              type: 'tool.result',
              turnId: 0,
              toolCallId: 'call_01',
              output: { report: '审查通过：可选链修复正确，无回归风险。' },
              time: B + 4000,
            },
          },
          {
            event: {
              type: 'turn.step.completed',
              turnId: 0,
              step: 1,
              usage: { inputOther: 2900, output: 72, inputCacheRead: 11000, inputCacheCreation: 0 },
              finishReason: 'tool_use',
              time: B + 4100,
            },
          },
          { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 4150 } },
          {
            event: {
              type: 'assistant.delta',
              turnId: 0,
              delta: '子代理审查通过：修复正确，无回归风险，可以放心提交。',
              time: B + 4500,
            },
          },
          {
            event: {
              type: 'turn.step.completed',
              turnId: 0,
              step: 2,
              usage: { inputOther: 3100, output: 80, inputCacheRead: 11800, inputCacheCreation: 0 },
              finishReason: 'end_turn',
              time: B + 4800,
            },
          },
          { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 4883, time: B + 4900 } },
          {
            facts: {
              activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
              agentActivity: { lifecycle: 'ready' },
              status: {
                contextTokens: 6200,
                usage: { total: { inputOther: 6000, output: 152, inputCacheRead: 22800, inputCacheCreation: 0 } },
              },
              time: B + 4920,
            },
          },
        ],
      },
      {
        sectionLabel: 'B · 后台（主通道）',
        steps: [
          ...startSteps('起个后台子代理，', '结果回来再汇总。', '我起一个后台审查子代理：'),
          {
            event: {
              type: 'tool.call.started',
              turnId: 0,
              toolCallId: 'call_01',
              name: 'Agent',
              args: { ...spawnArgs, run_in_background: true },
              agentRefs: reviewRefs,
              time: B + 1500,
            },
          },
          { event: { type: 'tool.result', turnId: 0, toolCallId: 'call_01', output: { task_id: 'task_01' }, time: B + 1600 } },
          {
            event: {
              type: 'task.started',
              info: {
                taskId: 'task_01',
                kind: 'agent',
                status: 'running',
                description: '审查 LoginView 的白屏修复',
                detached: true,
                childAgentId: 'review_01',
              },
              time: B + 1610,
            },
          },
          { event: { type: 'assistant.delta', turnId: 0, delta: '子代理在后台审查，完成后我汇总。', time: B + 2000 } },
          {
            event: {
              type: 'turn.step.completed',
              turnId: 0,
              step: 1,
              usage: { inputOther: 2600, output: 64, inputCacheRead: 9800, inputCacheCreation: 0 },
              finishReason: 'end_turn',
              time: B + 2300,
            },
          },
          { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 2383, time: B + 2400 } },
          {
            facts: {
              activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
              agentActivity: { lifecycle: 'ready' },
              status: {
                contextTokens: 4500,
                usage: { total: { inputOther: 2600, output: 64, inputCacheRead: 9800, inputCacheCreation: 0 } },
              },
              time: B + 2420,
            },
          },
          {
            event: {
              type: 'shell.output',
              taskId: 'task_01',
              update: { kind: 'stdout', text: '…正在读 LoginView 的改动…' },
              time: B + 3500,
            },
          },
          ...collectSteps(B + 4100),
        ],
      },
      {
        sectionLabel: 'C · 前台转后台（主通道）',
        steps: [
          ...startSteps('先前台跑着，', '不行再转后台。', '我起一个审查子代理：'),
          {
            event: {
              type: 'tool.call.started',
              turnId: 0,
              toolCallId: 'call_01',
              name: 'Agent',
              args: spawnArgs,
              agentRefs: reviewRefs,
              time: B + 1500,
            },
          },
          {
            event: {
              type: 'task.started',
              info: {
                taskId: 'task_01',
                kind: 'agent',
                status: 'running',
                description: '审查 LoginView 的白屏修复',
                detached: true,
                childAgentId: 'review_01',
                outputTail: '…正在读 LoginView 的改动…',
              },
              time: B + 3500,
            },
          },
          {
            event: {
              type: 'tool.result',
              turnId: 0,
              toolCallId: 'call_01',
              output: { detached: true, task_id: 'task_01' },
              time: B + 3510,
            },
          },
          { event: { type: 'assistant.delta', turnId: 0, delta: '子代理转后台了，完成后我汇总。', time: B + 3800 } },
          {
            event: {
              type: 'turn.step.completed',
              turnId: 0,
              step: 1,
              usage: { inputOther: 2600, output: 64, inputCacheRead: 9800, inputCacheCreation: 0 },
              finishReason: 'end_turn',
              time: B + 4100,
            },
          },
          { event: { type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 4183, time: B + 4200 } },
          {
            facts: {
              activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
              agentActivity: { lifecycle: 'ready' },
              status: {
                contextTokens: 4500,
                usage: { total: { inputOther: 2600, output: 64, inputCacheRead: 9800, inputCacheCreation: 0 } },
              },
              time: B + 4220,
            },
          },
          {
            event: {
              type: 'shell.output',
              taskId: 'task_01',
              update: { kind: 'stdout', text: '…正在读 LoginView 的改动…' },
              time: B + 5300,
            },
          },
          ...collectSteps(B + 5900),
        ],
      },
      {
        sectionLabel: '子代理通道（按需订阅）',
        steps: [
          { event: { type: 'turn.started', agentId: 'review_01', turnId: 0, origin: { kind: 'task', taskId: 'task_01' }, time: B + 1600 } },
          { event: { type: 'turn.step.started', agentId: 'review_01', turnId: 0, step: 1, time: B + 1620 } },
          { event: { type: 'thinking.delta', agentId: 'review_01', turnId: 0, delta: '先读 LoginView 的改动，', time: B + 2000 } },
          { event: { type: 'thinking.delta', agentId: 'review_01', turnId: 0, delta: '重点看 token 处理。', time: B + 2200 } },
          { event: { type: 'assistant.delta', agentId: 'review_01', turnId: 0, delta: '我先读 LoginView 的改动。', time: B + 2800 } },
          {
            event: {
              type: 'tool.call.started',
              agentId: 'review_01',
              turnId: 0,
              toolCallId: 'call_02',
              name: 'Read',
              args: { path: 'apps/web/src/views/LoginView.vue' },
              time: B + 3200,
            },
          },
          {
            event: {
              type: 'tool.result',
              agentId: 'review_01',
              turnId: 0,
              toolCallId: 'call_02',
              output: { content: '<template>…</template>', lines: 214 },
              time: B + 3800,
            },
          },
          {
            event: {
              type: 'subagent.completed',
              agentId: 'review_01',
              subagentId: 'review_01',
              resultSummary: '审查通过：可选链修复正确，无回归风险。',
              time: B + 4500,
            },
          },
          {
            event: {
              type: 'turn.step.completed',
              agentId: 'review_01',
              turnId: 0,
              step: 1,
              usage: { inputOther: 2200, output: 64, inputCacheRead: 8000, inputCacheCreation: 0 },
              finishReason: 'end_turn',
              time: B + 4500,
            },
          },
          { event: { type: 'turn.ended', agentId: 'review_01', turnId: 0, reason: 'completed', durationMs: 2997, time: B + 4600 } },
        ],
      },
    ]);
  });
});

interface ColdRec {
  type: string;
  time?: number;
  [key: string]: unknown;
}

function rec(type: string, fields: Record<string, unknown>, time: number): ColdRec {
  return { type, ...fields, time };
}

function loop(event: Record<string, unknown>, time: number): ColdRec {
  return { type: 'context.append_loop_event', event, time };
}

function begin(uuid: string, turn: number, step: number, time: number): ColdRec {
  return loop({ type: 'step.begin', uuid, turnId: String(turn), step }, time);
}

function end(uuid: string, finishReason: string, usage: unknown, time: number): ColdRec {
  return loop({ type: 'step.end', uuid, finishReason, usage }, time);
}

function fail(uuid: string, time: number): ColdRec {
  return loop({ type: 'step.end', uuid, finishReason: 'error' }, time);
}

function think(uuid: string, text: string, time: number): ColdRec {
  return loop({ type: 'content.part', stepUuid: uuid, part: { type: 'think', think: text } }, time);
}

function say(uuid: string, text: string, time: number): ColdRec {
  return loop({ type: 'content.part', stepUuid: uuid, part: { type: 'text', text } }, time);
}

function call(uuid: string, toolCallId: string, name: string, args: unknown, time: number): ColdRec {
  return loop({ type: 'tool.call', stepUuid: uuid, toolCallId, name, args }, time);
}

function result(toolCallId: string, output: unknown, time: number, isError?: boolean): ColdRec {
  return loop({ type: 'tool.result', toolCallId, result: { output, isError } }, time);
}

function usageOf(inputOther: number, output: number, inputCacheRead = 0): Record<string, number> {
  return { inputOther, output, inputCacheRead, inputCacheCreation: 0 };
}

function promptAccepted(promptId: string, createdAt: string, time: number): ColdRec {
  return rec('prompt.accepted', { promptId, createdAt }, time);
}

const USER_ORIGIN = { kind: 'user' } as const;

function turnPrompt(promptId: string, text: string, time: number, origin: unknown = USER_ORIGIN): ColdRec {
  return rec('turn.prompt', { input: [{ type: 'text', text }], origin, promptId }, time);
}

function promptCompleted(promptId: string, finishedAt: string, time: number): ColdRec {
  return rec('prompt.completed', { promptId, finishedAt, reason: 'completed' }, time);
}

function queryFromRequest(request: string): { beforeTurn?: string; afterStep?: string; pageSize?: number } {
  const url = new URL(request, 'http://localhost');
  const query: { beforeTurn?: string; afterStep?: string; pageSize?: number } = {};
  const beforeTurn = url.searchParams.get('before_turn');
  const afterStep = url.searchParams.get('after_step');
  const pageSize = url.searchParams.get('page_size');
  if (beforeTurn) query.beforeTurn = beforeTurn;
  if (afterStep) query.afterStep = afterStep;
  if (pageSize) query.pageSize = Number(pageSize);
  return query;
}

function expectRestHistory(tabId: string, sectionLabel: string, records: ColdRec[]): void {
  const tab = FIXTURES.tabs.find((t) => t.id === tabId);
  if (!tab) throw new Error(`tab ${tabId} not found`);
  const section = tab.sections.find((s) => s.label === sectionLabel) as
    | (FixtureTab['sections'][number] & { request?: string })
    | undefined;
  if (!section?.request) throw new Error(`REST section ${sectionLabel} not found in ${tabId}`);
  const responses = section.items.map((it) => JSON.parse(it.json) as Record<string, unknown>);
  const sessionId = (responses[0] as { session_id?: string }).session_id ?? 's_01';
  const page = buildColdHistory(sessionId, 'main', records, queryFromRequest(section.request));
  for (const msg of page.items) parseServerMessage(msg);
  expect(page).toEqual(responses[0]);
  const secondNote = section.items[1]?.note;
  if (responses[1] !== undefined && secondNote) {
    const match = /GET\s+(\/\S+)/.exec(secondNote);
    if (!match) throw new Error(`no request line in note of ${tabId}/${sectionLabel}#1`);
    const page2 = buildColdHistory(sessionId, 'main', records, queryFromRequest(match[1]!));
    for (const msg of page2.items) parseServerMessage(msg);
    expect(page2).toEqual(responses[1]);
  }
}

describe('v2Projection × REST 历史冷重建', () => {
  it('basic REST 历史', () => {
    const B = Date.parse('2026-09-03T10:00:00.000Z');
    expectRestHistory('basic', 'REST 历史', [
      promptAccepted('p_01', '2026-09-03T10:00:00.000Z', B + 10),
      turnPrompt('p_01', '你好', B + 12),
      begin('s1', 0, 1, B + 20),
      think('s1', '用户在打招呼，', B + 450),
      think('s1', '简短回应即可。', B + 700),
      say('s1', '你好！', B + 1050),
      say('s1', '有什么可以帮你的？', B + 1300),
      end('s1', 'end_turn', usageOf(1820, 24), B + 1395),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 1483 }, B + 1495),
      promptCompleted('p_01', '2026-09-03T10:00:01.500Z', B + 1500),
    ]);
  });

  it('tool REST 历史', () => {
    const B = Date.parse('2026-09-03T11:00:00.000Z');
    expectRestHistory('tool', 'REST 历史', [
      promptAccepted('p_01', '2026-09-03T11:00:00.000Z', B + 10),
      turnPrompt('p_01', '执行一下 ls', B + 12),
      begin('s1', 0, 1, B + 20),
      think('s1', '用户想看当前目录内容，用 Bash 执行 ls。', B + 600),
      say('s1', '好的，执行 `ls`：', B + 800),
      call('s1', 'call_01', 'Bash', { command: 'ls' }, B + 1150),
      result('call_01', { stdout: 'apps\ndocs\npackages\npnpm-workspace.yaml\n', exit_code: 0 }, B + 1600),
      end('s1', 'tool_use', usageOf(2100, 96), B + 1695),
      begin('s2', 0, 2, B + 1895),
      say('s2', '当前目录下有 4 个条目：', B + 2250),
      say('s2', '`apps`、`docs`、`packages` 和 `pnpm-workspace.yaml`。', B + 2500),
      end('s2', 'end_turn', usageOf(2240, 58), B + 2595),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 2683 }, B + 2695),
      promptCompleted('p_01', '2026-09-03T11:00:02.700Z', B + 2700),
    ]);
  });

  it('multi-tool REST 历史', () => {
    const B = Date.parse('2026-09-03T12:00:00.000Z');
    expectRestHistory('multi-tool', 'REST 历史', [
      promptAccepted('p_01', '2026-09-03T12:00:00.000Z', B + 10),
      turnPrompt('p_01', '写一个 hello.py 打印当前时间，加个 shebang，然后跑一下', B + 12),
      begin('s1', 0, 1, B + 20),
      think('s1', '先 Write 创建脚本，再 Edit 加 shebang，最后 Bash 运行。', B + 600),
      say('s1', '我来创建 `hello.py`：', B + 800),
      call('s1', 'call_01', 'Write', { path: 'hello.py', content: 'from datetime import datetime\nprint(datetime.now())\n' }, B + 1100),
      result('call_01', { bytes_written: 52 }, B + 1400),
      end('s1', 'tool_use', usageOf(2400, 130), B + 1495),
      begin('s2', 0, 2, B + 1695),
      say('s2', '补上 shebang：', B + 2000),
      call('s2', 'call_02', 'Edit', { path: 'hello.py', old: 'from datetime import datetime', new: '#!/usr/bin/env python3\nfrom datetime import datetime' }, B + 2200),
      result('call_02', { applied: true }, B + 2400),
      end('s2', 'tool_use', usageOf(2580, 74), B + 2495),
      begin('s3', 0, 3, B + 2695),
      say('s3', '跑一下验证：', B + 2900),
      call('s3', 'call_03', 'Bash', { command: 'python3 hello.py' }, B + 3100),
      result('call_03', { stdout: '2026-09-03 12:00:03.587201\n', exit_code: 0 }, B + 3600),
      end('s3', 'tool_use', usageOf(2720, 66), B + 3695),
      begin('s4', 0, 4, B + 3895),
      say('s4', '完成。`hello.py` 已创建并加上 shebang，', B + 4100),
      say('s4', '运行输出当前时间，一切正常。', B + 4200),
      end('s4', 'end_turn', usageOf(2830, 62), B + 4295),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 4383 }, B + 4395),
      promptCompleted('p_01', '2026-09-03T12:00:04.400Z', B + 4400),
    ]);
  });

  it('todo REST 历史', () => {
    const B = Date.parse('2026-09-03T12:00:00.000Z');
    const todos1 = [
      { title: '查看登录页代码，定位白屏原因', status: 'in_progress' },
      { title: '修复崩溃', status: 'pending' },
      { title: '跑测试验证', status: 'pending' },
    ];
    const todos2 = [
      { title: '查看登录页代码，定位白屏原因', status: 'done' },
      { title: '修复崩溃', status: 'in_progress' },
      { title: '跑测试验证', status: 'pending' },
    ];
    const todos3 = [
      { title: '查看登录页代码，定位白屏原因', status: 'done' },
      { title: '修复崩溃', status: 'done' },
      { title: '跑测试验证', status: 'in_progress' },
    ];
    const todos4 = [
      { title: '查看登录页代码，定位白屏原因', status: 'done' },
      { title: '修复崩溃', status: 'done' },
      { title: '跑测试验证', status: 'done' },
    ];
    expectRestHistory('todo', 'REST 历史', [
      promptAccepted('p_01', '2026-09-03T12:00:00.000Z', B + 10),
      turnPrompt('p_01', '登录页点登录直接白屏，修一下', B + 12),
      begin('s1', 0, 1, B + 20),
      think('s1', '白屏一般是运行时错误。分三步：', B + 450),
      think('s1', '定位、修复、验证。', B + 700),
      say('s1', '我分三步处理：', B + 1200),
      call('s1', 'call_01', 'TodoWrite', { items: todos1 }, B + 1300),
      result('call_01', { updated: true }, B + 1350),
      call('s1', 'call_02', 'Read', { path: 'apps/web/src/views/LoginView.vue' }, B + 1500),
      result('call_02', { content: '<template>…（文件内容）…</template>', lines: 214 }, B + 2200),
      call('s1', 'call_03', 'TodoWrite', { items: todos2 }, B + 2300),
      result('call_03', { updated: true }, B + 2350),
      call('s1', 'call_04', 'Edit', { path: 'apps/web/src/views/LoginView.vue', old: 'const token = user.token;', new: 'const token = user?.token;' }, B + 2500),
      result('call_04', { applied: true }, B + 3000),
      end('s1', 'tool_use', usageOf(2900, 78, 10000), B + 3095),
      begin('s2', 0, 2, B + 3145),
      call('s2', 'call_05', 'TodoWrite', { items: todos3 }, B + 3300),
      result('call_05', { updated: true }, B + 3350),
      call('s2', 'call_06', 'Bash', { command: 'pnpm test -- login' }, B + 3500),
      result('call_06', { stdout: 'Test Files  1 passed (1)\n     Tests  6 passed (6)\n', exit_code: 0 }, B + 5500),
      call('s2', 'call_07', 'TodoWrite', { items: todos4 }, B + 5600),
      result('call_07', { updated: true }, B + 5650),
      say('s2', '修好了：`handleLogin` 在 `user` 为空时直接读 `token` 导致白屏，', B + 6000),
      say('s2', '已加可选链判空；登录相关 6 个测试全部通过。', B + 6500),
      end('s2', 'end_turn', usageOf(2600, 84, 9500), B + 6595),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 6683 }, B + 6695),
      promptCompleted('p_01', '2026-09-03T12:00:06.695Z', B + 6695),
    ]);
  });

  it('queue-abort REST 历史', () => {
    const B = Date.parse('2026-09-03T11:00:00.000Z');
    expectRestHistory('queue-abort', 'REST 历史', [
      promptAccepted('p_01', '2026-09-03T11:00:00.000Z', B + 10),
      turnPrompt('p_01', '跑一下测试套件', B + 12),
      begin('s1', 0, 1, B + 20),
      think('s1', '测试命令免审批，直接跑。', B + 700),
      say('s1', '我来跑测试：', B + 1200),
      call('s1', 'call_01', 'Bash', { command: 'pnpm test' }, B + 1500),
      result('call_01', { stdout: 'Test Files  1 failed | 3 passed (4)\n     Tests  2 failed | 18 passed (20)\n', exit_code: 1 }, B + 6000),
      end('s1', 'tool_use', usageOf(2600, 60, 9000), B + 6095),
      begin('s2', 0, 2, B + 6145),
      say('s2', '测试跑完了：18 通过、2 失败。', B + 6700),
      end('s2', 'end_turn', usageOf(2800, 40, 11000), B + 6795),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 6883 }, B + 6895),
      promptCompleted('p_01', '2026-09-03T11:00:06.895Z', B + 6895),
      promptAccepted('p_02', '2026-09-03T11:00:04.000Z', B + 4010),
      turnPrompt('p_02', '把失败的用例列出来', B + 6928),
      begin('s3', 1, 1, B + 6948),
      think('s3', '从刚才的输出里挑失败用例即可，', B + 7250),
      think('s3', '不用重跑。', B + 7550),
      say('s3', '失败的两个用例都在 `auth` 目录下：', B + 7900),
      say('s3', '`login.spec.ts` 的「过期 token 应跳转登录页」、', B + 8600),
      rec('turn.step.interrupted', { turnId: 1, step: 1, reason: 'aborted by user' }, B + 8605),
      rec('turn.ended', { turnId: 1, reason: 'cancelled' }, B + 8615),
      promptCompleted('p_02', '2026-09-03T11:00:08.615Z', B + 8615),
      rec('prompt.aborted', { promptId: 'p_02', abortedAt: '2026-09-03T11:00:08.640Z' }, B + 8640),
    ]);
  });

  it('question REST 历史', () => {
    const B = Date.parse('2026-09-03T14:00:00.000Z');
    expectRestHistory('question', 'REST 历史', [
      promptAccepted('p_01', '2026-09-03T14:00:00.000Z', B + 10),
      turnPrompt('p_01', '把 README 的安装命令更新成 pnpm', B + 12),
      begin('s1', 0, 1, B + 20),
      think('s1', '安装命令在快速开始和开发者文档各有一处。', B + 450),
      think('s1', '范围不明，先问用户。', B + 700),
      say('s1', 'README 里有两处安装命令，先确认范围：', B + 1200),
      rec('interaction.request', {
        id: 'q_01',
        kind: 'question',
        request: {
          questions: [
            { id: 'q1', question: 'README 里有两处安装命令（快速开始、开发者文档），要都更新吗？', options: ['两处都改', '只改快速开始'] },
          ],
        },
      }, B + 1500),
      rec('interaction.resolved', { id: 'q_01', response: { answers: { q1: '两处都改' } } }, B + 5100),
      call('s1', 'call_01', 'Edit', { path: 'README.md', old: 'npm install && npm run dev', new: 'pnpm install && pnpm dev' }, B + 5300),
      result('call_01', { applied: true }, B + 5800),
      end('s1', 'tool_use', usageOf(2300, 48, 7600), B + 5895),
      begin('s2', 0, 2, B + 5945),
      call('s2', 'call_02', 'Edit', { path: 'README.md', old: 'npm run build && npm start', new: 'pnpm build && pnpm start' }, B + 6100),
      result('call_02', { applied: true }, B + 6500),
      say('s2', '两处都改好了：快速开始和开发者文档的安装命令已更新为 `pnpm` 版。', B + 7100),
      end('s2', 'end_turn', usageOf(2500, 62, 8800), B + 7195),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 7283 }, B + 7295),
      promptCompleted('p_01', '2026-09-03T14:00:07.295Z', B + 7295),
    ]);
  });

  it('tool-error REST 历史', () => {
    const B = Date.parse('2026-09-03T15:00:00.000Z');
    expectRestHistory('tool-error', 'REST 历史', [
      promptAccepted('p_01', '2026-09-03T15:00:00.000Z', B + 10),
      turnPrompt('p_01', '把配置里的超时时间改成 30 秒', B + 12),
      begin('s1', 0, 1, B + 20),
      think('s1', '超时配置在 config/server.toml，直接 Edit。', B + 700),
      say('s1', '我来改超时配置：', B + 1200),
      call('s1', 'call_01', 'Edit', { path: 'config/server.toml', old: 'timeout = 10', new: 'timeout = 30' }, B + 1500),
      result('call_01', 'old_string 在文件中未找到', B + 1900, true),
      end('s1', 'tool_use', usageOf(2300, 46, 7200), B + 1995),
      begin('s2', 0, 2, B + 2045),
      say('s2', '没匹配上，我先看下文件实际内容：', B + 2600),
      call('s2', 'call_02', 'Read', { path: 'config/server.toml' }, B + 2800),
      result('call_02', { content: '[server]\nrequest_timeout = 10\n…', lines: 18 }, B + 3200),
      call('s2', 'call_03', 'Edit', { path: 'config/server.toml', old: 'request_timeout = 10', new: 'request_timeout = 30' }, B + 3400),
      result('call_03', { applied: true }, B + 3800),
      say('s2', '改好了：超时配置项是 `request_timeout`（不是 `timeout`），已从 10 改为 30。', B + 4400),
      end('s2', 'end_turn', usageOf(2800, 82, 10400), B + 4495),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 4583 }, B + 4595),
      promptCompleted('p_01', '2026-09-03T15:00:04.595Z', B + 4595),
    ]);
  });

  it('llm-retry REST 历史', () => {
    const B = Date.parse('2026-09-03T15:30:00.000Z');
    expectRestHistory('llm-retry', 'REST 历史', [
      promptAccepted('p_01', '2026-09-03T15:30:00.000Z', B + 10),
      turnPrompt('p_01', '总结一下这个项目的目录结构', B + 12),
      begin('s1', 0, 1, B + 20),
      fail('s1', B + 500),
      begin('s2', 0, 1, B + 2950),
      think('s2', '先列顶层目录，', B + 2950),
      think('s2', '再按功能分组说明。', B + 3300),
      say('s2', '项目分四块：`apps/` 三个端（desktop、web、auth-login）、', B + 3700),
      say('s2', '`packages/` 八个共享包、`scripts/` 构建发布脚本、`docs/` 设计文档。', B + 4100),
      end('s2', 'end_turn', usageOf(2400, 62, 8600), B + 4195),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 4283 }, B + 4295),
      promptCompleted('p_01', '2026-09-03T15:30:04.295Z', B + 4295),
    ]);
  });

  it('background-task REST 历史', () => {
    const B = Date.parse('2026-09-03T16:00:00.000Z');
    expectRestHistory('background-task', 'REST 历史', [
      promptAccepted('p_01', '2026-09-03T16:00:00.000Z', B + 10),
      turnPrompt('p_01', '跑一下完整构建', B + 12),
      begin('s1', 0, 1, B + 20),
      think('s1', '完整构建要几分钟，先跑起来，太久就转后台。', B + 700),
      say('s1', '我来跑完整构建：', B + 1200),
      call('s1', 'call_01', 'Bash', { command: 'pnpm build' }, B + 1500),
      rec('task.started', { info: { taskId: 'task_01', kind: 'shell', status: 'running', description: 'pnpm build', detached: true } }, B + 1500),
      result('call_01', { detached: true, task_id: 'task_01' }, B + 4010),
      end('s1', 'tool_use', usageOf(2500, 58, 9200), B + 4095),
      begin('s2', 0, 2, B + 4145),
      say('s2', '构建量比较大，已转后台跑（task_01），完成后我告诉你。', B + 4700),
      end('s2', 'end_turn', usageOf(2700, 66, 10100), B + 4795),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 4883 }, B + 4895),
      promptCompleted('p_01', '2026-09-03T16:00:04.895Z', B + 4895),
      rec('task.terminated', {
        info: { taskId: 'task_01', kind: 'shell', status: 'completed', description: 'pnpm build', resultSummary: '构建成功：8 个包全部编译通过', endedAt: '2026-09-03T16:07:58.495Z' },
        outputTail: '… build finished successfully in 7m 56s …',
      }, B + 478500),
      rec('turn.prompt', {
        input: [{ type: 'text', text: '<notification id="task:task_01:completed" category="task" type="task.completed" source_kind="background_task" source_id="task_01">\nTitle: 后台构建完成\nSeverity: info\n构建成功：8 个包全部编译通过\n</notification>' }],
        origin: { kind: 'task', taskId: 'task_01' },
        promptId: 'p_02',
      }, B + 478598),
      begin('s3', 1, 1, B + 478618),
      say('s3', '构建完成了：8 个包全部编译通过，产物在各自的 `dist/`。', B + 479200),
      end('s3', 'end_turn', usageOf(2900, 44, 12000), B + 479295),
      rec('turn.ended', { turnId: 1, reason: 'completed', durationMs: 797 }, B + 479395),
    ]);
  });

  it('compaction REST 历史', () => {
    const B = Date.parse('2026-09-03T16:30:00.000Z');
    const records: ColdRec[] = [];
    for (let i = 0; i < 8; i++) {
      records.push(
        rec('turn.prompt', { input: [{ type: 'text', text: `第 ${i + 1} 轮讨论` }], origin: { kind: 'user' }, promptId: `old_${i}` }, B - 20000 + i * 1000),
        rec('turn.ended', { turnId: i, reason: 'completed', durationMs: 900 }, B - 19500 + i * 1000),
      );
    }
    records.push(
      promptAccepted('p_01', '2026-09-03T16:30:00.000Z', B + 10),
      turnPrompt('p_01', '接着上面的讨论，把新页面的路由也加上', B + 12),
      rec('context.apply_compaction', { summary: '前 8 轮讨论摘要', compactedCount: 40, tokensBefore: 241000, tokensAfter: 62000 }, B + 100),
      begin('s1', 8, 1, B + 118),
      think('s1', '路由集中在 router 配置文件，加一条即可。', B + 800),
      say('s1', '我来加路由：', B + 1300),
      call('s1', 'call_01', 'Edit', {
        path: 'apps/web/src/router.ts',
        old: "  { path: '/login', component: LoginView },",
        new: "  { path: '/login', component: LoginView },\n  { path: '/new-page', component: NewPageView },",
      }, B + 1500),
      result('call_01', { applied: true }, B + 1900),
      say('s1', '加好了：`/new-page` 路由已注册到 `router.ts`。', B + 2500),
      end('s1', 'end_turn', usageOf(3100, 72, 9600), B + 2595),
      rec('turn.ended', { turnId: 8, reason: 'completed', durationMs: 2683 }, B + 2695),
      promptCompleted('p_01', '2026-09-03T16:30:02.695Z', B + 2695),
    );
    expectRestHistory('compaction', 'REST 历史', records);
  });

  it('undo REST 历史', () => {
    const B = Date.parse('2026-09-03T18:10:00.000Z');
    expectRestHistory('undo', 'REST 历史', [
      promptAccepted('p_01', '2026-09-03T18:10:00.000Z', B + 10),
      turnPrompt('p_01', '把配置里的超时改成 30 秒', B + 12),
      begin('s1', 0, 1, B + 20),
      think('s1', '超时配置在 config/server.toml，直接 Edit。', B + 700),
      say('s1', '我来改超时配置：', B + 1200),
      call('s1', 'call_01', 'Edit', { path: 'config/server.toml', old: 'request_timeout = 10', new: 'request_timeout = 30' }, B + 1500),
      result('call_01', { applied: true }, B + 1800),
      say('s1', '改好了：`request_timeout` 已从 10 改为 30。', B + 4400),
      end('s1', 'end_turn', usageOf(5100, 128, 17600), B + 4495),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 4583 }, B + 4595),
      promptCompleted('p_01', '2026-09-03T18:10:04.595Z', B + 4595),
      rec('context.undo', { count: 1 }, B + 4990),
      rec('context.undone', { turns: 1, fromTurnId: 0 }, B + 5000),
    ]);
  });

  it('approval REST 历史（A）', () => {
    const B = Date.parse('2026-09-03T10:00:00.000Z');
    expectRestHistory('approval', 'REST 历史（A）', [
      promptAccepted('p_01', '2026-09-03T10:00:00.000Z', B + 10),
      turnPrompt('p_01', '把登录页崩溃的复现脚本跑一下', B + 12),
      begin('s1', 0, 1, B + 20),
      think('s1', '复现脚本在 `scripts/` 下，node 执行需要审批。', B + 700),
      say('s1', '我来跑一下复现脚本：', B + 1200),
      call('s1', 'call_01', 'Bash', { command: 'node scripts/repro-login-crash.mjs' }, B + 1500),
      rec('interaction.request', {
        id: 'ap_01',
        kind: 'approval',
        toolCallId: 'call_01',
        request: { tool_name: 'Bash', input: { command: 'node scripts/repro-login-crash.mjs' }, reason: '运行脚本需要执行权限' },
      }, B + 1510),
      rec('interaction.resolved', { id: 'ap_01', response: { decision: 'approved' } }, B + 5100),
      result('call_01', { stdout: "TypeError: Cannot read properties of undefined (reading 'token')\n    at handleLogin (LoginView.vue:87)\n", exit_code: 1 }, B + 6200),
      end('s1', 'tool_use', usageOf(2400, 52, 8000), B + 6295),
      begin('s2', 0, 2, B + 6345),
      say('s2', '复现成功，报错和浏览器里看到的一致：`handleLogin` 读取了 undefined 的 `token` 字段（`LoginView.vue:87`）。', B + 7100),
      end('s2', 'end_turn', usageOf(3100, 88, 12800), B + 7195),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 7283 }, B + 7295),
      promptCompleted('p_01', '2026-09-03T10:00:07.295Z', B + 7295),
    ]);
  });

  it('recovery REST 历史与补尾巴', () => {
    const T1 = Date.parse('2026-09-03T10:30:00.000Z');
    const T2 = Date.parse('2026-09-03T11:00:00.000Z');
    const records: ColdRec[] = [
      promptAccepted('p_01', '2026-09-03T10:30:00.000Z', T1 + 10),
      turnPrompt('p_01', '这个 CLI 的入口文件是哪个？', T1 + 12),
      begin('s1', 0, 1, T1 + 20),
      think('s1', '入口是 src/cli.ts，顺带说明参数解析与子命令分发。', T1 + 800),
      say('s1', '入口是 `src/cli.ts`：全局参数在这里解析，再分发到 `build`、`dev`、`test` 三个子命令。', T1 + 1400),
      end('s1', 'end_turn', usageOf(2400, 58), T1 + 1495),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 1603 }, T1 + 1615),
      promptCompleted('p_01', '2026-09-03T10:30:01.615Z', T1 + 1615),
      promptAccepted('p_02', '2026-09-03T11:00:00.000Z', T2 + 10),
      turnPrompt('p_02', '我想给 CLI 加一个全局 `--verbose` 选项，加在哪里比较合适？', T2 + 12),
      begin('s2', 1, 1, T2 + 20),
      think('s2', '先读入口文件的参数解析部分，再给方案建议。', T2 + 700),
      say('s2', '我看一下 `src/cli.ts` 的参数解析实现：', T2 + 1200),
      call('s2', 'call_01', 'Read', { path: 'src/cli.ts' }, T2 + 1500),
      result('call_01', { content: '…（文件内容，含 parseArgs 实现）…', lines: 86 }, T2 + 1900),
      end('s2', 'tool_use', usageOf(2800, 64, 8000), T2 + 1995),
      begin('s3', 1, 2, T2 + 2050),
      say('s3', '建议加在 `parseArgs` 的全局区，', T2 + 2300),
    ];
    expectRestHistory('recovery', 'A · 刷新：REST 历史', records);
    expectRestHistory('recovery', 'B · 重连：REST 补尾巴', records);
  });

  it('history 路由：注册、响应包络、schema 校验与 404', async () => {
    const B = Date.parse('2026-09-03T10:00:00.000Z');
    const records: ColdRec[] = [
      promptAccepted('p_01', '2026-09-03T10:00:00.000Z', B + 10),
      turnPrompt('p_01', '你好', B + 12),
      begin('s1', 0, 1, B + 20),
      think('s1', '用户在打招呼，', B + 450),
      think('s1', '简短回应即可。', B + 700),
      say('s1', '你好！', B + 1050),
      say('s1', '有什么可以帮你的？', B + 1300),
      end('s1', 'end_turn', usageOf(1820, 24), B + 1395),
      rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 1483 }, B + 1495),
      promptCompleted('p_01', '2026-09-03T10:00:01.500Z', B + 1500),
    ];
    const captureHost = () => {
      const captured: { path?: string; handler?: (req: unknown, reply: unknown) => Promise<void> } = {};
      const app = {
        get(path: string, _options: unknown, handler: (req: unknown, reply: unknown) => Promise<void>) {
          captured.path = path;
          captured.handler = handler;
        },
      };
      return { app: app as Parameters<typeof registerHistoryRoutes>[0], captured };
    };
    const { app, captured } = captureHost();
    registerHistoryRoutes(app, { transcript: { readColdWireRecords: async () => records } });
    expect(captured.path).toBe('/sessions/:session_id/history');
    const handler = captured.handler!;
    const reply = { payload: undefined as unknown, send(p: unknown) { this.payload = p; return p; } };
    await handler({ id: 'req_01', params: { session_id: 's_01' }, query: { page_size: 50 } }, reply);
    const tab = FIXTURES.tabs.find((t) => t.id === 'basic')!;
    const restSection = tab.sections.find((s) => s.label === 'REST 历史')!;
    const expected = JSON.parse(restSection.items[0]!.json) as Record<string, unknown>;
    expect(reply.payload).toEqual({ code: 0, msg: 'success', data: expected, request_id: 'req_01' });
    expect(historyResponseSchema.parse((reply.payload as { data: unknown }).data)).toEqual(expected);

    const { app: app404, captured: captured404 } = captureHost();
    registerHistoryRoutes(app404, { transcript: { readColdWireRecords: async () => undefined } });
    const reply404 = { payload: undefined as unknown, send(p: unknown) { this.payload = p; return p; } };
    await captured404.handler!({ id: 'req_02', params: { session_id: 's_xx' }, query: {} }, reply404);
    expect(reply404.payload).toMatchObject({ code: 40401, data: null, request_id: 'req_02' });
  });
});

class FakeWsSocket {
  readonly sent: string[] = [];
  flush = true;
  closed = false;
  closeCalls: { code?: number; reason?: string }[] = [];
  private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args);
  }

  deliver(data: unknown): void {
    this.fire('message', data);
  }

  send(data: string, cb?: () => void): void {
    this.sent.push(data);
    if (this.flush && cb) queueMicrotask(cb);
  }

  ping(): void {}

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls.push({ code, reason });
    this.fire('close');
  }
}

type FakeBusEvent = { type: string } & Record<string, unknown>;

class FakeAgentBus {
  private readonly handlers: ((event: FakeBusEvent) => void)[] = [];

  subscribe(handler: (event: FakeBusEvent) => void): { dispose(): void } {
    this.handlers.push(handler);
    return {
      dispose: () => {
        const index = this.handlers.indexOf(handler);
        if (index >= 0) this.handlers.splice(index, 1);
      },
    };
  }

  emit(event: FakeBusEvent): void {
    for (const handler of [...this.handlers]) handler(event);
  }
}

interface FakeActivityState {
  busy: boolean;
  mainTurnActive: boolean;
  pendingInteraction: 'none' | 'approval' | 'question';
}

interface FakeActivitySource {
  state(): FakeActivityState;
  set(state: FakeActivityState, time?: number): void;
}

function makeFakeSession(sessionId: string, agentIds: string[]): {
  source: V2SessionSource;
  buses: Map<string, FakeAgentBus>;
  activity: FakeActivitySource;
} {
  const buses = new Map<string, FakeAgentBus>();
  for (const agentId of agentIds) buses.set(agentId, new FakeAgentBus());
  let activityState: FakeActivityState = { busy: false, mainTurnActive: false, pendingInteraction: 'none' };
  const activityListeners = new Set<(state: FakeActivityState, time?: number) => void>();
  const activity: FakeActivitySource = {
    state: () => activityState,
    set: (state, time) => {
      activityState = state;
      for (const listener of [...activityListeners]) listener(activityState, time);
    },
  };
  const source: V2SessionSource = {
    sessionId,
    agents: () =>
      agentIds.map((agentId) => ({
        agentId,
        bus: { subscribe: (handler: (event: FakeBusEvent) => void) => buses.get(agentId)!.subscribe(handler) },
        permissionMode: () => 'manual' as const,
      })),
    agentFor: (agentId) => {
      const bus = buses.get(agentId);
      if (!bus) return undefined;
      return {
        agentId,
        bus: { subscribe: (handler: (event: FakeBusEvent) => void) => bus.subscribe(handler) },
        permissionMode: () => 'manual' as const,
      };
    },
    activity: {
      state: () => activityState,
      onDidChange: (handler: (state: FakeActivityState, time?: number) => void) => {
        activityListeners.add(handler);
        return { dispose: () => activityListeners.delete(handler) };
      },
    },
  };
  return { source, buses, activity };
}

function stepper(start: number): () => number {
  let t = start;
  return () => (t += 1);
}

interface WsScenario {
  binding: SessionV2Binding;
  buses: Map<string, FakeAgentBus>;
  activity: FakeActivitySource;
  connect(opts?: { flush?: boolean; outboundCapacity?: number; inflightWindow?: number; globalFanout?: GlobalV2Fanout }): {
    socket: FakeWsSocket;
    frames: () => Record<string, unknown>[];
  };
}

function makeV2Scenario(opts: { sessionId: string; agentIds?: string[]; clock?: () => number }): WsScenario {
  const agentIds = opts.agentIds ?? ['main'];
  const { source, buses, activity } = makeFakeSession(opts.sessionId, agentIds);
  const binder = new SessionV2Binder(opts.clock ?? Date.now);
  const binding = binder.attach(source);
  const registry = new ConnectionRegistry();
  return {
    binding,
    buses,
    activity,
    connect: (connectOpts) => {
      const socket = new FakeWsSocket();
      if (connectOpts?.flush === false) socket.flush = false;
      const connection = new WsConnectionV2({
        socket: socket as never,
        binder,
        registry,
        serverId: 'srv_9f2c',
        sessionSourceFor: () => source,
        clock: opts.clock ?? Date.now,
        outboundCapacity: connectOpts?.outboundCapacity,
        inflightWindow: connectOpts?.inflightWindow,
        globalFanout: connectOpts?.globalFanout,
        heartbeatIntervalMs: 0,
      });
      void connection;
      return {
        socket,
        frames: () => socket.sent.map((line) => JSON.parse(line) as Record<string, unknown>),
      };
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fixtureSection(tabId: string, label: string): Record<string, unknown>[] {
  const tab = FIXTURES.tabs.find((t) => t.id === tabId);
  if (!tab) throw new Error(`tab ${tabId} not found`);
  const section = tab.sections.find((s) => s.label === label);
  if (!section) throw new Error(`section ${label} not found in ${tabId}`);
  return section.items.map((it) => JSON.parse(it.json) as Record<string, unknown>);
}

const HELLO_FRAME = { type: 'hello', protocol_version: 2, server_id: 'srv_9f2c', capabilities: ['step_replay_v1', 'interaction_v1'] };

describe('WS v2 传输层', () => {
  it('recovery A：刷新恢复与直播', async () => {
    const T2 = Date.parse('2026-09-03T11:00:00.000Z');
    const clock = stepper(T2 + 3627);
    const scenario = makeV2Scenario({ sessionId: 's_04', clock });
    const { buses, activity } = scenario;
    const { socket, frames } = scenario.connect();
    const drive = (event: FakeBusEvent) => buses.get('main')!.emit(event);
    activity.set({ busy: true, mainTurnActive: true, pendingInteraction: 'none' });
    drive({ type: 'prompt.submitted', promptId: 'p_02', status: 'running', turnId: 1, content: [{ type: 'text', text: '我想给 CLI 加一个全局 `--verbose` 选项，加在哪里比较合适？' }], createdAt: '2026-09-03T11:00:00.000Z', time: T2 + 10 });
    drive({ type: 'turn.started', turnId: 1, promptId: 'p_02', origin: { kind: 'user' }, time: T2 + 15 });
    drive({ type: 'turn.step.started', turnId: 1, step: 1, time: T2 + 22 });
    drive({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_01', name: 'Read', args: { path: 'src/cli.ts' }, time: T2 + 1500 });
    drive({ type: 'tool.result', turnId: 1, toolCallId: 'call_01', output: { content: '…（文件内容，含 parseArgs 实现）…', lines: 86 }, time: T2 + 1900 });
    drive({ type: 'turn.step.completed', turnId: 1, step: 1, usage: { inputOther: 2800, output: 64, inputCacheRead: 8000, inputCacheCreation: 0 }, finishReason: 'tool_use', time: T2 + 2000 });
    drive({ type: 'turn.step.started', turnId: 1, step: 2, time: T2 + 2050 });
    drive({ type: 'assistant.delta', turnId: 1, delta: '建议加在入口的', time: T2 + 2400 });
    drive({ type: 'assistant.delta', turnId: 1, delta: '全局参数解析处：', time: T2 + 2700 });
    drive({ type: 'agent.activity.updated', lifecycle: 'ready', turn: { turnId: 1, step: 2, phase: 'running', since: 1788433200015 }, time: T2 + 2060 });
    drive({ type: 'agent.status.updated', model: 'kimi-k3-highspeed', contextTokens: 8100, maxContextTokens: 262144, usage: { currentTurn: { inputOther: 5700, output: 150, inputCacheRead: 20000, inputCacheCreation: 0 }, total: { inputOther: 8100, output: 208, inputCacheRead: 20000, inputCacheCreation: 0 } }, time: T2 + 2070 });
    await settle();
    socket.deliver(JSON.stringify({ type: 'subscribe', id: 1, session_id: 's_04' }));
    drive({ type: 'assistant.delta', turnId: 1, delta: '`src/cli.ts` 的 `parseArgs` 里注册 `--verbose` 全局选项，', time: T2 + 4100 });
    drive({ type: 'assistant.delta', turnId: 1, delta: '子命令自动继承；日志模块读到该标志后调到 debug 级别。', time: T2 + 4600 });
    drive({ type: 'turn.step.completed', turnId: 1, step: 2, usage: { inputOther: 3100, output: 96, inputCacheRead: 12800, inputCacheCreation: 0 }, finishReason: 'end_turn', time: T2 + 5100 });
    drive({ type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 5183, time: T2 + 5200 });
    drive({ type: 'agent.activity.updated', lifecycle: 'ready', time: T2 + 5220 });
    drive({ type: 'agent.status.updated', contextTokens: 8500, usage: { total: { inputOther: 8300, output: 218, inputCacheRead: 20800, inputCacheCreation: 0 } }, time: T2 + 5220 });
    activity.set({ busy: false, mainTurnActive: false, pendingInteraction: 'none' }, T2 + 5220);
    await settle();

    const got = frames();
    expect(got[0]).toEqual(HELLO_FRAME);
    const expected = fixtureSection('recovery', 'A · 刷新：WS 恢复与直播').slice(2);
    for (const frame of got.slice(1)) parseServerMessage(frame);
    expect(got.slice(1)).toEqual(expected);
  });

  it('recovery B：重连恢复与收官补发', async () => {
    const T2 = Date.parse('2026-09-03T11:00:00.000Z');
    const clock = stepper(T2 + 5607);
    const scenario = makeV2Scenario({ sessionId: 's_04', clock });
    const { buses, activity } = scenario;
    const { socket, frames } = scenario.connect();
    const drive = (event: FakeBusEvent) => buses.get('main')!.emit(event);
    activity.set({ busy: true, mainTurnActive: true, pendingInteraction: 'none' });
    drive({ type: 'prompt.submitted', promptId: 'p_02', status: 'running', turnId: 1, content: [{ type: 'text', text: '我想给 CLI 加一个全局 `--verbose` 选项，加在哪里比较合适？' }], createdAt: '2026-09-03T11:00:00.000Z', time: T2 + 10 });
    drive({ type: 'turn.started', turnId: 1, promptId: 'p_02', origin: { kind: 'user' }, time: T2 + 15 });
    drive({ type: 'turn.step.started', turnId: 1, step: 1, time: T2 + 22 });
    drive({ type: 'tool.call.started', turnId: 1, toolCallId: 'call_01', name: 'Read', args: { path: 'src/cli.ts' }, time: T2 + 1500 });
    drive({ type: 'tool.result', turnId: 1, toolCallId: 'call_01', output: { content: '…（文件内容，含 parseArgs 实现）…', lines: 86 }, time: T2 + 1900 });
    drive({ type: 'turn.step.completed', turnId: 1, step: 1, usage: { inputOther: 2800, output: 64, inputCacheRead: 8000, inputCacheCreation: 0 }, finishReason: 'tool_use', time: T2 + 2000 });
    drive({ type: 'turn.step.started', turnId: 1, step: 2, time: T2 + 2050 });
    drive({ type: 'assistant.delta', turnId: 1, delta: '建议加在入口的', time: T2 + 2400 });
    drive({ type: 'assistant.delta', turnId: 1, delta: '全局参数解析处：', time: T2 + 2700 });
    drive({ type: 'assistant.delta', turnId: 1, delta: '`src/cli.ts` 的 `parseArgs` 里注册 `--verbose` 全局选项，', time: T2 + 4100 });
    drive({ type: 'assistant.delta', turnId: 1, delta: '子命令自动继承；日志模块读到该标志后调到 debug 级别。', time: T2 + 4600 });
    drive({ type: 'agent.activity.updated', lifecycle: 'ready', turn: { turnId: 1, step: 2, phase: 'running', since: 1788433200015 }, time: T2 + 2060 });
    drive({ type: 'agent.status.updated', model: 'kimi-k3-highspeed', contextTokens: 8300, maxContextTokens: 262144, usage: { currentTurn: { inputOther: 5850, output: 156, inputCacheRead: 20600, inputCacheCreation: 0 }, total: { inputOther: 8250, output: 214, inputCacheRead: 20600, inputCacheCreation: 0 } }, time: T2 + 5600 });
    await settle();
    socket.deliver(JSON.stringify({ type: 'subscribe', id: 1, session_id: 's_04' }));
    drive({ type: 'turn.step.completed', turnId: 1, step: 2, usage: { inputOther: 3100, output: 96, inputCacheRead: 12800, inputCacheCreation: 0 }, finishReason: 'end_turn', endedAt: T2 + 5100, time: T2 + 6400 });
    drive({ type: 'turn.ended', turnId: 1, reason: 'completed', durationMs: 6483, endedAt: T2 + 5200, time: T2 + 6500 });
    drive({ type: 'agent.activity.updated', lifecycle: 'ready', time: T2 + 6520 });
    drive({ type: 'agent.status.updated', contextTokens: 8500, usage: { total: { inputOther: 8300, output: 218, inputCacheRead: 20800, inputCacheCreation: 0 } }, time: T2 + 6520 });
    activity.set({ busy: false, mainTurnActive: false, pendingInteraction: 'none' }, T2 + 6520);
    await settle();

    const got = frames();
    expect(got[0]).toEqual(HELLO_FRAME);
    const expected = fixtureSection('recovery', 'B · 重连：WS 恢复与直播').slice(2);
    for (const frame of got.slice(1)) parseServerMessage(frame);
    expect(got.slice(1)).toEqual(expected);
  });

  it('connection：omit 订阅屏蔽 delta 族', async () => {
    const B = Date.parse('2026-09-03T17:20:00.000Z');
    const scenario = makeV2Scenario({ sessionId: 's_15' });
    const { buses, activity } = scenario;
    const { socket, frames } = scenario.connect();
    const drive = (event: FakeBusEvent) => buses.get('main')!.emit(event);
    socket.deliver(JSON.stringify({ type: 'subscribe', id: 1, session_id: 's_15', omit: ['assistant.delta', 'thinking.delta', 'tool_call.delta'] }));
    drive({ type: 'prompt.submitted', promptId: 'p_01', status: 'running', content: [{ type: 'text', text: '今天天气怎么样' }], createdAt: '2026-09-03T17:20:00.000Z', time: B + 10 });
    drive({ type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 });
    activity.set({ busy: true, mainTurnActive: true, pendingInteraction: 'none' }, B + 20);
    drive({ type: 'agent.activity.updated', lifecycle: 'ready', turn: { turnId: 0, step: 1, phase: 'running', since: 1788456000015 }, time: B + 20 });
    drive({ type: 'agent.status.updated', model: 'kimi-k3-highspeed', contextTokens: 1820, maxContextTokens: 262144, usage: { total: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } }, time: B + 20 });
    await settle();
    drive({ type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 });
    drive({ type: 'thinking.delta', turnId: 0, delta: '闲聊类问题，直接友好回答。', time: B + 300 });
    drive({ type: 'assistant.delta', turnId: 0, delta: '我没法查实时天气——告诉你城市的话，我可以聊聊一般的气候特点。', time: B + 900 });
    drive({ type: 'turn.step.completed', turnId: 0, step: 1, usage: { inputOther: 1820, output: 28, inputCacheRead: 0, inputCacheCreation: 0 }, finishReason: 'end_turn', time: B + 1400 });
    drive({ type: 'turn.ended', turnId: 0, reason: 'completed', durationMs: 1483, time: B + 1500 });
    drive({ type: 'agent.activity.updated', lifecycle: 'ready', time: B + 1520 });
    drive({ type: 'agent.status.updated', contextTokens: 1870, usage: { total: { inputOther: 1820, output: 28, inputCacheRead: 0, inputCacheCreation: 0 } }, time: B + 1520 });
    activity.set({ busy: false, mainTurnActive: false, pendingInteraction: 'none' }, B + 1520);
    await settle();

    const got = frames();
    expect(got[0]).toEqual(HELLO_FRAME);
    expect(got[1]).toEqual({ type: 'ack', id: 1, code: 0 });
    const expected = fixtureSection('connection', 'omit 订阅（WS）').slice(3);
    for (const frame of got.slice(2)) parseServerMessage(frame);
    expect(got.slice(2)).toEqual(expected);
    expect(got.some((frame) => String(frame['type']).endsWith('.delta'))).toBe(false);
  });

  it('connection：背压溢出断开与重连恢复', async () => {
    const B = Date.parse('2026-09-03T17:20:00.000Z');
    const scenario = makeV2Scenario({ sessionId: 's_15' });
    const first = scenario.connect({ flush: false, outboundCapacity: 2, inflightWindow: 1 });
    const drive = (event: FakeBusEvent) => scenario.buses.get('main')!.emit(event);
    first.socket.deliver(JSON.stringify({ type: 'subscribe', id: 1, session_id: 's_15' }));
    drive({ type: 'prompt.submitted', promptId: 'p_01', status: 'running', content: [{ type: 'text', text: '今天天气怎么样' }], createdAt: '2026-09-03T17:20:00.000Z', time: B + 10 });
    drive({ type: 'turn.started', turnId: 0, promptId: 'p_01', origin: { kind: 'user' }, time: B + 15 });
    drive({ type: 'turn.step.started', turnId: 0, step: 1, time: B + 22 });
    expect(first.socket.closed).toBe(true);
    const last = JSON.parse(first.socket.sent.at(-1)!) as Record<string, unknown>;
    expect(last).toEqual({ type: 'error', code: 'backpressure_overflow', msg: 'outbound queue overflow; connection closed, reconnect to resync' });

    const second = scenario.connect();
    const frames2 = second.frames;
    expect(frames2()[0]).toEqual(HELLO_FRAME);
    second.socket.deliver(JSON.stringify({ type: 'subscribe', id: 1, session_id: 's_15' }));
    expect(frames2()[1]).toEqual({ type: 'ack', id: 1, code: 0 });
    const recovered = frames2().slice(2);
    for (const frame of recovered) parseServerMessage(frame);
    expect(recovered.map((frame) => [frame['type'], frame['step_id'] ?? frame['turn_id'] ?? ''])).toEqual([
      ['turn', 't1'],
      ['step', 't1.0'],
    ]);
    expect(recovered[1]).toMatchObject({ state: 'running' });
    const again = scenario.binding.recoveryFor('main').filter((frame) => frame.type !== 'session.state');
    expect(again.map((frame) => [frame.type, (frame as { step_id?: string }).step_id ?? (frame as { turn_id?: string }).turn_id ?? ''])).toEqual([
      ['turn', 't1'],
      ['step', 't1.0'],
    ]);
  });

  it('subagent：子代理通道按需订阅', async () => {
    const B = Date.parse('2026-09-03T17:30:00.000Z');
    const scenario = makeV2Scenario({ sessionId: 's_16', agentIds: ['main', 'review_01'] });
    const { buses } = scenario;
    const { socket, frames } = scenario.connect();
    const drive = (event: FakeBusEvent) => buses.get('review_01')!.emit(event);
    socket.deliver(JSON.stringify({ type: 'subscribe', id: 2, session_id: 's_16', agent_id: 'review_01' }));
    drive({ type: 'turn.started', agentId: 'review_01', turnId: 0, origin: { kind: 'task', taskId: 'task_01' }, time: B + 1600 });
    drive({ type: 'turn.step.started', agentId: 'review_01', turnId: 0, step: 1, time: B + 1620 });
    drive({ type: 'thinking.delta', agentId: 'review_01', turnId: 0, delta: '先读 LoginView 的改动，', time: B + 2000 });
    drive({ type: 'thinking.delta', agentId: 'review_01', turnId: 0, delta: '重点看 token 处理。', time: B + 2200 });
    drive({ type: 'assistant.delta', agentId: 'review_01', turnId: 0, delta: '我先读 LoginView 的改动。', time: B + 2800 });
    drive({ type: 'tool.call.started', agentId: 'review_01', turnId: 0, toolCallId: 'call_02', name: 'Read', args: { path: 'apps/web/src/views/LoginView.vue' }, time: B + 3200 });
    drive({ type: 'tool.result', agentId: 'review_01', turnId: 0, toolCallId: 'call_02', output: { content: '<template>…</template>', lines: 214 }, time: B + 3800 });
    drive({ type: 'subagent.completed', agentId: 'review_01', subagentId: 'review_01', resultSummary: '审查通过：可选链修复正确，无回归风险。', time: B + 4500 });
    drive({ type: 'turn.step.completed', agentId: 'review_01', turnId: 0, step: 1, usage: { inputOther: 2200, output: 64, inputCacheRead: 8000, inputCacheCreation: 0 }, finishReason: 'end_turn', time: B + 4500 });
    drive({ type: 'turn.ended', agentId: 'review_01', turnId: 0, reason: 'completed', durationMs: 2997, time: B + 4600 });
    await settle();

    const got = frames();
    expect(got[0]).toEqual(HELLO_FRAME);
    const section = fixtureSection('subagent', '子代理通道（按需订阅）');
    expect(got[1]).toEqual(section[1]);
    const expected = section.slice(2);
    for (const frame of got.slice(2)) parseServerMessage(frame);
    expect(got.slice(2)).toEqual(expected);
  });
});

interface FanoutHarness {
  emit(event: GlobalV2Event): void;
  frames: ServerMessage[];
  fanout: GlobalV2Fanout;
}

function makeFanoutHarness(opts: {
  sessionInfoFor?: (sessionId: string) => Promise<SessionInfo | undefined>;
  workspaceWireFor?: (workspace: unknown) => Promise<WorkspaceInfo | undefined>;
  clock?: () => number;
}): FanoutHarness {
  const handlers: ((event: GlobalV2Event) => void)[] = [];
  const frames: ServerMessage[] = [];
  const fanout = new GlobalV2Fanout(
    {
      subscribe: (handler) => {
        handlers.push(handler);
        return { dispose: () => {} };
      },
    },
    {
      sessionInfoFor: opts.sessionInfoFor ?? (async () => undefined),
      workspaceWireFor: opts.workspaceWireFor ?? (async () => undefined),
      clock: opts.clock ?? Date.now,
    },
  );
  fanout.addTarget((msg) => frames.push(msg));
  return {
    emit: (event) => {
      for (const handler of [...handlers]) handler(event);
    },
    frames,
    fanout,
  };
}

describe('WS v2 全消息面', () => {
  it('session-changes 自动标题', async () => {
    const harness = makeFanoutHarness({
      sessionInfoFor: async (sessionId) => ({
        session_id: sessionId,
        workspace_id: 'ws_01',
        title: '修复登录页白屏',
        status: 'active',
        model: 'kimi-k3-highspeed',
        created_at: '2026-09-03T16:40:00.000Z',
        updated_at: '2026-09-03T17:00:06.700Z',
        turn_count: 1,
      }),
    });
    harness.emit({
      type: 'session.meta.updated',
      payload: { sessionId: 's_13', title: '修复登录页白屏', patch: { title: '修复登录页白屏' } },
      time: Date.parse('2026-09-03T17:00:06.800Z'),
    });
    await settle();
    const expected = fixtureSection('session-changes', '自动标题（WS）');
    expect(harness.frames.length).toBe(1);
    parseServerMessage(harness.frames[0]);
    expect(harness.frames[0]).toEqual(expected[0]);
  });

  it('session-changes 设置变更', async () => {
    const scenario = makeV2Scenario({ sessionId: 's_13' });
    const { buses, activity } = scenario;
    const { socket } = scenario.connect();
    const drive = (event: FakeBusEvent) => buses.get('main')!.emit(event);
    socket.deliver(JSON.stringify({ type: 'subscribe', id: 1, session_id: 's_13' }));
    activity.set({ busy: false, mainTurnActive: false, pendingInteraction: 'none' });
    drive({ type: 'agent.activity.updated', lifecycle: 'ready', time: Date.parse('2026-09-03T17:00:00.000Z') });
    drive({ type: 'agent.status.updated', model: 'kimi-k3-highspeed', contextTokens: 5700, maxContextTokens: 262144, usage: { total: { inputOther: 5500, output: 162, inputCacheRead: 19500, inputCacheCreation: 0 } }, time: Date.parse('2026-09-03T17:00:00.000Z') });
    await settle();
    drive({ type: 'profile.bind', model: 'kimi-k3', time: Date.parse('2026-09-03T17:02:10.000Z') });
    await settle();
    drive({ type: 'permission.set_mode', mode: 'yolo', time: Date.parse('2026-09-03T17:02:40.000Z') });
    await settle();
    const expected = fixtureSection('session-changes', '设置变更（WS）');
    const states = socket.sent
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((frame) => frame['type'] === 'session.state' && (frame['timestamp'] as string) >= '2026-09-03T17:02:00.000Z');
    expect(states.length).toBe(2);
    for (const frame of states) parseServerMessage(frame);
    expect(states).toEqual(expected);
  });

  it('global 工作区', async () => {
    const harness = makeFanoutHarness({
      workspaceWireFor: async (workspace) => {
        const ws = workspace as { id: string; root: string; name: string; createdAt: number; lastOpenedAt: number; sessionCount: number };
        return {
          id: ws.id,
          root: ws.root,
          name: ws.name,
          created_at: new Date(ws.createdAt).toISOString(),
          last_opened_at: new Date(ws.lastOpenedAt).toISOString(),
          session_count: ws.sessionCount,
        };
      },
    });
    harness.emit({
      type: 'event.workspace.created',
      payload: { workspace: { id: 'ws_02', root: '/Users/moonshot/projects/demo', name: 'demo', createdAt: Date.parse('2026-09-03T17:10:00.000Z'), lastOpenedAt: Date.parse('2026-09-03T17:10:00.000Z'), sessionCount: 0 } },
      time: Date.parse('2026-09-03T17:10:00.010Z'),
    });
    harness.emit({
      type: 'event.workspace.updated',
      payload: { workspace: { id: 'ws_02', root: '/Users/moonshot/projects/demo', name: 'demo', createdAt: Date.parse('2026-09-03T17:10:00.000Z'), lastOpenedAt: Date.parse('2026-09-03T17:12:00.000Z'), sessionCount: 1 } },
      time: Date.parse('2026-09-03T17:12:00.010Z'),
    });
    await settle();
    const expected = fixtureSection('global', '工作区（WS）');
    expect(harness.frames.length).toBe(2);
    for (const frame of harness.frames) parseServerMessage(frame);
    expect(harness.frames).toEqual(expected);
  });

  it('global 全局配置', async () => {
    const harness = makeFanoutHarness({});
    harness.emit({
      type: 'event.config.changed',
      payload: {
        changedFields: ['theme'],
        config: {
          model: 'kimi-k3-highspeed',
          theme: 'dark',
          permission: 'manual',
          max_turns: 100,
          providers: { anthropic: { base_url: 'https://api.anthropic.com' } },
        },
      },
      time: Date.parse('2026-09-03T17:15:00.000Z'),
    });
    await settle();
    const expected = fixtureSection('global', '全局配置（WS）');
    expect(harness.frames.length).toBe(1);
    parseServerMessage(harness.frames[0]);
    expect(harness.frames[0]).toEqual(expected[0]);
  });

  it('global 变更通知（通知型薄帧）', async () => {
    const harness = makeFanoutHarness({});
    harness.emit({ type: 'event.model_catalog.changed', payload: { changed: [], unchanged: [], failed: [] }, time: Date.parse('2026-09-03T17:20:00.000Z') });
    harness.emit({ type: 'event.plugin.changed', payload: {}, time: Date.parse('2026-09-03T17:21:00.000Z') });
    harness.emit({ type: 'event.capability.changed', payload: { capability_id: 'mcp.github', install: { running: false } }, time: Date.parse('2026-09-03T17:22:00.000Z') });
    await settle();
    const expected = fixtureSection('global', '变更通知（WS）');
    expect(harness.frames.length).toBe(3);
    for (const frame of harness.frames) parseServerMessage(frame);
    expect(harness.frames).toEqual(expected);
  });

  it('全局扇出：未订阅连接同样收到全局帧', async () => {
    const harness = makeFanoutHarness({});
    const scenario = makeV2Scenario({ sessionId: 's_15' });
    const { socket, frames } = scenario.connect({ globalFanout: harness.fanout });
    harness.emit({ type: 'event.model_catalog.changed', payload: {}, time: Date.parse('2026-09-03T17:20:00.000Z') });
    await settle();
    const got = frames();
    expect(got[0]).toEqual(HELLO_FRAME);
    expect(got[1]).toEqual({ type: 'model_catalog', timestamp: '2026-09-03T17:20:00.000Z' });
    void socket;
  });

  it('system 剩余 subtype：hook / skill / notice / clear / swarm', () => {
    const projector = new AgentV2Projector('s_x', 'main');
    const B = Date.parse('2026-09-03T18:00:00.000Z');
    const out = [
      ...projector.apply({ type: 'hook.result', hookEvent: 'user_prompt_submit', content: '继续', blocked: false, time: B + 10 }),
      ...projector.apply({ type: 'skill.activated', skillName: 'review-pr', time: B + 20 }),
      ...projector.apply({ type: 'plugin_command.activated', commandName: 'compact', time: B + 30 }),
      ...projector.apply({ type: 'context.clear', time: B + 40 }),
      ...projector.apply({ type: 'agent.status.updated', swarmMode: true, time: B + 50 }),
      ...projector.apply({ type: 'agent.status.updated', swarmMode: false, time: B + 60 }),
    ];
    for (const msg of out) parseServerMessage(msg);
    const systems = out as { type: string; subtype: string; system_id: string }[];
    expect(systems.map((msg) => [msg.type, msg.subtype])).toEqual([
      ['system', 'hook'],
      ['system', 'notice'],
      ['system', 'clear'],
      ['system', 'swarm.enter'],
      ['system', 'swarm.exit'],
    ]);
    expect(systems.map((msg) => msg.system_id)).toEqual(['m_01', 'm_02', 'm_03', 'm_04', 'm_05']);
    expect(out[0]).toMatchObject({ payload: { event: 'user_prompt_submit', content: '继续' } });
    expect(out[1]).toMatchObject({ payload: { message: 'compact' } });
  });
});


