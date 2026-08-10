import { describe, expect, it } from 'vitest';

import { createNativeTuiSession, listNativeSessions } from '#/cli/native-session';
import type { NativePermissionMode } from '#/cli/native-session-adapter';
import type { NativeServerClientLike } from '#/cli/native-server-client';

/** A fake `kimi-server-serve` client returning canned engine wire data. */
function fakeClient(options: {
  loadFound?: boolean;
  contextHistory?: unknown[];
  status?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  plan?: Record<string, unknown> | null;
  sessions?: Array<{ id: string; created_at: string; updated_at: string; work_dir?: string }>;
} = {}): NativeServerClientLike {
  const responses: Record<string, unknown> = {
    'session/list': { sessions: options.sessions ?? [] },
    'session/get_status': options.status ?? {
      model: 'kimi-k2',
      thinking_effort: 'high',
      permission: 'manual',
      plan_mode: false,
      swarm_mode: false,
      goal_enabled: true,
      context_tokens: 5,
      max_context_tokens: 100,
      context_usage: 0.05,
    },
    'session/get_context': { history: options.contextHistory ?? [], token_count: 5 },
    'session/get_usage': options.usage ?? { total: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } },
    'session/get_plan': options.plan ?? null,
    'session/load': { found: options.loadFound ?? true },
    'bg/list': { tasks: [] },
  };
  return {
    call: (method: string) => Promise.resolve(responses[method] ?? { ok: true }),
    sessionCreate: (init) => Promise.resolve({ session_id: init.sessionId ?? 'fake' }),
    sessionPrompt: () =>
      Promise.resolve({ stop_reason: 'EndTurn', steps: 1, usage: { total: { total_tokens: 1 } } }),
    sessionCancel: () => Promise.resolve({ cancelled: true }),
    approvalList: () => Promise.resolve([]),
    approvalResolve: () => Promise.resolve(true),
    onEvent: () => () => {},
    onSessionEvent: () => () => {},
    close: async () => {},
  };
}

describe('listNativeSessions', () => {
  it('filters to the workspace and sorts by updated_at (newest first)', async () => {
    const client = fakeClient({
      sessions: [
        { id: 'old', created_at: '1', updated_at: '1', work_dir: '/w' },
        { id: 'new', created_at: '2', updated_at: '3', work_dir: '/w' },
        { id: 'elsewhere', created_at: '4', updated_at: '4', work_dir: '/other' },
        { id: 'noworkdir', created_at: '5', updated_at: '5' },
      ],
    });
    const found = await listNativeSessions(client, '/w');
    expect(found.map((s) => s.id)).toEqual(['new', 'old']);
  });
});

describe('createNativeTuiSession', () => {
  it('resumes a persisted session: load restores state and getResumeState replays it', async () => {
    const client = fakeClient({
      contextHistory: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          origin: { kind: 'user' },
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi there' }],
        },
      ],
    });
    const session = await createNativeTuiSession(
      client,
      { sessionId: 'tui-fresh', workDir: '/w', model: 'kimi-k2' },
      { sessionId: 'saved-s1' },
    );
    expect(session).not.toBeNull();
    expect(session!.id).toBe('saved-s1');

    const resumeState = session!.getResumeState();
    expect(resumeState).toBeDefined();
    const main = resumeState!.agents['main']!;
    expect(main.config.modelAlias).toBe('kimi-k2');
    expect(main.context.tokenCount).toBe(5);
    expect(main.permission.mode as NativePermissionMode).toBe('manual');
    // Replay records are synthesized from the restored history.
    expect(main.replay.map((r) => r.type)).toEqual(['message', 'message']);
    const [user, assistant] = main.replay as unknown as [
      { message: { role: string; content: unknown[] } },
      { message: { role: string } },
    ];
    expect(user.message.role).toBe('user');
    expect(assistant.message.role).toBe('assistant');
  });

  it('returns null when the resumed id is not in the engine store', async () => {
    const client = fakeClient({ loadFound: false });
    const session = await createNativeTuiSession(
      client,
      { sessionId: 'tui-fresh', workDir: '/w' },
      { sessionId: 'missing' },
    );
    expect(session).toBeNull();
  });

  it('creates a fresh session without a resume snapshot', async () => {
    const client = fakeClient();
    const session = await createNativeTuiSession(client, {
      sessionId: 'tui-fresh',
      workDir: '/w',
    });
    expect(session).not.toBeNull();
    expect(session!.id).toBe('tui-fresh');
    expect(session!.getResumeState()).toBeUndefined();
  });
});
