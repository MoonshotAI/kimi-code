import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseServerMessage, type ServerMessage } from '../src/protocol/v2/messages/index';
import type {
  InteractionPendingRecord,
  InteractionResolvedRecord,
  ProjectionEvent,
} from '../src/services/v2Projection/agentProjector';
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
    if (step.event) out.push(...projector.applyAgentEvent('main', step.event));
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
  const expected = sectionLabels.flatMap((label) => fixtureStream(tabId, label)) as { session_id?: string }[];
  const sessionId = expected.find((m) => typeof m.session_id === 'string')?.session_id ?? 's_01';
  const actual = runScript(sessionId, steps);
  for (const msg of actual) parseServerMessage(msg);
  expect(actual).toEqual(expected);
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: T + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '用户在打招呼，', time: T + 420 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '简短回应即可。', time: T + 580 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '你好！', time: T + 1050 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '有什么可以帮你的？', time: T + 1200 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 0,
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: B + 22 } },
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
          step: 0,
          usage: { inputOther: 2100, output: 96, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 1700,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 1900 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '当前目录下有 4 个条目：', time: B + 2250 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '`apps`、`docs`、`packages` 和 `pnpm-workspace.yaml`。', time: B + 2400 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: B + 22 } },
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
          step: 0,
          usage: { inputOther: 2400, output: 130, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 1500,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 1700 } },
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
          step: 1,
          usage: { inputOther: 2580, output: 74, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 2500,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 2, time: B + 2700 } },
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
          step: 2,
          usage: { inputOther: 2720, output: 66, inputCacheRead: 0, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 3700,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 3, time: B + 3900 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '完成。`hello.py` 已创建并加上 shebang，', time: B + 4100 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '运行输出当前时间，一切正常。', time: B + 4150 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 3,
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: B + 22 } },
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
          step: 0,
          usage: { inputOther: 2900, output: 78, inputCacheRead: 10000, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 3100,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 3150 } },
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
          step: 1,
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: B + 22 } },
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
          step: 0,
          usage: { inputOther: 2600, output: 60, inputCacheRead: 9000, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 6100,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 6150 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '测试跑完了：18 通过、2 失败。', time: B + 6500 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
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
      { event: { type: 'turn.step.started', turnId: 1, step: 0, time: B + 6950 } },
      { event: { type: 'thinking.delta', turnId: 1, delta: '从刚才的输出里挑失败用例即可，', time: B + 7250 } },
      { event: { type: 'thinking.delta', turnId: 1, delta: '不用重跑。', time: B + 7400 } },
      { event: { type: 'assistant.delta', turnId: 1, delta: '失败的两个用例都在 `auth` 目录下：', time: B + 7900 } },
      { event: { type: 'assistant.delta', turnId: 1, delta: '`login.spec.ts` 的「过期 token 应跳转登录页」、', time: B + 8100 } },
      {
        event: {
          type: 'turn.step.interrupted',
          turnId: 1,
          step: 0,
          reason: 'aborted by user',
          usage: { inputOther: 2200, output: 35, inputCacheRead: 6000, inputCacheCreation: 0 },
          time: B + 8610,
        },
      },
      { event: { type: 'turn.ended', turnId: 1, reason: 'cancelled', time: B + 8620 } },
      { event: { type: 'prompt.aborted', promptId: 'p_02', abortedAt: '2026-09-03T11:00:08.640Z', time: B + 8640 } },
      {
        facts: {
          activity: { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
          agentActivity: { lifecycle: 'ready' },
          status: {
            contextTokens: 6500,
            usage: { total: { inputOther: 7600, output: 135, inputCacheRead: 26000, inputCacheCreation: 0 } },
          },
          time: B + 8650,
        },
      },
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: B + 22 } },
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
          step: 0,
          usage: { inputOther: 2300, output: 46, inputCacheRead: 7200, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 2000,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 2050 } },
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
          step: 1,
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: B + 22 } },
      { event: { type: 'thinking.delta', turnId: 0, delta: '', time: B + 300 } },
      {
        event: {
          type: 'turn.step.retrying',
          turnId: 0,
          step: 0,
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
          step: 0,
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: B + 22 } },
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
          step: 0,
          usage: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 6300,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 6350 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '复现成功，报错和浏览器里看到的一致：', time: B + 6700 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '`handleLogin` 读取了 undefined 的 `token` 字段（`LoginView.vue:87`）。', time: B + 6900 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: B + 22 } },
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
          step: 0,
          usage: { inputOther: 2400, output: 52, inputCacheRead: 8000, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 5300,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 5350 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '好，那不跑了。', time: B + 5700 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '需要我换个方式排查吗——比如直接读 `handleLogin` 的实现？', time: B + 5900 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: B + 22 } },
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
          step: 0,
          usage: { inputOther: 2300, output: 48, inputCacheRead: 7600, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 5900,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 5950 } },
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
          step: 1,
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: B + 22 } },
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
          step: 0,
          usage: { inputOther: 2500, output: 58, inputCacheRead: 9200, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 4100,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 4150 } },
      { event: { type: 'assistant.delta', turnId: 0, delta: '构建量比较大，已转后台跑（task_01），完成后我告诉你。', time: B + 4500 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 0,
          step: 1,
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
      { event: { type: 'turn.step.started', turnId: 1, step: 0, time: B + 478620 } },
      { event: { type: 'assistant.delta', turnId: 1, delta: '构建完成了：8 个包全部编译通过，产物在各自的 `dist/`。', time: B + 479000 } },
      {
        event: {
          type: 'turn.step.completed',
          turnId: 1,
          step: 0,
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
      { event: { type: 'turn.step.started', turnId: 8, step: 0, time: B + 120 } },
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
          step: 0,
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
      { event: { type: 'turn.step.started', turnId: 0, step: 0, time: B + 22 } },
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
          step: 0,
          usage: { inputOther: 2800, output: 72, inputCacheRead: 11000, inputCacheCreation: 0 },
          finishReason: 'tool_use',
          time: B + 45300,
        },
      },
      { event: { type: 'turn.step.started', turnId: 0, step: 1, time: B + 45350 } },
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
          step: 1,
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
});
