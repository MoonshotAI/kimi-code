import type { DisplayEffect, DisplayEvent, DisplayState } from '../../src';

export interface DisplayReducerFixture {
  name: string;
  events: DisplayEvent[];
  expectedState: DisplayState;
  expectedEffects: DisplayEffect[];
}

const emptyTokenUsage = {
  inputOther: 0,
  output: 0,
  inputCacheRead: 0,
  inputCacheCreation: 0,
};

export const displayReducerFixtures = [
  {
    name: 'streams assistant text and thinking into a completed turn',
    events: [
      { type: 'turn.begin', userText: 'draft' },
      { type: 'step.begin', n: 1 },
      { type: 'content.append', kind: 'thinking', text: 'Inspect' },
      { type: 'content.append', kind: 'text', text: 'Answer' },
      { type: 'turn.complete' },
    ],
    expectedState: {
      messages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'draft' }], status: 'completed' },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [],
          steps: [
            {
              id: 'step-1',
              n: 1,
              parts: [
                { type: 'thinking', text: 'Inspect', finished: true },
                { type: 'text', text: 'Answer', finished: true },
              ],
            },
          ],
          status: 'completed',
        },
      ],
      plan: null,
      status: null,
      pendingApprovals: [],
      tokenUsage: emptyTokenUsage,
      activeTokenUsage: emptyTokenUsage,
      availableCommands: [],
      isStreaming: false,
      isCompacting: false,
    },
    expectedEffects: [{ type: 'ClearApprovals' }],
  },
  {
    name: 'tracks tool calls, rich display blocks, and file tracking effects',
    events: [
      { type: 'turn.begin', userText: 'edit' },
      { type: 'step.begin', n: 1 },
      { type: 'tool.call', id: 'tool-1', name: 'Shell', argumentsText: '{"command":"pwd"}', status: 'running' },
      {
        type: 'tool.result',
        id: 'tool-1',
        isError: false,
        output: '/repo',
        message: 'pwd',
        displayBlocks: [
          { type: 'brief', text: 'Current directory' },
          { type: 'diff', path: 'src/a.ts', oldText: 'old', newText: 'new' },
        ],
      },
      { type: 'turn.complete' },
    ],
    expectedState: {
      messages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'edit' }], status: 'completed' },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [],
          steps: [
            {
              id: 'step-1',
              n: 1,
              parts: [
                {
                  type: 'tool-call',
                  id: 'tool-1',
                  name: 'Shell',
                  argumentsText: '{"command":"pwd"}',
                  status: 'success',
                  resultText: '/repo',
                  displayBlocks: [
                    { type: 'brief', text: 'Current directory' },
                    { type: 'diff', path: 'src/a.ts', oldText: 'old', newText: 'new' },
                  ],
                },
              ],
            },
          ],
          status: 'completed',
        },
      ],
      plan: null,
      status: null,
      pendingApprovals: [],
      tokenUsage: emptyTokenUsage,
      activeTokenUsage: emptyTokenUsage,
      availableCommands: [],
      isStreaming: false,
      isCompacting: false,
    },
    expectedEffects: [
      { type: 'TrackFiles', paths: ['src/a.ts'] },
      { type: 'ClearApprovals' },
    ],
  },
  {
    name: 'keeps plan, status, usage, and available commands with display effects',
    events: [
      { type: 'turn.begin', userText: 'status' },
      { type: 'step.begin', n: 1 },
      {
        type: 'plan.replace',
        plan: {
          entries: [
            { content: 'Inspect', status: 'completed', priority: 'high' },
            { content: 'Implement', status: 'in_progress' },
          ],
        },
      },
      {
        type: 'status.update',
        status: {
          contextUsage: 0.5,
          contextTokens: 50,
          maxContextTokens: 100,
          tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
          messageId: 'msg-1',
        },
      },
      { type: 'usage.add', usage: { inputOther: 0, output: 5, inputCacheRead: 0, inputCacheCreation: 0 } },
      {
        type: 'available_commands.update',
        commands: [
          { name: 'review', description: 'Review changes', group: 'code' },
          { name: 'test', description: 'Run tests' },
        ],
      },
      { type: 'turn.complete' },
    ],
    expectedState: {
      messages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'status' }], status: 'completed' },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [],
          steps: [
            {
              id: 'step-1',
              n: 1,
              parts: [
                {
                  type: 'plan',
                  plan: {
                    entries: [
                      { content: 'Inspect', status: 'completed', priority: 'high' },
                      { content: 'Implement', status: 'in_progress' },
                    ],
                  },
                },
                {
                  type: 'status',
                  status: {
                    contextUsage: 0.5,
                    contextTokens: 50,
                    maxContextTokens: 100,
                    tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
                    messageId: 'msg-1',
                  },
                },
              ],
            },
          ],
          status: 'completed',
        },
      ],
      plan: {
        entries: [
          { content: 'Inspect', status: 'completed', priority: 'high' },
          { content: 'Implement', status: 'in_progress' },
        ],
      },
      status: {
        contextUsage: 0.5,
        contextTokens: 50,
        maxContextTokens: 100,
        tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
        messageId: 'msg-1',
      },
      pendingApprovals: [],
      tokenUsage: { inputOther: 1, output: 7, inputCacheRead: 3, inputCacheCreation: 4 },
      activeTokenUsage: emptyTokenUsage,
      availableCommands: [
        { name: 'review', description: 'Review changes', group: 'code' },
        { name: 'test', description: 'Run tests' },
      ],
      isStreaming: false,
      isCompacting: false,
    },
    expectedEffects: [
      {
        type: 'UpdateStatus',
        status: {
          contextUsage: 0.5,
          contextTokens: 50,
          maxContextTokens: 100,
          tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
          messageId: 'msg-1',
        },
      },
      {
        type: 'UpdateAvailableCommands',
        commands: [
          { name: 'review', description: 'Review changes', group: 'code' },
          { name: 'test', description: 'Run tests' },
        ],
      },
      { type: 'ClearApprovals' },
    ],
  },
  {
    name: 'opens and resolves approval requests without leaving stale pending approvals',
    events: [
      { type: 'turn.begin', userText: 'approve' },
      {
        type: 'approval.request',
        request: {
          type: 'approval',
          requestId: 0,
          toolCallId: 'tool-1',
          sender: 'agent',
          action: 'Edit',
          description: 'Edit a file',
          displayBlocks: [{ type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }],
          options: [{ optionId: 'allow', name: 'Allow', kind: 'approve' }],
        },
      },
      { type: 'approval.resolved', requestId: 0 },
      { type: 'turn.complete' },
    ],
    expectedState: {
      messages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'approve' }], status: 'completed' },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [],
          steps: [
            {
              id: 'step-1',
              n: 1,
              parts: [
                {
                  type: 'approval',
                  requestId: 0,
                  toolCallId: 'tool-1',
                  sender: 'agent',
                  action: 'Edit',
                  description: 'Edit a file',
                  displayBlocks: [{ type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }],
                  options: [{ optionId: 'allow', name: 'Allow', kind: 'approve' }],
                },
              ],
            },
          ],
          status: 'completed',
        },
      ],
      plan: null,
      status: null,
      pendingApprovals: [],
      tokenUsage: emptyTokenUsage,
      activeTokenUsage: emptyTokenUsage,
      availableCommands: [],
      isStreaming: false,
      isCompacting: false,
    },
    expectedEffects: [
      {
        type: 'OpenApproval',
        request: {
          type: 'approval',
          requestId: 0,
          toolCallId: 'tool-1',
          sender: 'agent',
          action: 'Edit',
          description: 'Edit a file',
          displayBlocks: [{ type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }],
          options: [{ optionId: 'allow', name: 'Allow', kind: 'approve' }],
        },
      },
      { type: 'ClearApprovals' },
    ],
  },
  {
    name: 'records compaction lifecycle and interruptions as terminal display parts',
    events: [
      { type: 'turn.begin', userText: 'compact' },
      { type: 'step.begin', n: 1 },
      { type: 'compaction.begin' },
      { type: 'compaction.end', status: 'completed' },
      { type: 'turn.interrupted', reason: 'STOPPED_BY_USER', message: 'Stopped by user.' },
    ],
    expectedState: {
      messages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'compact' }], status: 'completed' },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [],
          steps: [
            {
              id: 'step-1',
              n: 1,
              parts: [
                { type: 'compaction', status: 'running' },
                { type: 'compaction', status: 'completed' },
                { type: 'interrupt', reason: 'STOPPED_BY_USER', message: 'Stopped by user.' },
              ],
            },
          ],
          status: 'interrupted',
        },
      ],
      plan: null,
      status: null,
      pendingApprovals: [],
      tokenUsage: emptyTokenUsage,
      activeTokenUsage: emptyTokenUsage,
      availableCommands: [],
      isStreaming: false,
      isCompacting: false,
    },
    expectedEffects: [{ type: 'ClearApprovals' }],
  },
  {
    name: 'nests subagent child steps under the parent task tool and forwards child effects',
    events: [
      { type: 'turn.begin', userText: 'delegate' },
      { type: 'step.begin', n: 1 },
      { type: 'tool.call', id: 'task-1', name: 'Task', argumentsText: '{"prompt":"inspect"}', status: 'running' },
      { type: 'subagent.event', parentToolCallId: 'task-1', event: { type: 'step.begin', n: 1 } },
      { type: 'subagent.event', parentToolCallId: 'task-1', event: { type: 'content.append', kind: 'text', text: 'child output' } },
      {
        type: 'subagent.event',
        parentToolCallId: 'task-1',
        event: {
          type: 'status.update',
          status: {
            contextUsage: 0.25,
            contextTokens: 25,
            maxContextTokens: 100,
            tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
            messageId: null,
          },
        },
      },
      {
        type: 'subagent.event',
        parentToolCallId: 'task-1',
        event: {
          type: 'approval.request',
          request: {
            type: 'approval',
            requestId: 'child-approval',
            toolCallId: 'child-tool',
            sender: 'agent',
            action: 'Shell',
            description: 'Run child command',
          },
        },
      },
      { type: 'subagent.event', parentToolCallId: 'task-1', event: { type: 'approval.resolved', requestId: 'child-approval' } },
      { type: 'turn.complete' },
    ],
    expectedState: {
      messages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'delegate' }], status: 'completed' },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [],
          steps: [
            {
              id: 'step-1',
              n: 1,
              parts: [
                {
                  type: 'tool-call',
                  id: 'task-1',
                  name: 'Task',
                  argumentsText: '{"prompt":"inspect"}',
                  status: 'running',
                  children: [
                    {
                      id: 'step-1',
                      n: 1,
                      parts: [
                        { type: 'text', text: 'child output' },
                        {
                          type: 'status',
                          status: {
                            contextUsage: 0.25,
                            contextTokens: 25,
                            maxContextTokens: 100,
                            tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
                            messageId: null,
                          },
                        },
                        {
                          type: 'approval',
                          requestId: 'child-approval',
                          toolCallId: 'child-tool',
                          sender: 'agent',
                          action: 'Shell',
                          description: 'Run child command',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
          status: 'completed',
        },
      ],
      plan: null,
      status: null,
      pendingApprovals: [],
      tokenUsage: emptyTokenUsage,
      activeTokenUsage: emptyTokenUsage,
      availableCommands: [],
      isStreaming: false,
      isCompacting: false,
    },
    expectedEffects: [
      {
        type: 'UpdateStatus',
        status: {
          contextUsage: 0.25,
          contextTokens: 25,
          maxContextTokens: 100,
          tokenUsage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
          messageId: null,
        },
      },
      {
        type: 'OpenApproval',
        request: {
          type: 'approval',
          requestId: 'child-approval',
          toolCallId: 'child-tool',
          sender: 'agent',
          action: 'Shell',
          description: 'Run child command',
        },
      },
      { type: 'ClearApprovals' },
    ],
  },
  {
    name: 'preserves user and assistant media display parts through display events',
    events: [
      {
        type: 'turn.begin',
        userText: 'look\n[image img-1]',
        parts: [
          { type: 'text', text: 'look' },
          { type: 'media', kind: 'image', url: 'data:image/png;base64,abc', id: 'img-1' },
        ],
      },
      { type: 'step.begin', n: 1 },
      { type: 'content.append', kind: 'media', media: { type: 'media', kind: 'video', url: 'data:video/mp4;base64,abc', id: 'vid-1' } },
      { type: 'turn.complete' },
    ],
    expectedState: {
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: [
            { type: 'text', text: 'look' },
            { type: 'media', kind: 'image', url: 'data:image/png;base64,abc', id: 'img-1' },
          ],
          status: 'completed',
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [],
          steps: [
            {
              id: 'step-1',
              n: 1,
              parts: [{ type: 'media', kind: 'video', url: 'data:video/mp4;base64,abc', id: 'vid-1' }],
            },
          ],
          status: 'completed',
        },
      ],
      plan: null,
      status: null,
      pendingApprovals: [],
      tokenUsage: emptyTokenUsage,
      activeTokenUsage: emptyTokenUsage,
      availableCommands: [],
      isStreaming: false,
      isCompacting: false,
    },
    expectedEffects: [{ type: 'ClearApprovals' }],
  },
  {
    name: 'rolls back empty preflight turns without leaving stale assistant placeholders',
    events: [
      { type: 'turn.begin', userText: 'first' },
      { type: 'step.begin', n: 1 },
      { type: 'content.append', kind: 'text', text: 'ok' },
      { type: 'turn.complete' },
      { type: 'turn.begin', userText: 'second' },
      { type: 'turn.error', error: { code: 'HANDSHAKE_TIMEOUT', message: 'Connection timed out.', phase: 'preflight' } },
    ],
    expectedState: {
      messages: [
        { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'first' }], status: 'completed' },
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [],
          steps: [{ id: 'step-1', n: 1, parts: [{ type: 'text', text: 'ok', finished: true }] }],
          status: 'completed',
        },
      ],
      plan: null,
      status: null,
      pendingApprovals: [],
      tokenUsage: emptyTokenUsage,
      activeTokenUsage: emptyTokenUsage,
      availableCommands: [],
      isStreaming: false,
      isCompacting: false,
    },
    expectedEffects: [{ type: 'ClearApprovals' }, { type: 'ClearApprovals' }],
  },
] satisfies DisplayReducerFixture[];
