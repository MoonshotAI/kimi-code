/**
 * Scenario: persisted and live message histories become user-visible chat turns.
 * Responsibilities: preserve plan-review content and derive its durable status.
 * Wiring: real wire mapper + messagesToTurns; no collaborators are stubbed.
 * Run: pnpm --filter @moonshot-ai/kimi-web test -- turn-logic.test.ts
 */
import { describe, expect, it } from 'vitest';
import type { AppMessage, AppMessageContent } from '../src/api/types';
import { toAppMessage } from '../src/api/daemon/mappers';
import type { WireApprovalResponse, WireMessage } from '../src/api/daemon/wire';
import { latestTodos } from '../src/composables/latestTodos';
import { messagesToTurns } from '../src/composables/messagesToTurns';
import type { ToolCall } from '../src/types';

function message(
  id: string,
  role: AppMessage['role'],
  content: AppMessageContent[],
  extra: Partial<AppMessage> = {},
): AppMessage {
  return {
    id,
    sessionId: 'session-1',
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

const PLAN_DISPLAY = {
  kind: 'plan_review',
  plan: '## Release plan\n\n1. Update the server\n2. Verify the web replay',
  path: '/workspace/plans/release.md',
  options: [
    { label: 'Safe rollout', description: 'Ship behind the existing boundary.' },
    { label: 'Direct rollout', description: 'Ship in one step.' },
  ],
};

function replayPlanTool(input: {
  approvalResult?: WireApprovalResponse;
  toolOutput?: unknown;
  isError?: boolean;
  sessionActive?: boolean;
}): ToolCall {
  const wireMessages: WireMessage[] = [
    {
      id: 'assistant-plan',
      session_id: 'session-1',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          tool_call_id: 'plan-call',
          tool_name: 'ExitPlanMode',
          input: {},
          tool_input_display: PLAN_DISPLAY,
          approval_result: input.approvalResult,
        },
      ],
      created_at: '2026-01-01T00:00:00.000Z',
      prompt_id: 'prompt-1',
    },
  ];
  if (input.toolOutput !== undefined) {
    wireMessages.push({
      id: 'tool-plan',
      session_id: 'session-1',
      role: 'tool',
      content: [
        {
          type: 'tool_result',
          tool_call_id: 'plan-call',
          output: input.toolOutput,
          is_error: input.isError,
        },
      ],
      created_at: '2026-01-01T00:00:01.000Z',
      prompt_id: 'prompt-1',
    });
  }

  const turns = messagesToTurns(
    wireMessages.map(toAppMessage),
    [],
    undefined,
    input.sessionActive ?? false,
  );
  const tool = turns[0]?.tools?.[0];
  if (tool === undefined) throw new Error('expected replayed plan tool');
  return tool;
}

describe('plan review history (durable message projection)', () => {
  it('keeps the plan pending when a live durable tool use has no decision yet', () => {
    const tool = replayPlanTool({ sessionActive: true });

    expect(tool.planReview).toEqual({
      plan: '## Release plan\n\n1. Update the server\n2. Verify the web replay',
      path: '/workspace/plans/release.md',
      options: [
        { label: 'Safe rollout', description: 'Ship behind the existing boundary.' },
        { label: 'Direct rollout', description: 'Ship in one step.' },
      ],
      status: 'pending',
      selectedLabel: undefined,
      feedback: undefined,
    });
  });

  it('keeps rejected plan content and feedback when replaying persisted messages', () => {
    const tool = replayPlanTool({
      approvalResult: {
        decision: 'rejected',
        selected_label: 'Reject and Exit',
      },
      toolOutput: 'Plan rejected by the user.',
      isError: true,
    });

    expect(tool.planReview).toMatchObject({
      status: 'rejected',
      plan: '## Release plan\n\n1. Update the server\n2. Verify the web replay',
      path: '/workspace/plans/release.md',
      selectedLabel: 'Reject and Exit',
    });
  });

  it('keeps approved plan content and selection when replaying persisted messages', () => {
    const tool = replayPlanTool({
      approvalResult: {
        decision: 'approved',
        selected_label: 'Safe rollout',
      },
      toolOutput: 'Plan saved to: /workspace/plans/release.md',
    });

    expect(tool.planReview).toMatchObject({
      status: 'approved',
      plan: '## Release plan\n\n1. Update the server\n2. Verify the web replay',
      selectedLabel: 'Safe rollout',
    });
  });

  it('marks a rejected plan as revision requested when persisted feedback asks for changes', () => {
    const tool = replayPlanTool({
      approvalResult: {
        decision: 'rejected',
        selected_label: 'Revise',
        feedback: 'Add rollback verification.',
      },
      toolOutput: 'Plan revision requested.',
      isError: true,
    });

    expect(tool.planReview).toMatchObject({
      status: 'revision_requested',
      feedback: 'Add rollback verification.',
    });
  });

  it('marks a cancelled persisted review as dismissed', () => {
    const tool = replayPlanTool({
      approvalResult: { decision: 'cancelled' },
      toolOutput: 'Plan review cancelled.',
      isError: true,
    });

    expect(tool.planReview?.status).toBe('dismissed');
  });

  it('marks a result-less plan as interrupted when the recorded tool interruption arrives', () => {
    const tool = replayPlanTool({
      toolOutput: 'Tool execution was interrupted before its result was recorded.',
      isError: true,
    });

    expect(tool.planReview?.status).toBe('interrupted');
  });

  it('marks an approved plan as failed when its tool result records an execution error', () => {
    const tool = replayPlanTool({
      approvalResult: { decision: 'approved' },
      toolOutput: 'Could not save the plan.',
      isError: true,
    });

    expect(tool.planReview?.status).toBe('failed');
  });

  it('marks an auto-approved plan as approved when its tool result succeeds', () => {
    const tool = replayPlanTool({
      toolOutput: 'Plan saved to: /workspace/plans/release.md',
    });

    expect(tool.planReview?.status).toBe('approved');
  });

  it('renders a live approval overlay as a synthetic pending plan before tool use arrives', () => {
    const turns = messagesToTurns(
      [],
      [],
      undefined,
      true,
      {
        'approval-1': {
          approvalId: 'approval-1',
          toolCallId: 'plan-call',
          turnId: 2,
          toolInputDisplay: PLAN_DISPLAY,
          renderSynthetic: true,
        },
      },
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.tools?.[0]?.planReview).toMatchObject({
      status: 'pending',
      plan: '## Release plan\n\n1. Update the server\n2. Verify the web replay',
    });
  });

  it('does not attach a reused plan overlay id to an older tool from another turn', () => {
    const turns = messagesToTurns(
      [
        message('old-assistant', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'call-1',
            toolName: 'bash',
            input: { command: 'pnpm test' },
          },
        ], { promptId: 'old-prompt' }),
        message('old-result', 'tool', [
          { type: 'toolResult', toolCallId: 'call-1', output: 'passed' },
        ], { promptId: 'old-prompt' }),
        message('next-user', 'user', [{ type: 'text', text: 'Review the new plan' }]),
      ],
      [],
      undefined,
      true,
      {
        'approval-new': {
          approvalId: 'approval-new',
          toolCallId: 'call-1',
          turnId: 2,
          toolInputDisplay: PLAN_DISPLAY,
          renderSynthetic: true,
        },
      },
    );

    expect(turns[0]?.tools?.[0]).toMatchObject({ name: 'bash', status: 'ok' });
    expect(turns[0]?.tools?.[0]?.planReview).toBeUndefined();
    expect(turns.at(-1)?.tools?.[0]?.planReview).toMatchObject({
      status: 'pending',
      plan: '## Release plan\n\n1. Update the server\n2. Verify the web replay',
    });
  });

  it('keeps a new pending plan when an older durable plan reused the same tool call id', () => {
    const turns = messagesToTurns(
      [
        message('old-plan', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'call-1',
            toolName: 'ExitPlanMode',
            input: {},
            toolInputDisplay: {
              kind: 'plan_review',
              plan: '## Old rejected plan',
            },
            approvalResult: {
              decision: 'rejected',
              selectedLabel: 'Reject and Exit',
            },
          },
        ], { promptId: 'old-prompt' }),
        message('old-plan-result', 'tool', [
          {
            type: 'toolResult',
            toolCallId: 'call-1',
            output: 'Old plan rejected.',
            isError: true,
          },
        ], { promptId: 'old-prompt' }),
        message('next-user', 'user', [{ type: 'text', text: 'Review a replacement plan' }]),
      ],
      [],
      undefined,
      true,
      {
        'approval-new': {
          approvalId: 'approval-new',
          toolCallId: 'call-1',
          turnId: 2,
          toolInputDisplay: {
            kind: 'plan_review',
            plan: '## New pending plan',
          },
          renderSynthetic: true,
        },
      },
    );

    expect(turns[0]?.tools?.[0]?.planReview).toMatchObject({
      status: 'rejected',
      plan: '## Old rejected plan',
    });
    expect(turns.at(-1)?.tools?.[0]?.planReview).toMatchObject({
      status: 'pending',
      plan: '## New pending plan',
    });
  });
});

describe('messagesToTurns', () => {
  it('merges an assistant turn and folds tool results into it', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'hello' }]),
        message('a1', 'assistant', [
          { type: 'thinking', thinking: 'plan' },
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'read', input: { path: 'src/a.ts' } },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'tool-1', output: 'alpha\nbeta' }]),
        message('a2', 'assistant', [{ type: 'text', text: 'done' }]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      thinking: 'plan',
      text: 'done',
    });
    expect(turns[1]?.tools).toMatchObject([
      { id: 'tool-1', status: 'ok', output: ['alpha', 'beta'] },
    ]);
  });

  it('surfaces a ReadMediaFile snapshot result as media', () => {
    // After a reload the daemon snapshot delivers a ReadMediaFile result as
    // raw content parts (the same shape the live tool.result stream carries),
    // so a resumed session must render the image card, not a generic tool card.
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'tool-9', toolName: 'ReadMediaFile', input: { path: 'shot.png' } },
        ]),
        message('t1', 'tool', [
          {
            type: 'toolResult',
            toolCallId: 'tool-9',
            output: [
              { type: 'text', text: '<image path="/tmp/shot.png">' },
              { type: 'image_url', imageUrl: { url: 'data:image/png;base64,QUJD' } },
              { type: 'text', text: '</image>' },
            ],
          },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[0]?.tools).toMatchObject([
      {
        id: 'tool-9',
        status: 'ok',
        media: {
          kind: 'image',
          url: 'data:image/png;base64,QUJD',
          path: '/tmp/shot.png',
          mimeType: 'image/png',
        },
      },
    ]);
  });

  it('splits assistant turns when prompt ids differ', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'one' }], { promptId: 'p1' }),
        message('a2', 'assistant', [{ type: 'text', text: 'two' }], { promptId: 'p2' }),
      ],
      [],
      undefined,
      false,
    );

    expect(turns.map((turn) => turn.text)).toEqual(['one', 'two']);
  });

  it('renders compaction summaries as divider turns', () => {
    const turns = messagesToTurns(
      [
        message('s1', 'assistant', [{ type: 'text', text: 'summary' }], {
          metadata: { origin: { kind: 'compaction_summary' } },
        }),
      ],
      [],
      undefined,
      false,
    );

    expect(turns).toMatchObject([{ role: 'compaction', text: 'summary' }]);
  });

  it('renders a live multi-member swarm inline as a tool card', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'run a swarm' }]),
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'swarm-1', toolName: 'AgentSwarm', input: {} },
        ]),
      ],
      [],
      undefined,
      true,
    );

    const assistant = turns.at(-1);
    expect(assistant?.tools).toContainEqual(
      expect.objectContaining({ id: 'swarm-1', name: 'AgentSwarm', status: 'running' }),
    );
    expect(assistant?.blocks ?? []).not.toContainEqual(
      expect.objectContaining({ kind: 'agentGroup' }),
    );
  });

  it('renders a completed multi-member swarm inline as a tool card', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'run a swarm' }]),
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'swarm-2', toolName: 'AgentSwarm', input: {} },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'swarm-2', output: 'all done' }]),
      ],
      [],
      undefined,
      false,
    );

    const assistant = turns.at(-1);
    expect(assistant?.tools).toContainEqual(
      expect.objectContaining({ id: 'swarm-2', name: 'AgentSwarm', status: 'ok' }),
    );
    expect(assistant?.blocks ?? []).not.toContainEqual(
      expect.objectContaining({ kind: 'agentGroup' }),
    );
  });

  it('renders a single subagent spawn as a tool card, not an agent block', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'go explore' }]),
        message('a1', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'agent-call-1',
            toolName: 'Agent',
            input: { description: 'explore the repo', prompt: 'list the top-level dirs' },
          },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'agent-call-1', output: 'done' }]),
      ],
      [],
      undefined,
      false,
    );

    const assistant = turns.at(-1);
    // The spawning `Agent` call renders as a normal tool card (args + result)…
    expect(assistant?.tools).toContainEqual(
      expect.objectContaining({ id: 'agent-call-1', name: 'Agent', status: 'ok' }),
    );
    // …and never as an inline agent/agentGroup block (live progress moves to
    // the right-side panel).
    expect(assistant?.blocks ?? []).not.toContainEqual(expect.objectContaining({ kind: 'agent' }));
    expect(assistant?.blocks ?? []).not.toContainEqual(
      expect.objectContaining({ kind: 'agentGroup' }),
    );
  });

  it('renders a `<video path>` text tag as a video attachment, not raw text', () => {
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'look at this' },
          {
            type: 'text',
            text: `<video path="/Users/me/.kimi-code/cache/${fileId}.mp4"></video>`,
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: 'user', text: 'look at this' });
    expect(turns[0]?.images).toEqual([
      { url: `/api/v1/files/${fileId}`, kind: 'video', alt: fileId, fileId },
    ]);
  });

  it('keeps the video tag as text when no file resolver is provided', () => {
    const tag =
      '<video path="/Users/me/.kimi-code/cache/f_01KWK39A0ZC8R2ATZEQMD8716C.mp4"></video>';
    const turns = messagesToTurns(
      [message('u1', 'user', [{ type: 'text', text: tag }])],
      [],
      undefined,
      false,
    );

    expect(turns[0]).toMatchObject({ role: 'user', text: tag });
    expect(turns[0]?.images).toBeUndefined();
  });

  it('leaves non-file-store media paths as text instead of fabricating a url', () => {
    // TUI/legacy cache names are not shaped like a file-store id (`f_…`), so the
    // tag must stay as text rather than becoming a broken /files/<name> request.
    const tag =
      '<video path="/tmp/550e8400-e29b-41d4-a716-446655440000-clip.mp4"></video>';
    const turns = messagesToTurns(
      [message('u1', 'user', [{ type: 'text', text: tag }])],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]).toMatchObject({ role: 'user', text: tag });
    expect(turns[0]?.images).toBeUndefined();
  });

  it('strips the hidden image-compression caption from a user bubble', () => {
    // The server persists this `<system>` note as its own text part next to a
    // compressed upload (buildImageCompressionCaption). It is model-facing
    // harness metadata and must never render as user-typed text.
    const caption =
      '<system>Image compressed to fit model limits: original 3024x1834 image/png (934 KB) -> ' +
      'sent 2000x1213 image/png (518 KB). Fine detail may be lost. The uncompressed original ' +
      'is saved at "/Users/me/.kimi-code/files/f_0000000000000000000000000"; if you need fine ' +
      'detail, call ReadMediaFile on that path with the region parameter to view a crop at full ' +
      'fidelity.</system>';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'look at this' },
          { type: 'text', text: caption },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: 'user', text: 'look at this' });
    expect(turns[0]?.text).not.toContain('<system>');
  });

  it('drops a caption-only text part and strips captions merged into prose', () => {
    const caption =
      '<system>Image compressed to fit model limits: original 100x100 image/png (1 KB) -> ' +
      'sent 100x100 image/png (1 KB). Fine detail may be lost.</system>';

    // Image-only upload: the caption is the sole text part, so nothing
    // user-typed remains and the bubble text is empty (the image still renders).
    const captionOnly = messagesToTurns(
      [message('u1', 'user', [{ type: 'text', text: caption }])],
      [],
      undefined,
      false,
    );
    expect(captionOnly[0]).toMatchObject({ role: 'user', text: '' });

    // TUI-paste style: a caption merged into the surrounding text segment is
    // stripped without eating the prose around it.
    const merged = messagesToTurns(
      [message('u2', 'user', [{ type: 'text', text: `before ${caption} after` }])],
      [],
      undefined,
      false,
    );
    expect(merged[0]?.text).not.toContain('<system>');
    expect(merged[0]?.text).toContain('before');
    expect(merged[0]?.text).toContain('after');
  });

  it('preserves a literal `<system>` block the user typed themselves', () => {
    // Only the image-compression caption is harness metadata. A `<system>` tag
    // the user pasted on purpose (e.g. an XML / prompt example) is their own
    // text, so it must reach the bubble and the edit/resend payload verbatim.
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'hi <system>some example markup</system> there' },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[0]?.text).toBe('hi <system>some example markup</system> there');
  });

  it('leaves ordinary user text and stray angle brackets untouched', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'a < b and c > d, no system tag here' },
        ]),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[0]).toMatchObject({ role: 'user', text: 'a < b and c > d, no system tag here' });
  });
});

describe('messagesToTurns resync dedup', () => {
  it('drops a resync-seeded copy that differs only by signature, progress, and part boundaries', () => {
    const turns = messagesToTurns(
      [
        // Persisted transcript copy: thinking carries the provider signature,
        // text split at the model's part boundary, plain tool_use.
        message(
          'a1',
          'assistant',
          [
            { type: 'thinking', thinking: 'let me check', signature: 'sig-abc' },
            { type: 'text', text: 'I will ' },
            { type: 'text', text: 'run ls' },
            { type: 'toolUse', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'ls' } },
          ],
          { promptId: 'p1' },
        ),
        // Resync seed from in_flight_turn: no signature, streams concatenated
        // into single parts, tool card carrying live progress outputLines.
        message(
          'seed',
          'assistant',
          [
            { type: 'thinking', thinking: 'let me check' },
            { type: 'text', text: 'I will run ls' },
            {
              type: 'toolUse',
              toolCallId: 'tool-1',
              toolName: 'bash',
              input: { command: 'ls' },
              outputLines: ['total 8'],
            },
          ],
          { promptId: 'p1' },
        ),
      ],
      [],
      undefined,
      true,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.thinking).toBe('let me check');
    expect(turns[0]?.text).toBe('I will \nrun ls');
    expect(turns[0]?.tools).toHaveLength(1);
    // The seed's live progress survives the dedup — the persisted card had none.
    expect(turns[0]?.tools?.[0]?.output).toEqual(['total 8']);
  });

  it('keeps the seeded message when the transcript has no copy of the current step yet', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'step one done' }], { promptId: 'p1' }),
        message('seed', 'assistant', [{ type: 'text', text: 'step two streami' }], {
          promptId: 'p1',
        }),
      ],
      [],
      undefined,
      true,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('step one done\nstep two streami');
  });

  it('merges a later durable plan display into a display-less live seed', () => {
    const turns = messagesToTurns(
      [
        message(
          'seed',
          'assistant',
          [
            {
              type: 'toolUse',
              toolCallId: 'plan-call',
              toolName: 'ExitPlanMode',
              input: {},
            },
          ],
          { promptId: 'p1' },
        ),
        message(
          'durable',
          'assistant',
          [
            {
              type: 'toolUse',
              toolCallId: 'plan-call',
              toolName: 'ExitPlanMode',
              input: {},
              toolInputDisplay: PLAN_DISPLAY,
            },
          ],
          { promptId: 'p1' },
        ),
      ],
      [],
      undefined,
      true,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.tools).toHaveLength(1);
    expect(turns[0]?.tools?.[0]?.planReview).toMatchObject({
      status: 'pending',
      plan: '## Release plan\n\n1. Update the server\n2. Verify the web replay',
    });
  });

  it('keeps a following step whose content differs', () => {
    const turns = messagesToTurns(
      [
        message(
          'a1',
          'assistant',
          [
            { type: 'text', text: 'step one' },
            { type: 'toolUse', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'ls' } },
          ],
          { promptId: 'p1' },
        ),
        message('a2', 'assistant', [{ type: 'text', text: 'step two' }], { promptId: 'p1' }),
      ],
      [],
      undefined,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('step one\nstep two');
  });

  it('does not overwrite a settled tool result with seed progress', () => {
    const turns = messagesToTurns(
      [
        message(
          'a1',
          'assistant',
          [{ type: 'toolUse', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'ls' } }],
          { promptId: 'p1' },
        ),
        message('t1', 'tool', [
          { type: 'toolResult', toolCallId: 'tool-1', output: 'real result' },
        ]),
        message(
          'seed',
          'assistant',
          [
            {
              type: 'toolUse',
              toolCallId: 'tool-1',
              toolName: 'bash',
              input: { command: 'ls' },
              outputLines: ['stale progress'],
            },
          ],
          { promptId: 'p1' },
        ),
      ],
      [],
      undefined,
      false,
    );

    expect(turns[0]?.tools).toHaveLength(1);
    expect(turns[0]?.tools?.[0]?.output).toEqual(['real result']);
  });

  it('drops a seed whose finished parallel tools left running_tools (subset of the persisted message)', () => {
    const turns = messagesToTurns(
      [
        message(
          'a1',
          'assistant',
          [
            { type: 'text', text: 'running two tools' },
            { type: 'toolUse', toolCallId: 'tool-a', toolName: 'bash', input: { command: 'a' } },
            { type: 'toolUse', toolCallId: 'tool-b', toolName: 'bash', input: { command: 'b' } },
          ],
          { promptId: 'p1' },
        ),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'tool-a', output: 'a done' }]),
        // tool-a finished and left running_tools; the seed carries only tool-b.
        message(
          'seed',
          'assistant',
          [
            { type: 'text', text: 'running two tools' },
            {
              type: 'toolUse',
              toolCallId: 'tool-b',
              toolName: 'bash',
              input: { command: 'b' },
              outputLines: ['b progress'],
            },
          ],
          { promptId: 'p1' },
        ),
      ],
      [],
      undefined,
      true,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('running two tools');
    expect(turns[0]?.tools).toMatchObject([
      { id: 'tool-a', status: 'ok', output: ['a done'] },
      { id: 'tool-b', status: 'running', output: ['b progress'] },
    ]);
  });
});

describe('latestTodos', () => {
  it('returns the newest todo write and ignores later read-only queries', () => {
    expect(
      latestTodos([
        message('a1', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'todo-1',
            toolName: 'TodoWrite',
            input: { todos: [{ title: 'old', status: 'pending' }] },
          },
        ]),
        message('a2', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'todo-2',
            toolName: 'TodoWrite',
            input: JSON.stringify({ todos: [{ content: 'new', status: 'completed' }] }),
          },
        ]),
        message('a3', 'assistant', [
          { type: 'toolUse', toolCallId: 'todo-3', toolName: 'TodoRead', input: {} },
        ]),
      ]),
    ).toEqual([{ title: 'new', status: 'done' }]);
  });
});

describe('messagesToTurns cron', () => {
  it('renders a cron_job injection as a cron notice with the unwrapped prompt', () => {
    const envelope =
      '<cron-fire jobId="a3f9c2" cron="*/5 * * * *" recurring="true" coalescedCount="2" stale="false">\n' +
      '<prompt>\nCheck the deploy status\n</prompt>\n</cron-fire>';
    const turns = messagesToTurns(
      [
        message('c1', 'user', [{ type: 'text', text: envelope }], {
          metadata: {
            origin: {
              kind: 'cron_job',
              jobId: 'a3f9c2',
              cron: '*/5 * * * *',
              recurring: true,
              coalescedCount: 2,
              stale: false,
            },
          },
        }),
      ],
      [],
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      role: 'cron',
      text: 'Check the deploy status',
      cron: {
        jobId: 'a3f9c2',
        cron: '*/5 * * * *',
        recurring: true,
        coalescedCount: 2,
        stale: false,
      },
    });
  });

  it('renders a cron_missed injection as a cron notice carrying the missed count', () => {
    const envelope = '<cron-fire missed="3">\nDaily report\n</cron-fire>';
    const turns = messagesToTurns(
      [
        message('c2', 'user', [{ type: 'text', text: envelope }], {
          metadata: { origin: { kind: 'cron_missed', count: 3 } },
        }),
      ],
      [],
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      role: 'cron',
      text: 'Daily report',
      cron: { missedCount: 3 },
    });
  });

  it('does not also render a user bubble for a cron injection', () => {
    const turns = messagesToTurns(
      [
        message(
          'c3',
          'user',
          [{ type: 'text', text: '<cron-fire>\n<prompt>\nhi\n</prompt>\n</cron-fire>' }],
          {
            metadata: {
              origin: {
                kind: 'cron_job',
                jobId: 'j',
                cron: '* * * * *',
                recurring: true,
                coalescedCount: 1,
                stale: false,
              },
            },
          },
        ),
      ],
      [],
    );

    expect(turns.some((t) => t.role === 'user')).toBe(false);
    expect(turns).toHaveLength(1);
  });


  it('flushes an idle cron fire as its own turn even when no prompt ids are present', () => {
    const envelope =
      '<cron-fire jobId="j" cron="* * * * *" recurring="true" coalescedCount="1" stale="false">\n' +
      '<prompt>\nCheck BTC\n</prompt>\n</cron-fire>';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'hi' }]),
        message('a1', 'assistant', [{ type: 'text', text: 'answer' }]),
        message('c1', 'user', [{ type: 'text', text: envelope }], {
          metadata: {
            origin: {
              kind: 'cron_job',
              jobId: 'j',
              cron: '* * * * *',
              recurring: true,
              coalescedCount: 1,
              stale: false,
            },
          },
        }),
        message('a2', 'assistant', [{ type: 'text', text: 'btc is 62k' }]),
      ],
      [],
    );

    // No prompt ids anywhere (REST-shaped): the cron still becomes its own
    // turn, and the cron-triggered reply does not merge into the first answer.
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'cron', 'assistant']);
  });
});
