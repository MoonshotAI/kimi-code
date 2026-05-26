import type {
  AgentReplayRecord,
  BackgroundTaskInfo,
  ContentPart,
  PromptOrigin,
  Role,
  ToolCall,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { projectReplayRecords } from '#/tui/actions/replay-ops';

interface ReplayMessageExtra {
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly origin?: PromptOrigin;
  readonly isError?: boolean;
}

function message(
  role: Role,
  content: readonly ContentPart[],
  extra: ReplayMessageExtra = {},
): AgentReplayRecord {
  return {
    type: 'message',
    message: {
      role,
      content: [...content],
      toolCalls: [...(extra.toolCalls ?? [])],
      toolCallId: extra.toolCallId,
      origin: extra.origin,
      isError: extra.isError,
    },
  };
}

function backgroundTask(
  taskId: string,
  description: string,
  status: BackgroundTaskInfo['status'] = 'running',
): BackgroundTaskInfo {
  return {
    taskId,
    command: `[agent] ${description}`,
    description,
    status,
    pid: 0,
    exitCode: status === 'completed' ? 0 : null,
    startedAt: 1,
    endedAt: status === 'running' || status === 'awaiting_approval' ? null : 2,
  };
}

describe('projectReplayRecords', () => {
  it('projects only the most recent ten visible user turns from agent replay', () => {
    const projected = projectReplayRecords(
      Array.from({ length: 12 }, (_, index) => [
        message('user', [{ type: 'text', text: `prompt ${index}` }]),
        message('assistant', [{ type: 'text', text: `answer ${index}` }]),
      ]).flat(),
    );

    expect(
      projected.entries.filter((entry) => entry.kind === 'user').map((entry) => entry.content),
    ).toEqual([
      'prompt 2',
      'prompt 3',
      'prompt 4',
      'prompt 5',
      'prompt 6',
      'prompt 7',
      'prompt 8',
      'prompt 9',
      'prompt 10',
      'prompt 11',
    ]);
    expect(
      projected.entries.filter((entry) => entry.kind === 'assistant').map((entry) => entry.content),
    ).toEqual([
      'answer 2',
      'answer 3',
      'answer 4',
      'answer 5',
      'answer 6',
      'answer 7',
      'answer 8',
      'answer 9',
      'answer 10',
      'answer 11',
    ]);
  });

  it('does not count model-triggered skill activations as user turns', () => {
    const records: AgentReplayRecord[] = Array.from({ length: 9 }, (_, index) => [
      message('user', [{ type: 'text', text: `prompt ${index}` }]),
      message('assistant', [{ type: 'text', text: `answer ${index}` }]),
    ]).flat();
    for (const index of [0, 1, 2, 3]) {
      records.push(
        message('user', [{ type: 'text', text: `Skill body ${index}` }], {
          origin: {
            kind: 'skill_activation',
            activationId: `act-${index}`,
            skillName: 'review',
            trigger: 'model-tool',
          },
        }),
      );
    }

    const projected = projectReplayRecords(records);

    expect(
      projected.entries.filter((entry) => entry.kind === 'user').map((entry) => entry.content),
    ).toEqual([
      'prompt 0',
      'prompt 1',
      'prompt 2',
      'prompt 3',
      'prompt 4',
      'prompt 5',
      'prompt 6',
      'prompt 7',
      'prompt 8',
    ]);
    expect(projected.entries.filter((entry) => entry.kind === 'skill_activation')).toHaveLength(4);
  });

  it('projects UserPromptSubmit hook results as assistant transcript entries', () => {
    const hookResult =
      '<hook_result hook_event="UserPromptSubmit">\nhook response 1\n</hook_result>\n<hook_result hook_event="UserPromptSubmit">\nhook response 2\n</hook_result>';
    const projected = projectReplayRecords([
      message('user', [{ type: 'text', text: 'prompt' }]),
      message('user', [{ type: 'text', text: hookResult }], {
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      }),
      message('assistant', [{ type: 'text', text: 'model response' }]),
    ]);

    expect(projected.entries.map((e) => [e.kind, e.content])).toEqual([
      ['user', 'prompt'],
      [
        'assistant',
        '*UserPromptSubmit hook*\n\nhook response 1\n\n*UserPromptSubmit hook*\n\nhook response 2',
      ],
      ['assistant', 'model response'],
    ]);
  });

  it('projects blocking UserPromptSubmit hook results from replayed assistant entries', () => {
    const hookResult =
      '<hook_result hook_event="UserPromptSubmit">\nblocked reason\n</hook_result>';
    const projected = projectReplayRecords([
      message('user', [{ type: 'text', text: 'blocked prompt' }]),
      message('assistant', [{ type: 'text', text: hookResult }], {
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      }),
    ]);

    expect(projected.entries.map((e) => [e.kind, e.content])).toEqual([
      ['user', 'blocked prompt'],
      ['assistant', '*UserPromptSubmit hook blocked*\n\nblocked reason'],
    ]);
  });

  it('does not infer blocked UserPromptSubmit hook results from assistant role alone', () => {
    const hookResult =
      '<hook_result hook_event="UserPromptSubmit">\nlegacy hook response\n</hook_result>';
    const projected = projectReplayRecords([
      message('user', [{ type: 'text', text: 'prompt' }]),
      message('assistant', [{ type: 'text', text: hookResult }], {
        origin: { kind: 'hook_result', event: 'UserPromptSubmit' },
      }),
    ]);

    expect(projected.entries.map((e) => [e.kind, e.content])).toEqual([
      ['user', 'prompt'],
      ['assistant', '*UserPromptSubmit hook*\n\nlegacy hook response'],
    ]);
  });

  it('preserves literal hook result XML from normal assistant replies', () => {
    const hookResult =
      '<hook_result hook_event="UserPromptSubmit">\nhook response\n</hook_result>';
    const projected = projectReplayRecords([
      message('user', [{ type: 'text', text: 'show me the hook XML' }]),
      message('assistant', [{ type: 'text', text: hookResult }]),
    ]);

    expect(projected.entries.map((e) => [e.kind, e.content])).toEqual([
      ['user', 'show me the hook XML'],
      ['assistant', hookResult],
    ]);
  });

  it('projects user messages plus thinking and assistant content', () => {
    const projected = projectReplayRecords([
      message('user', [{ type: 'text', text: 'hello' }]),
      message('assistant', [
        { type: 'think', think: 'thinking...' },
        { type: 'text', text: 'answer' },
      ]),
    ]);

    expect(projected.entries.map((e) => [e.kind, e.content])).toEqual([
      ['user', 'hello'],
      ['thinking', 'thinking...'],
      ['assistant', 'answer'],
    ]);
  });

  it('projects skill activation origin metadata without exposing the full prompt', () => {
    const projected = projectReplayRecords([
      message(
        'user',
        [{ type: 'text', text: 'Review the requested file.\n\nUser request:\nsrc/app.ts' }],
        {
          origin: {
            kind: 'skill_activation',
            activationId: 'act-1',
            skillName: 'review',
            skillArgs: 'src/app.ts',
            trigger: 'user-slash',
          },
        },
      ),
    ]);

    expect(projected.entries).toHaveLength(1);
    expect(projected.entries[0]).toEqual(
      expect.objectContaining({
        kind: 'skill_activation',
        content: 'Activated skill: review',
        skillActivationId: 'act-1',
        skillName: 'review',
        skillArgs: 'src/app.ts',
      }),
    );
    expect(JSON.stringify(projected.entries)).not.toContain('Review the requested file');
  });

  it('deduplicates replayed skill activation cards by activation id', () => {
    const record = message('user', [{ type: 'text', text: 'Skill body' }], {
      origin: {
        kind: 'skill_activation',
        activationId: 'act-1',
        skillName: 'review',
        trigger: 'user-slash',
      },
    });

    const projected = projectReplayRecords([record, record]);

    expect(projected.entries).toHaveLength(1);
    expect(projected.entries[0]).toEqual(
      expect.objectContaining({
        kind: 'skill_activation',
        skillActivationId: 'act-1',
        skillName: 'review',
      }),
    );
  });

  it('projects background task notifications as status rows', () => {
    const notificationXml = [
      '<notification id="task:agent-bg123:completed" category="task" type="task.completed" source_kind="background_task" source_id="agent-bg123">',
      'Title: Background agent completed',
      'Severity: info',
      'Optimize summary completed.',
      '<task-notification>',
      'Subagent detailed output should stay out of the transcript row.',
      '</task-notification>',
      '</notification>',
    ].join('\n');
    const projected = projectReplayRecords([
      message('assistant', [], {
        toolCalls: [
          {
            type: 'function',
            id: 'call_agent',
            name: 'Agent',
              arguments: JSON.stringify({
                description: 'Optimize summary',
                subagent_type: 'coder',
                run_in_background: true,
              }),
          },
        ],
      }),
      message('tool', [
        {
          type: 'text',
          text: [
            'task_id: agent-bg123',
            'status: running',
            'agent_id: agent-child123',
            'actual_subagent_type: coder',
            'automatic_notification: true',
            '',
            'description: Optimize summary',
          ].join('\n'),
        },
      ], {
        toolCallId: 'call_agent',
      }),
      message('user', [{ type: 'text', text: notificationXml }], {
        origin: {
          kind: 'background_task',
          taskId: 'agent-bg123',
          status: 'completed',
          notificationId: 'task:agent-bg123:completed',
        },
      }),
    ], [backgroundTask('agent-bg123', 'Optimize summary', 'completed')]);

    expect(projected.entries.map((entry) => [entry.kind, entry.content])).toEqual([
      ['tool_call', ''],
      ['status', 'agent completed in background'],
    ]);
    expect(projected.entries[1]?.backgroundAgentStatus).toMatchObject({
      phase: 'completed',
      headline: 'agent completed in background',
      detail: 'Optimize summary',
    });
    expect(JSON.stringify(projected.entries)).not.toContain('<notification');
    expect(JSON.stringify(projected.entries)).not.toContain('Subagent detailed output');
  });

  it('uses background notification origin over XML attributes', () => {
    const projected = projectReplayRecords([
      message('user', [
        {
          type: 'text',
          text: [
            '<notification id="task:wrong:completed" category="task" type="task.completed" source_kind="background_task" source_id="wrong">',
            'Title: Background agent completed',
            'Severity: info',
            'Optimize ch03 lost.',
            '</notification>',
          ].join('\n'),
        },
      ], {
        origin: {
          kind: 'background_task',
          taskId: 'agent-real',
          status: 'lost',
          notificationId: 'task:agent-real:lost',
        },
      }),
    ], [backgroundTask('agent-real', 'Real task description', 'lost')]);

    expect(projected.entries).toHaveLength(1);
    expect(projected.entries[0]).toEqual(
      expect.objectContaining({
        kind: 'status',
        content: 'agent lost in background',
        backgroundAgentStatus: expect.objectContaining({
          phase: 'failed',
          detail: 'Real task description',
        }),
      }),
    );
  });

  it('renders multimodal user parts as stable placeholders', () => {
    const projected = projectReplayRecords([
      message('user', [
        { type: 'text', text: 'look ' },
        { type: 'image_url', imageUrl: { url: 'file:///tmp/a.png' } },
        { type: 'video_url', videoUrl: { url: 'file:///tmp/a.mov' } },
      ]),
    ]);

    expect(projected.entries[0]?.content).toBe(
      'look <image url="file:///tmp/a.png"><video url="file:///tmp/a.mov">',
    );
  });

  it('summarizes data URLs in resumed multimodal user parts', () => {
    const projected = projectReplayRecords([
      message('user', [
        { type: 'text', text: 'look ' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,qrs=' } },
        { type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AQIDBA==' } },
      ]),
    ]);

    expect(projected.entries[0]?.content).toBe('look [image image/png, 2 B][video video/mp4, 4 B]');
    expect(projected.entries[0]?.content).not.toContain('qrs=');
    expect(projected.entries[0]?.content).not.toContain('AQIDBA==');
  });

  it('pairs tool results with their tool call entry', () => {
    const projected = projectReplayRecords([
      message('assistant', [], {
        toolCalls: [
          {
            type: 'function',
            id: 'tc_1',
            name: 'Bash',
              arguments: '{"command":"pwd"}',
          },
        ],
      }),
      message('tool', [{ type: 'text', text: 'done' }], {
        toolCallId: 'tc_1',
      }),
    ]);

    expect(projected.entries).toHaveLength(1);
    expect(projected.entries[0]?.toolCallData).toMatchObject({
      id: 'tc_1',
      name: 'Bash',
      result: { tool_call_id: 'tc_1', output: 'done' },
    });
  });

  it('preserves failed tool result state', () => {
    const projected = projectReplayRecords([
      message('assistant', [], {
        toolCalls: [
          {
            type: 'function',
            id: 'tc_1',
            name: 'Bash',
              arguments: '{"command":"false"}',
          },
        ],
      }),
      message('tool', [{ type: 'text', text: 'failed' }], {
        toolCallId: 'tc_1',
        isError: true,
      }),
    ]);

    expect(projected.entries[0]?.toolCallData?.result).toMatchObject({
      tool_call_id: 'tc_1',
      output: 'failed',
      is_error: true,
    });
  });

  it('projects resumed assistant text, tool call, and tool result records in order', () => {
    const projected = projectReplayRecords([
      message('user', [{ type: 'text', text: 'try call a tool' }]),
      message(
        'assistant',
        [
          { type: 'think', think: 'I should call Bash.' },
          { type: 'text', text: 'Calling Bash now.' },
        ],
        {
          toolCalls: [
            {
              type: 'function',
              id: 'call_resume_bash',
              name: 'Bash',
                arguments: '{"command":"echo ok"}',
            },
          ],
        },
      ),
      message('tool', [{ type: 'text', text: 'ok' }], {
        toolCallId: 'call_resume_bash',
      }),
    ]);

    expect(projected.entries.map((entry) => [entry.kind, entry.content])).toEqual([
      ['user', 'try call a tool'],
      ['thinking', 'I should call Bash.'],
      ['assistant', 'Calling Bash now.'],
      ['tool_call', ''],
    ]);
    expect(projected.entries[3]?.toolCallData).toMatchObject({
      id: 'call_resume_bash',
      name: 'Bash',
      args: { command: 'echo ok' },
      result: { tool_call_id: 'call_resume_bash', output: 'ok' },
    });
  });

  it('keeps media-bearing tool results as a JSON envelope', () => {
    const mediaContent: ContentPart[] = [
      { type: 'text', text: '<image path="/tmp/a.png">' },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,QUJD' } },
      { type: 'text', text: '</image>' },
    ];
    const projected = projectReplayRecords([
      message('assistant', [], {
        toolCalls: [
          {
            type: 'function',
            id: 'tc_media',
            name: 'ReadMediaFile',
              arguments: '{"path":"/tmp/a.png"}',
          },
        ],
      }),
      message('tool', mediaContent, {
        toolCallId: 'tc_media',
      }),
    ]);

    const output = projected.entries[0]?.toolCallData?.result?.output ?? '';
    expect(JSON.parse(output)).toEqual(mediaContent);
  });

  it('projects plan, permission, and approval replay records as notices', () => {
    const projected = projectReplayRecords([
      { type: 'plan_updated', enabled: true },
      { type: 'permission_updated', mode: 'auto' },
      { type: 'permission_updated', mode: 'yolo' },
      { type: 'permission_updated', mode: 'manual' },
      {
        type: 'approval_result',
        record: {
          turnId: 0,
          toolCallId: 'call_bash',
          action: 'run command',
          toolName: 'Bash',
          result: {
            decision: 'approved',
            scope: 'session',
            selectedLabel: 'Approve for this session',
          },
        },
      },
      { type: 'plan_updated', enabled: false },
    ]);

    expect(projected.entries.map((e) => [e.kind, e.renderMode, e.content])).toEqual([
      ['status', 'notice', 'Plan mode: ON'],
      ['status', 'notice', 'Permission mode: auto'],
      ['status', 'notice', 'YOLO mode: ON'],
      ['status', 'notice', 'YOLO mode: OFF'],
      ['status', 'notice', 'Approved for session: run command'],
      ['status', 'notice', 'Plan mode: OFF'],
    ]);
    expect(projected.entries[2]?.detail).toBe(
      'All actions will be approved automatically. Use with caution.',
    );
  });

  it('ignores config replay records and system injections', () => {
    const projected = projectReplayRecords([
      { type: 'config_updated', config: { thinkingLevel: 'off' } },
      message('user', [{ type: 'text', text: 'ignore by origin' }], {
        origin: { kind: 'injection', variant: 'plan_mode' },
      }),
      message('user', [{ type: 'text', text: 'visible' }]),
    ]);

    expect(projected.entries.map((e) => [e.kind, e.content])).toEqual([['user', 'visible']]);
  });
});
