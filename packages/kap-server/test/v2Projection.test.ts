import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseServerMessage, type ServerMessage } from '../src/protocol/v2/messages/index';
import type { ProjectionEvent } from '../src/services/v2Projection/agentProjector';
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
  }
  return out;
}

function expectStream(tabId: string, sectionLabel: string, steps: ScriptStep[]): void {
  const expected = fixtureStream(tabId, sectionLabel) as { session_id?: string }[];
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
});
