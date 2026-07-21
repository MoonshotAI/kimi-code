/**
 * Scenario: context projection rebuilds stored history into provider-valid messages.
 *
 * Responsibilities: validates tool-exchange repair, strict projection, and
 * degraded/full-strip media projections through the public projector contract.
 * Wiring: real AgentContextProjectorService with captured log and telemetry
 * boundaries. Run: pnpm test -- test/agent/contextProjector/projector-tool-exchanges.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService, type ILogger } from '#/_base/log/log';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { AgentContextProjectorService } from '#/agent/contextProjector/contextProjectorService';
import { toProtocolMessage } from '#/agent/contextMemory/messageProjection';
import type { Message } from '#/kosong/contract/message';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

const REPAIR_WARNING = 'repaired the request to keep it wire-valid';

interface WarningCall {
  readonly message: string;
  readonly payload: unknown;
}

function createCapturingLog(warnings: WarningCall[]): ILogService {
  const logger: ILogger = {
    error: () => {},
    warn: (message, payload) => {
      warnings.push({ message, payload });
    },
    info: () => {},
    debug: () => {},
    child: () => logger,
  };
  return {
    ...logger,
    _serviceBrand: undefined,
    level: 'warn',
    setLevel: () => {},
    flush: () => Promise.resolve(),
  };
}

function repairPayloads(warnings: WarningCall[]): Record<string, unknown>[] {
  return warnings
    .filter((call) => call.message === REPAIR_WARNING)
    .map((call) => call.payload as Record<string, unknown>);
}


const INTERRUPTED = 'Tool result is not available in the current context';

function user(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
}

function reminder(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'host' },
  };
}

function assistant(text: string, toolCallIds: readonly string[] = []): ContextMessage {
  return {
    role: 'assistant',
    content: text === '' ? [] : [{ type: 'text', text }],
    toolCalls: toolCallIds.map((id) => ({ type: 'function', id, name: 'Lookup', arguments: '{}' })),
  };
}

function toolResult(toolCallId: string, text: string): ContextMessage {
  return { role: 'tool', content: [{ type: 'text', text }], toolCalls: [], toolCallId };
}

function schemaMessage(name: string): ContextMessage {
  return {
    role: 'system',
    content: [],
    toolCalls: [],
    tools: [
      {
        name,
        description: `${name} desc`,
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      },
    ],
    origin: { kind: 'injection', variant: 'dynamic_tool_schema' },
  };
}

describe('projector tool-exchange normalization', () => {
  let disposables: DisposableStore;
  let projector: IAgentContextProjectorService;
  let warnings: WarningCall[];
  let telemetryRecords: TelemetryRecord[];

  beforeEach(() => {
    disposables = new DisposableStore();
    warnings = [];
    telemetryRecords = [];
    const ix = disposables.add(new TestInstantiationService());
    ix.set(ILogService, createCapturingLog(warnings));
    ix.set(ITelemetryService, recordingTelemetry(telemetryRecords));
    ix.set(IAgentContextProjectorService, new SyncDescriptor(AgentContextProjectorService));
    projector = ix.get(IAgentContextProjectorService);
  });

  afterEach(() => disposables.dispose());

  function project(history: readonly ContextMessage[]): readonly Message[] {
    return projector.project(history);
  }

  function shape(history: readonly ContextMessage[]): string[] {
    return project(history).map((message) =>
      message.role === 'tool' ? `tool:${message.toolCallId}` : message.role,
    );
  }

  function projectStrict(history: readonly ContextMessage[]): readonly Message[] {
    return projector.projectStrict(history);
  }

  it('leaves a fully resolved exchange untouched', () => {
    const history = [user('go'), assistant('', ['c1']), toolResult('c1', 'one'), user('next')];
    expect(shape(history)).toEqual(['user', 'assistant', 'tool:c1', 'user']);
    expect(project(history)).toHaveLength(4);
  });

  it('synthesizes a result for a trailing unanswered call', () => {
    const projected = project([user('go'), assistant('', ['c1', 'c2']), toolResult('c1', 'one')]);
    expect(shape([user('go'), assistant('', ['c1', 'c2']), toolResult('c1', 'one')])).toEqual([
      'user',
      'assistant',
      'tool:c1',
      'tool:c2',
    ]);
    const synthetic = projected.at(-1);
    expect(synthetic).toMatchObject({ role: 'tool', toolCallId: 'c2' });
    expect((synthetic?.content[0] as { text: string }).text).toContain(INTERRUPTED);
  });

  it('synthesizes every open call of a multi-call step in tool-call order', () => {
    expect(shape([user('go'), assistant('', ['a', 'b', 'c'])])).toEqual([
      'user',
      'assistant',
      'tool:a',
      'tool:b',
      'tool:c',
    ]);
  });

  it('pulls a real result up and defers a reminder that landed inside the exchange', () => {
    const history = [
      assistant('', ['c1', 'c2']),
      reminder('host note'),
      toolResult('c1', 'one'),
      toolResult('c2', 'two'),
    ];
    expect(shape(history)).toEqual(['assistant', 'tool:c1', 'tool:c2', 'user']);
    const projected = project(history);
    expect((projected.at(-1)?.content[0] as { text: string }).text).toContain('host note');
  });

  it('keeps the real result and synthesizes only the still-open call', () => {
    const history = [
      assistant('', ['done', 'open']),
      toolResult('done', 'real result'),
      assistant('All done.'),
    ];
    const projected = project(history);
    expect(shape(history)).toEqual(['assistant', 'tool:done', 'tool:open', 'assistant']);
    expect((projected[1]?.content[0] as { text: string }).text).toBe('real result');
    expect((projected[2]?.content[0] as { text: string }).text).toContain(INTERRUPTED);
  });

  it('closes an interrupted mid-history call before the next turn', () => {
    const history = [
      user('go'),
      assistant('', ['c1']),
      user('keep going'),
      assistant('All done.'),
    ];
    expect(shape(history)).toEqual(['user', 'assistant', 'tool:c1', 'user', 'assistant']);
  });

  it('closes consecutive interrupted steps each at their own boundary', () => {
    const history = [
      user('go'),
      assistant('', ['one']),
      assistant('', ['two']),
      assistant('Done.'),
    ];
    expect(shape(history)).toEqual([
      'user',
      'assistant',
      'tool:one',
      'assistant',
      'tool:two',
      'assistant',
    ]);
  });

  it('drops a stale duplicate result for an already-answered call', () => {
    const history = [
      user('go'),
      assistant('', ['c1']),
      user('keep going'),
      assistant('All done.'),
      toolResult('c1', 'late duplicate'),
    ];
    expect(shape(history)).toEqual(['user', 'assistant', 'tool:c1', 'user', 'assistant']);
  });

  it('matches results across exchanges that reuse the same tool-call id', () => {
    const history = [
      assistant('', ['call']),
      toolResult('call', 'first'),
      assistant('', ['call']),
      toolResult('call', 'second'),
    ];
    const projected = project(history);
    expect(shape(history)).toEqual(['assistant', 'tool:call', 'assistant', 'tool:call']);
    expect((projected[1]?.content[0] as { text: string }).text).toBe('first');
    expect((projected[3]?.content[0] as { text: string }).text).toBe('second');
  });

  it('drops an orphan result whose call was never recorded', () => {
    const history = [user('hi'), assistant('hello'), toolResult('ghost', 'orphaned')];
    expect(shape(history)).toEqual(['user', 'assistant']);
  });

  it('drops a leading orphan result when the slice contains an assistant', () => {
    const history = [toolResult('ghost', 'orphaned'), user('hi'), assistant('hello')];
    expect(shape(history)).toEqual(['user', 'assistant']);
  });

  it('drops a partial assistant exchange without stranding its results', () => {
    const history: ContextMessage[] = [
      user('go'),
      { ...assistant('', ['c1', 'c2']), partial: true },
      toolResult('c1', 'one'),
      assistant('recovered'),
    ];
    expect(shape(history)).toEqual(['user', 'assistant']);
  });

  it('keeps a bare result slice with no preceding assistant (used for sizing)', () => {
    expect(shape([toolResult('c1', 'partial result')])).toEqual(['tool:c1']);
  });

  it('keeps a tool-shaped message without a toolCallId', () => {
    const message: ContextMessage = {
      role: 'tool',
      content: [{ type: 'text', text: 'tool-like output' }],
      toolCalls: [],
    };
    expect(project([message])).toHaveLength(1);
  });

  it('keeps a schema-only system message when it declares dynamic tools', () => {
    const projected = project([user('load it'), schemaMessage('mcp__srv__query')]);

    expect(projected).toEqual([
      {
        role: 'user',
        name: undefined,
        content: [{ type: 'text', text: 'load it' }],
        toolCalls: [],
        toolCallId: undefined,
        partial: undefined,
      },
      {
        role: 'system',
        name: undefined,
        content: [],
        toolCalls: [],
        toolCallId: undefined,
        partial: undefined,
        tools: [
          {
            name: 'mcp__srv__query',
            description: 'mcp__srv__query desc',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
          },
        ],
      },
    ]);
  });

  it('renders structured tool-result notes only for the model projection', () => {
    const note = '<system>Image compressed.</system>';
    const result: ContextMessage = {
      role: 'tool',
      content: [{ type: 'text', text: 'image result' }],
      toolCalls: [],
      toolCallId: 'call_image',
      note,
    };
    const history = [assistant('', ['call_image']), result];

    expect(project(history)[1]?.content).toEqual([
      { type: 'text', text: `image result\n${note}` },
    ]);
    expect(result.content).toEqual([{ type: 'text', text: 'image result' }]);

    const protocol = toProtocolMessage('session_1', 0, result, 0);
    expect(protocol.content).toEqual([
      { type: 'tool_result', tool_call_id: 'call_image', output: 'image result' },
    ]);
  });

  it('passes raw media parts through as the tool_result output', () => {
    const result: ContextMessage = {
      role: 'tool',
      content: [
        { type: 'text', text: 'image result' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
      ],
      toolCalls: [],
      toolCallId: 'call_media',
    };

    const protocol = toProtocolMessage('session_1', 0, result, 0);
    expect(protocol.content).toEqual([
      { type: 'tool_result', tool_call_id: 'call_media', output: result.content },
    ]);
  });

  it('renders v1 tool-result status at the model projection boundary', () => {
    const history = [
      assistant('', ['call_error', 'call_empty']),
      {
        role: 'tool',
        content: [{ type: 'text', text: '<system>ERROR: remote failed</system>' }],
        toolCalls: [],
        toolCallId: 'call_error',
        isError: true,
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: '   ' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
    ] satisfies ContextMessage[];

    expect(project(history)[1]?.content).toEqual([
      {
        type: 'text',
        text:
          '<system>ERROR: Tool execution failed.</system>\n' +
          '<system>ERROR: remote failed</system>',
      },
    ]);
    expect(project(history)[2]?.content).toEqual([
      { type: 'text', text: '<system>Tool output is empty.</system>' },
    ]);
  });

  it('strict mode dedupes duplicate assistant tool call ids', () => {
    const history = [
      user('go'),
      assistant('first', ['dup']),
      toolResult('dup', 'one'),
      assistant('second', ['dup']),
      toolResult('dup', 'two'),
    ];

    const projected = projectStrict(history);

    expect(projected.map((message) => (message.role === 'tool' ? `tool:${message.toolCallId}` : message.role))).toEqual([
      'user',
      'assistant',
      'tool:dup',
      'assistant',
    ]);
    expect(projected[1]?.toolCalls.map((call) => call.id)).toEqual(['dup']);
    expect(projected.filter((message) => message.role === 'tool')).toHaveLength(1);
  });

  it("strict mode reattaches a later duplicate's result when the first call has none", () => {
    const projected = projectStrict([
      user('go'),
      assistant('first attempt', ['dup']),
      assistant('second attempt', ['dup']),
      toolResult('dup', 'late result'),
      user('next'),
    ]);

    expect(
      projected.map((message) =>
        message.role === 'tool' ? `tool:${message.toolCallId}` : message.role,
      ),
    ).toEqual(['user', 'assistant', 'tool:dup', 'assistant', 'user']);
    expect(projected[1]?.toolCalls.map((call) => call.id)).toEqual(['dup']);
    expect((projected[2]?.content[0] as { text: string }).text).toBe('late result');
  });

  it('strict mode drops an assistant left with only vacuous content after deduping', () => {
    const history = [
      user('go'),
      assistant('first', ['dup']),
      toolResult('dup', 'one'),
      {
        role: 'assistant' as const,
        content: [{ type: 'think' as const, think: '' }],
        toolCalls: [{ type: 'function' as const, id: 'dup', name: 'Lookup', arguments: '{}' }],
      },
      toolResult('dup', 'two'),
      user('next'),
    ];

    const projected = projectStrict(history);

    expect(
      projected.map((message) =>
        message.role === 'tool' ? `tool:${message.toolCallId}` : message.role,
      ),
    ).toEqual(['user', 'assistant', 'tool:dup', 'user']);
    expect(repairPayloads(warnings)).toEqual([
      expect.objectContaining({ duplicateCallsDropped: 1, vacuousDropped: 1 }),
    ]);
  });

  it('strict mode keeps a deduped assistant whose remaining content is sendable', () => {
    const history = [
      user('go'),
      assistant('first', ['dup']),
      toolResult('dup', 'one'),
      {
        role: 'assistant' as const,
        content: [
          { type: 'think' as const, think: '' },
          { type: 'text' as const, text: 'second' },
        ],
        toolCalls: [{ type: 'function' as const, id: 'dup', name: 'Lookup', arguments: '{}' }],
      },
      toolResult('dup', 'two'),
      user('next'),
    ];

    const projected = projectStrict(history);

    expect(
      projected.map((message) =>
        message.role === 'tool' ? `tool:${message.toolCallId}` : message.role,
      ),
    ).toEqual(['user', 'assistant', 'tool:dup', 'assistant', 'user']);
    expect(projected[3]?.toolCalls).toEqual([]);
    expect(projected[3]?.content).toEqual([
      { type: 'think', think: '' },
      { type: 'text', text: 'second' },
    ]);
    expect(repairPayloads(warnings)).toEqual([
      expect.objectContaining({ duplicateCallsDropped: 1, vacuousDropped: 0 }),
    ]);
  });

  it('strict mode drops leading non-user messages', () => {
    const projected = projectStrict([assistant('stale'), toolResult('ghost', 'orphaned'), user('hi')]);

    expect(projected.map((message) => message.role)).toEqual(['user']);
    expect(projected[0]?.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('strict mode merges consecutive assistant messages', () => {
    const projected = projectStrict([user('go'), assistant('one'), assistant('two')]);

    expect(projected.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(projected[1]?.content).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
  });

  describe('surfaces repairs so a mangled history leaves a trace', () => {
    it('stays silent for a well-formed projection', () => {
      project([user('go'), assistant('', ['c1']), toolResult('c1', 'one'), user('next')]);
      expect(repairPayloads(warnings)).toEqual([]);
    });

    it('reports a result pulled up to its call as reordered', () => {
      project([
        assistant('', ['c1', 'c2']),
        reminder('host note'),
        toolResult('c1', 'one'),
        toolResult('c2', 'two'),
      ]);
      expect(repairPayloads(warnings)).toEqual([
        expect.objectContaining({
          reordered: 2,
          toolCallIds: expect.arrayContaining(['c1', 'c2']),
        }),
      ]);
    });

    it('reports a mid-history lost result but not a trailing in-flight close', () => {
      project([user('go'), assistant('', ['c1']), user('keep going'), assistant('All done.')]);
      expect(repairPayloads(warnings)).toEqual([
        expect.objectContaining({ synthesized: 1, toolCallIds: ['c1'] }),
      ]);

      warnings.length = 0;
      project([user('go'), assistant('', ['c1'])]);
      expect(repairPayloads(warnings)).toEqual([]);
    });

    it('reports an orphan result whose call was never recorded', () => {
      project([user('hi'), assistant('hello'), toolResult('ghost', 'orphaned')]);
      expect(repairPayloads(warnings)).toEqual([
        expect.objectContaining({ droppedOrphan: 1, toolCallIds: ['ghost'] }),
      ]);
    });

    it('logs a recurring defect once per signature and again after a clean projection', () => {
      const broken = [user('go'), assistant('', ['c1']), user('keep going'), assistant('x')];
      project(broken);
      project(broken);
      expect(repairPayloads(warnings)).toHaveLength(1);

      project([user('go'), assistant('', ['c1']), toolResult('c1', 'one'), user('next')]);
      project(broken);
      expect(repairPayloads(warnings)).toHaveLength(2);
    });

    it('reports strict-mode leading-drop and orphan', () => {
      projectStrict([assistant('stale'), toolResult('ghost', 'orphaned'), user('hi')]);
      expect(repairPayloads(warnings).at(-1)).toEqual(
        expect.objectContaining({ leadingDropped: 1, droppedOrphan: 1, toolCallIds: ['ghost'] }),
      );
    });

    it('reports strict-mode consecutive assistant merge', () => {
      projectStrict([user('go'), assistant('one'), assistant('two')]);
      expect(repairPayloads(warnings).at(-1)).toEqual(
        expect.objectContaining({ assistantsMerged: 1 }),
      );
    });

    it('emits context_projection_repaired telemetry with the v1 wire keys when a repair occurs', () => {
      project([
        assistant('', ['c1', 'c2']),
        reminder('host note'),
        toolResult('c1', 'one'),
        toolResult('c2', 'two'),
      ]);
      expect(telemetryRecords).toEqual([
        {
          event: 'context_projection_repaired',
          properties: {
            reordered: 2,
            synthesized: 0,
            dropped_orphan: 0,
            duplicate_calls_dropped: 0,
            duplicate_results_dropped: 0,
            leading_dropped: 0,
            assistants_merged: 0,
            whitespace_dropped: 0,
            vacuous_dropped: 0,
          },
        },
      ]);
    });

    it('does not emit context_projection_repaired on a clean projection or a trailing in-flight close', () => {
      project([user('go'), assistant('', ['c1']), toolResult('c1', 'one'), user('next')]);
      project([user('go'), assistant('', ['c1'])]);
      expect(telemetryRecords).toEqual([]);
    });
  });

  describe('vacuous (thinking-only) messages', () => {
    function thinkingAssistant(content: ContextMessage['content']): ContextMessage {
      return { role: 'assistant', content: [...content], toolCalls: [] };
    }

    it('drops an assistant message whose only part is an empty think block', () => {
      const history = [
        user('u1'),
        thinkingAssistant([{ type: 'think', think: '' }]),
        reminder('ping'),
      ];
      expect(shape(history)).toEqual(['user', 'user']);
      expect(repairPayloads(warnings)).toEqual([expect.objectContaining({ vacuousDropped: 1 })]);
      expect(telemetryRecords).toEqual([
        {
          event: 'context_projection_repaired',
          properties: expect.objectContaining({ vacuous_dropped: 1 }),
        },
      ]);
    });

    it('un-wedges a history poisoned by a filtered step (session regression)', () => {
      const history = [
        user('u1'),
        assistant('', ['c1']),
        toolResult('c1', 'one'),
        thinkingAssistant([{ type: 'think', think: '' }]),
        reminder('ping'),
      ];
      expect(shape(history)).toEqual(['user', 'assistant', 'tool:c1', 'user']);
      expect(repairPayloads(warnings)).toEqual([expect.objectContaining({ vacuousDropped: 1 })]);
    });

    it('keeps a message with real text intact — including its empty think part', () => {
      const history = [
        user('u1'),
        thinkingAssistant([{ type: 'think', think: '' }, { type: 'text', text: 'answer' }]),
      ];
      expect(project(history)[1]?.content).toEqual([
        { type: 'think', think: '' },
        { type: 'text', text: 'answer' },
      ]);
      expect(repairPayloads(warnings)).toEqual([]);
    });

    it('keeps a message whose think block has real content', () => {
      const history = [user('u1'), thinkingAssistant([{ type: 'think', think: 'real reasoning' }])];
      expect(shape(history)).toEqual(['user', 'assistant']);
      expect(repairPayloads(warnings)).toEqual([]);
    });

    it('keeps a signed think block even when its text is empty', () => {
      const history = [
        user('u1'),
        thinkingAssistant([{ type: 'think', think: '', encrypted: 'sig' }]),
      ];
      expect(shape(history)).toEqual(['user', 'assistant']);
      expect(project(history)[1]?.content).toEqual([{ type: 'think', think: '', encrypted: 'sig' }]);
    });

    it('drops a message whose think block is whitespace-only', () => {
      const history = [
        user('u1'),
        thinkingAssistant([{ type: 'think', think: '   ' }]),
        reminder('ping'),
      ];
      expect(shape(history)).toEqual(['user', 'user']);
      expect(repairPayloads(warnings)).toEqual([expect.objectContaining({ vacuousDropped: 1 })]);
    });

    it('keeps an assistant message with tool calls even when its think part is empty', () => {
      const history = [
        user('u1'),
        {
          role: 'assistant' as const,
          content: [{ type: 'think' as const, think: '' }],
          toolCalls: [{ type: 'function' as const, id: 'c1', name: 'Lookup', arguments: '{}' }],
        },
        toolResult('c1', 'one'),
      ];
      expect(shape(history)).toEqual(['user', 'assistant', 'tool:c1']);
      expect(project(history)[1]?.content).toEqual([{ type: 'think', think: '' }]);
      expect(repairPayloads(warnings)).toEqual([]);
    });
  });

  describe('projectMediaDegraded', () => {
    function imageMessage(url: string): ContextMessage {
      return {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url } }],
        toolCalls: [],
        origin: { kind: 'user' },
      };
    }

    it('keeps the two most recent media parts and replaces older ones with markers', () => {
      const projected = projector.projectMediaDegraded([
        imageMessage('data:image/png;base64,OLD1'),
        user('middle'),
        imageMessage('data:image/png;base64,OLD2'),
        imageMessage('data:image/png;base64,KEEP1'),
        imageMessage('data:image/png;base64,KEEP2'),
      ]);

      const urls = projected
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'image_url')
        .map((part) => part.imageUrl.url);
      expect(urls).toEqual(['data:image/png;base64,KEEP1', 'data:image/png;base64,KEEP2']);
      const markers = projected
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'text')
        .map((part) => part.text);
      expect(
        markers.filter((text) => text.includes('dropped to fit the provider request size limit')),
      ).toHaveLength(2);
    });

    it('returns the projected messages untouched when media fits within keep-recent', () => {
      const projected = projector.projectMediaDegraded([
        user('text'),
        imageMessage('data:image/png;base64,AAAA'),
      ]);
      const allParts = projected.flatMap((message) => message.content);
      expect(allParts.some((part) => part.type === 'image_url')).toBe(true);
    });
  });

  describe('projectMediaStripped', () => {
    function imageMessage(url: string, id?: string): ContextMessage {
      return {
        role: 'user',
        content: [{ type: 'image_url', imageUrl: { url, id } }],
        toolCalls: [],
        origin: { kind: 'user' },
      };
    }

    it('replaces every media part with a text marker, keeping the surrounding text', () => {
      const projected = projector.projectMediaStripped([
        user('look at these'),
        imageMessage('data:image/png;base64,AAAA'),
        {
          role: 'tool',
          content: [
            { type: 'text', text: '<image path="/tmp/shot.png">' },
            { type: 'image_url', imageUrl: { url: 'data:image/avif;base64,BBBB' } },
            { type: 'text', text: '</image>' },
          ],
          toolCalls: [],
          toolCallId: 'c1',
        },
        {
          role: 'user',
          content: [{ type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,CCCC' } }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      ]);

      const allParts = projected.flatMap((message) => message.content);
      expect(allParts.some((part) => part.type === 'image_url')).toBe(false);
      expect(allParts.some((part) => part.type === 'video_url')).toBe(false);
      const texts = allParts.filter((part) => part.type === 'text').map((part) => part.text);
      expect(texts).toContain('look at these');
      expect(texts).toContain('<image path="/tmp/shot.png">');
      expect(texts.some((text) => text.includes('omitted for provider compatibility'))).toBe(true);
      expect(texts.some((text) => text.includes('get conversion guidance'))).toBe(true);
    });

    it('returns the projected messages untouched when there is no media', () => {
      const projected = projector.projectMediaStripped([user('just text')]);
      expect(projected).toEqual(project([user('just text')]));
    });

    it('preserves media introduced after the rejected-media snapshot', () => {
      const rejected = imageMessage('data:image/png;base64,OLD', 'old-id');
      const snapshot = projector.captureMediaStripSnapshot([rejected]);

      const projected = projector.projectMediaStripped(
        [rejected, imageMessage('data:image/png;base64,NEW', 'new-id')],
        snapshot,
      );

      const urls = projected
        .flatMap((message) => message.content)
        .filter((part) => part.type === 'image_url')
        .map((part) => part.imageUrl.url);
      expect(urls).toEqual(['data:image/png;base64,NEW']);
    });

    it('does not snapshot media dropped by the normal provider projection', () => {
      const url = 'data:image/png;base64,ORPHAN';
      const orphan: ContextMessage = {
        role: 'tool',
        content: [{ type: 'image_url', imageUrl: { url, id: 'orphan-id' } }],
        toolCalls: [],
        toolCallId: 'ghost',
      };
      const snapshot = projector.captureMediaStripSnapshot([
        user('go'),
        assistant('done'),
        orphan,
      ]);

      const projected = projector.projectMediaStripped(
        [imageMessage(url, 'orphan-id')],
        snapshot,
      );

      expect(
        projected
          .flatMap((message) => message.content)
          .some((part) => part.type === 'image_url'),
      ).toBe(true);
    });

    it('strips a new media container with the same provider-visible identity', () => {
      const snapshot = projector.captureMediaStripSnapshot([
        imageMessage('data:image/png;base64,SAME', 'same-id'),
      ]);

      const projected = projector.projectMediaStripped(
        [imageMessage('data:image/png;base64,SAME', 'same-id')],
        snapshot,
      );

      expect(
        projected
          .flatMap((message) => message.content)
          .some((part) => part.type === 'image_url'),
      ).toBe(false);
    });

    it('preserves a matching URL when its provider-visible id is different', () => {
      const url = 'https://example.test/media/image.png';
      const snapshot = projector.captureMediaStripSnapshot([imageMessage(url, 'old-id')]);

      const projected = projector.projectMediaStripped(
        [imageMessage(url, 'new-id')],
        snapshot,
      );

      const image = projected
        .flatMap((message) => message.content)
        .find((part) => part.type === 'image_url');
      expect(image).toMatchObject({ imageUrl: { url, id: 'new-id' } });
    });
  });
});
